// "@bot rtx 3070ti 300€"  -> marché + meilleures offres
// "@bot <lien>" ou "@bot" + capture d'écran -> analyse de fiabilité
const { marketReport } = require('./market');
const { analyse } = require('./analyse');
const { marketMessage, analysisMessage } = require('./embed');
const platforms = require('./platforms');

const COOLDOWN_MS = 10000;
const last = new Map();

function parseBudget(text) {
  const re = [/(?:max(?:imum)?|moins de|budget|<=?|jusqu'?a)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)?/i, /(\d+(?:[.,]\d+)?)\s*(?:€|eur\b|euros?\b)/i];
  for (const r of re) {
    const m = r.exec(text);
    if (m) return { budget: parseFloat(m[1].replace(',', '.')), rest: text.replace(m[0], ' ') };
  }
  return { budget: 0, rest: text };
}

/** Sépare une saisie en { query, maxPrice, exclude[] } (« -coque » exclut un mot). */
function parseQuery(text) {
  const { budget, rest } = parseBudget(text);
  const exclude = [...rest.matchAll(/(?:^|\s)-([\p{L}\d]{2,})/gu)].map(m => m[1]);
  const query = rest.replace(/(?:^|\s)-[\p{L}\d]{2,}/gu, ' ').replace(/\s+/g, ' ').trim();
  return { query, maxPrice: budget, exclude };
}

const HELP = '👋 Écris-moi un produit : `@bot rtx 3070ti` (option : `max 300€`, `-coque` pour exclure un mot).\n' +
  'Ou envoie-moi **le lien** d\'une annonce Leboncoin/Vinted, ou une **capture d\'écran**, pour savoir si elle est fiable.';

/**
 * @param {object} msg Discord message
 * @param {object} client Discord client
 * @param {object} dependencies Optional injectable functions for deterministic tests.
 */
async function onMessage(msg, client, dependencies = {}) {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true })) return;

  const now = Date.now();
  if (now - (last.get(msg.author.id) || 0) < COOLDOWN_MS) {
    return msg.reply({ content: '⏳ Doucement, une recherche à la fois (10 s entre deux demandes).', allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  }
  last.set(msg.author.id, now);

  const text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  const urls = text.match(/https?:\/\/[^\s<>]+/g) || [];
  let images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/')).map(a => a.url);

  // Réponse à un message contenant une capture
  if (!images.length && !urls.length && msg.reference?.messageId) {
    const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
    if (ref) {
      images = [...ref.attachments.values()].filter(a => a.contentType?.startsWith('image/')).map(a => a.url);
      urls.push(...(ref.content.match(/https?:\/\/[^\s<>]+/g) || []));
    }
  }

  const reply = payload => msg.reply({ ...payload, allowedMentions: { parse: [], repliedUser: false } });
  await msg.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

  try {
    if (urls.length || images.length) {
      const url = urls.find(u => platforms.fromUrl(u));
      if (!url && !images.length) return await reply({ content: '🔗 Ce lien n\'est ni Leboncoin ni Vinted. Envoie une **capture d\'écran** de l\'annonce à la place.' });
      const result = await (dependencies.analyse || analyse)({ url, imageUrls: url ? [] : images, text: text.replace(/https?:\/\/\S+/g, '').trim() });
      return await reply(analysisMessage(result));
    }
    const { query, maxPrice, exclude } = parseQuery(text);
    if (query.length < 2) return await reply({ content: HELP });
    const report = await (dependencies.marketReport || marketReport)({ query, maxPrice, exclude });
    return await reply(marketMessage(report));
  } catch (e) {
    console.error('[mention]', e.message);
    await reply({ content: `❌ ${e.message}` }).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

module.exports = { onMessage, parseQuery, parseBudget };
