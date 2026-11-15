// Moteur de scan : parcourt les targets, interroge chaque plateforme,
// détecte les deals et les poste dans le salon Discord configuré.
const store = require('./store');
const platforms = require('./platforms');
const { findDeals } = require('./deals');
const { dealMessage } = require('./embed');

const SCAN_LIMIT = 40;
const FIRST_SCAN_MAX_POSTS = 5; // au 1er scan d'une target : on poste seulement les meilleurs
const MAX_POSTS_PER_TARGET = 8; // anti-flood par scan
const POST_DELAY_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const radar = {
  client: null,
  scanning: false,
  lastScan: null,
  nextScanAt: null,
  lastErrors: [],
  intervalMin: parseInt(process.env.DEAL_RADAR_INTERVAL_MIN || '10', 10),
  timer: null,

  // Une plateforme -> deals (pas de post). Utilisé par /radar scan et /search.
  async searchPlatform(platformId, { keyword, maxPrice, minDiscount, exclude = [] }) {
    const p = platforms.get(platformId);
    // Pas de plafond de prix côté plateforme : il fausserait la médiane (appliqué ensuite sur les deals)
    const ads = await p.search({ query: keyword, limit: SCAN_LIMIT });
    return { ads, ...findDeals(ads, { maxPrice, minDiscount, query: keyword, exclude }) };
  },

  async scanTarget(t, { post = true } = {}) {
    const isFirst = !t.scannedAt;
    const out = { posted: 0, found: 0, errors: [] };
    let fresh = [];

    for (const pid of t.platforms) {
      if (!platforms.platforms[pid]) { out.errors.push(`${pid}: plateforme indisponible`); continue; }
      try {
        const { deals } = await this.searchPlatform(pid, t);
        out.found += deals.length;
        for (const d of deals) {
          const key = `${t.id}:${d.id}`;
          if (store.seen.has(key)) continue;
          fresh.push({ d, key });
        }
      } catch (e) {
        out.errors.push(`${pid}: ${e.message}`);
      }
    }

    // meilleures remises d'abord
    const rank = x => x.d.ratio - (x.d.suspicious ? 100 : 0);
    fresh.sort((a, b) => rank(b) - rank(a));
    const cap = isFirst ? FIRST_SCAN_MAX_POSTS : MAX_POSTS_PER_TARGET;
    const toPost = fresh.slice(0, cap);

    // tout ce qui est "fresh" est marqué vu (évite un déluge au scan suivant)
    for (const { key } of fresh) store.seen.add(key);

    if (post && toPost.length && this.client) {
      const channel = await this.client.channels.fetch(t.channelId).catch(() => null);
      if (!channel?.isTextBased()) {
        out.errors.push(`salon ${t.channelId} introuvable ou inaccessible`);
      } else {
        const ping = t.roleId ? `<@&${t.roleId}>` : undefined;
        let first = true;
        for (const { d } of toPost) {
          try {
            const payload = dealMessage(d, t.keyword);
            // le ping de rôle n'est envoyé qu'une fois par scan (pas de spam)
            if (ping && first) { payload.content = ping; payload.allowedMentions = { roles: [t.roleId] }; first = false; }
            await channel.send(payload);
            out.posted++;
          } catch (e) {
            out.errors.push(`envoi: ${e.message}`);
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

  async scanAll() {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
    this.lastErrors = [];
    let posted = 0;
    try {
      for (const t of [...store.targets]) {
        const r = await this.scanTarget(t);
        posted += r.posted;
        r.errors.forEach(e => this.lastErrors.push(`${t.keyword} → ${e}`));
      }
    } finally {
      this.scanning = false;
      this.lastScan = new Date().toISOString();
      this.nextScanAt = new Date(Date.now() + this.intervalMin * 60000).toISOString();
    }
    return { skipped: false, posted, errors: this.lastErrors.length };
  },

  start(client) {
    this.client = client;
    if (String(process.env.DEAL_RADAR_ENABLED || 'true').toLowerCase() === 'false') {
      console.log('[radar] scan auto désactivé');
      return;
    }
    const run = () => this.scanAll()
      .then(r => !r.skipped && console.log(`[radar] scan: ${r.posted} deal(s) postés, ${r.errors} erreur(s)`))
      .catch(e => console.error('[radar] erreur scan:', e));
    this.nextScanAt = new Date(Date.now() + 15000).toISOString();
    setTimeout(run, 15000); // 1er scan peu après le démarrage
    this.timer = setInterval(run, this.intervalMin * 60000);
    console.log(`[radar] actif — scan toutes les ${this.intervalMin} min`);
  },
};

module.exports = radar;
