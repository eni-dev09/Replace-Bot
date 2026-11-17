// Source « bons plans » Dealabs — flux RSS public (https://www.dealabs.com/rss/tous : les 30 derniers deals).
// Ce n'est PAS une place de marché d'occasion : pas de médiane de prix, on filtre les promos par mot-clé et prix max.
// Le flux ne couvre qu'environ 20 minutes d'activité : le radar scanne en continu (DEAL_RADAR_INTERVAL_S, défaut 60 s).
//
// Variables : DEALABS_FEED_URL (défaut https://www.dealabs.com/rss/tous), DEALABS_CACHE_S (défaut 45)

const { XMLParser } = require('fast-xml-parser');
const { squash, tokens } = require('../deals');

const env = (k, d = '') => (process.env[k] || d).trim();
const cacheMs = () => { const n = Number.parseInt(process.env.DEALABS_CACHE_S ?? '', 10); return (Number.isFinite(n) && n >= 0 ? n : 45) * 1000; };
const DEALABS_HOST = /(^|\.)dealabs\.com$/i;
const UA = 'Mozilla/5.0 (compatible; ReplaceBot/2.0; +https://github.com/eni-dev09/Replace-Bot)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,       // garde les valeurs en texte (ids, prix)
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, path) => path === 'rss.channel.item',
});

const text = v => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

function stripHtml(h) {
  return text(h)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/** "11,99€" -> 11.99 ; "1 299,99 €" -> 1299.99 ; "1.299€" -> 1299 ; devises étrangères ($, £) -> null. */
function parsePrice(raw) {
  const s = String(raw ?? '').replace(/[\s  ]/g, '');
  if (!s || (/[$£]/.test(s) && !/€|eur/i.test(s))) return null;
  const m = /(\d[\d.,]*)/.exec(s);
  if (!m) return null;
  let n = m[1].replace(/[.,]+$/, '');
  if (n.includes(',') && n.includes('.')) n = n.replace(/\./g, '').replace(',', '.');
  else if (n.includes(',')) n = n.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, '');   // "1.299" = 1299
  const v = parseFloat(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
}

function originalPriceOf(s) {
  const m = /au lieu de\s*(\d[\d\s .,]*)\s*(?:€|euros?)/i.exec(s);
  return m ? parsePrice(m[1] + '€') : null;
}

function imageOf(it) {
  for (const k of ['media:content', 'media:thumbnail']) {
    const v = Array.isArray(it[k]) ? it[k][0] : it[k];
    const u = v?.['@_url'];
    if (typeof u === 'string' && /^https:\/\//i.test(u)) return u;
  }
  return null;
}

function normalize(it) {
  const link = text(it.link) || text(it.guid);
  let url;
  try {
    const x = new URL(link);
    if (x.protocol !== 'https:' || !DEALABS_HOST.test(x.hostname)) return null; // lien hors Dealabs : ignoré
    url = x.toString();
  } catch { return null; }
  const idm = /-(\d+)\/?(?:[?#]|$)/.exec(url) || /\/(\d+)\/?(?:[?#]|$)/.exec(url);
  if (!idm) return null;

  const title = stripHtml(it.title).slice(0, 200);
  if (!title) return null;
  const merchant = it['pepper:merchant'] || {};
  const excerpt = stripHtml(it.description);
  let price = parsePrice(merchant['@_price']);
  if (price == null && /\bgratuit/i.test(title)) price = 0;
  const original = originalPriceOf(`${title} ${excerpt}`);
  const cat = Array.isArray(it.category) ? text(it.category[0]) : text(it.category);
  const d = new Date(text(it.pubDate));

  return {
    id: `dealabs-${idm[1]}`,
    platform: 'dealabs',
    kind: 'promo',
    title,
    price,
    originalPrice: original && price != null && original > price ? original : null,
    merchant: merchant['@_name'] ? String(merchant['@_name']).slice(0, 80) : '',
    category: cat.slice(0, 80),
    image: imageOf(it),
    url,
    publishedAt: Number.isNaN(d.getTime()) ? null : d.toISOString(),
    excerpt: excerpt.slice(0, 400),
    condition: '', location: '', sellerType: 'pro', sellerName: merchant['@_name'] || 'Dealabs', risky: false,
  };
}

function parseFeed(xml) {
  let doc;
  try { doc = parser.parse(String(xml)); } catch (e) { throw new Error(`Dealabs: flux illisible (${e.message.slice(0, 60)})`); }
  const items = doc?.rss?.channel?.item;
  if (!Array.isArray(items)) throw new Error('Dealabs: flux RSS inattendu (aucun deal trouvé)');
  return items.map(normalize).filter(Boolean);
}

// --- Récupération avec cache et requête unique (plusieurs alertes = un seul appel) -------------
let cache = { at: 0, items: null };
let inflight = null;

async function fetchFeed() {
  const url = env('DEALABS_FEED_URL', 'https://www.dealabs.com/rss/tous');
  let u;
  try { u = new URL(url); } catch { throw new Error('Dealabs: DEALABS_FEED_URL invalide'); }
  if (u.protocol !== 'https:' || !DEALABS_HOST.test(u.hostname)) throw new Error('Dealabs: DEALABS_FEED_URL doit être une URL https://…dealabs.com');
  const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 403 || res.status === 429) throw new Error(`Dealabs: accès limité (HTTP ${res.status}), réessaie plus tard`);
  if (!res.ok) throw new Error(`Dealabs: HTTP ${res.status}`);
  return parseFeed(await res.text());
}

async function getItems() {
  if (cache.items && Date.now() - cache.at < cacheMs()) return cache.items;
  if (!inflight) {
    inflight = fetchFeed().then(items => { cache = { at: Date.now(), items }; return items; }).finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = {
  id: 'dealabs',
  label: 'Dealabs',
  emoji: '🏷️',
  color: 0x2f9e44,
  kind: 'promo',          // promos : pas de médiane de marché
  available: true,

  async search({ query, limit = 30 }) {
    const toks = tokens(query);
    if (!toks.length) return [];
    const items = await getItems();
    const matches = items.filter(a => {
      const hay = squash(`${a.title} ${a.category} ${a.excerpt}`);
      return toks.every(t => hay.includes(t));
    });
    matches.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return matches.slice(0, Math.max(1, limit));
  },

  _parseFeed: parseFeed,
  _parsePrice: parsePrice,
  _resetCache() { cache = { at: 0, items: null }; inflight = null; },
};
