// Tests déterministes de l'adaptateur eBay : aucun appel réseau réel.
const assert = require('assert');

process.env.EBAY_CLIENT_ID = 'cid';
process.env.EBAY_CLIENT_SECRET = 'sec';
process.env.EBAY_MIN_GAP_MS = '0';
const ebay = require('./ebay');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const item = (n, price, extra = {}) => ({
  itemId: `v1|${100000000000 + n}|0`, title: `RTX 3070 Ti ${n}`, price: { value: String(price), currency: 'EUR' },
  image: { imageUrl: `https://i.ebayimg.com/${n}.jpg` }, itemWebUrl: `https://www.ebay.fr/itm/${100000000000 + n}`,
  condition: 'D\'occasion', conditionId: '3000', buyingOptions: ['FIXED_PRICE'],
  seller: { username: `seller${n}`, feedbackPercentage: '99.5', feedbackScore: 120 }, itemLocation: { country: 'FR' }, ...extra,
});

async function withMock(handler, run) {
  const original = global.fetch;
  const calls = [];
  ebay._resetSession();
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts, calls); };
  try { await run(calls); } finally { global.fetch = original; }
}
const isToken = u => u.includes('/identity/v1/oauth2/token');

(async () => {
  // 1. recherche : OAuth, en-têtes, mapping, filtres (enchère, devise, pièces), frais de port
  await withMock((u, o) => {
    if (isToken(u)) return json(200, { access_token: 'tok1', expires_in: 7200, token_type: 'Application Access Token' });
    return json(200, { itemSummaries: [
      item(1, 300),
      item(2, 280, { shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '10.50', currency: 'EUR' } }] }),
      item(3, 100, { buyingOptions: ['AUCTION'] }),                              // enchère -> ignorée
      item(4, 250, { price: { value: '250', currency: 'USD' } }),                // devise étrangère -> ignorée
      item(5, 40, { conditionId: '7000', condition: 'Pour pièces' }),            // pièces -> junk
      item(6, 0),                                                                // prix nul -> ignoré
      item(7, 290, { itemWebUrl: 'https://evil.example/phish' }),                // URL non eBay -> lien de secours
      item(8, 310, { shippingOptions: [{ shippingCostType: 'CALCULATED', shippingCost: { value: '99', currency: 'EUR' } }] }),
    ] });
  }, async calls => {
    const ads = await ebay.search({ query: 'rtx (3070) ti, "8go"*', limit: 500 });
    assert.deepStrictEqual(ads.map(a => a.id), ['ebay-100000000001', 'ebay-100000000002', 'ebay-100000000005', 'ebay-100000000007', 'ebay-100000000008']);
    const [a1, a2, a5, a7, a8] = ads;
    assert.strictEqual(a1.price, 300); assert.strictEqual(a1.platform, 'ebay'); assert.strictEqual(a1.condition, 'bon');
    assert.strictEqual(a2.price, 290.5); assert.strictEqual(a2.itemPrice, 280); assert.strictEqual(a2.shippingCost, 10.5);
    assert.strictEqual(a5.junk, true); assert.strictEqual(a1.junk, false);
    assert.strictEqual(a7.url, 'https://www.ebay.fr/itm/100000000007');
    assert.strictEqual(a8.price, 310); assert.strictEqual(a8.shippingCost, null); // port calculé : non ajouté
    assert.strictEqual(a1.sellerRating, 5); assert.strictEqual(a1.sellerReviews, 120);
    assert.strictEqual(a1.image, 'https://i.ebayimg.com/1.jpg');
    // requêtes
    const tokenCall = calls[0];
    assert.strictEqual(tokenCall.opts.method, 'POST');
    assert.strictEqual(tokenCall.opts.headers.Authorization, 'Basic ' + Buffer.from('cid:sec').toString('base64'));
    assert(String(tokenCall.opts.body).includes('grant_type=client_credentials'));
    const sc = new URL(calls[1].url);
    assert.strictEqual(sc.origin + sc.pathname, 'https://api.ebay.com/buy/browse/v1/item_summary/search');
    assert.strictEqual(sc.searchParams.get('q'), 'rtx 3070 ti 8go');   // caractères spéciaux retirés
    assert.strictEqual(sc.searchParams.get('limit'), '200');           // plafonné
    assert(!sc.searchParams.has('filter'));                            // pas de plafond de prix côté API
    assert.strictEqual(calls[1].opts.headers.Authorization, 'Bearer tok1');
    assert.strictEqual(calls[1].opts.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_FR');
  });
  console.log('ok ebay search/mapping/filtres');

  // 2. jeton réutilisé entre deux recherches + requêtes simultanées = un seul jeton
  await withMock((u) => isToken(u) ? json(200, { access_token: 'tok', expires_in: 7200 }) : json(200, { itemSummaries: [item(1, 100)] }), async calls => {
    await Promise.all([ebay.search({ query: 'a' }), ebay.search({ query: 'b' }), ebay.search({ query: 'c' })]);
    await ebay.search({ query: 'd' });
    assert.strictEqual(calls.filter(c => isToken(c.url)).length, 1);
    assert.strictEqual(calls.length, 5);
  });
  console.log('ok ebay jeton mis en cache');

  // 3. 401 -> nouveau jeton, une seule relance
  let apiCalls = 0, tokens = 0;
  await withMock((u, o) => {
    if (isToken(u)) return json(200, { access_token: `t${++tokens}`, expires_in: 7200 });
    apiCalls++;
    return o.headers.Authorization === 'Bearer t1' ? json(401, { errors: [{ message: 'expired' }] }) : json(200, { itemSummaries: [item(1, 100)] });
  }, async () => {
    const ads = await ebay.search({ query: 'x' });
    assert.strictEqual(ads.length, 1); assert.strictEqual(tokens, 2); assert.strictEqual(apiCalls, 2);
  });
  // 401 persistant : pas de boucle infinie
  apiCalls = 0;
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : (apiCalls++, json(401, { errors: [{ message: 'nope' }] })), async () => {
    await assert.rejects(ebay.search({ query: 'x' }), /HTTP 401/);
    assert.strictEqual(apiCalls, 2);
  });
  console.log('ok ebay 401 relance unique');

  // 4. erreurs lisibles : identifiants, 429, 403, requête vide
  await withMock(() => json(401, { error: 'invalid_client', error_description: 'bad' }), async () => {
    await assert.rejects(ebay.search({ query: 'x' }), /identifiants invalides.*PRODUCTION/);
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(429, {}), async () => {
    await assert.rejects(ebay.search({ query: 'x' }), /limite d'appels/);
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(403, {}), async () => {
    await assert.rejects(ebay.search({ query: 'x' }), /accès refusé/);
  });
  await withMock(() => { throw new Error('ne doit pas être appelé'); }, async () => {
    assert.deepStrictEqual(await ebay.search({ query: ' ()*" ' }), []);
  });
  console.log('ok ebay erreurs');

  // 5. parseUrl
  const ok = {
    'https://www.ebay.fr/itm/123456789012': '123456789012',
    'https://www.ebay.fr/itm/RTX-3070-Ti/123456789012?hash=item1ca&_trkparms=x': '123456789012',
    'https://www.ebay.com/itm/123456789012#reviews': '123456789012',
    'http://ebay.co.uk/itm/123456789012/': '123456789012',
  };
  for (const [u, id] of Object.entries(ok)) assert.strictEqual(ebay.parseUrl(u), id, u);
  for (const u of ['https://www.ebay.fr/', 'https://www.ebay.fr/itm/12345', 'https://example.com/itm/123456789012', 'https://www.ebay.fr/sch/i.html?_nkw=rtx', 'n importe quoi']) {
    assert.strictEqual(ebay.parseUrl(u), null, u);
  }
  console.log('ok ebay parseUrl');

  // 6. getAd : description HTML nettoyée, enchère, 404, variantes
  await withMock((u) => {
    if (isToken(u)) return json(200, { access_token: 't', expires_in: 7200 });
    assert(u.includes('/item/get_item_by_legacy_id?legacy_item_id=123456789012'));
    return json(200, { ...item(9, 250), description: '<div>Carte <b>neuve</b>&nbsp;&amp; garantie<script>alert(1)</script></div><p>Contactez-moi sur WhatsApp</p>' });
  }, async () => {
    const ad = await ebay.getAd('123456789012');
    assert.strictEqual(ad.description, 'Carte neuve & garantie Contactez-moi sur WhatsApp');
    assert.strictEqual(ad.id, 'ebay-100000000009'); assert.deepStrictEqual(ad.redFlags, []);
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(200, item(9, 99, { buyingOptions: ['AUCTION'] })), async () => {
    const ad = await ebay.getAd('123456789012');
    assert.strictEqual(ad.auction, true); assert(ad.condition.includes('enchère'));
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(404, { errors: [{ errorId: 11001, message: 'not found' }] }), async () => {
    await assert.rejects(ebay.getAd('123456789012'), /introuvable/);
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(400, { errors: [{ errorId: 11006, message: 'The legacy Id is invalid for item with variation' }] }), async () => {
    await assert.rejects(ebay.getAd('123456789012'), /variantes.*capture/);
  });
  await withMock((u) => isToken(u) ? json(200, { access_token: 't', expires_in: 7200 }) : json(200, item(9, 99, { price: { value: '99', currency: 'GBP' } })), async () => {
    await assert.rejects(ebay.getAd('123456789012'), /inexploitable.*EUR/);
  });
  console.log('ok ebay getAd');

  // 6b. non-régression : hôtes usurpés, ponctuation finale, URL de bouton, état reconditionné
  for (const u of ['https://notebay.fr/itm/123456789012', 'https://evil.com/?u=ebay.fr/itm/123456789012', 'https://ebay.evil.com/itm/123456789012', 'ftp://www.ebay.fr/itm/123456789012']) {
    assert.strictEqual(ebay.parseUrl(u), null, u);
  }
  assert.strictEqual(ebay.parseUrl('https://www.ebay.fr/itm/123456789012)'), '123456789012');
  assert.strictEqual(ebay.parseUrl('https://m.ebay.de/itm/123456789012'), '123456789012');
  assert.strictEqual(ebay.parseUrl('https://www.ebay.fr/itm/1234567890123456'), null); // trop long
  assert.strictEqual(ebay._normalize(item(1, 10, { itemWebUrl: 'https://ebay.evil.com/phish' })).url, 'https://www.ebay.fr/itm/100000000001');
  assert.strictEqual(ebay._normalize(item(1, 10, { itemWebUrl: 'http://www.ebay.fr/itm/1' })).url, 'https://www.ebay.fr/itm/100000000001'); // http refusé
  assert.strictEqual(ebay._normalize(item(1, 10, { itemWebUrl: 'https://www.ebay.co.uk/itm/1' })).url, 'https://www.ebay.co.uk/itm/1');
  assert.strictEqual(ebay._normalize(item(1, 10, { conditionId: undefined, condition: 'Reconditionné par le vendeur' })).condition, 'excellent');
  console.log('ok ebay non-régression');

  // 7. vendeur sans avis / disponibilité
  const n = ebay._normalize(item(1, 100, { seller: { username: 'neuf', feedbackScore: 0 } }));
  assert.strictEqual(n.sellerRating, 0); assert.strictEqual(n.sellerReviews, 0);
  const n2 = ebay._normalize(item(1, 100, { seller: { username: 'inconnu' } }));
  assert.strictEqual(n2.sellerRating, null);
  assert.strictEqual(ebay.available, true);
  delete process.env.EBAY_CLIENT_SECRET;
  assert.strictEqual(ebay.available, false);
  process.env.EBAY_CLIENT_SECRET = 'sec';
  console.log('ok ebay vendeur/disponibilité');
})().catch(e => { console.error('FAIL ebay', e); process.exit(1); });
