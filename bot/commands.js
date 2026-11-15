const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags,
} = require('discord.js');
const store = require('./store');
const radar = require('./radar');
const platforms = require('./platforms');
const { dealMessage, marketMessage, analysisMessage, eur } = require('./embed');
const { marketReport } = require('./market');
const { analyse } = require('./analyse');

const platformChoices = [
  { name: 'Toutes les plateformes', value: 'all' },
  ...platforms.ids.map(id => ({ name: platforms.get(id).label, value: id })),
];
const resolvePlatforms = v => (!v || v === 'all' ? [...platforms.ids] : [v]);

const radarCmd = new SlashCommandBuilder()
  .setName('radar')
  .setDescription('Gérer les alertes bonnes affaires')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand(s => s.setName('add').setDescription('Surveiller un produit')
    .addStringOption(o => o.setName('produit').setDescription('Ex : iPhone 13, RTX 3070, Nike Air Max').setRequired(true).setMaxLength(80))
    .addNumberOption(o => o.setName('prix_max').setDescription('Budget maximum en €').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('plateforme').setDescription('Où chercher (défaut : toutes)').addChoices(...platformChoices))
    .addChannelOption(o => o.setName('salon').setDescription('Salon des alertes (défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('role').setDescription('Rôle à mentionner quand une affaire tombe'))
    .addStringOption(o => o.setName('exclure').setDescription('Mots à exclure, séparés par des virgules (ex : coque, hs, pour pièces)').setMaxLength(100))
    .addIntegerOption(o => o.setName('remise_min').setDescription('Remise mini vs prix du marché, en % (défaut 20)').setMinValue(5).setMaxValue(90)))
  .addSubcommand(s => s.setName('list').setDescription('Lister les alertes actives'))
  .addSubcommand(s => s.setName('remove').setDescription('Supprimer une alerte')
    .addStringOption(o => o.setName('id').setDescription('Alerte à supprimer').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('scan').setDescription('Lancer un scan immédiat de toutes les alertes'))
  .addSubcommand(s => s.setName('status').setDescription('État du radar'));

const searchCmd = new SlashCommandBuilder()
  .setName('deals')
  .setDescription('Prix du marché + meilleures offres du moment sur un produit')
  .addStringOption(o => o.setName('produit').setDescription('Produit recherché').setRequired(true).setMaxLength(80))
  .addNumberOption(o => o.setName('prix_max').setDescription('Budget maximum en €').setMinValue(1))
  .addStringOption(o => o.setName('plateforme').setDescription('Où chercher (défaut : toutes)').addChoices(...platformChoices));

const analyseCmd = new SlashCommandBuilder()
  .setName('analyse')
  .setDescription('Une annonce est-elle fiable ? Prix vs marché + signaux d\'arnaque')
  .addStringOption(o => o.setName('lien').setDescription('Lien Leboncoin ou Vinted'))
  .addAttachmentOption(o => o.setName('image').setDescription('Capture d\'écran de l\'annonce'));

const definitions = [radarCmd, searchCmd, analyseCmd].map(c => c.toJSON());

const ephemeral = { flags: MessageFlags.Ephemeral };

async function handleRadar(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'add') {
    const channel = i.options.getChannel('salon') || i.channel;
    const me = i.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return i.reply({ content: `❌ Il me manque les droits **Voir / Envoyer / Intégrer des liens** dans ${channel}.`, ...ephemeral });
    }
    const { target, created } = store.addTarget({
      guildId: i.guildId,
      channelId: channel.id,
      keyword: i.options.getString('produit').trim(),
      maxPrice: i.options.getNumber('prix_max'),
      platforms: resolvePlatforms(i.options.getString('plateforme')),
      minDiscount: (i.options.getInteger('remise_min') ?? 20) / 100,
      roleId: i.options.getRole('role')?.id || null,
      exclude: (i.options.getString('exclure') || '').split(',').map(x => x.trim()).filter(Boolean),
      createdBy: i.user.id,
    });
    const where = target.platforms.map(p => platforms.get(p).label).join(', ');
    return i.reply(created
      ? `✅ Alerte **${target.keyword}** ≤ ${eur(target.maxPrice)} (−${Math.round(target.minDiscount * 100)} % min) sur ${where} → ${channel}` +
        `${target.roleId ? ` · ping <@&${target.roleId}>` : ''}${target.exclude.length ? ` · exclut : ${target.exclude.join(', ')}` : ''}\nPremier scan dans quelques instants. ID : \`${target.id}\``
      : `ℹ️ Cette alerte existe déjà (\`${target.id}\`).`);
  }

  if (sub === 'list') {
    const list = store.forGuild(i.guildId);
    if (!list.length) return i.reply({ content: 'Aucune alerte. Crée-en une avec `/radar add`.', ...ephemeral });
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📡 Alertes actives')
      .setDescription(list.slice(0, 25).map(t =>
        `\`${t.id}\` **${t.keyword}** ≤ ${eur(t.maxPrice)} · −${Math.round(t.minDiscount * 100)} % · ${t.platforms.map(p => platforms.get(p).label).join('/')} · <#${t.channelId}>`
      ).join('\n'));
    return i.reply({ embeds: [embed], ...ephemeral });
  }

  if (sub === 'remove') {
    const ok = store.removeTarget(i.options.getString('id'), i.guildId);
    return i.reply({ content: ok ? '🗑️ Alerte supprimée.' : '❌ Alerte introuvable.', ...ephemeral });
  }

  if (sub === 'scan') {
    if (radar.scanning) return i.reply({ content: '⏳ Un scan est déjà en cours.', ...ephemeral });
    await i.reply({ content: '🔎 Scan lancé… (peut prendre un moment : les requêtes sont espacées pour éviter les blocages)', ...ephemeral });
    const r = await radar.scanAll();
    return i.editReply(`✅ Scan terminé : **${r.posted}** nouvelle(s) affaire(s) postée(s)${r.errors ? `, ${r.errors} erreur(s) (voir \`/radar status\`)` : ''}.`);
  }

  if (sub === 'status') {
    const mine = store.forGuild(i.guildId).length;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📡 Statut du radar').addFields(
      { name: 'Alertes (ce serveur)', value: String(mine), inline: true },
      { name: 'Intervalle', value: `${radar.intervalMin} min`, inline: true },
      { name: 'Scan en cours', value: radar.scanning ? 'oui' : 'non', inline: true },
      { name: 'Dernier scan', value: radar.lastScan ? `<t:${Math.floor(Date.parse(radar.lastScan) / 1000)}:R>` : 'jamais', inline: true },
      { name: 'Prochain scan', value: radar.nextScanAt ? `<t:${Math.floor(Date.parse(radar.nextScanAt) / 1000)}:R>` : 'n/c', inline: true },
      { name: 'Dernières erreurs', value: radar.lastErrors.slice(0, 5).join('\n').slice(0, 1000) || 'aucune' },
    );
    return i.reply({ embeds: [embed], ...ephemeral });
  }
}

async function handleDeals(i) {
  await i.deferReply();
  const query = i.options.getString('produit').trim();
  const maxPrice = i.options.getNumber('prix_max') || 0;
  const report = await marketReport({ query, maxPrice, platformIds: resolvePlatforms(i.options.getString('plateforme')) });
  return i.editReply({ ...marketMessage(report), allowedMentions: { parse: [] } });
}

async function handleAnalyse(i) {
  const lien = i.options.getString('lien');
  const img = i.options.getAttachment('image');
  if (!lien && !img) return i.reply({ content: 'Donne un **lien** (Leboncoin/Vinted) ou une **image** (capture de l\'annonce).', ...ephemeral });
  await i.deferReply();
  const imageUrls = !lien && img?.contentType?.startsWith('image/') ? [img.url] : [];
  if (!lien && !imageUrls.length) return i.editReply('❌ Le fichier joint n\'est pas une image.');
  const result = await analyse({ url: lien ? (lien.match(/https?:\/\/\S+/) || [lien])[0] : undefined, imageUrls });
  return i.editReply({ ...analysisMessage(result), allowedMentions: { parse: [] } });
}

async function handle(i) {
  if (i.isAutocomplete() && i.commandName === 'radar') {
    const q = String(i.options.getFocused()).toLowerCase();
    return i.respond(store.forGuild(i.guildId)
      .filter(t => t.keyword.toLowerCase().includes(q) || t.id.includes(q))
      .slice(0, 25)
      .map(t => ({ name: `${t.keyword} ≤ ${t.maxPrice}€ (${t.id})`.slice(0, 100), value: t.id })));
  }
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'radar') await handleRadar(i);
    else if (i.commandName === 'deals') await handleDeals(i);
    else if (i.commandName === 'analyse') await handleAnalyse(i);
  } catch (e) {
    console.error('[cmd]', e);
    const msg = { content: `❌ Erreur : ${e.message}`, ...ephemeral };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
}

module.exports = { definitions, handle };
