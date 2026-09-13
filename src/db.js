import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "monitor.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS servers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    host          TEXT NOT NULL,
    port          INTEGER NOT NULL,
    password      TEXT NOT NULL,
    connect       TEXT NOT NULL DEFAULT '',
    monitor_token TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    options    TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panel_servers (
    panel_id  INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (panel_id, server_id)
  );

  CREATE TABLE IF NOT EXISTS samples (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts        INTEGER NOT NULL,
    players   INTEGER NOT NULL,
    max_players INTEGER NOT NULL,
    map       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS samples_server_ts ON samples(server_id, ts);
`);

// Additive migrations for older databases.
const sampleCols = new Set(db.prepare("PRAGMA table_info(samples)").all().map((c) => c.name));
if (!sampleCols.has("total_cash")) db.exec("ALTER TABLE samples ADD COLUMN total_cash INTEGER NOT NULL DEFAULT 0");
if (!sampleCols.has("faction_cash")) db.exec("ALTER TABLE samples ADD COLUMN faction_cash TEXT NOT NULL DEFAULT '{}'");
if (!sampleCols.has("match_start")) db.exec("ALTER TABLE samples ADD COLUMN match_start INTEGER NOT NULL DEFAULT 0");

// Panel display options and their defaults. Everything the embed can show is a toggle here.
export const PANEL_DEFAULTS = {
  title: "Wardogs Servers",
  banner: "",          // image URL shown on top, "" = none
  color: "",           // accent hex, "" = config.defaultColor
  chart: true,         // 24h player graph image per server
  history: true,       // "24h: peak / avg" text line
  map: true,
  mode: true,          // experience / game mode
  lighting: true,
  match: true,         // match start time
  score: true,
  tick: false,         // score tick value + min/max range (raw scoreTick from the API)
  economy: true,       // "cash this match": total + per faction with change since match start
  cashchart: false,    // cash-over-time image for the current match
  top: false,          // top 3 players by kills
  nextmap: true,
  players: false,      // full player list (names) — long, off by default
  footer: true,        // "updated <relative time>"
};

export const PANEL_OPTION_KEYS = Object.keys(PANEL_DEFAULTS);

const now = () => Date.now();

function rowToServer(row) {
  return row ? { ...row } : null;
}

function rowToPanel(row) {
  if (!row) return null;
  let options = {};
  try { options = JSON.parse(row.options || "{}"); } catch { /* corrupt json → defaults */ }
  return { ...row, options: { ...PANEL_DEFAULTS, ...options } };
}

// ---- servers -------------------------------------------------------------

export function listServers() {
  return db.prepare("SELECT * FROM servers ORDER BY id").all().map(rowToServer);
}

export function getServer(id) {
  return rowToServer(db.prepare("SELECT * FROM servers WHERE id = ?").get(Number(id)));
}

export function getServerByName(name) {
  return rowToServer(db.prepare("SELECT * FROM servers WHERE name = ? COLLATE NOCASE").get(String(name).trim()));
}

export function addServer({ name, host, port, password, connect = "", monitorToken = "" }) {
  const res = db.prepare(
    "INSERT INTO servers (name, host, port, password, connect, monitor_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(name.trim(), host.trim(), Number(port), password, connect || "", monitorToken || "", now());
  return getServer(res.lastInsertRowid);
}

const SERVER_COLUMNS = { name: "name", host: "host", port: "port", password: "password", connect: "connect", monitor_token: "monitor_token" };

export function updateServer(id, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const col = SERVER_COLUMNS[key];
    if (!col) continue;
    db.prepare(`UPDATE servers SET ${col} = ? WHERE id = ?`).run(col === "port" ? Number(value) : String(value), Number(id));
  }
  return getServer(id);
}

export function removeServer(id) {
  return db.prepare("DELETE FROM servers WHERE id = ?").run(Number(id)).changes > 0;
}

// ---- panels --------------------------------------------------------------

export function listPanels(guildId) {
  const rows = guildId
    ? db.prepare("SELECT * FROM panels WHERE guild_id = ? ORDER BY id").all(String(guildId))
    : db.prepare("SELECT * FROM panels ORDER BY id").all();
  return rows.map(rowToPanel);
}

export function getPanel(id) {
  return rowToPanel(db.prepare("SELECT * FROM panels WHERE id = ?").get(Number(id)));
}

export function addPanel({ guildId, channelId, options = {} }) {
  const res = db.prepare(
    "INSERT INTO panels (guild_id, channel_id, options, created_at) VALUES (?, ?, ?, ?)"
  ).run(String(guildId), String(channelId), JSON.stringify(options), now());
  return getPanel(res.lastInsertRowid);
}

// A panel may span several Discord messages; ids are stored comma-separated in message_id.
export function setPanelMessages(id, channelId, messageIds) {
  db.prepare("UPDATE panels SET channel_id = ?, message_id = ? WHERE id = ?").run(String(channelId), (messageIds || []).join(","), Number(id));
}

export function panelMessageIds(panel) {
  return String(panel.message_id || "").split(",").filter(Boolean);
}

export function setPanelOptions(id, patch) {
  const panel = getPanel(id);
  if (!panel) return null;
  const merged = { ...panel.options, ...patch };
  // Only persist non-default values so new defaults apply to old panels.
  const stored = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k in PANEL_DEFAULTS && v !== PANEL_DEFAULTS[k]) stored[k] = v;
  }
  db.prepare("UPDATE panels SET options = ? WHERE id = ?").run(JSON.stringify(stored), Number(id));
  return getPanel(id);
}

export function removePanel(id) {
  return db.prepare("DELETE FROM panels WHERE id = ?").run(Number(id)).changes > 0;
}

export function panelServers(panelId) {
  return db.prepare(`
    SELECT s.* FROM panel_servers ps JOIN servers s ON s.id = ps.server_id
    WHERE ps.panel_id = ? ORDER BY ps.position, s.id
  `).all(Number(panelId)).map(rowToServer);
}

export function panelServerIds(panelId) {
  return panelServers(panelId).map((s) => s.id);
}

export function attachServer(panelId, serverId) {
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM panel_servers WHERE panel_id = ?").get(Number(panelId)).p;
  db.prepare("INSERT OR IGNORE INTO panel_servers (panel_id, server_id, position) VALUES (?, ?, ?)").run(Number(panelId), Number(serverId), pos);
}

export function detachServer(panelId, serverId) {
  return db.prepare("DELETE FROM panel_servers WHERE panel_id = ? AND server_id = ?").run(Number(panelId), Number(serverId)).changes > 0;
}

export function setPanelServerList(panelId, serverIds) {
  db.prepare("DELETE FROM panel_servers WHERE panel_id = ?").run(Number(panelId));
  const ins = db.prepare("INSERT OR IGNORE INTO panel_servers (panel_id, server_id, position) VALUES (?, ?, ?)");
  serverIds.forEach((sid, i) => ins.run(Number(panelId), Number(sid), i));
}

// ---- samples -------------------------------------------------------------

const insertSample = db.prepare(
  "INSERT INTO samples (server_id, ts, players, max_players, map, total_cash, faction_cash, match_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);

/** Match start derived from a snapshot (ms), rounded so per-poll jitter doesn't split a match. 0 = unknown. */
export function matchStartOf(snap) {
  if (!(Number(snap.matchSeconds) > 0)) return 0;
  const ms = (snap.at || now()) - Number(snap.matchSeconds) * 1000;
  return Math.round(ms / 10_000) * 10_000;
}

export function addSample(serverId, snap) {
  const factionCash = Object.fromEntries((snap.factions || []).map((f) => [f.name, Math.round(f.cash || 0)]));
  insertSample.run(
    Number(serverId), now(), Number(snap.players) || 0, Number(snap.maxPlayers) || 0, String(snap.map || ""),
    Math.round(Number(snap.totalCash) || 0), JSON.stringify(factionCash), matchStartOf(snap)
  );
}

/** All samples of the current match (for the cash chart). */
export function matchSamples(serverId, matchStart) {
  if (!matchStart) return [];
  return db.prepare(
    "SELECT ts, total_cash AS totalCash, faction_cash AS factionCash FROM samples WHERE server_id = ? AND match_start BETWEEN ? AND ? ORDER BY ts"
  ).all(Number(serverId), Number(matchStart) - 60_000, Number(matchStart) + 60_000).map((r) => {
    let factionCash = {};
    try { factionCash = JSON.parse(r.factionCash || "{}"); } catch { /* ignore */ }
    return { ts: r.ts, totalCash: r.totalCash, factionCash };
  });
}

/** Earliest sample of the current match (cash baseline), or null if this is the first one. */
export function matchBaseline(serverId, matchStart) {
  if (!matchStart) return null;
  const row = db.prepare(
    "SELECT ts, total_cash AS totalCash, faction_cash AS factionCash FROM samples WHERE server_id = ? AND match_start BETWEEN ? AND ? ORDER BY ts LIMIT 1"
  ).get(Number(serverId), Number(matchStart) - 60_000, Number(matchStart) + 60_000);
  if (!row) return null;
  let factionCash = {};
  try { factionCash = JSON.parse(row.factionCash || "{}"); } catch { /* ignore */ }
  return { ts: row.ts, totalCash: row.totalCash, factionCash };
}

export function samplesSince(serverId, sinceTs) {
  return db.prepare("SELECT ts, players, max_players AS maxPlayers, map FROM samples WHERE server_id = ? AND ts >= ? ORDER BY ts")
    .all(Number(serverId), Number(sinceTs));
}

export function pruneSamples(olderThanTs) {
  return db.prepare("DELETE FROM samples WHERE ts < ?").run(Number(olderThanTs)).changes;
}

// 24h summary + bucketed series for charts.
export function history(serverId, { hours = 24, buckets = 48 } = {}) {
  const end = now();
  const start = end - hours * 3600_000;
  const rows = samplesSince(serverId, start);
  const width = (end - start) / buckets;
  const series = Array.from({ length: buckets }, () => null);
  let peak = 0, sum = 0, n = 0, peakAt = null;
  for (const r of rows) {
    const i = Math.min(buckets - 1, Math.floor((r.ts - start) / width));
    series[i] = series[i] === null ? r.players : Math.max(series[i], r.players);
    if (r.players > peak) { peak = r.players; peakAt = r.ts; }
    sum += r.players; n++;
  }
  return {
    start, end, series,
    peak, peakAt,
    avg: n ? sum / n : 0,
    samples: n,
  };
}

export { db };
