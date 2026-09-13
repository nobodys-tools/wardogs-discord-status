// Client for the Wardogs RCON HTTP API (same one rcon.wardogs.com talks to).
//   GET /v1/status, /v1/players, /v1/rotation, /v1/catalog/maps
//   Authorization: Bearer <rcon password>
import { config } from "./config.js";

const CATALOG_TTL_MS = 60 * 60_000;
const catalogCache = new Map(); // serverId -> { at, maps: Map<id, display>, experiences: Map<id, display> }

async function rconGet(server, path) {
  const url = `http://${server.host}:${server.port}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${server.password}` },
    signal: AbortSignal.timeout(config.rconTimeoutMs),
    cache: "no-store",
  });
  if (Number(res.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("Response too large");
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Response too large");
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
  if (!res.ok) {
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Not a JSON API response");
  return body;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function catalog(server) {
  const cached = catalogCache.get(server.id);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached;
  const entry = { at: Date.now(), maps: new Map(), experiences: new Map() };
  const [maps, exps] = await Promise.allSettled([
    rconGet(server, "/v1/catalog/maps"),
    rconGet(server, "/v1/catalog/experiences"),
  ]);
  if (maps.status === "fulfilled") {
    for (const m of maps.value.maps || []) entry.maps.set(m.id, m.displayName || m.id);
  }
  if (exps.status === "fulfilled") {
    for (const e of exps.value.experiences || []) entry.experiences.set(e.id, e.displayName || e.id);
  }
  catalogCache.set(server.id, entry);
  return entry;
}

function factionColor(hex) {
  // Map a faction colour to the closest circle emoji.
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return "⚪";
  const v = parseInt(m[1], 16);
  const r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  if (r > g + 40 && r > b + 40) return "🔴";
  if (b > r + 40 && b > g + 40) return "🔵";
  if (g > r + 40 && g > b + 40) return "🟢";
  if (r > 150 && g > 150 && b < 100) return "🟡";
  if (r > 150 && g > 80 && b < 80) return "🟠";
  if (r > 100 && b > 100 && g < 100) return "🟣";
  return "⚪";
}

/**
 * Poll one server. Returns a normalised snapshot or throws when /v1/status is unreachable.
 * Players / rotation / catalog failures are tolerated (fields fall back).
 */
export async function querySnapshot(server) {
  const [statusRes, playersRes, rotationRes, cat] = await Promise.all([
    rconGet(server, "/v1/status"),
    rconGet(server, "/v1/players").catch(() => null),
    rconGet(server, "/v1/rotation").catch(() => null),
    catalog(server).catch(() => ({ maps: new Map(), experiences: new Map() })),
  ]);

  const s = statusRes;
  if (!("players" in s) && !("map" in s) && !("serverName" in s)) throw new Error("Not a Wardogs RCON API (no status fields)");
  const players = Array.isArray(playersRes?.players) ? playersRes.players : null;

  const factions = (Array.isArray(s.factionScores) ? s.factionScores : []).map((f) => ({
    name: String(f.name || ""),
    colorHex: String(f.colorHex || ""),
    emoji: factionColor(f.colorHex),
    score: Number(f.score || 0),
    players: 0,
    cash: 0,
  }));
  const byName = new Map(factions.map((f) => [f.name.toLowerCase(), f]));
  // Player rows carry a faction *label* (RED/BLU/GRN — see FACTION_HEX in the official tool) while
  // factionScores carry names (Valkyra/Lonestar/…). Match by name, by name prefix, or by colour.
  const EMOJI_LABEL = { "🔴": "RED", "🔵": "BLU", "🟢": "GRN", "🟡": "YEL", "🟠": "ORG", "🟣": "PUR" };
  const byLabel = new Map();
  for (const f of factions) {
    byLabel.set(f.name.slice(0, 3).toUpperCase(), f);
    if (EMOJI_LABEL[f.emoji]) byLabel.set(EMOJI_LABEL[f.emoji], f);
  }

  let totalCash = 0;
  const playerList = (players || []).map((p) => {
    const key = String(p.faction || "").trim();
    const f = byName.get(key.toLowerCase()) || byLabel.get(key.toUpperCase()) || null;
    const cash = Number(p.cash || 0);
    totalCash += cash;
    if (f) { f.players += 1; f.cash += cash; }
    return {
      name: String(p.name || "?"),
      steamId: String(p.steamId || ""),
      faction: f ? f.name : key,
      emoji: f ? f.emoji : "⚪",
      kills: Number(p.kills || 0),
      deaths: Number(p.deaths || 0),
      cash,
      ping: Number(p.pingMs ?? p.ping ?? 0),
    };
  });

  const rotationEntries = Array.isArray(rotationRes?.entries) ? rotationRes.entries : [];
  const nextEntry = rotationEntries.find((e) => e.status === "next")
    || (s.rotation && rotationEntries[s.rotation.nextIndex]) || null;

  const mapId = String(s.map || "");
  const experiences = Array.isArray(s.experiences) ? s.experiences : [];

  return {
    at: Date.now(),
    serverName: String(s.serverName || server.name),
    map: mapId,
    mapDisplay: cat.maps.get(mapId) || mapId,
    experiences,
    mode: experiences.map((e) => cat.experiences.get(e) || prettyId(e)).join(" + "),
    lighting: prettyId(s.lighting),
    alternator: prettyZone(s.alternator),
    scoreTick: Number(s.scoreTick?.current ?? s.scoreTick ?? 0),
    scoreTickMin: Number(s.scoreTick?.min ?? 0),
    scoreTickMax: Number(s.scoreTick?.max ?? 0),
    scoreCap: Number(s.scoreCap || 0),
    matchSeconds: Number(s.matchSeconds || 0),
    players: players ? players.length : Number(s.players?.current ?? s.playerCount ?? 0),
    maxPlayers: Number(s.players?.max ?? s.maxPlayers ?? 0),
    factions: factions.sort((a, b) => b.score - a.score),
    totalCash,
    playerList,
    nextMap: nextEntry ? (cat.maps.get(nextEntry.map) || nextEntry.map) : "",
    nextMode: nextEntry ? (nextEntry.experiences || []).map((e) => cat.experiences.get(e) || prettyId(e)).join(" + ") : "",
  };
}

export function prettyId(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function prettyZone(alternator) {
  const parts = String(alternator || "").split(".");
  return parts.length > 2 ? parts.slice(1).join(" ") : "";
}

export function clearCatalogCache(serverId) {
  if (serverId === undefined) catalogCache.clear();
  else catalogCache.delete(serverId);
}
