require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, ActivityType } = require('discord.js');
const commands = require('./commands');
const { onMessage } = require('./mention');
const radar = require('./radar');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ DISCORD_TOKEN et DISCORD_CLIENT_ID requis (copie .env.example vers .env)');
  process.exit(1);
}

// Enregistre les slash commands (instantané si DISCORD_GUILD_ID est défini, sinon global ~1h)
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);
  await rest.put(route, { body: commands.definitions });
  console.log(`[bot] ${commands.definitions.length} commandes enregistrées (${DISCORD_GUILD_ID ? 'serveur' : 'global'})`);
  if (DISCORD_GUILD_ID) {
    // Évite les doublons : d'anciennes commandes globales + celles du serveur s'afficheraient deux fois.
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
  }
}

// Les messages qui MENTIONNENT le bot arrivent avec leur contenu sans intent privilégié.
// MESSAGE_CONTENT_INTENT=true (+ activer l'intent dans le portail) permet en plus de lire
// la capture/le lien d'un message auquel on répond.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (String(process.env.MESSAGE_CONTENT_INTENT).toLowerCase() === 'true') intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });

client.once(Events.ClientReady, async c => {
  console.log(`[bot] connecté : ${c.user.tag}`);
  c.user.setActivity('les bonnes affaires', { type: ActivityType.Watching });
  try { await registerCommands(); } catch (e) { console.error('[bot] enregistrement commandes:', e.message); }
  radar.start(client);
});

client.on(Events.InteractionCreate, commands.handle);
client.on(Events.MessageCreate, m => onMessage(m, client).catch(e => console.error('[mention]', e)));
client.on(Events.Error, e => console.error('[bot] client error:', e));
process.on('unhandledRejection', e => console.error('[bot] unhandledRejection:', e));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`[bot] ${sig} : arrêt`); radar.stop(); client.destroy(); process.exit(0); });
}

client.login(DISCORD_TOKEN);
