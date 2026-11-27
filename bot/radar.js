// Moteur de scan : parcourt les targets, interroge chaque plateforme,
// détecte les deals et les poste dans le salon Discord configuré.
const store = require('./store');
const platforms = require('./platforms');
const { findDeals, filterPromos, priority } = require('./deals');
const { dealMessage } = require('./embed');

const SCAN_LIMIT = 40;
const FIRST_SCAN_MAX_POSTS = 10; // au 1er scan d'une target : on poste seulement les meilleurs
const MAX_POSTS_PER_TARGET = 25; // anti-flood par scan
const POST_DELAY_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function intervalSeconds() {
  const s = Number.parseInt(process.env.DEAL_RADAR_INTERVAL_S ?? '', 10);
  const m = Number.parseInt(process.env.DEAL_RADAR_INTERVAL_MIN ?? '', 10);
  const v = Number.isFinite(s) && s > 0 ? s : Number.isFinite(m) && m > 0 ? m * 60 : 60;
  return Math.max(20, v);
}
const fmtInterval = s => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

const radar = {
  client: null,
  scanning: false,
  lastScan: null,
  nextScanAt: null,
  lastErrors: [],
  // Scan continu : une passe, puis la suivante démarre `intervalS` secondes après le DÉBUT de la précédente
  // (jamais de chevauchement). DEAL_RADAR_INTERVAL_S (défaut 60, min 20) ; ancien DEAL_RADAR_INTERVAL_MIN toujours accepté.
  intervalS: intervalSeconds(),
  timer: null,

  // Mémo d'une passe : plusieurs alertes sur le même produit = une seule requête par plateforme.
  passMemo: null,
  fetchAds(p, keyword) {
    if (!this.passMemo) return p.search({ query: keyword, limit: SCAN_LIMIT });
    const key = `${p.id}|${String(keyword).toLowerCase().trim()}`;
    if (!this.passMemo.has(key)) {
      const pr = p.search({ query: keyword, limit: SCAN_LIMIT });
      this.passMemo.set(key, pr);
      pr.catch(() => this.passMemo?.delete(key)); // un échec n'est pas mémorisé
    }
    return this.passMemo.get(key);
  },

  // Une plateforme -> deals (pas de post). Utilisé par /radar scan et /search.
  async searchPlatform(platformId, { keyword, maxPrice, minDiscount, exclude = [] }) {
    const p = platforms.get(platformId);
    if (p.kind === 'promo') {
      // Bons plans : pas de médiane ; filtrés par mot-clé (côté source), budget et mots exclus
      const ads = await this.fetchAds(p, keyword);
      const deals = filterPromos(ads, { maxPrice, exclude }).map(a => ({
        ...a, promo: true, ratio: a.originalPrice ? Math.round(((a.originalPrice - a.price) / a.originalPrice) * 100) : 0,
      }));
      return { ads, median: 0, stats: { n: 0 }, sample: [], deals };
    }
    // Pas de plafond de prix côté plateforme : il fausserait la médiane (appliqué ensuite sur les deals)
    const ads = await this.fetchAds(p, keyword);
    return { ads, ...findDeals(ads, { maxPrice, minDiscount, query: keyword, exclude }) };
  },

  async scanTarget(t, { post = true } = {}) {
    const isFirst = !t.scannedAt;
    const out = { posted: 0, found: 0, errors: [] };
    let fresh = [];

    const list = t.platforms.includes('*') ? platforms.ids : t.platforms;
    // plateformes en parallèle (chacune a sa file de débit) ; résultats traités dans l'ordre de la liste
    const results = await Promise.all(list.map(async pid => {
      if (!platforms.platforms[pid]) return { pid, error: new Error('plateforme indisponible') };
      try { return { pid, res: await this.searchPlatform(pid, t) }; } catch (error) { return { pid, error }; }
    }));
    for (const { pid, res, error } of results) {
      if (error) { out.errors.push(`${pid}: ${error.message}`); continue; }
      out.found += res.deals.length;
      for (const d of res.deals) {
        const key = `${t.id}:${d.id}`;
        if (store.seen.has(key)) continue;
        fresh.push({ d, key });
      }
    }

    // meilleures remises d'abord
    const rank = x => x.d.ratio + priority(x.d) - (x.d.suspicious ? 100 : 0);
    fresh.sort((a, b) => rank(b) - rank(a));
    const cap = isFirst ? FIRST_SCAN_MAX_POSTS : MAX_POSTS_PER_TARGET;
    const toPost = fresh.slice(0, cap);

    // tout ce qui est "fresh" est marqué vu (évite un déluge au scan suivant)
    for (const { key } of fresh) store.seen.add(key);

    if (post && toPost.length && this.client) {
      const channel = await this.client.channels.fetch(t.channelId).catch(() => null);
      if (!channel?.isTextBased()) {
        for (const { key } of toPost) store.seen.delete(key); // on réessaiera au prochain scan
        out.errors.push(`salon ${t.channelId} introuvable ou inaccessible`);
      } else {
        const ping = t.roleId ? `<@&${t.roleId}>` : undefined;
        let first = true;
        for (const [idx, { d }] of toPost.entries()) {
          try {
            const payload = dealMessage(d, t.keyword);
            // le ping de rôle n'est envoyé qu'une fois par scan (pas de spam)
            if (ping && first) { payload.content = ping; payload.allowedMentions = { roles: [t.roleId] }; first = false; }
            await channel.send(payload);
            out.posted++;
          } catch (e) {
            out.errors.push(`envoi: ${e.message}`);
            for (const { key } of toPost.slice(idx)) store.seen.delete(key); // non postées : réessayées au prochain scan
            break;
          }
          await sleep(POST_DELAY_MS);
        }
      }
    }

    if (!out.errors.length || out.found) { t.scannedAt = new Date().toISOString(); }
    store.saveSeen();
    store.saveTargets();
    return out;
  },

  fmtInterval() { return fmtInterval(this.intervalS); },

  async scanAll() {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
    this.lastErrors = [];
    this.passMemo = new Map();
    let posted = 0, found = 0;
    const list = [...store.targets];
    try {
      for (const t of list) {
        const r = await this.scanTarget(t);
        posted += r.posted; found += r.found;
        r.errors.forEach(e => this.lastErrors.push(`${t.keyword} → ${e}`));
      }
    } finally {
      this.passMemo = null;
      this.scanning = false;
      this.lastScan = new Date().toISOString();
    }
    return { skipped: false, posted, found, targets: list.length, errors: this.lastErrors.length };
  },

  start(client) {
    this.client = client;
    if (String(process.env.DEAL_RADAR_ENABLED || 'true').toLowerCase() === 'false') {
      console.log('[radar] scan auto désactivé');
      return;
    }
    this.stopped = false;
    const loop = async delayMs => {
      this.nextScanAt = new Date(Date.now() + delayMs).toISOString();
      this.timer = setTimeout(async () => {
        if (this.stopped) return;
        const t0 = Date.now();
        try {
          const r = await this.scanAll();
          if (!r.skipped) {
            this.passes = (this.passes || 0) + 1;
            const loud = r.posted || r.errors || !r.targets || this.passes <= 3 || this.passes % 10 === 0; // pas de spam quand tout est calme
            if (loud) console.log(`[radar] passe ${this.passes} : ${r.targets} alerte(s), ${r.found} deal(s) trouvé(s), ${r.posted} posté(s), ${r.errors} erreur(s)${r.targets ? '' : ' → aucune alerte : crée-en une avec /radar add'}`);
            for (const e of this.lastErrors.slice(0, 5)) console.warn(`[radar]   ✗ ${e}`);
          }
        } catch (e) { console.error('[radar] erreur scan:', e); }
        if (!this.stopped) loop(Math.max(1000, this.intervalS * 1000 - (Date.now() - t0)));
      }, delayMs);
    };
    loop(15000); // 1er scan peu après le démarrage
    console.log(`[radar] actif — scan en continu, une passe toutes les ${fmtInterval(this.intervalS)}`);
    if (this.intervalS < 45) console.warn('[radar] intervalle très court : risque de blocage par Leboncoin/Vinted (conseillé ≥ 60 s)');
    if (platforms.ids.includes('dealabs') && this.intervalS > 900) {
      console.warn('[radar] Dealabs : le flux ne couvre que ~20 min de deals ; mets DEAL_RADAR_INTERVAL_S ≤ 900 pour n\'en rater aucun');
    }
  },

  stop() { this.stopped = true; clearTimeout(this.timer); },
};

module.exports = radar;
