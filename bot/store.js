// Persistance JSON simple (targets du radar + annonces déjà vues).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'bot-targets.json');
const SEEN_FILE = path.join(DATA_DIR, 'bot-seen.json');
const MAX_SEEN = 5000;

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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
    const arr = [...this.seen];
    write(SEEN_FILE, arr.slice(-MAX_SEEN));
  },

  addTarget(t) {
    const dup = this.targets.find(x =>
      x.guildId === t.guildId && x.channelId === t.channelId &&
      x.keyword.toLowerCase() === t.keyword.toLowerCase() &&
      x.maxPrice === t.maxPrice && x.platforms.join() === t.platforms.join());
    if (dup) return { target: dup, created: false };
    const target = { id: 'r' + Date.now().toString(36), createdAt: new Date().toISOString(), ...t };
    this.targets.push(target);
    this.saveTargets();
    return { target, created: true };
  },

  removeTarget(id, guildId) {
    const before = this.targets.length;
    this.targets = this.targets.filter(t => !(t.id === id && t.guildId === guildId));
    if (this.targets.length !== before) this.saveTargets();
    return this.targets.length !== before;
  },

  forGuild(guildId) { return this.targets.filter(t => t.guildId === guildId); },
};

module.exports = store;
