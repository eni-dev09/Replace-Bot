// Registre des plateformes. Pour en ajouter une (Back Market...) :
// créer bot/platforms/<nom>.js exportant { id, label, emoji, color, available, unavailableReason, search({query,maxPrice,limit}), parseUrl, getAd }
// qui renvoie des annonces normalisées, puis l'ajouter ci-dessous.
const all = {
  leboncoin: require('./leboncoin'),
  vinted: require('./vinted'),
  ebay: require('./ebay'),
  dealabs: require('./dealabs'),
};

const platforms = {};
for (const [id, p] of Object.entries(all)) {
  if (p.available === false) console.warn(`[platforms] ${p.label} désactivé (${p.unavailableReason || 'prérequis absents'})`);
  else platforms[id] = p;
}

// Reconnaît un lien d'annonce. available=false : plateforme connue mais désactivée sur cet hébergement.
function fromUrl(url) {
  for (const p of Object.values({ ...all, ...platforms })) {
    const id = p.parseUrl?.(url);
    if (id) return { platform: p, id, available: p.available !== false };
  }
  return null;
}

// Libellés des plateformes dont je sais lire les liens (pour les messages d'aide).
const labels = () => Object.values(all).filter(p => p.parseUrl).map(p => p.label);

module.exports = {
  fromUrl,
  labels,
  platforms,
  get ids() { return Object.keys(platforms); },
  get: id => platforms[id] || all[id], // all[id] : anciennes alertes d'une plateforme désactivée
};
