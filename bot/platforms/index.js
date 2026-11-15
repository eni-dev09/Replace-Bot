// Registre des plateformes. Pour en ajouter une (eBay, Back Market...) :
// créer bot/platforms/<nom>.js exportant { id, label, emoji, color, available, search({query,maxPrice,limit}) }
// qui renvoie des annonces normalisées, puis l'ajouter ci-dessous.
const all = {
  leboncoin: require('./leboncoin'),
  vinted: require('./vinted'),
};

const platforms = {};
for (const [id, p] of Object.entries(all)) {
  if (p.available === false) console.warn(`[platforms] ${p.label} désactivé (prérequis absents : Python + lib lbc)`);
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

module.exports = {
  fromUrl,
  platforms,
  get ids() { return Object.keys(platforms); },
  get: id => platforms[id] || all[id], // all[id] : anciennes alertes d'une plateforme désactivée
};
