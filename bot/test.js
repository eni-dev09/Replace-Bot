// Tests sans réseau ni Discord : node bot/test.js
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
process.env.SEARCH_CACHE_TTL_S = '0';

const { findDeals, relevantAds, isJunk, stats } = require('./deals');
const { assess } = require('./trust');
const store = require('./store');
const platforms = require('./platforms');
const radar = require('./radar');
process.env.EBAY_MIN_GAP_MS = '0';
for (const id of Object.keys(platforms.platforms)) delete platforms.platforms[id]; // tests isolés : aucun appel réseau réel

const mk = (id, price, extra = {}) => ({ id, platform: 'fake', title: 'iPhone t' + id, price, url: 'http://x/' + id, ...extra });
const gpu = (id, price, title, extra = {}) => ({ id: 'fake-' + id, platform: 'fake', title, price, url: 'http://x/' + id, location: 'Paris', condition: 'bon', ...extra });

(async () => {
  // 1. détection
  const ads = [mk(1, 100), mk(2, 110), mk(3, 120), mk(4, 130), mk(5, 70), mk(6, 20), mk(7, 60, { risky: true }), mk(8, 0)];
  const r = findDeals(ads, { maxPrice: 200, minDiscount: 0.2 });
  assert.strictEqual(r.median, 100);
  assert.deepStrictEqual(r.deals.map(d => d.id), [5, 6]);  // suspect (6, -80 %) relégué après la vraie affaire (5)
  assert.strictEqual(r.deals[1].suspicious, true);
  assert.strictEqual(findDeals([mk(1, 10), mk(2, 5)], {}).deals.length, 0);
  console.log('ok deals');

  // 1b. pertinence / junk / stats
  const titles = [gpu(1, 280, 'RTX 3070 Ti Gigabyte'), gpu(2, 300, 'rtx 3070ti MSI'), gpu(3, 20, 'Support carte graphique RTX 3070 Ti'),
    gpu(4, 150, 'GTX 1070'), gpu(5, 50, 'RTX 3070 Ti HS pour pièces')];
  assert.deepStrictEqual(relevantAds(titles, 'rtx 3070ti').map(a => a.id), ['fake-1', 'fake-2', 'fake-3', 'fake-5']);
  assert(isJunk(titles[2], 'rtx 3070ti') && isJunk(titles[4], 'rtx 3070ti'));
  assert(!isJunk(titles[2], 'support rtx')); // le mot est dans la recherche -> pas du junk
  assert.strictEqual(stats([100, 100, 110, 5, 900]).median, 100); // aberrants écartés
  console.log('ok pertinence/junk/stats');

  // 1c. score de fiabilité
  const market = { median: 300, n: 20, p25: 270 };
  const good = assess({ title: 'RTX 3070 Ti', price: 280, description: 'Carte en parfait état, facture dispo, remise en main propre.', sellerRating: 4.8, sellerReviews: 30 }, market);
  assert(good.risk < 25, 'fiable: ' + good.risk);
  const scam = assess({ title: 'RTX 3070 Ti', price: 90, description: 'Urgent contactez moi sur WhatsApp, paiement par virement', sellerRating: 0, sellerReviews: 0 }, market);
  assert(scam.risk >= 75 && scam.label === 'Très suspect', 'scam: ' + scam.risk);
  assert(scam.reasons[0].type === 'bad');
  const unk = assess({ title: 'x', price: 100, redFlags: ['paiement hors plateforme'] }, {});
  assert(unk.reasons.some(x => x.text.includes('Capture')));
  console.log('ok trust', good.risk, scam.risk);

  // 2. store
  const a = store.addTarget({ guildId: 'g', channelId: 'c', keyword: 'iPhone', maxPrice: 300, platforms: ['fake'], minDiscount: 0.2, exclude: ['coque'], roleId: 'role1' });
  const b = store.addTarget({ guildId: 'g', channelId: 'c', keyword: 'iphone', maxPrice: 300, platforms: ['fake'], minDiscount: 0.2 });
  assert(a.created && !b.created);
  assert.strictEqual(store.removeTarget(a.target.id, 'other'), false);
  console.log('ok store');

  // 3. scan complet + ping de rôle
  platforms.platforms.fake = {
    id: 'fake', label: 'Fake', emoji: '🧪', color: 1, search: async () => ads,
    parseUrl: u => (/fake\/(\d+)/.exec(u) || [])[1] || null,
    getAd: async id => ({ ...gpu(id, 90, 'RTX 3070 Ti Gigabyte', { description: 'contact whatsapp', sellerRating: 0, sellerReviews: 0 }), id: 'fake-' + id, redFlags: [] }),
  };
  const sent = [];
  radar.client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async m => sent.push(m) }) } };
  const t = store.targets[0];
  const r1 = await radar.scanTarget(t);
  assert.strictEqual(r1.posted, 2);
  assert(sent[0].embeds[0].data.title.includes('t5'));
  assert.strictEqual(sent[0].content, '<@&role1>'); assert.strictEqual(sent[1].content, undefined);
  assert.strictEqual((await radar.scanTarget(t)).posted, 0);
  console.log('ok scan + dédoublonnage + ping');

  platforms.platforms.fake.search = async () => { throw new Error('boom'); };
  assert.deepStrictEqual((await radar.scanTarget({ ...t, id: 'zz', scannedAt: null })).errors, ['fake: boom']);
  console.log('ok erreurs');

  // 4. rapport de marché + message
  const market_ads = [gpu(1, 300, 'RTX 3070 Ti Gigabyte'), gpu(2, 320, 'RTX 3070 Ti MSI'), gpu(3, 310, 'rtx 3070ti Asus'), gpu(4, 330, 'RTX 3070 Ti Zotac'),
    gpu(5, 200, 'RTX 3070 Ti Palit'), gpu(6, 15, 'Support RTX 3070 Ti'), gpu(7, 60, 'RTX 3070 Ti HS')];
  platforms.platforms.fake.search = async () => market_ads;
  const { marketReport } = require('./market');
  const rep = await marketReport({ query: 'rtx 3070ti', maxPrice: 250, platformIds: ['fake'] });
  assert.strictEqual(rep.overall.n, 5); assert.strictEqual(rep.overall.median, 310);
  assert.deepStrictEqual(rep.best.map(b => b.id), ['fake-5']); // budget 250 respecté, junk exclu
  const { marketMessage, analysisMessage } = require('./embed');
  const mm = marketMessage(rep);
  assert.strictEqual(mm.embeds.length, 2); assert(mm.embeds[0].data.description.includes('310'));
  console.log('ok marché');

  // 5. analyse par lien
  const an = await require('./analyse').analyse({ url: 'https://fake/42' });
  assert.strictEqual(an.ad.price, 90);
  assert(an.assessment.risk >= 50, 'risk ' + an.assessment.risk); // 90 € vs ~310 + whatsapp + 0 avis
  const am = analysisMessage(an);
  assert(am.embeds[0].data.title.includes('risque'));
  await assert.rejects(require('./analyse').analyse({ url: 'https://exemple.com/x' }), /non reconnu/);
  await assert.rejects(require('./analyse').analyse({ imageUrls: ['http://img/x.png'] }), /OPENAI_API_KEY/);
  console.log('ok analyse lien', an.assessment.risk);

  // 6. capture d'écran (API Anthropic simulée)
  process.env.ANTHROPIC_API_KEY = 'test';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://img/')) return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    const body = JSON.parse(opts.body);
    assert(body.messages[0].content[0].source.media_type === 'image/png' || body.max_tokens === 40);
    const text = body.max_tokens === 40 ? 'rtx 3070ti' : '```json\n' + JSON.stringify({ readable: true, platform: 'fake', title: 'RTX 3070 Ti', price: 90, seller_rating: null,
      description: 'ecrire sur whatsapp', search_query: 'rtx 3070ti', red_flags: ['contact WhatsApp'] }) + '\n```';
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { headers: { 'content-type': 'application/json' } });
  };
  const shot = await require('./analyse').analyse({ imageUrls: ['http://img/a.png'] });
  assert.strictEqual(shot.ad.price, 90); assert(shot.assessment.risk >= 60, 'shot ' + shot.assessment.risk);
  assert(shot.assessment.reasons.some(x => x.text.startsWith('Capture')));
  global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY;
  console.log('ok analyse capture', shot.assessment.risk);

  // 6a. capture d'écran via OpenAI (priorité si la clé est présente)
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'also-set';
  assert.strictEqual(require('./ai').provider(), 'openai');
  const realFetch2 = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://img/')) return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    assert.strictEqual(url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(opts.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(opts.body);
    seen.push(body);
    assert.strictEqual(body.messages[0].role, 'system');
    const isShot = body.messages[1].content.some(c => c.type === 'image_url');
    if (isShot) {
      assert(body.messages[1].content.find(c => c.type === 'image_url').image_url.url.startsWith('data:image/png;base64,'));
      assert.deepStrictEqual(body.response_format, { type: 'json_object' });
    }
    const text = !isShot ? 'rtx 3070ti' : JSON.stringify({ readable: true, platform: 'fake', title: 'RTX 3070 Ti', price: 90, seller_rating: null,
      description: 'ecrire sur whatsapp', search_query: 'rtx 3070ti', red_flags: ['contact WhatsApp'] });
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const shot2 = await require('./analyse').analyse({ imageUrls: ['http://img/a.png'] });
  assert.strictEqual(shot2.ad.price, 90); assert(shot2.assessment.risk >= 60);
  assert(seen[0].max_completion_tokens && seen[0].model);
  global.fetch = realFetch2; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual(require('./ai').provider(), null);
  console.log('ok analyse capture OpenAI');

  // 6a2. capture d'écran via Gemini (prioritaire)
  process.env.GEMINI_API_KEY = 'g-test'; process.env.OPENAI_API_KEY = 'also'; process.env.ANTHROPIC_API_KEY = 'also';
  assert.strictEqual(require('./ai').provider(), 'gemini');
  process.env.AI_PROVIDER = 'openai'; assert.strictEqual(require('./ai').provider(), 'openai'); delete process.env.AI_PROVIDER;
  const realFetch3 = global.fetch;
  const gseen = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://img/')) return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    assert(String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/models/') && String(url).endsWith(':generateContent'));
    assert.strictEqual(opts.headers['x-goog-api-key'], 'g-test');
    const body = JSON.parse(opts.body); gseen.push(body);
    assert(body.systemInstruction.parts[0].text.length > 10);
    const parts = body.contents[0].parts;
    const isShot = parts.some(p => p.inlineData);
    if (isShot) { assert.strictEqual(parts.find(p => p.inlineData).inlineData.mimeType, 'image/png'); assert.strictEqual(body.generationConfig.responseMimeType, 'application/json'); }
    const text = !isShot ? 'rtx 3070ti' : JSON.stringify({ readable: true, platform: 'fake', title: 'RTX 3070 Ti', price: 90, seller_rating: null,
      description: 'ecrire sur whatsapp', search_query: 'rtx 3070ti', red_flags: ['contact WhatsApp'] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const shot3 = await require('./analyse').analyse({ imageUrls: ['http://img/a.png'] });
  assert.strictEqual(shot3.ad.price, 90); assert(shot3.assessment.risk >= 60); assert(gseen[0].generationConfig.maxOutputTokens);
  global.fetch = async url => String(url).startsWith('http://img/')
    ? new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } })
    : new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(require('./ai').readScreenshot(['http://img/a.png']), /réponse vide de Gemini.*SAFETY/);
  global.fetch = realFetch3; delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  process.env.GOOGLE_API_KEY = 'alias'; assert.strictEqual(require('./ai').provider(), 'gemini'); delete process.env.GOOGLE_API_KEY;
  console.log('ok analyse capture Gemini');

  // 6b. cache : 2 appels identiques = 1 recherche réelle
  process.env.SEARCH_CACHE_TTL_S = '60';
  let calls = 0;
  platforms.platforms.fake.search = async () => { calls++; return market_ads; };
  await Promise.all([marketReport({ query: 'cache test', platformIds: ['fake'] }), marketReport({ query: 'Cache Test', platformIds: ['fake'] })]);
  await marketReport({ query: 'cache test', platformIds: ['fake'] });
  assert.strictEqual(calls, 1);
  process.env.SEARCH_CACHE_TTL_S = '0';
  console.log('ok cache');

  // 6c. erreurs Anthropic lisibles
  const { explainError } = require('./ai');
  const fakeRes = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const credit = await explainError(fakeRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
  assert(credit.includes('crédits') && !credit.includes('{'));
  assert((await explainError(fakeRes(401, {}))).includes('invalide'));
  assert((await explainError(fakeRes(500, {}))).includes('HTTP 500'));
  const oai = (status, body) => explainError(fakeRes(status, body), 'openai');
  const q = await oai(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } });
  assert(q.includes('crédits') && q.includes('platform.openai.com') && !q.includes('{'));
  assert((await oai(429, { error: { message: 'Rate limit reached' } })).includes('saturée'));
  assert((await oai(401, { error: { message: 'Incorrect API key' } })).includes('OPENAI_API_KEY'));
  assert((await oai(404, { error: { message: 'The model does not exist' } })).includes('OPENAI_MODEL'));
  const gem = (status, body) => explainError(fakeRes(status, body), 'gemini');
  const gq = await gem(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } });
  assert(gq.includes('quota') && !gq.includes('{'));
  assert((await gem(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })).includes('GEMINI_API_KEY'));
  assert((await gem(404, { error: { message: 'models/x is not found', status: 'NOT_FOUND' } })).includes('GEMINI_MODEL'));
  assert((await gem(400, { error: { message: 'User location is not supported for the API use.' } })).includes('région'));
  assert((await gem(403, { error: { message: 'denied' } })).includes('refusé'));
  console.log('ok erreurs IA');

  // 7. mention
  const { onMessage, parseQuery } = require('./mention');
  assert.deepStrictEqual(parseQuery('rtx 3070ti max 300€ -coque'), { query: 'rtx 3070ti', maxPrice: 300, exclude: ['coque'] });
  assert.deepStrictEqual(parseQuery('iphone 13 pro 450 euros'), { query: 'iphone 13 pro', maxPrice: 450, exclude: [] });
  const replies = [];
  const client = { user: { id: '123' } };
  const msg = txt => ({ author: { id: 'u' + Math.random(), bot: false }, guild: {}, content: txt, attachments: new Map(),
    mentions: { has: () => true }, channel: { sendTyping: async () => {} }, reply: async p => replies.push(p) });
  const deterministicMarketReport = async () => rep;
  await onMessage(msg('<@123> rtx 3070ti max 250€'), client, { marketReport: deterministicMarketReport });
  assert.strictEqual(replies[0].embeds.length, 2, 'mention search should render summary + one deal embed');
  assert.deepStrictEqual(replies[0].allowedMentions, { parse: [], repliedUser: false }, 'mention reply must suppress mentions');
  await onMessage(msg('<@123> https://fake/7'), client);
  assert(replies[1].embeds[0].data.title.includes('risque'));
  await onMessage(msg('<@123>'), client);
  assert(replies[2].content.includes('Écris-moi un produit'));
  console.log('ok mention');

  // 7b. non-régression : enchère jugée sur son prix, message de lien, lien suivi de ponctuation
  const auc = assess({ title: 'x', price: 20, auction: true, sellerRating: 4.9, sellerReviews: 50 }, { median: 300, n: 20 });
  assert(auc.risk < 25 && auc.reasons.some(x => x.text.includes('Enchère en cours')), 'enchère ' + auc.risk);
  await assert.rejects(require('./analyse').analyse({ url: 'https://exemple.com/x' }), /Lien non reconnu : je gère les liens .*Leboncoin.*Vinted.*eBay/);
  assert.strictEqual(platforms.fromUrl('https://notleboncoin.fr/ad/x/2123456789'), null);
  const punct = [];
  await onMessage({ author: { id: 'up', bot: false }, guild: {}, content: '<@123> regarde https://exemple.com/x).', attachments: new Map(),
    mentions: { has: () => true }, channel: { sendTyping: async () => {} }, reply: async p => punct.push(p) }, client);
  assert(punct[0].content.includes('pas pris en charge') && punct[0].content.includes('eBay'));
  console.log('ok non-régression bot');

  // 8. eBay de bout en bout (API simulée) : marché, analyse par lien, mention, alerte « toutes plateformes »
  delete platforms.platforms.fake;
  process.env.EBAY_CLIENT_ID = 'cid'; process.env.EBAY_CLIENT_SECRET = 'sec';
  const ebay = require('./platforms/ebay'); ebay._resetSession();
  platforms.platforms.ebay = ebay;
  const eItem = (n, price, extra = {}) => ({ itemId: `v1|${100000000000 + n}|0`, title: `RTX 3070 Ti Gigabyte ${n}`, price: { value: String(price), currency: 'EUR' },
    image: { imageUrl: `https://i.ebayimg.com/${n}.jpg` }, itemWebUrl: `https://www.ebay.fr/itm/${100000000000 + n}`, condition: 'D\'occasion', conditionId: '3000',
    buyingOptions: ['FIXED_PRICE'], seller: { username: `s${n}`, feedbackPercentage: '99.5', feedbackScore: 120 }, itemLocation: { country: 'FR' }, ...extra });
  const ebayItems = [eItem(1, 290), eItem(2, 300), eItem(3, 310), eItem(4, 320), eItem(5, 330), eItem(6, 295),
    eItem(7, 200, { shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '0.00', currency: 'EUR' } }] }),
    eItem(8, 10, { title: 'Support carte graphique RTX 3070 Ti' }), eItem(9, 400, { buyingOptions: ['AUCTION'] })];
  const realFetch4 = global.fetch;
  global.fetch = async url => {
    const j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/oauth2/token')) return j(200, { access_token: 'tk', expires_in: 7200 });
    if (String(url).includes('get_item_by_legacy_id')) return j(200, { ...eItem(99, 90), description: '<p>Dispo vite, contactez-moi sur WhatsApp</p>' });
    return j(200, { itemSummaries: ebayItems });
  };
  const { analyse } = require('./analyse');
  const erep = await marketReport({ query: 'rtx 3070 ti', platformIds: ['ebay'] });
  assert.strictEqual(erep.errors.length, 0);
  assert.strictEqual(erep.overall.n, 7);              // enchère et support exclus
  assert.strictEqual(erep.overall.median, 300);
  assert.strictEqual(erep.best[0].id, 'ebay-100000000007'); assert.strictEqual(erep.best[0].ratio, 33);
  const ean = await analyse({ url: 'https://www.ebay.fr/itm/RTX-3070-Ti/100000000099?hash=x' });
  assert.strictEqual(ean.ad.platform, 'ebay'); assert.strictEqual(ean.market.scope, 'eBay');
  assert(ean.assessment.risk >= 60 && ean.assessment.reasons.some(x => /WhatsApp/i.test(x.text)), 'ebay risk ' + ean.assessment.risk);
  const eReplies = [];
  await onMessage({ author: { id: 'ue', bot: false }, guild: {}, content: '<@123> https://www.ebay.fr/itm/100000000099', attachments: new Map(),
    mentions: { has: () => true }, channel: { sendTyping: async () => {} }, reply: async p => eReplies.push(p) }, client);
  assert(eReplies[0].embeds[0].data.title.includes('risque'), 'mention ebay');
  // alerte créée avec « toutes » (*) : eBay pris en compte même s'il a été activé après la création
  const wild = store.addTarget({ guildId: 'g2', channelId: 'c2', keyword: 'rtx 3070 ti', maxPrice: 250, platforms: ['*'], minDiscount: 0.2 }).target;
  sent.length = 0;
  const rw = await radar.scanTarget(wild);
  assert.deepStrictEqual(rw.errors, []); assert.strictEqual(rw.posted, 1);
  assert(sent[0].embeds[0].data.fields.some(f => f.name === 'Livraison' && f.value === 'gratuite'));
  global.fetch = realFetch4;
  // un identifiant eBay invalide ne casse pas le rapport : l'erreur est remontée proprement
  global.fetch = async () => new Response('{"error":"invalid_client"}', { status: 401 }); ebay._resetSession();
  const bad = await marketReport({ query: 'rtx 3070 ti', platformIds: ['ebay'] });
  assert(bad.errors[0].includes('identifiants invalides')); assert.strictEqual(bad.best.length, 0);
  global.fetch = realFetch4; ebay._resetSession();
  console.log('ok ebay de bout en bout');

  // 5. Dealabs de bout en bout (flux RSS simulé)
  const dealabs = require('./platforms/dealabs'); dealabs._resetCache();
  platforms.platforms.dealabs = dealabs;
  const dItem = (id, title, price, extra = '') => `<item><title><![CDATA[${title}]]></title><category>Informatique</category>${price != null ? `<pepper:merchant name="Cdiscount" price="${price}"/>` : ''}<link>https://www.dealabs.com/bons-plans/x-${id}</link><pubDate>Mon, 16 Nov 2026 07:2${id % 10}:00 +0100</pubDate><description><![CDATA[${extra}]]></description></item>`;
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:pepper="http://www.pepper.com/rss"><channel>${[
    dItem(1, 'Carte graphique RTX 3070 Ti 8 Go', '329,99€', 'au lieu de 499 €'),
    dItem(2, 'RTX 3070 Ti coque HS', '120€'),
    dItem(3, 'RTX 3070 Ti Asus', '650€'),
    dItem(4, 'RTX 3070 Ti sans prix', null),
  ].join('')}</channel></rss>`;
  const realFetch5 = global.fetch;
  global.fetch = async () => new Response(feed, { status: 200 });
  const drep = await marketReport({ query: 'rtx 3070 ti', platformIds: ['dealabs'] });
  assert.strictEqual(drep.best.length, 0);                 // pas une place d'occasion : jamais dans les offres/médiane
  assert.strictEqual(drep.overall.n || 0, 0);
  assert.deepStrictEqual(drep.promos.map(p => p.id), ['dealabs-4', 'dealabs-3', 'dealabs-2']);  // 3 max, plus récent d'abord
  const dbud = await marketReport({ query: 'rtx 3070 ti', maxPrice: 400, platformIds: ['dealabs'] });
  assert.deepStrictEqual(dbud.promos.map(p => p.id).sort(), ['dealabs-1', 'dealabs-2']);  // budget : prix inconnu et trop cher écartés
  const dex = await marketReport({ query: 'rtx 3070 ti', exclude: ['coque'], platformIds: ['dealabs'] });
  assert(!dex.promos.some(p => p.id === 'dealabs-2'));
  const dmsg = marketMessage(dbud);
  assert(dmsg.embeds.some(e => /329\.99/.test(JSON.stringify(e.data))), 'promo dans le message');
  assert(dmsg.embeds.length <= 10);
  // radar : une promo est postée avec le message promo, une seule fois
  const dt = store.addTarget({ guildId: 'g3', channelId: 'c3', keyword: 'rtx 3070 ti', maxPrice: 400, platforms: ['dealabs'], minDiscount: 0.2, exclude: ['coque'] }).target;
  sent.length = 0;
  const rd = await radar.scanTarget(dt);
  assert.deepStrictEqual(rd.errors, []); assert.strictEqual(rd.posted, 1);
  assert(JSON.stringify(sent[0].embeds[0].data).includes('329.99'));
  assert.strictEqual((await radar.scanTarget(dt)).posted, 0);
  // analyse d'un lien Dealabs : pas une annonce d'occasion -> refus lisible, pas de crash
  const dan = await analyse({ url: 'https://www.dealabs.com/bons-plans/x-1' }).catch(e => e);
  assert(dan && (dan.error || dan.message), 'analyse dealabs');
  // flux en panne : l'erreur est remontée, le rapport reste valide
  dealabs._resetCache(); global.fetch = async () => new Response('', { status: 429 });
  const dbad = await marketReport({ query: 'rtx 3070 ti', platformIds: ['dealabs'] });
  assert(dbad.errors[0].includes('accès limité')); assert.strictEqual(dbad.promos.length, 0);
  global.fetch = realFetch5; dealabs._resetCache();
  delete platforms.platforms.dealabs;
  console.log('ok dealabs de bout en bout');

  // 6. priorité livraison + France
  const { inFrance, priority } = require('./deals');
  assert.strictEqual(inFrance({ platform: 'leboncoin' }), true);
  assert.strictEqual(inFrance({ platform: 'ebay', country: 'FR' }), true);
  assert.strictEqual(inFrance({ platform: 'ebay', country: 'DE' }), false);
  assert.strictEqual(inFrance({ platform: 'ebay', location: 'Lyon, FR' }), true);
  assert.strictEqual(inFrance({ platform: 'vinted', country: 'Allemagne' }), false);
  assert.strictEqual(inFrance({ platform: 'vinted', country: 'France' }), true);
  assert.strictEqual(inFrance({ platform: 'vinted' }), null);
  assert(priority({ platform: 'ebay', country: 'FR', delivery: true }) > priority({ platform: 'ebay', country: 'DE', delivery: true }));
  assert(priority({ platform: 'ebay', country: 'FR', delivery: true }) > priority({ platform: 'ebay', country: 'FR', delivery: false }));
  // le radar poste d'abord l'annonce française avec livraison, même avec une remise un peu plus faible
  const pt = store.addTarget({ guildId: 'g4', channelId: 'c4', keyword: 'zzz prio', maxPrice: 500, platforms: ['prio'], minDiscount: 0.2 }).target;
  const pm = (id, price, extra) => ({ id: 'prio-' + id, platform: 'prio', title: 'zzz prio ' + id, price, url: 'http://x/' + id, ...extra });
  platforms.platforms.prio = { id: 'prio', label: 'Prio', emoji: '🧪', color: 1, search: async () => [
    pm(1, 100), pm(2, 100), pm(3, 100), pm(4, 100),
    pm(5, 70, { country: 'DE', delivery: true }), pm(6, 75, { country: 'FR', delivery: true }), pm(7, 74, { country: 'FR', delivery: false })] };
  sent.length = 0;
  const rp = await radar.scanTarget(pt);
  assert.strictEqual(rp.posted, 3);
  assert(sent[0].embeds[0].data.title.includes('zzz prio 6'), sent[0].embeds[0].data.title);
  assert(sent[2].embeds[0].data.title.includes('zzz prio 5'));
  assert(JSON.stringify(sent[0].embeds[0].data).includes('Livraison dispo'));
  delete platforms.platforms.prio;
  console.log('ok priorité livraison/France');

  // 7. scan en continu : intervalle, pas de chevauchement, arrêt propre
  const freshRadar = env => { const old = { ...process.env }; Object.assign(process.env, env); for (const k of ['DEAL_RADAR_INTERVAL_S', 'DEAL_RADAR_INTERVAL_MIN']) if (!(k in env)) delete process.env[k];
    delete require.cache[require.resolve('./radar')]; const r = require('./radar'); Object.assign(process.env, old); return r; };
  assert.strictEqual(freshRadar({}).intervalS, 60);
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_S: '30' }).intervalS, 30);
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_S: '5' }).intervalS, 20);          // minimum 20 s
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_MIN: '10' }).intervalS, 600);      // ancienne variable
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_S: 'abc' }).intervalS, 60);
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_S: '90' }).fmtInterval(), '90 s');
  assert.strictEqual(freshRadar({ DEAL_RADAR_INTERVAL_S: '120' }).fmtInterval(), '2 min');
  const realST = global.setTimeout;
  const cr = freshRadar({ DEAL_RADAR_INTERVAL_S: '20' });
  let running = 0, maxRunning = 0, passes = 0;
  cr.scanAll = async () => { passes++; running++; maxRunning = Math.max(maxRunning, running); await new Promise(r => realST(r, 30)); running--; return { skipped: false, posted: 0, errors: 0 }; };
  const delays = [];
  global.setTimeout = (fn, ms, ...a) => { delays.push(ms); return realST(fn, Math.min(ms, 5), ...a); }; // accélère le temps
  cr.start({});
  await new Promise(r => realST(r, 400));
  cr.stop(); const after = passes; await new Promise(r => realST(r, 100));
  global.setTimeout = realST;
  assert(after >= 3, 'plusieurs passes enchaînées : ' + after); assert.strictEqual(maxRunning, 1); assert.strictEqual(passes, after, 'arrêt effectif');
  assert.strictEqual(delays[0], 15000); assert(delays.slice(1).every(d => d >= 1000 && d <= 20000));
  console.log('ok scan en continu');

  const cmds = require('./commands');
  assert.strictEqual(cmds.definitions.length, 3);
  console.log('ok commandes:', cmds.definitions.map(c => c.name).join(', '));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
