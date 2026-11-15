// Rapport de marché : interroge les plateformes, calcule la médiane et les meilleures offres.
const platforms = require('./platforms');
const { findDeals, stats } = require('./deals');
const { assess } = require('./trust');
const { cached } = require('./cache');

const MARKET_LIMIT = 40;

/**
 * @returns {{ query, perPlatform:[{pid,label,emoji,stats,deals,sample}], overall, best:Array, errors:[] }}
 * Les stats sont calculées SANS plafond de prix (sinon la médiane est biaisée vers le bas) ;
 * maxPrice ne sert qu'à filtrer les offres affichées.
 */
async function marketReport({ query, maxPrice = 0, platformIds = platforms.ids, minDiscount = 0.15, minMatch = 1, exclude = [], excludeId, limit = MARKET_LIMIT }) {
  const perPlatform = [];
  const errors = [];
  for (const pid of platformIds) {
    const p = platforms.get(pid);
    if (!p || p.available === false) continue;
    try {
      const ads = await cached(`${pid}|${query.toLowerCase()}|${limit}`, () => p.search({ query, limit }));
      const r = findDeals(ads, { maxPrice, minDiscount, query, minMatch, exclude, excludeId });
      perPlatform.push({ pid, label: p.label, emoji: p.emoji, color: p.color, stats: r.stats, deals: r.deals, sample: r.sample });
    } catch (e) {
      errors.push(`${p.label} : ${e.message}`);
    }
  }

  const overall = stats(perPlatform.flatMap(p => p.sample.map(a => a.price)));

  // Meilleures offres toutes plateformes : remise vs médiane de SA plateforme, budget respecté
  const cand = [];
  for (const pp of perPlatform) {
    if (pp.stats.n < 3) continue;
    for (const a of pp.sample) {
      if (maxPrice && a.price > maxPrice) continue;
      const ratio = Math.round(((pp.stats.median - a.price) / pp.stats.median) * 100);
      const suspicious = a.price < pp.stats.median * 0.35;
      const risk = assess(a, pp.stats);
      cand.push({ ...a, median: pp.stats.median, ratio, suspicious, risk, savings: Math.round((pp.stats.median - a.price) * 100) / 100 });
    }
  }
  // meilleure remise d'abord ; suspects et annonces à risque élevé relégués
  const rank = c => c.ratio - (c.suspicious ? 100 : 0) - (c.risk.risk >= 50 ? 40 : 0);
  cand.sort((a, b) => rank(b) - rank(a));

  return { query, maxPrice, perPlatform, overall, best: cand.slice(0, 5), errors };
}

module.exports = { marketReport };
