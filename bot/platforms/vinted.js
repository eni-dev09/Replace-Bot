// Adaptateur Vinted (API web interne, non officielle).
// Le catalogue est servi par api.vinted.<pays>/svc-catalogue/items.
// La session anonyme est initialisée sur www.vinted.<pays> et utilise
// access_token_web + anon_id (aucune connexion à un compte Vinted n'est codée ici).
//
// Variables : VINTED_DOMAIN (défaut vinted.fr), VINTED_MIN_GAP_MS (défaut 4000),
// VINTED_RETRY_DELAY_MS (défaut 1000)

const DOMAIN = (process.env.VINTED_DOMAIN || 'vinted.fr').replace(/^www\./i, '');
const WEB = `https://www.${DOMAIN}`;
const API = `https://api.${DOMAIN}`;
const MIN_GAP_MS = Math.max(0, Number.parseInt(process.env.VINTED_MIN_GAP_MS || '4000', 10) || 0);
const RETRY_DELAY_MS = Math.max(0, Number.parseInt(process.env.VINTED_RETRY_DELAY_MS || '1000', 10) || 0);
const SESSION_TTL_MS = 20 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LANGUAGE = 'fr-FR,fr;q=0.9';

let cookies = new Map();
let anonId = '';
let cookieAt = 0;
let lastReq = 0;
let chain = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Une seule requête Vinted à la fois, avec un délai global entre les appels.
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

function getSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers?.get?.('set-cookie');
  if (!combined) return [];
  // Headers.getSetCookie() n'est pas disponible dans toutes les versions de Node 18.
  // Cette séparation ne coupe pas la virgule dans Expires=Wed, ... (pas de nom=valeur après).
  return combined.split(/,(?=\s*[^;,=\s]+=)/);
}

function storeSetCookies(headers) {
  for (const raw of getSetCookies(headers)) {
    const pair = String(raw).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  const headerAnonId = headers?.get?.('x-anon-id');
  if (headerAnonId) anonId = headerAnonId;
  if (!anonId) anonId = cookies.get('anon_id') || '';
}

function decodeCookie(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function sessionHeaders() {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Accept-Language': LANGUAGE,
    Referer: `${WEB}/`,
    Origin: WEB,
  };
  const token = cookies.get('access_token_web');
  if (token) headers.Authorization = `Bearer ${decodeCookie(token)}`;
  if (anonId) headers['x-anon-id'] = decodeCookie(anonId);
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function refreshSession() {
  cookies = new Map();
  anonId = '';

  const headers = { 'User-Agent': UA, 'Accept-Language': LANGUAGE };
  let res = await fetch(`${WEB}/`, { method: 'HEAD', headers });
  storeSetCookies(res.headers);

  // Some Vinted deployments do not issue the web token for HEAD requests.
  // A normal homepage GET is a compatibility fallback, not an authentication bypass.
  if (!cookies.has('access_token_web')) {
    res = await fetch(`${WEB}/`, {
      headers: { ...headers, Accept: 'text/html,application/xhtml+xml' },
    });
    storeSetCookies(res.headers);
  }

  cookieAt = Date.now();
  if (!cookies.has('access_token_web')) {
    throw new Error('Vinted: aucun cookie access_token_web reçu depuis le site (session anonyme indisponible)');
  }
}

const CONDITIONS = [
  [/neuf avec/i, 'neuf'], [/neuf sans/i, 'neuf'], [/tr[èe]s bon/i, 'excellent'],
  [/satisf/i, 'satisfaisant'], [/bon/i, 'bon'],
];

function condition(status) {
  const value = typeof status === 'object' && status !== null
    ? (status.title || status.name || '') : String(status || '');
  for (const [pattern, result] of CONDITIONS) if (pattern.test(value)) return result;
  return 'bon';
}

function priceOf(item) {
  const price = item?.price;
  const value = price && typeof price === 'object' ? price.amount : price;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function api(pathname, params = {}, attempt = 0, origin = API) {
  if (!cookies.has('access_token_web') || Date.now() - cookieAt > SESSION_TTL_MS) {
    await refreshSession();
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      search.set(key, String(value));
    }
  }
  const url = `${origin}${pathname}${search.size ? `?${search}` : ''}`;
  const res = await fetch(url, { headers: sessionHeaders() });

  if ((res.status === 401 || res.status === 403) && attempt < 2) {
    // Seuls 401/403 déclenchent un renouvellement de session. Un 404 est une
    // vraie erreur de route et ne doit pas être masqué par un retry d'auth.
    cookieAt = 0;
    if (RETRY_DELAY_MS) await sleep(RETRY_DELAY_MS);
    return api(pathname, params, attempt + 1, origin);
  }
  if (res.status === 429) throw new Error('Vinted: trop de requêtes (429), réessaie plus tard');
  if (!res.ok) throw new Error(`Vinted: HTTP ${res.status}${res.status === 404 ? ' (route introuvable)' : ''}`);

  storeSetCookies(res.headers);
  return res.json();
}

function normalizedItem(item) {
  const user = item.user || {};
  return {
    id: `vinted-${item.id}`,
    platform: 'vinted',
    title: item.title || 'Annonce Vinted',
    price: priceOf(item),
    image: item.photo?.url || item.photos?.[0]?.url || null,
    url: item.url ? new URL(item.url, `${WEB}/`).href : `${WEB}/items/${item.id}`,
    location: user.city || user.country_title || '',
    condition: condition(item.status || item.item_box?.second_line),
    sellerType: user.business ? 'pro' : 'private',
    sellerName: user.login || 'Vendeur Vinted',
    delivery: true,
    brand: item.brand_title || item.item_box?.first_line || '',
    size: item.size_title || '',
    risky: false,
  };
}

module.exports = {
  id: 'vinted',
  label: 'Vinted',
  emoji: '🟢',
  color: 0x09b1ba,

  // Réinitialise la session anonyme (utilisé par les tests pour isoler les scénarios).
  _resetSession() { cookies = new Map(); anonId = ''; cookieAt = 0; },

  parseUrl(url) {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)vinted\.[a-z.]+$/i.test(parsed.hostname)) return null;
      return (/^\/items\/(\d+)/.exec(parsed.pathname) || [])[1] || null;
    } catch {
      return null;
    }
  },

  async getAd(id) {
    // La route de détail historique reste distincte de la nouvelle route catalogue.
    // Ne pas appeler /svc-catalogue/items/:id : cette route n'est pas documentée.
    const data = await enqueue(() => api(`/api/v2/items/${encodeURIComponent(id)}`, {}, 0, WEB));
    const item = data.item;
    if (!item) throw new Error('annonce Vinted introuvable (supprimée ou vendue ?)');
    const user = item.user || {};
    const reviews = user.feedback_count ?? ((user.positive_feedback_count || 0) + (user.neutral_feedback_count || 0) + (user.negative_feedback_count || 0));
    return {
      id: `vinted-${item.id}`,
      platform: 'vinted',
      title: item.title,
      price: priceOf(item),
      description: item.description || '',
      image: item.photos?.[0]?.url || item.photo?.url || null,
      url: item.url ? new URL(item.url, `${WEB}/`).href : `${WEB}/items/${item.id}`,
      location: user.city || user.country_title || '',
      condition: condition(item.status),
      sellerType: user.business ? 'pro' : 'private',
      sellerName: user.login || 'Vendeur Vinted',
      sellerRating: typeof user.feedback_reputation === 'number' ? Math.round(user.feedback_reputation * 50) / 10 : null,
      sellerReviews: reviews || 0,
      delivery: true,
      brand: item.brand_title || '',
      size: item.size_title || '',
      redFlags: [],
    };
  },

  async search({ query, maxPrice, limit = 30 }) {
    const params = {
      search_text: String(query || '').trim(),
      order: 'newest_first',
      per_page: String(Math.max(1, Math.min(Number(limit) || 30, 96))),
      page: '1',
    };
    if (Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0) params.price_to = String(maxPrice);
    const data = await enqueue(() => api('/svc-catalogue/items', params));
    return (Array.isArray(data.items) ? data.items : []).map(normalizedItem);
  },
};
