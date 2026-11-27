// Persistance JSON simple (targets du radar + annonces déjà vues).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'bot-targets.json');
const SEEN_FILE = path.join(DATA_DIR, 'bot-seen.json');
const MAX_SEEN = 5000;

function read(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; } // fichier absent : normal
  try { return JSON.parse(raw); } catch {
    // fichier corrompu : on le garde de côté au lieu de l'écraser au prochain enregistrement
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); console.error(`[store] ${path.basename(file)} illisible, copie conservée (.corrupt)`); } catch {}
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // écriture atomique
}

const store = {
  targets: read(TARGETS_FILE, []),
  seen: new Set(read(SEEN_FILE, [])),

  saveTargets() { write(TARGETS_FILE, this.targets); },

  saveSeen() {
    if (this.seen.size > MAX_SEEN) this.seen = new Set([...this.seen].slice(-MAX_SEEN)); // borne aussi la mémoire
    write(SEEN_FILE, [...this.seen]);
  },

  addTarget(t) {
    const dup = this.targets.find(x =>
      x.guildId === t.guildId && x.channelId === t.channelId &&
      x.keyword.toLowerCase() === t.keyword.toLowerCase() &&
      x.maxPrice === t.maxPrice && x.platforms.join() === t.platforms.join());
    if (dup) return { target: dup, created: false };
    const target = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), createdAt: new Date().toISOString(), ...t };
    this.targets.push(target);
    this.saveTargets();
    return { target, created: true };
  },

  removeTarget(id, guildId) {
    const before = this.targets.length;
    this.targets = this.targets.filter(t => !(t.id === id && t.guildId === guildId));
    if (this.targets.length !== before) {
      for (const k of [...this.seen]) if (k.startsWith(`${id}:`)) this.seen.delete(k); // purge les annonces vues de cette alerte
      this.saveTargets(); this.saveSeen();
    }
    return this.targets.length !== before;
  },

  forGuild(guildId) { return this.targets.filter(t => t.guildId === guildId); },
};

module.exports = store;
