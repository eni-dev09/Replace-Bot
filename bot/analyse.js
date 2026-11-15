// Analyse de fiabilité d'une annonce : à partir d'un lien OU d'une capture d'écran.
const platforms = require('./platforms');
const ai = require('./ai');
const { marketReport } = require('./market');
const { assess, tips } = require('./trust');
const { tokens } = require('./deals');

const FLUFF = new Set(('vends vend vendu vente a de du des le la les un une et en tres bon bonne etat parfait parfaitement neuf neuve comme ' +
  'quasi jamais utilise utilisee urgent pas cher prix sous garantie facture boite complet complete avec sans etat ' +
  'occasion tbe tb excellent excellente').split(' '));

function deriveQuery(title) {
  const toks = tokens(title).filter(t => !FLUFF.has(t));
  return toks.slice(0, 4).join(' ') || String(title).slice(0, 40);
}

/** @param input { url?, imageUrls?, text? } */
async function analyse({ url, imageUrls = [], text = '' }) {
  let ad;
  if (url) {
    const hit = platforms.fromUrl(url);
    if (!hit) throw new Error('Lien non reconnu : je gère les liens Leboncoin et Vinted. Sinon envoie une **capture d\'écran**.');
    if (!hit.available) throw new Error(`${hit.platform.label} n'est pas activé sur cet hébergement : envoie plutôt une **capture d'écran** de l'annonce.`);
    ad = await hit.platform.getAd(hit.id);
  } else if (imageUrls.length) {
    if (!ai.enabled()) throw new Error('L\'analyse de capture d\'écran nécessite une clé IA (`OPENAI_API_KEY`, ou `ANTHROPIC_API_KEY`) dans le .env (voir README). En attendant, envoie le **lien** de l\'annonce.');
    ad = await ai.readScreenshot(imageUrls, text);
  } else {
    throw new Error('Envoie un lien d\'annonce ou une capture d\'écran.');
  }

  const query = ad.searchQuery || (await ai.suggestQuery(ad.title, ad.description)) || deriveQuery(ad.title);
  // titre dérivé = moins fiable que la saisie de l'utilisateur : on tolère 60 % de mots communs
  const report = await marketReport({ query, minMatch: 0.6, excludeId: ad.id, minDiscount: 0.15 });

  // On compare d'abord à la plateforme de l'annonce si l'échantillon est assez gros
  const own = report.perPlatform.find(p => p.pid === String(ad.platform).toLowerCase() && p.stats.n >= 5);
  const market = own ? { ...own.stats, scope: own.label } : { ...report.overall, scope: 'toutes plateformes' };

  const assessment = assess(ad, market);
  return { ad, query, market, report, assessment, tips: tips(assessment) };
}

module.exports = { analyse, deriveQuery };
