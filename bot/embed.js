const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { get } = require('./platforms');

const eur = n => `${Number.isInteger(n) ? n : n.toFixed(2)} €`;

function dealMessage(deal, keyword) {
  const p = get(deal.platform);
  const fire = deal.ratio >= 50 ? '🔥🔥' : deal.ratio >= 35 ? '🔥' : '💸';
  const embed = new EmbedBuilder()
    .setColor(p?.color ?? 0x5865f2)
    .setTitle(`${fire} ${deal.title}`.slice(0, 256))
    .setURL(deal.url)
    .setDescription(
      `**${eur(deal.price)}** au lieu de ~${eur(deal.median)} · **−${deal.ratio} %** (${eur(deal.savings)} d'économie)` +
      (deal.suspicious ? '\n⚠️ Prix très bas : vérifie que ce n\'est pas un lot incomplet, une pièce ou une arnaque.' : '')
    )
    .addFields(
      { name: 'Plateforme', value: `${p?.emoji ?? ''} ${p?.label ?? deal.platform}`, inline: true },
      { name: 'État', value: deal.condition || 'n/c', inline: true },
      { name: 'Vendeur', value: `${deal.sellerName || 'n/c'} (${deal.sellerType === 'pro' ? 'pro' : 'particulier'})`, inline: true },
    )
    .setFooter({ text: `Radar « ${keyword} »` })
    .setTimestamp();
  if (deal.location) embed.addFields({ name: 'Lieu', value: deal.location, inline: true });
  if (deal.platform === 'ebay') {
    embed.addFields({ name: 'Livraison', value: deal.shippingCost == null ? 'à calculer (non incluse)' : deal.shippingCost === 0 ? 'gratuite' : `${eur(deal.shippingCost)} (incluse dans le prix)`, inline: true });
  }
  if (deal.size) embed.addFields({ name: 'Taille', value: deal.size, inline: true });
  if (deal.brand) embed.addFields({ name: 'Marque', value: deal.brand, inline: true });
  if (deal.image) embed.setImage(deal.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Voir l\'annonce').setStyle(ButtonStyle.Link).setURL(deal.url)
  );
  return { embeds: [embed], components: [row] };
}

const REASON_ICON = { bad: '🔴', warn: '🟡', good: '🟢', info: 'ℹ️' };
const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));
const statLine = st => `médiane **${eur(st.median)}** · P25 ${eur(st.p25)} · min ${eur(st.min)} · ${st.n} annonces`;

/** Réponse à « @bot rtx 3070ti » et /deals : synthèse du marché + 5 meilleures offres. */
function marketMessage(r) {
  const hasData = r.overall.n >= 3;
  const summary = new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 Marché : ${clip(r.query, 80)}`);
  if (!hasData) {
    summary.setDescription('Pas assez d\'annonces comparables trouvées. Essaie un nom plus précis ou moins restrictif.');
  } else {
    summary.setDescription(`Prix médian du marché : **${eur(r.overall.median)}**` +
      (r.maxPrice ? `\nBudget : ${eur(r.maxPrice)}` : '') +
      `\nFourchette courante : ${eur(r.overall.p25)} – ${eur(r.overall.max)}`);
    for (const p of r.perPlatform) {
      summary.addFields({ name: `${p.emoji} ${p.label}`, value: p.stats.n >= 3 ? statLine(p.stats) : 'pas assez d\'annonces', inline: false });
    }
  }
  if (r.errors.length) summary.addFields({ name: '⚠️ Erreurs', value: clip(r.errors.join('\n'), 1000) });
  summary.setFooter({ text: 'Médiane calculée sur les annonces actuelles, accessoires/pièces exclus' });

  const embeds = [summary];
  r.best.forEach((d, i) => {
    const pl = get(d.platform);
    const e = new EmbedBuilder().setColor(d.risk?.color ?? pl?.color ?? 0x5865f2)
      .setTitle(`${i + 1}. ${clip(d.title, 200)}`).setURL(d.url)
      .setDescription(
        `**${eur(d.price)}** ${d.ratio > 0 ? `· −${d.ratio} % vs médiane` : d.ratio < 0 ? `· +${-d.ratio} % vs médiane` : ''} ` +
        `· ${pl?.emoji ?? ''} ${pl?.label ?? d.platform}\n` +
        `${d.risk.emoji} ${d.risk.label}${d.suspicious ? ' · ⚠️ prix très bas' : ''}` +
        `${d.location ? ` · 📍 ${d.location}` : ''}${d.condition ? ` · ${d.condition}` : ''}`);
    if (d.image) e.setThumbnail(d.image);
    embeds.push(e);
  });
  if (hasData && !r.best.length) {
    summary.addFields({ name: 'Offres', value: r.maxPrice ? 'Aucune offre dans ton budget.' : 'Aucune offre exploitable.' });
  }
  const content = r.best.length ? '🔎 Meilleures offres du moment (verdict = estimation rapide ; envoie-moi le lien ou une capture pour une analyse complète) :' : undefined;
  return { content, embeds };
}

/** Réponse d'analyse de fiabilité (lien / capture). */
function analysisMessage(a) {
  const { ad, market, assessment: v } = a;
  const pl = get(String(ad.platform).toLowerCase());
  const e = new EmbedBuilder().setColor(v.color)
    .setTitle(`${v.emoji} ${v.label} — risque ${v.risk}/100`)
    .setDescription(`**${clip(ad.title, 200)}**\n` +
      `${ad.price ? `Prix : **${eur(ad.price)}**` : 'Prix : non lisible'} · ${pl ? `${pl.emoji} ${pl.label}` : ad.platform}` +
      `${ad.condition ? ` · ${ad.condition}` : ''}${ad.location ? ` · 📍 ${ad.location}` : ''}`);
  if (ad.url) e.setURL(ad.url);
  if (ad.image) e.setThumbnail(ad.image);

  if (market.n >= 3) {
    const cmp = ad.price && market.median ? ` → ${ad.price <= market.median ? '−' : '+'}${Math.abs(Math.round((1 - ad.price / market.median) * 100))} %` : '';
    e.addFields({ name: `📊 Marché (${market.scope})`, value: `${statLine(market)}${cmp}\nRecherche : *${clip(a.query, 60)}*` });
  } else {
    e.addFields({ name: '📊 Marché', value: `Pas assez d'annonces comparables (recherche : *${clip(a.query, 60)}*)` });
  }
  e.addFields({ name: 'Analyse', value: clip(v.reasons.map(r => `${REASON_ICON[r.type]} ${r.text}`).join('\n') || 'Rien de particulier', 1024) });
  if (ad.sellerName) e.addFields({ name: 'Vendeur', value: `${ad.sellerName}${ad.sellerRating != null ? ` · ${ad.sellerRating}/5 (${ad.sellerReviews ?? 0} avis)` : ''}`, inline: true });
  e.addFields({ name: '🛡️ Conseils', value: clip(a.tips.map(t => `• ${t}`).join('\n'), 1024) });
  e.setFooter({ text: 'Estimation indicative : aucun outil ne garantit qu\'une annonce est sûre.' });

  const embeds = [e];
  const better = a.report.best.filter(b => b.price < (ad.price || Infinity) && b.risk.risk < 50).slice(0, 2);
  if (better.length) {
    embeds.push(new EmbedBuilder().setColor(0x5865f2).setTitle('💡 Alternatives moins chères')
      .setDescription(better.map(b => `[${clip(b.title, 70).replace(/[\[\]]/g, '')}](${b.url}) — **${eur(b.price)}** (${b.risk.emoji} ${b.risk.label})`).join('\n')));
  }
  return { embeds };
}

module.exports = { dealMessage, marketMessage, analysisMessage, eur };
