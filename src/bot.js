// Discord client + panel message lifecycle (post, edit in place, re-post when deleted).
import { Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes } from "discord.js";
import { config } from "./config.js";
import * as db from "./db.js";
import { buildPanelPayloads, panelFingerprint } from "./panel.js";
import { liveOf, pollAll } from "./poller.js";
import { commandDefinitions, handleInteraction } from "./commands.js";

export const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Permissions the bot needs in a panel channel.
export const REQUIRED_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];
export const INVITE_PERMISSION_BITS = REQUIRED_PERMS.reduce((a, b) => a | b, 0n);

const lastEdit = new Map(); // panelId -> { fingerprint, at }
const locks = new Map();    // panelId -> Promise chain, serialises post/edit per panel
const warned = new Set();   // panelIds whose channel is gone (warn once)

/** Run fn for a panel with no other post/edit of that panel in flight. */
function withPanelLock(panelId, fn) {
  const prev = locks.get(panelId) || Promise.resolve();
  const next = prev.catch(() => null).then(fn);
  locks.set(panelId, next);
  next.finally(() => { if (locks.get(panelId) === next) locks.delete(panelId); });
  return next;
}

async function fetchChannel(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel;
}

export function checkChannelPerms(channel) {
  const me = channel.guild?.members?.me;
  if (!me) return [];
  const perms = channel.permissionsFor(me);
  return REQUIRED_PERMS.filter((p) => !perms?.has(p));
}

function payloadsFor(panel) {
  const servers = db.panelServers(panel.id);
  return { servers, payloads: buildPanelPayloads(panel, servers, liveOf) };
}

/** OAuth2 invite link with exactly the permissions the bot needs (null until logged in). */
export function inviteUrl() {
  if (!client.isReady()) return null;
  return `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSION_BITS}`;
}

export function isAdminGuild(guildId) {
  return !config.adminGuildIds.length || config.adminGuildIds.includes(String(guildId));
}

async function deleteMessages(channel, ids) {
  for (const id of ids) {
    const msg = await channel.messages.fetch(id).catch(() => null);
    if (msg) await msg.delete().catch(() => null);
  }
}

/** Resolve a channel the bot can post panels in, or throw a readable error. */
async function requirePanelChannel(channelId) {
  const channel = await fetchChannel(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found or not a text channel.`);
  const missing = checkChannelPerms(channel);
  if (missing.length) throw new Error(`Missing permissions in #${channel.name}: ${missing.map(permName).join(", ")}`);
  return channel;
}

/** Post fresh message(s) for a panel, deleting any previous ones first. */
export function postPanelMessage(panel) {
  return withPanelLock(panel.id, () => postLocked(panel));
}

async function postLocked(panel, payloads = null) {
  const channel = await requirePanelChannel(panel.channel_id);
  await deleteMessages(channel, db.panelMessageIds(panel));
  db.setPanelMessages(panel.id, channel.id, []);
  payloads ??= payloadsFor(panel).payloads;
  const ids = [];
  try {
    for (const payload of payloads) ids.push((await channel.send(payload)).id);
  } catch (err) {
    await deleteMessages(channel, ids); // don't leave a half-posted set behind
    throw err;
  }
  db.setPanelMessages(panel.id, channel.id, ids);
  lastEdit.set(panel.id, { fingerprint: "", at: Date.now() });
  warned.delete(panel.id);
  return ids;
}

/** Edit the panel's message(s) in place; re-posts the set if any went missing or the count changed. */
export function refreshPanel(panel, { force = false } = {}) {
  if (!client.isReady()) return Promise.resolve();
  return withPanelLock(panel.id, async () => {
    const servers = db.panelServers(panel.id);
    const fp = panelFingerprint(servers, liveOf);
    const last = lastEdit.get(panel.id);
    // Skip the (expensive) render + edit when nothing changed, but refresh at least once a minute for the chart/footer.
    if (!force && last && last.fingerprint === fp && Date.now() - last.at < 60_000) return;

    const channel = await fetchChannel(panel.channel_id);
    if (!channel) {
      if (!warned.has(panel.id)) {
        console.warn(`[panel #${panel.id}] channel ${panel.channel_id} unavailable (deleted, or bot removed from the guild) — delete the panel with /wd panel delete`);
        warned.add(panel.id);
      }
      return;
    }
    const payloads = buildPanelPayloads(panel, servers, liveOf);
    const ids = db.panelMessageIds(panel);
    const messages = await Promise.all(ids.map((id) => channel.messages.fetch(id).catch(() => null)));
    if (!ids.length || messages.some((m) => !m) || messages.length !== payloads.length) {
      console.log(`[panel #${panel.id}] ${!ids.length ? "no message yet" : messages.some((m) => !m) ? "message missing" : `now ${payloads.length} message(s)`}, re-posting`);
      await postLocked(panel, payloads);
      return;
    }
    try {
      for (let i = 0; i < messages.length; i++) await messages[i].edit(payloads[i]);
      lastEdit.set(panel.id, { fingerprint: fp, at: Date.now() });
    } catch (err) {
      if (err.code === 10008) { // Unknown Message
        await postLocked(panel, payloads);
        return;
      }
      console.error(`[panel #${panel.id}] edit failed: ${err.message}`);
    }
  });
}

export async function refreshAllPanels(opts) {
  for (const panel of db.listPanels()) {
    await refreshPanel(panel, opts).catch((err) => console.error(`[panel #${panel.id}] ${err.message}`));
  }
}

export async function deletePanelMessage(panel) {
  const channel = await fetchChannel(panel.channel_id);
  if (!channel) return;
  await deleteMessages(channel, db.panelMessageIds(panel));
}

/** Create a panel row + post its message. Used by the slash command and the web UI. */
export async function createPanel({ guildId, channelId, options = {}, serverIds = [] }) {
  const panel = db.addPanel({ guildId, channelId, options });
  db.setPanelServerList(panel.id, serverIds);
  try {
    await postPanelMessage(db.getPanel(panel.id));
  } catch (err) {
    db.removePanel(panel.id);
    throw err;
  }
  return db.getPanel(panel.id);
}

/** Move a panel to another channel (validates the target first, then deletes the old set and posts anew). */
export function movePanel(panel, channelId) {
  return withPanelLock(panel.id, async () => {
    await requirePanelChannel(channelId);
    await deletePanelMessage(panel);
    db.setPanelMessages(panel.id, channelId, []);
    return postLocked(db.getPanel(panel.id));
  });
}

export function removePanel(panel) {
  return withPanelLock(panel.id, async () => {
    await deletePanelMessage(panel);
    db.removePanel(panel.id);
    lastEdit.delete(panel.id);
    warned.delete(panel.id);
  });
}

function permName(bit) {
  return Object.entries(PermissionFlagsBits).find(([, v]) => v === bit)?.[0] || String(bit);
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const appId = client.application?.id || client.user.id;
  const body = commandDefinitions();
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(appId, config.discordGuildId), { body });
    console.log(`[bot] registered ${body.length} guild command(s) in ${config.discordGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log(`[bot] registered ${body.length} global command(s) (can take up to an hour to appear)`);
  }
}

export function startBot() {
  client.once("clientReady", async () => {
    console.log(`[bot] logged in as ${client.user.tag}`);
    console.log(`[bot] invite: ${inviteUrl()}`);
    if (!config.adminGuildIds.length) {
      console.warn("[bot] ADMIN_GUILD_IDS / DISCORD_GUILD_ID not set: any guild the bot is in can manage servers (RCON credentials).");
    }
    await registerCommands().catch((err) => console.error("[bot] command registration failed:", err.message));
    // If a poll round is already running it will refresh the panels itself when it finishes.
    const ran = await pollAll().catch(() => false);
    if (ran) await refreshAllPanels({ force: true });
  });

  // Guild commands can only be registered once the bot is in that guild — retry on join.
  client.on("guildCreate", (guild) => {
    console.log(`[bot] joined guild ${guild.name} (${guild.id})`);
    const register = !config.discordGuildId || config.discordGuildId === guild.id ? registerCommands() : Promise.resolve();
    register
      .catch((err) => console.error("[bot] command registration failed:", err.message))
      .then(() => refreshAllPanels({ force: true }))
      .catch((err) => console.error("[bot] refresh after join failed:", err.message));
  });

  client.on("guildDelete", (guild) => {
    const panels = db.listPanels(guild.id);
    console.log(`[bot] removed from guild ${guild.name} (${guild.id})${panels.length ? `; ${panels.length} panel(s) there are now orphaned — /wd panel delete or the web UI removes them` : ""}`);
  });

  client.on("interactionCreate", (interaction) => {
    handleInteraction(interaction).catch(async (err) => {
      console.error("[bot] interaction failed:", err);
      const msg = { content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral };
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => null);
        else await interaction.reply(msg).catch(() => null);
      }
    });
  });

  client.on("error", (err) => console.error("[bot] client error:", err.message));
  return client.login(config.discordToken);
}
