// Logique pure de détection de bonnes affaires (testable sans réseau).

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const squash = s => norm(s).replace(/[^a-z0-9]+/g, '');
const tokens = q => norm(q).split(/[^a-z0-9]+/).filter(Boolean);
const round2 = n => Math.round(n * 100) / 100;

// Annonces qui faussent le prix du marché (pièces, accessoires, recherches...).
// Ignorées sauf si le mot figure dans la recherche de l'utilisateur.
const JUNK = [
  /pour pieces|pour bricol/, /\bhs\b/, /en panne/, /\bcasse\b/, /defectueu/, /a reparer/,
  /ne fonctionne|non fonctionnel|ne marche/, /boite (vide|seule)/, /\bcoques?\b/, /\bhousses?\b/,
  /\bsupports?\b/, /\bcables?\b/, /\bchargeurs?\b/, /\brecherche\b|\bcherche\b/, /echange|\becha\b/,
  /\blot de\b/, /\bfaux\b|\breplique\b|\bcopie\b/, /\bsticker|\bautocollant/,
];

function isJunk(ad, queryNorm) {
  if (ad.junk) return true; // marqué par la plateforme (ex. eBay « pour pièces »)
  const t = norm(ad.title);
  return JUNK.some(re => re.test(t) && !re.test(queryNorm));
}

/** Garde les annonces dont le titre contient les mots de la recherche ("3070ti" == "3070 Ti"). */
function relevantAds(ads, query, minMatch = 1) {
  const toks = tokens(query);
  if (!toks.length) return ads;
  return ads.filter(a => {
    const t = squash(a.title);
    const hit = toks.filter(k => t.includes(k)).length;
    return hit / toks.length >= minMatch;
  });
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const b = Math.floor(pos);
  return sorted[b + 1] !== undefined ? sorted[b] + (pos - b) * (sorted[b + 1] - sorted[b]) : sorted[b];
}

/** Stats de prix robustes : écarte les valeurs aberrantes (< 20 % ou > 300 % de la médiane brute). */
function stats(prices) {
  const s = prices.filter(p => p > 0).sort((a, b) => a - b);
  if (!s.length) return { n: 0, median: 0, p25: 0, min: 0, max: 0 };
  const raw = quantile(s, 0.5);
  const kept = s.filter(p => p >= raw * 0.2 && p <= raw * 3);
  const k = kept.length ? kept : s;
  return { n: k.length, median: round2(quantile(k, 0.5)), p25: round2(quantile(k, 0.25)), min: k[0], max: k[k.length - 1] };
}

// Compat : ancienne API
const median = prices => stats(prices).median;

/**
 * @param ads  annonces normalisées d'UNE plateforme
 * @param opts { maxPrice, minDiscount, query, minMatch, exclude[], excludeId }
 * @returns { median, stats, sample, deals }  deals triés par remise décroissante
 */
function findDeals(ads, { maxPrice = 0, minDiscount = 0.2, query = '', minMatch = 1, exclude = [], excludeId } = {}) {
  const qn = norm(query);
  const ex = exclude.map(norm).filter(Boolean);
  const sample = relevantAds(ads, query, minMatch).filter(a =>
    a.price > 0 && a.id !== excludeId && !isJunk(a, qn) && !ex.some(w => norm(a.title).includes(w)));

  const st = stats(sample.map(a => a.price));
  if (st.n < 3 || st.median <= 0) return { median: st.median, stats: st, sample, deals: [] };

  const threshold = st.median * (1 - minDiscount);
  const deals = [];
  for (const ad of sample) {
    if (ad.risky || (maxPrice && ad.price > maxPrice) || ad.price > threshold) continue;
    deals.push({
      ...ad,
      median: st.median,
      savings: round2(st.median - ad.price),
      ratio: Math.round(((st.median - ad.price) / st.median) * 100),
      // < 25 % de la médiane : souvent un lot incomplet, une pièce ou une arnaque
      suspicious: ad.price < st.median * 0.25,
    });
  }
  // les prix suspects passent après les vraies affaires
  deals.sort((a, b) => (b.ratio - (b.suspicious ? 100 : 0)) - (a.ratio - (a.suspicious ? 100 : 0)));
  return { median: st.median, stats: st, sample, deals };
}

/** Promos (Dealabs) : filtre mots exclus et budget (un prix inconnu est écarté si un budget est fixé). */
function filterPromos(ads, { maxPrice = 0, exclude = [] } = {}) {
  const ex = exclude.map(norm).filter(Boolean);
  return ads.filter(a => {
    if (ex.some(w => norm(a.title).includes(w))) return false;
    if (maxPrice > 0 && !(a.price != null && a.price <= maxPrice)) return false;
    return true;
  });
}

module.exports = { filterPromos, norm, squash, tokens, isJunk, relevantAds, stats, median, findDeals };
