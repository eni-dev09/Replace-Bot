// Tests déterministes de la source Dealabs : flux RSS simulé, aucun appel réseau réel.
const assert = require('assert');
process.env.DEALABS_CACHE_S = '60';
const dealabs = require('./dealabs');
const { filterPromos } = require('../deals');

const rss = items => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"
 xmlns:media="http://search.yahoo.com/mrss/" xmlns:pepper="http://www.pepper.com/rss"><channel><title>Dealabs</title>
<link>https://www.dealabs.com</link><atom:link href="https://www.dealabs.com/rss/tous" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;

const item = ({ id, title, price, merchant = 'Cdiscount', category = 'Informatique', date = 'Mon, 16 Nov 2026 07:25:12 +0100', link, desc = '<p>Détails du deal</p>', image = 'https://static.dealabs.com/i.jpg', merchantTag } = {}) => `
<item><title><![CDATA[${title}]]></title><category>${category}</category>
${merchantTag ?? (price !== undefined ? `<pepper:merchant name="${merchant}" price="${price}"/>` : '')}
<link>${link ?? `https://www.dealabs.com/bons-plans/slug-${id}`}</link><guid>${link ?? `https://www.dealabs.com/bons-plans/slug-${id}`}</guid>
<pubDate>${date}</pubDate><media:content url="${image}" width="100" height="100"/><media:thumbnail url="${image}"/>
<description><![CDATA[${desc}]]></description></item>`;

const SAMPLE = rss([
  item({ id: 3456931, title: 'Carte graphique MSI RTX 3070 Ti 8 Go', price: '329,99€', desc: '<p><b>329,99€</b> Cdiscount</p><p>au lieu de 499 €</p>' }),
  item({ id: 3456930, title: 'The Rogue Prince of Persia PS5', price: '11,99€', category: 'Consoles & Jeux vidéo', date: 'Mon, 16 Nov 2026 07:20:00 +0100' }),
  item({ id: 3456929, title: '[Étudiants] ElevenLabs : Plan Creator gratuit pendant 3 mois (au lieu de 22$/mois)', category: 'High-Tech', date: 'Mon, 16 Nov 2026 07:18:51 +0100' }),
  item({ id: 3456928, title: 'Écran AOC 32" incurvé', price: '1 299,99 €', merchant: 'Amazon', date: 'Mon, 16 Nov 2026 07:06:03 +0100' }),
  item({ id: 3456927, title: 'Clavier mécanique', price: '$49.99', merchant: 'Newegg' }),
  item({ id: 3456926, title: 'Piège : lien hors Dealabs', price: '5,00€', link: 'https://evil.example/bons-plans/x-3456926' }),
  item({ id: 3456925, title: 'Piège : lien http', price: '5,00€', link: 'http://www.dealabs.com/bons-plans/x-3456925' }),
  item({ id: 3456924, title: 'RTX 3070 Ti Gigabyte Gaming OC (au lieu de 450 €)', price: '399€', image: 'http://insecure.example/i.jpg', date: 'invalid date' }),
  `<item><title></title><link>https://www.dealabs.com/bons-plans/vide-3456923</link></item>`,
]);

const json200 = body => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
async function withFeed(handler, run) {
  const original = global.fetch; const calls = [];
  dealabs._resetCache();
  global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); };
  try { await run(calls); } finally { global.fetch = original; }
}

(async () => {
  // 1. parseFeed : champs, prix, ids, filtres de sécurité
  const items = dealabs._parseFeed(SAMPLE);
  assert.deepStrictEqual(items.map(i => i.id), ['dealabs-3456931', 'dealabs-3456930', 'dealabs-3456929', 'dealabs-3456928', 'dealabs-3456927', 'dealabs-3456924']);
  const [gpu, game, free, screen, kbd, gpu2] = items;
  assert.strictEqual(gpu.price, 329.99); assert.strictEqual(gpu.merchant, 'Cdiscount'); assert.strictEqual(gpu.category, 'Informatique');
  assert.strictEqual(gpu.originalPrice, 499); assert.strictEqual(gpu.kind, 'promo'); assert.strictEqual(gpu.platform, 'dealabs');
  assert.strictEqual(gpu.publishedAt, '2026-11-16T06:25:12.000Z');
  assert.strictEqual(gpu.url, 'https://www.dealabs.com/bons-plans/slug-3456931');
  assert.strictEqual(gpu.image, 'https://static.dealabs.com/i.jpg');
  assert.strictEqual(game.price, 11.99);
  assert.strictEqual(free.price, 0); assert.strictEqual(free.merchant, ''); assert.strictEqual(free.originalPrice, null); // « 22$ » : pas en €
  assert.strictEqual(screen.price, 1299.99);
  assert.strictEqual(kbd.price, null);                                   // devise étrangère : non convertie
  assert.strictEqual(gpu2.originalPrice, 450); assert.strictEqual(gpu2.image, null); assert.strictEqual(gpu2.publishedAt, null);
  console.log('ok dealabs parseFeed');

  // 2. parsePrice
  const cases = { '11,99€': 11.99, '1 299,99 €': 1299.99, '1.299€': 1299, '1.299,99€': 1299.99, '0€': 0, '25 €': 25, '99.5€': 99.5, '$49': null, '£5': null, '': null, 'gratuit': null, undefined: null };
  for (const [raw, want] of Object.entries(cases)) assert.strictEqual(dealabs._parsePrice(raw === 'undefined' ? undefined : raw), want, `parsePrice(${raw})`);
  console.log('ok dealabs parsePrice');

  // 3. search : mots-clés (3070ti = 3070 Ti), tri récent d'abord, aucun mot = rien ; une seule requête, bons en-têtes
  await withFeed(() => json200(SAMPLE), async calls => {
    const r = await dealabs.search({ query: 'rtx 3070 ti' });
    assert.deepStrictEqual(r.map(a => a.id), ['dealabs-3456931', 'dealabs-3456924']); // date valide avant date invalide
    assert.deepStrictEqual((await dealabs.search({ query: 'rtx 3070ti' })).map(a => a.id), ['dealabs-3456931', 'dealabs-3456924']); // 3070ti == 3070 Ti
    assert.deepStrictEqual((await dealabs.search({ query: 'prince persia' })).map(a => a.id), ['dealabs-3456930']);
    assert.deepStrictEqual((await dealabs.search({ query: 'crème solaire' })), []);
    assert.deepStrictEqual((await dealabs.search({ query: '  ' })), []);
    assert.deepStrictEqual((await dealabs.search({ query: 'high-tech elevenlabs' })).map(a => a.id), ['dealabs-3456929']); // catégorie prise en compte
    assert.strictEqual(calls.length, 1);                              // cache : une seule requête pour 5 recherches
    assert.strictEqual(calls[0].url, 'https://www.dealabs.com/rss/tous');
    assert(calls[0].opts.headers['User-Agent'].includes('ReplaceBot'));
    assert.strictEqual((await dealabs.search({ query: 'rtx', limit: 1 })).length, 1);
  });
  // requêtes simultanées = un seul appel réseau
  await withFeed(() => json200(SAMPLE), async calls => {
    await Promise.all([dealabs.search({ query: 'rtx' }), dealabs.search({ query: 'ps5' }), dealabs.search({ query: 'ecran' })]);
    assert.strictEqual(calls.length, 1);
  });
  console.log('ok dealabs search/cache');

  // 4. erreurs lisibles, et un échec n'est pas mis en cache
  for (const [status, re] of [[403, /accès limité \(HTTP 403\)/], [429, /accès limité \(HTTP 429\)/], [500, /HTTP 500/]]) {
    await withFeed(() => new Response('', { status }), async () => { await assert.rejects(dealabs.search({ query: 'rtx' }), re); });
  }
  await withFeed(() => json200('<html>pas du rss</html>'), async () => { await assert.rejects(dealabs.search({ query: 'rtx' }), /flux RSS inattendu/); });
  await withFeed(() => json200('<rss><channel><item><title>x</title></rss>'), async () => { await assert.rejects(dealabs.search({ query: 'rtx' }), /Dealabs: (flux illisible|flux RSS inattendu)/); });
  let n = 0;
  await withFeed(() => (++n === 1 ? new Response('', { status: 500 }) : json200(SAMPLE)), async () => {
    await assert.rejects(dealabs.search({ query: 'rtx' }), /HTTP 500/);
    assert.strictEqual((await dealabs.search({ query: 'rtx' })).length, 2); // la 2e tentative refait la requête
  });
  console.log('ok dealabs erreurs');

  // 5. URL du flux : https + dealabs.com uniquement
  for (const bad of ['http://www.dealabs.com/rss/tous', 'https://evil.example/rss', 'https://dealabs.com.evil.example/rss', 'pas une url']) {
    process.env.DEALABS_FEED_URL = bad;
    await withFeed(() => { throw new Error('ne doit pas être appelé'); }, async () => { await assert.rejects(dealabs.search({ query: 'rtx' }), /DEALABS_FEED_URL/); });
  }
  process.env.DEALABS_FEED_URL = 'https://www.dealabs.com/rss/groupe/high-tech';
  await withFeed(() => json200(SAMPLE), async calls => { await dealabs.search({ query: 'rtx' }); assert.strictEqual(calls[0].url, 'https://www.dealabs.com/rss/groupe/high-tech'); });
  delete process.env.DEALABS_FEED_URL;
  console.log('ok dealabs URL du flux');

  // 6. filterPromos : budget, mots exclus, prix inconnu
  const all = items;
  assert.deepStrictEqual(filterPromos(all, { maxPrice: 350 }).map(a => a.id), ['dealabs-3456931', 'dealabs-3456930', 'dealabs-3456929']); // prix inconnu écarté, gratuit gardé
  assert.deepStrictEqual(filterPromos(all, { exclude: ['gigabyte', 'AOC'] }).map(a => a.id), ['dealabs-3456931', 'dealabs-3456930', 'dealabs-3456929', 'dealabs-3456927']);
  assert.strictEqual(filterPromos(all, {}).length, 6);
  console.log('ok dealabs filterPromos');

  assert.strictEqual(dealabs.available, true);
})().catch(e => { console.error('FAIL dealabs', e); process.exit(1); });
