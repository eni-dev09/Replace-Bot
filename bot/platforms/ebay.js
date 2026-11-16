// Adaptateur eBay — API officielle Browse (https://developer.ebay.com/api-docs/buy/browse).
// Auth : OAuth2 « client credentials » (clés de production EBAY_CLIENT_ID = App ID, EBAY_CLIENT_SECRET = Cert ID).
// Sans ces deux variables, la plateforme est désactivée automatiquement.
//
// Variables : EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_MARKETPLACE (défaut EBAY_FR), EBAY_CURRENCY (défaut EUR),
// EBAY_DOMAIN (défaut ebay.fr, pour les liens de secours), EBAY_MIN_GAP_MS (défaut 500), EBAY_API_BASE.

const env = (k, d = '') => (process.env[k] || d).trim();
const num = (k, d) => { const n = Number.parseInt(process.env[k] ?? '', 10); return Number.isFinite(n) && n >= 0 ? n : d; };

const apiBase = () => env('EBAY_API_BASE', 'https://api.ebay.com').replace(/\/+$/, '');
const marketplace = () => env('EBAY_MARKETPLACE', 'EBAY_FR');
const currency = () => env('EBAY_CURRENCY', 'EUR').toUpperCase();
const domain = () => env('EBAY_DOMAIN', 'ebay.fr').replace(/^www\./i, '');
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

let token = '';
let tokenExp = 0;
let tokenPromise = null;
let lastReq = 0;
let chain = Promise.resolve();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Une requête à la fois, espacées (quota d'appels quotidien limité côté eBay).
function enqueue(job) {
  const task = chain.then(async () => {
    const wait = lastReq + num('EBAY_MIN_GAP_MS', 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    return job();
  });
  chain = task.catch(() => {});
  return task;
}

function fail(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function readError(res) {
  let body = {};
  try { body = await res.json(); } catch { /* corps non JSON */ }
  const e = body.errors?.[0] || {};
  return { status: res.status, errorId: e.errorId, detail: e.message || body.error_description || '' };
}

// --- OAuth : jeton d'application, mis en cache jusqu'à expiration -----------------------------
async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp) return token;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const id = env('EBAY_CLIENT_ID');
    const secret = env('EBAY_CLIENT_SECRET');
    if (!id || !secret) throw fail('eBay: EBAY_CLIENT_ID et EBAY_CLIENT_SECRET requis');
    const res = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const err = await readError(res);
      if (res.status === 400 || res.status === 401) {
        throw fail('eBay: identifiants invalides (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET : utilise le jeu de clés de PRODUCTION)');
      }
      throw fail(`eBay: authentification impossible (HTTP ${res.status}${err.detail ? ' ' + err.detail.slice(0, 80) : ''})`);
    }
    const data = await res.json();
    if (!data.access_token) throw fail('eBay: réponse d\'authentification sans jeton');
    const ttl = Math.max(60, (Number(data.expires_in) || 7200) - 120);
    token = data.access_token;
    tokenExp = Date.now() + ttl * 1000;
    return token;
  })().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function api(pathname, params = {}, attempt = 0) {
  const t = await getToken(attempt > 0);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${apiBase()}${pathname}${qs ? '?' + qs : ''}`, {
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplace(),
      ...(env('EBAY_ACCEPT_LANGUAGE') ? { 'Accept-Language': env('EBAY_ACCEPT_LANGUAGE') } : {}), // utile seulement pour certains marchés (ex. fr-BE)
    },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && attempt < 1) { token = ''; return api(pathname, params, attempt + 1); }
  if (res.status === 429) throw fail('eBay: limite d\'appels atteinte (429), réessaie plus tard', { status: 429 });
  if (res.status === 403) throw fail('eBay: accès refusé (403) : vérifie tes clés de production et leur activation', { status: 403 });
  if (!res.ok) {
    const err = await readError(res);
    throw fail(`eBay: HTTP ${res.status}${err.detail ? ' — ' + err.detail.slice(0, 100) : ''}`, err);
  }
  return res.json();
}

// --- Normalisation -------------------------------------------------------------------------------
const legacyId = itemId => { const p = String(itemId || '').split('|'); return p.length > 1 ? p[1] : p[0]; };

const CONDITIONS = {
  1000: 'neuf', 1500: 'neuf', 1750: 'neuf',
  2000: 'excellent', 2010: 'excellent', 2020: 'excellent', 2030: 'excellent', 2500: 'excellent', 2750: 'excellent',
  3000: 'bon', 4000: 'bon', 5000: 'satisfaisant', 6000: 'satisfaisant',
};
function conditionOf(it) {
  const byId = CONDITIONS[Number(it.conditionId)];
  if (byId) return byId;
  const t = String(it.condition || '').toLowerCase();
  if (/reconditionn|refurb|certifi/.test(t)) return 'excellent';
  if (/neuf|new/.test(t)) return 'neuf';
  if (/pi[eè]ces|parts|not working/.test(t)) return 'pour pièces';
  return t ? 'bon' : '';
}

const EBAY_HOST = /(^|\.)ebay\.(com|fr|de|it|es|nl|be|at|ch|ie|pl|ca|co\.uk|com\.au)$/i;

function safeUrl(u, id) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' && EBAY_HOST.test(x.hostname)) return x.toString();
  } catch { /* URL absente ou invalide */ }
  return `https://www.${domain()}/itm/${id}`;
}

function stripHtml(h) {
  return String(h || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim().slice(0, 1500);
}

function shippingOf(it) {
  for (const o of it.shippingOptions || []) {
    const c = o.shippingCost;
    if (o.shippingCostType === 'FIXED' && c && (!c.currency || c.currency === currency())) {
      const v = parseFloat(c.value);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  }
  return null; // inconnu ou calculé selon l'adresse
}

/** @returns annonce normalisée, ou null si inutilisable (devise étrangère, enchère...). */
function normalize(it, { keepAuctions = false } = {}) {
  const base = parseFloat(it.price?.value);
  if (!(base > 0)) return null;
  if (it.price?.currency && it.price.currency !== currency()) return null; // pas de conversion : on évite de fausser la médiane
  const opts = Array.isArray(it.buyingOptions) ? it.buyingOptions : null;
  const auction = !!opts && !opts.includes('FIXED_PRICE') && !opts.includes('BEST_OFFER');
  if (auction && !keepAuctions) return null; // le prix d'une enchère en cours n'est pas un prix de vente

  const id = legacyId(it.itemId);
  if (!id) return null;
  const ship = shippingOf(it);
  const s = it.seller || {};
  const pct = parseFloat(s.feedbackPercentage);
  const score = Number.isInteger(s.feedbackScore) ? s.feedbackScore : null;
  const cond = conditionOf(it);
  const loc = [it.itemLocation?.city, it.itemLocation?.country].filter(Boolean).join(', ');

  return {
    id: `ebay-${id}`,
    platform: 'ebay',
    title: String(it.title || '').slice(0, 200),
    price: Math.round((base + (ship || 0)) * 100) / 100, // frais de port fixes inclus quand connus
    itemPrice: base,
    shippingCost: ship,
    image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
    url: safeUrl(it.itemWebUrl, id),
    location: loc,
    condition: auction ? `${cond ? cond + ' · ' : ''}enchère en cours` : cond,
    sellerType: s.sellerAccountType === 'BUSINESS' ? 'pro' : 'private',
    sellerName: s.username || 'Vendeur eBay',
    sellerRating: Number.isFinite(pct) ? Math.round((pct / 20) * 10) / 10 : (score === 0 ? 0 : null), // % positifs -> /5
    sellerReviews: score,
    delivery: true,
    auction,
    junk: Number(it.conditionId) === 7000 || cond === 'pour pièces', // « pour pièces » : exclu du calcul
    risky: false,
  };
}

const cleanQuery = q => String(q || '').replace(/[()*",]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

module.exports = {
  id: 'ebay',
  label: 'eBay',
  emoji: '🔷',
  color: 0x0064d2,
  unavailableReason: 'EBAY_CLIENT_ID et EBAY_CLIENT_SECRET absents',
  get available() { return !!(env('EBAY_CLIENT_ID') && env('EBAY_CLIENT_SECRET')); },

  parseUrl(url) {
    const m = /^https?:\/\/(?:[a-z0-9-]+\.)*ebay\.(?:com|fr|de|it|es|nl|be|at|ch|ie|pl|ca|co\.uk|com\.au)\/itm\/(?:[^/?#\s]+\/)?(\d{9,14})(?!\d)/i.exec(String(url).trim());
    return m ? m[1] : null;
  },

  async getAd(id) {
    let it;
    try {
      it = await enqueue(() => api('/buy/browse/v1/item/get_item_by_legacy_id', { legacy_item_id: String(id) }));
    } catch (e) {
      if (e.status === 404) throw fail('annonce eBay introuvable (terminée ou supprimée ?)');
      if (e.errorId === 11006 || /variation|item_group/i.test(e.message || '')) {
        throw fail('cette annonce eBay a des variantes (taille, couleur…) que je ne sais pas lire : envoie plutôt une **capture d\'écran**');
      }
      throw e;
    }
    const ad = normalize(it, { keepAuctions: true });
    if (!ad) throw fail(`annonce eBay inexploitable (prix absent ou en devise autre que ${currency()})`);
    ad.description = stripHtml(it.description || it.shortDescription);
    ad.redFlags = [];
    return ad;
  },

  async search({ query, limit = 40 }) {
    const q = cleanQuery(query);
    if (!q) return [];
    const data = await enqueue(() => api('/buy/browse/v1/item_summary/search', {
      q,
      limit: String(Math.min(Math.max(limit, 1), 200)),
    }));
    // Pas de plafond de prix côté API : il fausserait la médiane (appliqué ensuite sur les offres).
    return (data.itemSummaries || []).map(it => normalize(it)).filter(Boolean);
  },

  _resetSession() { token = ''; tokenExp = 0; tokenPromise = null; lastReq = 0; chain = Promise.resolve(); },
  _normalize: normalize,
};
