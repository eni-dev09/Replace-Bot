const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { get } = require('./platforms');
const { inFrance } = require('./deals');

const eur = n => `${Number.isInteger(n) ? n : n.toFixed(2)} €`;

/** Embed d'un bon plan Dealabs (pas de médiane : prix, marchand, remise annoncée). */
function promoEmbed(d, footer) {
  const p = get('dealabs');
  const priceTxt = d.price == null ? 'prix non indiqué' : d.price === 0 ? '**Gratuit**' : `**${eur(d.price)}**`;
  let desc = `${priceTxt}${d.merchant ? ` chez **${clip(d.merchant, 60)}**` : ''}`;
  if (d.price != null && d.originalPrice > d.price) {
    desc += ` · au lieu de ${eur(d.originalPrice)} (−${Math.round(((d.originalPrice - d.price) / d.originalPrice) * 100)} % annoncé)`;
  }
  const e = new EmbedBuilder().setColor(p?.color ?? 0x2f9e44).setTitle(`🏷️ ${clip(d.title, 240)}`).setURL(d.url).setDescription(desc);
  if (d.category) e.addFields({ name: 'Catégorie', value: clip(d.category, 100), inline: true });
  if (d.publishedAt) e.addFields({ name: 'Publié', value: `<t:${Math.floor(Date.parse(d.publishedAt) / 1000)}:R>`, inline: true });
  if (d.excerpt) e.addFields({ name: 'Détails', value: clip(d.excerpt, 300) });
  if (d.image) e.setThumbnail(d.image);
  if (footer) e.setFooter({ text: footer });
  return e;
}

function promoMessage(d, keyword) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Voir le bon plan').setStyle(ButtonStyle.Link).setURL(d.url)
  );
  return { embeds: [promoEmbed(d, `Bon plan Dealabs · radar « ${keyword} »`).setTimestamp()], components: [row] };
}

function dealMessage(deal, keyword) {
  if (deal.kind === 'promo') return promoMessage(deal, keyword);
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
  const fr = inFrance(deal);
  const tags = [fr === true ? '🇫🇷 France' : fr === false ? '🌍 Étranger' : '', deal.delivery === true ? '📦 Livraison dispo' : deal.delivery === false ? '🤝 Remise en main propre' : ''].filter(Boolean);
  if (tags.length) embed.addFields({ name: 'Origine / livraison', value: tags.join(' · '), inline: false });
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
  const promos = r.promos || [];
  const summary = new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 Marché : ${clip(r.query, 80)}`);
  if (!hasData) {
    summary.setDescription(promos.length
      ? 'Pas assez d\'annonces d\'occasion pour calculer un prix médian. Voici les bons plans Dealabs correspondants.'
      : 'Pas assez d\'annonces comparables trouvées. Essaie un nom plus précis ou moins restrictif.');
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
  for (const p of promos.slice(0, 3)) embeds.push(promoEmbed(p, 'Bon plan Dealabs (prix promo, sans comparaison au marché)'));
  if (hasData && !r.best.length) {
    summary.addFields({ name: 'Offres', value: r.maxPrice ? 'Aucune offre dans ton budget.' : 'Aucune offre exploitable.' });
  }
  const content = r.best.length
    ? `🔎 Meilleures offres du moment (verdict = estimation rapide ; envoie-moi le lien ou une capture pour une analyse complète)${promos.length ? ', puis 🏷️ bons plans Dealabs' : ''} :`
    : promos.length ? '🏷️ Bons plans Dealabs correspondants :' : undefined;
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

module.exports = { promoEmbed, promoMessage, dealMessage, marketMessage, analysisMessage, eur };
