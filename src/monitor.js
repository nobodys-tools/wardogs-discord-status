// Optional per-server "monitor" bots: a separate bot account whose nickname shows the player count
// and whose custom status shows the map. Needs only the "Change Nickname" permission.
import { ActivityType, Client, GatewayIntentBits } from "discord.js";
import { listServers } from "./db.js";
import { liveOf } from "./poller.js";

const clients = new Map(); // serverId -> { token, client }
const failedTokens = new Map(); // token -> timestamp of last failed login (retried after RETRY_MS)
const RETRY_MS = 15 * 60_000;

function clip(text, max) {
  text = String(text || "");
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function viewOf(server) {
  const live = liveOf(server.id);
  if (!live?.snap || live.error) {
    return { nick: clip(`🔴 ${server.name}`, 32), state: "Offline", status: "dnd" };
  }
  const s = live.snap;
  const count = s.maxPlayers > 0 ? `${s.players}/${s.maxPlayers}` : String(s.players);
  return {
    nick: clip(`🟢 ${count} · ${server.name}`, 32),
    state: clip([s.mapDisplay, s.mode].filter(Boolean).join(" · ") || "Online", 128),
    status: "online",
  };
}

async function apply(server, client) {
  if (!client.isReady()) return;
  const view = viewOf(server);
  client.user.setPresence({
    status: view.status,
    activities: [{ type: ActivityType.Custom, name: "Status", state: view.state }],
  });
  for (const guild of client.guilds.cache.values()) {
    try {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      if (me.nickname !== view.nick) await me.setNickname(view.nick);
    } catch (err) {
      console.warn(`[monitor] ${server.name}: cannot set nickname in ${guild.name}: ${err.message}`);
    }
  }
}

function ensureClient(server) {
  const existing = clients.get(server.id);
  if (existing && existing.token === server.monitor_token) return existing.client;
  if (existing) { existing.client.destroy(); clients.delete(server.id); }
  const failedAt = failedTokens.get(server.monitor_token);
  if (failedAt && Date.now() - failedAt < RETRY_MS) return null;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once("clientReady", () => console.log(`[monitor] ${server.name}: logged in as ${client.user.tag}`));
  client.on("error", (err) => console.warn(`[monitor] ${server.name}: ${err.message}`));
  clients.set(server.id, { token: server.monitor_token, client });
  // Not awaited: login blocks until the gateway is ready and must not stall the poll loop.
  client.login(server.monitor_token).catch((err) => {
    console.error(`[monitor] ${server.name}: login failed — ${err.message} (retrying in ${RETRY_MS / 60_000} min)`);
    failedTokens.set(server.monitor_token, Date.now());
    clients.delete(server.id);
    client.destroy();
  });
  return client;
}

/** Called after every poll round. Logs in / drops monitor bots as the config changes. */
export async function refreshMonitors() {
  const servers = listServers();
  const wanted = new Set();
  for (const server of servers) {
    if (!server.monitor_token) continue;
    wanted.add(server.id);
    const client = ensureClient(server);
    if (client?.isReady()) await apply(server, client).catch((err) => console.warn(`[monitor] ${server.name}: ${err.message}`));
  }
  for (const [id, entry] of clients) {
    if (!wanted.has(id)) { entry.client.destroy(); clients.delete(id); }
  }
}

export function stopMonitors() {
  for (const { client } of clients.values()) client.destroy();
  clients.clear();
}
