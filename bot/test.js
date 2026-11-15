// Tests sans réseau ni Discord : node bot/test.js
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
process.env.SEARCH_CACHE_TTL_S = '0';

const { findDeals, relevantAds, isJunk, stats } = require('./deals');
const { assess } = require('./trust');
const store = require('./store');
const platforms = require('./platforms');
const radar = require('./radar');

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
  await assert.rejects(require('./analyse').analyse({ imageUrls: ['http://img/x.png'] }), /ANTHROPIC_API_KEY/);
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

  // 6b. cache : 2 appels identiques = 1 recherche réelle
  process.env.SEARCH_CACHE_TTL_S = '60';
  let calls = 0;
  platforms.platforms.fake.search = async () => { calls++; return market_ads; };
  await Promise.all([marketReport({ query: 'cache test', platformIds: ['fake'] }), marketReport({ query: 'Cache Test', platformIds: ['fake'] })]);
  await marketReport({ query: 'cache test', platformIds: ['fake'] });
  assert.strictEqual(calls, 1);
  process.env.SEARCH_CACHE_TTL_S = '0';
  console.log('ok cache');

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

  const cmds = require('./commands');
  assert.strictEqual(cmds.definitions.length, 3);
  console.log('ok commandes:', cmds.definitions.map(c => c.name).join(', '));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
