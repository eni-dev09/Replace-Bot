// Adaptateur Vinted (API web interne, non officielle).
// Vinted exige un cookie de session : on charge la page d'accueil, on récupère les
// cookies, puis on interroge /api/v2/catalog/items. Les cookies sont recyclés.
//
// Variables : VINTED_DOMAIN (défaut vinted.fr), VINTED_MIN_GAP_MS (défaut 4000)

const DOMAIN = process.env.VINTED_DOMAIN || 'vinted.fr';
const BASE = `https://www.${DOMAIN}`;
const MIN_GAP_MS = parseInt(process.env.VINTED_MIN_GAP_MS || '4000', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cookie = '';
let cookieAt = 0;
let lastReq = 0;
let chain = Promise.resolve();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// File d'attente globale : une requête à la fois, espacées (anti-blocage)
function enqueue(job) {
  const task = chain.then(async () => {
    const wait = lastReq + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    return job();
  });
  chain = task.catch(() => {});
  return task;
}

async function refreshCookie() {
  const res = await fetch(BASE + '/', { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' } });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  cookie = set.map(c => c.split(';')[0]).join('; ');
  cookieAt = Date.now();
  if (!cookie) throw new Error('Vinted: aucun cookie de session reçu (blocage probable)');
}

const CONDITIONS = [
  [/neuf avec/i, 'neuf'], [/neuf sans/i, 'neuf'], [/tr[èe]s bon/i, 'excellent'],
  [/satisf/i, 'satisfaisant'], [/bon/i, 'bon'],
];

function condition(status) {
  const s = String(status || '');
  for (const [re, v] of CONDITIONS) if (re.test(s)) return v;
  return 'bon';
}

function priceOf(it) {
  const p = it.price;
  if (p && typeof p === 'object') return parseFloat(p.amount);
  return parseFloat(p);
}

async function api(pathname, params = {}, attempt = 0) {
  if (!cookie || Date.now() - cookieAt > 20 * 60 * 1000) await refreshCookie();
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${pathname}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'fr-FR,fr;q=0.9', Cookie: cookie },
  });
  if ((res.status === 401 || res.status === 403) && attempt < 1) {
    cookie = '';
    await sleep(2000);
    return api(pathname, params, attempt + 1);
  }
  if (res.status === 429) throw new Error('Vinted: trop de requêtes (429), réessaie plus tard');
  if (!res.ok) throw new Error(`Vinted: HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  id: 'vinted',
  label: 'Vinted',
  emoji: '🟢',
  color: 0x09b1ba,

  parseUrl(url) {
    const m = /vinted\.[a-z.]+\/items\/(\d+)/.exec(url);
    return m ? m[1] : null;
  },

  async getAd(id) {
    const data = await enqueue(() => api(`/api/v2/items/${id}`));
    const it = data.item;
    if (!it) throw new Error('annonce Vinted introuvable (supprimée ou vendue ?)');
    const u = it.user || {};
    const reviews = u.feedback_count ?? ((u.positive_feedback_count || 0) + (u.neutral_feedback_count || 0) + (u.negative_feedback_count || 0));
    return {
      id: `vinted-${it.id}`, platform: 'vinted', title: it.title, price: priceOf(it), description: it.description || '',
      image: it.photos?.[0]?.url || it.photo?.url || null, url: it.url || `${BASE}/items/${it.id}`,
      location: u.city || u.country_title || '', condition: condition(it.status),
      sellerType: u.business ? 'pro' : 'private', sellerName: u.login || 'Vendeur Vinted',
      sellerRating: typeof u.feedback_reputation === 'number' ? Math.round(u.feedback_reputation * 50) / 10 : null,
      sellerReviews: reviews || 0, delivery: true, brand: it.brand_title || '', size: it.size_title || '',
      redFlags: [],
    };
  },

  async search({ query, maxPrice, limit = 30 }) {
    const params = { search_text: query, order: 'newest_first', per_page: String(Math.min(limit, 96)), page: '1' };
    if (maxPrice) params.price_to = String(maxPrice);
    const data = await enqueue(() => api('/api/v2/catalog/items', params));
    return (data.items || []).map(it => ({
      id: `vinted-${it.id}`,
      platform: 'vinted',
      title: it.title,
      price: priceOf(it),
      image: it.photo?.url || null,
      url: it.url || `${BASE}/items/${it.id}`,
      location: it.user?.city || '',
      condition: condition(it.status),
      sellerType: it.user?.business ? 'pro' : 'private',
      sellerName: it.user?.login || 'Vendeur Vinted',
      delivery: true,
      brand: it.brand_title || '',
      size: it.size_title || '',
      risky: false,
    }));
  },
};
