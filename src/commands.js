// /wd slash command: server + panel management. Guild owner / Administrator only.
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import * as db from "./db.js";
import { PANEL_DEFAULTS, PANEL_OPTION_KEYS } from "./db.js";
import { pollServer, liveOf } from "./poller.js";
import { querySnapshot, clearCatalogCache } from "./rcon.js";
import * as bot from "./bot.js";
import { MAX_SERVERS_PER_PANEL } from "./panel.js";
import * as v from "./validate.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const SERVER_KEYS = ["name", "host", "port", "password", "connect", "monitor_token"];

export function commandDefinitions() {
  const serverOpt = (o, desc = "Server name") => o.setName("server").setDescription(desc).setRequired(true).setAutocomplete(true);
  const panelOpt = (o) => o.setName("panel").setDescription("Panel id").setRequired(true).setAutocomplete(true);

  const wd = new SlashCommandBuilder()
    .setName("wd")
    .setDescription("Wardogs server monitor")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((g) => g
      .setName("server").setDescription("Manage Wardogs servers (RCON connections)")
      .addSubcommand((s) => s.setName("add").setDescription("Add a server")
        .addStringOption((o) => o.setName("name").setDescription("Short name, e.g. EU1").setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName("host").setDescription("RCON host / IP").setRequired(true))
        .addIntegerOption((o) => o.setName("port").setDescription("RCON port").setRequired(true).setMinValue(1).setMaxValue(65535))
        .addStringOption((o) => o.setName("password").setDescription("RCON password").setRequired(true))
        .addStringOption((o) => o.setName("connect").setDescription("Game address ip:port for the Connect link (optional)"))
        .addStringOption((o) => o.setName("monitor_token").setDescription("Token of an extra bot whose nickname shows the player count (optional)")))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a server (and its history)")
        .addStringOption((o) => serverOpt(o)))
      .addSubcommand((s) => s.setName("list").setDescription("List servers and their live state"))
      .addSubcommand((s) => s.setName("set").setDescription("Change a server setting")
        .addStringOption((o) => serverOpt(o))
        .addStringOption((o) => o.setName("key").setDescription("Setting").setRequired(true)
          .addChoices(...SERVER_KEYS.map((k) => ({ name: k, value: k }))))
        .addStringOption((o) => o.setName("value").setDescription("New value").setRequired(true)))
      .addSubcommand((s) => s.setName("test").setDescription("Query a server now and show the raw result")
        .addStringOption((o) => serverOpt(o))))
    .addSubcommandGroup((g) => g
      .setName("panel").setDescription("Manage status panels (one message per panel)")
      .addSubcommand((s) => s.setName("create").setDescription("Post a new panel message")
        .addChannelOption((o) => o.setName("channel").setDescription("Target channel (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName("title").setDescription("Panel title").setMaxLength(80))
        .addStringOption((o) => o.setName("servers").setDescription("Comma-separated server names (default: all)")))
      .addSubcommand((s) => s.setName("delete").setDescription("Delete a panel and its message")
        .addStringOption((o) => panelOpt(o)))
      .addSubcommand((s) => s.setName("list").setDescription("List panels in this server"))
      .addSubcommand((s) => s.setName("add").setDescription("Show a server on a panel")
        .addStringOption((o) => panelOpt(o))
        .addStringOption((o) => serverOpt(o)))
      .addSubcommand((s) => s.setName("remove").setDescription("Hide a server from a panel")
        .addStringOption((o) => panelOpt(o))
        .addStringOption((o) => serverOpt(o)))
      .addSubcommand((s) => s.setName("set").setDescription("Change what a panel shows")
        .addStringOption((o) => panelOpt(o))
        .addStringOption((o) => o.setName("key").setDescription("Option").setRequired(true)
          .addChoices(...PANEL_OPTION_KEYS.map((k) => ({ name: `${k} (${typeof PANEL_DEFAULTS[k] === "boolean" ? "on/off" : "text"})`, value: k }))))
        .addStringOption((o) => o.setName("value").setDescription("on / off, or text").setRequired(true)))
      .addSubcommand((s) => s.setName("move").setDescription("Move a panel to another channel")
        .addStringOption((o) => panelOpt(o))
        .addChannelOption((o) => o.setName("channel").setDescription("New channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName("refresh").setDescription("Force-refresh all panels now")));

  return [wd.toJSON()];
}

function requireServer(name) {
  const server = db.getServerByName(name) || (/^\d+$/.test(name) ? db.getServer(name) : null);
  if (!server) throw new Error(`No server named "${name}". Use \`/wd server list\`.`);
  return server;
}

function requirePanel(id, guildId) {
  const panel = db.getPanel(String(id).replace(/^#/, ""));
  if (!panel || panel.guild_id !== guildId) throw new Error(`No panel "${id}" in this Discord server. Use \`/wd panel list\`.`);
  return panel;
}

function parseBool(value) {
  const v = String(value).trim().toLowerCase();
  if (["on", "true", "yes", "1", "show"].includes(v)) return true;
  if (["off", "false", "no", "0", "hide"].includes(v)) return false;
  throw new Error(`Expected on/off, got "${value}".`);
}

function liveLine(server) {
  const l = liveOf(server.id);
  if (!l) return "⏳ not polled yet";
  if (l.error || !l.snap) return `🔴 offline — ${l.error || "no data"}`;
  const s = l.snap;
  return `🟢 ${s.players}/${s.maxPlayers} · ${s.mapDisplay}${s.mode ? ` · ${s.mode}` : ""}`;
}

export async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) return autocomplete(interaction);
  if (!interaction.isChatInputCommand() || interaction.commandName !== "wd") return;

  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  // Only the guild owner or members with Administrator may use /wd. Checked at runtime because the
  // default-permission gate below can be loosened by guild admins in Server Settings → Integrations.
  const isOwner = interaction.guild?.ownerId === interaction.user.id;
  if (!guildId || !(isOwner || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))) {
    throw new Error("Only the server owner or administrators can use /wd.");
  }
  // Servers (RCON credentials) are shared across guilds; only admin guilds may touch them.
  if (group === "server" && !bot.isAdminGuild(guildId)) {
    throw new Error("Server management is only allowed from the bot owner's admin guild. Panels can still be created here with `/wd panel create`.");
  }

  if (group === "server") {
    if (sub === "add") {
      const name = v.serverName(interaction.options.getString("name", true));
      if (db.getServerByName(name)) throw new Error(`A server named "${name}" already exists.`);
      const fields = {
        name,
        host: v.host(interaction.options.getString("host", true)),
        port: v.port(interaction.options.getInteger("port", true)),
        password: interaction.options.getString("password", true),
        connect: v.connect(interaction.options.getString("connect")),
        monitorToken: v.token(interaction.options.getString("monitor_token")),
      };
      await interaction.deferReply(EPHEMERAL);
      const server = db.addServer(fields);
      const live = await pollServer(server);
      await bot.refreshAllPanels({ force: true });
      await interaction.editReply(
        `✅ Added **${server.name}** (${server.host}:${server.port}) — ${liveLine(server)}\n` +
        (live.error ? "The server is not reachable right now; it will keep retrying.\n" : "") +
        `Show it on a panel with \`/wd panel create\` or \`/wd panel add\`.`
      );
      return;
    }
    if (sub === "remove") {
      const server = requireServer(interaction.options.getString("server", true));
      db.removeServer(server.id);
      clearCatalogCache(server.id);
      await interaction.reply({ content: `🗑️ Removed **${server.name}** and its history.`, ...EPHEMERAL });
      await bot.refreshAllPanels({ force: true });
      return;
    }
    if (sub === "list") {
      const servers = db.listServers();
      if (!servers.length) return interaction.reply({ content: "No servers yet. `/wd server add`", ...EPHEMERAL });
      const lines = servers.map((s) => `**${s.name}** \`${s.host}:${s.port}\`${s.connect ? ` · connect ${s.connect}` : ""}${s.monitor_token ? " · monitor bot" : ""}\n  ${liveLine(s)}`);
      return interaction.reply({ content: v.clip(lines.join("\n"), 1900), ...EPHEMERAL });
    }
    if (sub === "set") {
      const server = requireServer(interaction.options.getString("server", true));
      const key = interaction.options.getString("key", true);
      const raw = interaction.options.getString("value", true);
      const value = {
        name: v.serverName, host: v.host, port: v.port, connect: v.connect, monitor_token: v.token,
        password: (x) => { if (!x) throw new Error("Password can't be empty."); return x; },
      }[key](raw);
      if (key === "name" && db.getServerByName(value) && db.getServerByName(value).id !== server.id) throw new Error("Name already in use.");
      db.updateServer(server.id, { [key]: value });
      clearCatalogCache(server.id);
      await interaction.deferReply(EPHEMERAL);
      await pollServer(db.getServer(server.id));
      await bot.refreshAllPanels({ force: true });
      const shown = ["password", "monitor_token"].includes(key) ? "(hidden)" : value || "(cleared)";
      await interaction.editReply(`✅ **${server.name}** ${key} → ${shown}\n${liveLine(server)}`);
      return;
    }
    if (sub === "test") {
      const server = requireServer(interaction.options.getString("server", true));
      await interaction.deferReply(EPHEMERAL);
      try {
        const s = await querySnapshot(server);
        const factions = s.factions.map((f) => `${f.emoji} ${f.name}: ${Math.round(f.score)} (${f.players} players, $${f.cash})`).join("\n");
        await interaction.editReply([
          `✅ **${s.serverName}** — ${s.players}/${s.maxPlayers} players`,
          `Map: ${s.mapDisplay} (${s.map}) · Mode: ${s.mode || "-"} · Lighting: ${s.lighting || "-"} · Zone: ${s.alternator || "-"}`,
          `Match: ${Math.floor(s.matchSeconds / 60)} min · Score cap ${s.scoreCap} · tick ${s.scoreTick} · next: ${s.nextMap || "-"}`,
          `Economy: $${s.totalCash} total`,
          factions || "(no factions)",
        ].join("\n"));
      } catch (err) {
        await interaction.editReply(`❌ ${server.host}:${server.port} — ${v.clip(err.message, 300)}`);
      }
      return;
    }
  }

  if (group === "panel") {
    if (sub === "create") {
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const title = v.title(interaction.options.getString("title"));
      const list = interaction.options.getString("servers");
      let serverIds;
      if (list) {
        serverIds = list.split(",").map((n) => requireServer(n.trim()).id);
      } else {
        serverIds = db.listServers().map((s) => s.id);
      }
      if (serverIds.length > MAX_SERVERS_PER_PANEL) throw new Error(`Max ${MAX_SERVERS_PER_PANEL} servers per panel.`);
      await interaction.deferReply(EPHEMERAL);
      const panel = await bot.createPanel({
        guildId, channelId: channel.id,
        options: title ? { title } : {},
        serverIds,
      });
      await interaction.editReply(`✅ Panel **#${panel.id}** posted in <#${channel.id}> with ${serverIds.length} server(s). Tweak it with \`/wd panel set panel:${panel.id}\`.`);
      return;
    }
    if (sub === "delete") {
      const panel = requirePanel(interaction.options.getString("panel", true), guildId);
      await interaction.deferReply(EPHEMERAL);
      await bot.removePanel(panel);
      await interaction.editReply(`🗑️ Panel #${panel.id} deleted.`);
      return;
    }
    if (sub === "list") {
      const panels = db.listPanels(guildId);
      if (!panels.length) return interaction.reply({ content: "No panels here yet. `/wd panel create`", ...EPHEMERAL });
      const lines = panels.map((p) => {
        const names = db.panelServers(p.id).map((s) => s.name).join(", ") || "(no servers)";
        const ids = db.panelMessageIds(p);
        const link = ids.length ? `https://discord.com/channels/${p.guild_id}/${p.channel_id}/${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} more)` : ""}` : "(no message)";
        const off = PANEL_OPTION_KEYS.filter((k) => typeof PANEL_DEFAULTS[k] === "boolean" && p.options[k] !== PANEL_DEFAULTS[k]);
        return `**#${p.id}** ${p.options.title} — <#${p.channel_id}> ${link}\n  servers: ${names}${off.length ? `\n  toggled: ${off.map((k) => `${k}=${p.options[k] ? "on" : "off"}`).join(", ")}` : ""}`;
      });
      return interaction.reply({ content: v.clip(lines.join("\n"), 1900), ...EPHEMERAL });
    }
    if (sub === "add" || sub === "remove") {
      const panel = requirePanel(interaction.options.getString("panel", true), guildId);
      const server = requireServer(interaction.options.getString("server", true));
      if (sub === "add") {
        if (db.panelServerIds(panel.id).length >= MAX_SERVERS_PER_PANEL) throw new Error(`Max ${MAX_SERVERS_PER_PANEL} servers per panel.`);
        db.attachServer(panel.id, server.id);
      } else {
        db.detachServer(panel.id, server.id);
      }
      await interaction.deferReply(EPHEMERAL);
      await bot.refreshPanel(db.getPanel(panel.id), { force: true });
      await interaction.editReply(`✅ Panel #${panel.id}: ${sub === "add" ? "now shows" : "no longer shows"} **${server.name}**.`);
      return;
    }
    if (sub === "set") {
      const panel = requirePanel(interaction.options.getString("panel", true), guildId);
      const key = interaction.options.getString("key", true);
      const raw = interaction.options.getString("value", true).trim();
      let value;
      if (typeof PANEL_DEFAULTS[key] === "boolean") value = parseBool(raw);
      else if (key === "color") value = v.color(raw);
      else if (key === "banner") value = v.bannerUrl(raw);
      else if (key === "title") value = v.title(raw) || PANEL_DEFAULTS.title;
      else value = raw;
      db.setPanelOptions(panel.id, { [key]: value });
      await interaction.deferReply(EPHEMERAL);
      await bot.refreshPanel(db.getPanel(panel.id), { force: true });
      await interaction.editReply(`✅ Panel #${panel.id}: ${key} = ${typeof value === "boolean" ? (value ? "on" : "off") : value || "(default)"}`);
      return;
    }
    if (sub === "move") {
      const panel = requirePanel(interaction.options.getString("panel", true), guildId);
      const channel = interaction.options.getChannel("channel", true);
      await interaction.deferReply(EPHEMERAL);
      await bot.movePanel(panel, channel.id);
      await interaction.editReply(`✅ Panel #${panel.id} moved to <#${channel.id}>.`);
      return;
    }
    if (sub === "refresh") {
      await interaction.deferReply(EPHEMERAL);
      for (const server of db.listServers()) await pollServer(server);
      await bot.refreshAllPanels({ force: true });
      await interaction.editReply("🔄 Refreshed.");
      return;
    }
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const q = String(focused.value || "").toLowerCase();
  let choices = [];
  if (focused.name === "server") {
    choices = db.listServers()
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({ name: v.clip(`${s.name} (${s.host}:${s.port})`, 100), value: s.name }));
  } else if (focused.name === "panel") {
    choices = db.listPanels(interaction.guildId)
      .filter((p) => `${p.id} ${p.options.title}`.toLowerCase().includes(q))
      .map((p) => ({ name: v.clip(`#${p.id} ${p.options.title}`, 100), value: String(p.id) }));
  }
  await interaction.respond(choices.slice(0, 25)).catch(() => null);
}
