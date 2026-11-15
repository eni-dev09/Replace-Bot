// Score de fiabilité d'une annonce (heuristique, sans réseau).
// Retourne un risque 0-100 + la liste des raisons. Ce n'est PAS une garantie.
const { norm } = require('./deals');

const OFF_PLATFORM = [
  [/whatsapp|telegram|\bsignal\b|snap(chat)?\b/, 'te pousse à discuter hors de la plateforme (WhatsApp, Telegram, Snap…)'],
  [/@\w+\.\w{2,}|\bgmail\b|hotmail|contact par mail|ecris.moi par mail/, 'demande un contact par e-mail'],
  [/hors (plateforme|leboncoin|vinted)/, 'propose de conclure hors plateforme'],
  [/western union|mandat cash|transcash|neosurf|paysafe|\bpcs\b/, 'moyen de paiement typique des arnaques'],
  [/paypal.{0,20}(amis|famille|friends)|virement (direct|bancaire|instantane)/, 'paiement par virement / PayPal « amis » (aucune protection)'],
  [/lien de paiement|paiement (securise )?par lien|payer via (ce )?lien/, 'lien de paiement externe'],
];
const PRESSURE = /urgent|derniere chance|premier (arrive|qui)|a l.etranger|en deplacement|ne peux pas me deplacer|envoi uniquement|colis uniquement|pas de remise en main propre|transporteur (viendra|passera)/;

const VERDICTS = [
  { max: 25, emoji: '✅', label: 'Plutôt fiable', color: 0x2ecc71 },
  { max: 50, emoji: '⚠️', label: 'À vérifier', color: 0xf1c40f },
  { max: 75, emoji: '🟠', label: 'Risque élevé', color: 0xe67e22 },
  { max: 101, emoji: '🚫', label: 'Très suspect', color: 0xe74c3c },
];
const verdictFor = risk => VERDICTS.find(v => risk < v.max);

/**
 * @param ad      { title, price, description, sellerRating (0-5|null), sellerReviews, sellerType, platform, redFlags[] }
 * @param market  { median, n, p25 }
 */
function assess(ad, market = {}) {
  let risk = 20; // base : une annonce inconnue n'est jamais « sûre à 100 % »
  const reasons = [];
  const add = (pts, type, text) => { risk += pts; reasons.push({ type, text }); };

  // --- Prix vs marché ---
  let priceRatio = null;
  if (ad.price > 0 && market.median > 0 && market.n >= 3) {
    priceRatio = ad.price / market.median;
    const pct = Math.round(Math.abs(1 - priceRatio) * 100);
    if (priceRatio < 0.35) add(40, 'bad', `Prix **${pct} % sous** la médiane : très suspect (arnaque, pièce détachée ou lot incomplet)`);
    else if (priceRatio < 0.5) add(28, 'bad', `Prix **${pct} % sous** la médiane : écart anormal, méfiance`);
    else if (priceRatio < 0.7) add(8, 'warn', `Prix ${pct} % sous la médiane : bonne affaire possible, vérifie l'état et la fonctionnalité`);
    else if (priceRatio <= 1.1) add(-8, 'good', 'Prix cohérent avec le marché');
    else add(0, 'info', `Prix ${pct} % **au-dessus** de la médiane : ce n'est pas une affaire`);
    if (market.n < 6) reasons.push({ type: 'info', text: `Seulement ${market.n} annonces comparables : prix du marché indicatif` });
  } else {
    reasons.push({ type: 'info', text: 'Pas assez d\'annonces comparables pour juger le prix' });
  }

  // --- Texte ---
  const text = norm(`${ad.title || ''} ${ad.description || ''}`);
  let off = 0;
  for (const [re, label] of OFF_PLATFORM) {
    if (re.test(text) && off < 2) { off++; add(25, 'bad', `L'annonce ${label}`); }
  }
  if (PRESSURE.test(text)) add(8, 'warn', 'Formulation de pression / envoi uniquement (fréquent dans les arnaques)');
  if (ad.description !== undefined && ad.description !== null && String(ad.description).trim().length < 25 && ad.description !== '') {
    add(4, 'warn', 'Description très courte');
  }

  // --- Vendeur ---
  const hasSellerInfo = ad.sellerRating !== undefined && ad.sellerRating !== null;
  if (hasSellerInfo) {
    const reviews = ad.sellerReviews || 0;
    if (!reviews) add(10, 'warn', 'Vendeur **sans aucun avis**');
    else if (ad.sellerRating > 0 && ad.sellerRating < 3.5 && reviews >= 3) add(25, 'bad', `Vendeur mal noté (${ad.sellerRating}/5, ${reviews} avis)`);
    else if (ad.sellerRating >= 4.5 && reviews >= 10) add(-15, 'good', `Vendeur bien noté (${ad.sellerRating}/5, ${reviews} avis)`);
    else if (reviews) add(-4, 'good', `Vendeur avec des avis (${ad.sellerRating}/5, ${reviews})`);
  } else {
    reasons.push({ type: 'info', text: 'Profil vendeur non vérifiable depuis cette source : regarde sa note et son ancienneté' });
  }
  if (ad.sellerType === 'pro') add(-5, 'good', 'Vendeur professionnel');

  // --- Signaux relevés sur la capture d'écran ---
  (ad.redFlags || []).slice(0, 2).forEach(f => add(15, 'bad', `Capture : ${f}`));

  risk = Math.max(0, Math.min(100, Math.round(risk)));
  const verdict = verdictFor(risk);
  const order = { bad: 0, warn: 1, good: 2, info: 3 };
  reasons.sort((a, b) => order[a.type] - order[b.type]);
  return { risk, ...verdict, priceRatio, reasons };
}

function tips(a) {
  const t = ['Privilégie la **remise en main propre** et teste l\'objet avant de payer.',
    'Paie **uniquement via le système de la plateforme** (jamais de virement, de PayPal « amis » ou de lien externe).'];
  if (a.risk >= 25) t.push('Demande des **photos supplémentaires** (numéro de série, objet à côté d\'un papier daté) et compare avec une recherche d\'image inversée.');
  if (a.risk >= 50) t.push('Si le vendeur insiste pour sortir de la plateforme ou presse : **abandonne**.');
  return t;
}

module.exports = { assess, tips, verdictFor };
