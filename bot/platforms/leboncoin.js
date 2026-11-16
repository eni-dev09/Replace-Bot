// Adaptateur Leboncoin : réutilise le scraper existant (pont Python `lbc`).
const { spawnSync } = require('child_process');
const { scrapeLeBonCoin, getLeBonCoinDetail } = require('../../server/scrapers/leboncoinScraper');

// Disponible uniquement si Python + la lib `lbc` sont présents (absents sur la plupart
// des hébergeurs Node comme Bot-Hosting) ou si LBC_ENABLED n'est pas "false".
function detect() {
  if (String(process.env.LBC_ENABLED || '').toLowerCase() === 'false') return false;
  const py = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  try { return spawnSync(py, ['-c', 'import lbc'], { timeout: 15000 }).status === 0; } catch { return false; }
}

module.exports = {
  id: 'leboncoin',
  label: 'Leboncoin',
  emoji: '🟠',
  color: 0xff6e14,
  available: detect(),
  unavailableReason: 'Python + lib lbc absents',

  parseUrl(url) {
    const m = /^https?:\/\/(?:[a-z0-9-]+\.)*leboncoin\.fr\/(?:[^?#\s]*\/)?(\d{7,})/i.exec(String(url).trim());
    return m ? m[1] : null;
  },

  async getAd(id) {
    const a = await getLeBonCoinDetail(id);
    if (!a || a.error) throw new Error(a?.error || 'annonce Leboncoin introuvable');
    return {
      id: a.id, platform: 'leboncoin', title: a.title, price: a.price, description: a.description || '',
      image: a.image && !a.image.includes('placeholder') ? a.image : null, url: a.url, location: a.location,
      condition: a.condition, sellerType: a.sellerType, sellerName: a.sellerName,
      sellerRating: a.sellerRating || 0, sellerReviews: a.sellerReviews || 0, delivery: a.delivery,
      redFlags: [],
    };
  },

  async search({ query, maxPrice, limit = 30 }) {
    const data = await scrapeLeBonCoin({ query, maxPrice, sort: 'relevance', limit });
    if (data.error) throw new Error(data.error);
    return (data.results || []).map(a => ({
      id: a.id,
      platform: 'leboncoin',
      title: a.title,
      price: a.price,
      image: a.image && !a.image.includes('placeholder') ? a.image : null,
      url: a.url,
      location: a.location,
      condition: a.condition,
      sellerType: a.sellerType,
      sellerName: a.sellerName,
      delivery: a.delivery,
      description: a.description,
      sellerRating: a.sellerRating || undefined,
      sellerReviews: a.sellerReviews || undefined,
      risky: a.scamRisk === 'eleve',
    }));
  },
};
