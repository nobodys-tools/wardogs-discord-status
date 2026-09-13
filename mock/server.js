// Stand-alone mock of the Wardogs RCON HTTP API, modelled on the demo data of rcon.wardogs.com.
// Implements every route the official web tool uses, so you can point http://rcon.wardogs.com at it
// (host 127.0.0.1, port 7780, password "mock") as well as this bot. State is in-memory and drifts:
// players join/leave, scores tick, cash moves, matches rotate.
//   MOCK_PORT (default 7780), MOCK_PASSWORD (default "mock"), MOCK_NAME, MOCK_MAX_PLAYERS
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 7780);
const PASSWORD = process.env.MOCK_PASSWORD || "mock";
const NAME = process.env.MOCK_NAME || "Wardogs Mock Server [EU-TEST-02]";
const MAX_PLAYERS = Number(process.env.MOCK_MAX_PLAYERS || 64);

const FACTIONS = [
  { name: "Valkyra", label: "RED", colorHex: "#D86060" },
  { name: "Lonestar", label: "BLU", colorHex: "#5B95D8" },
  { name: "Manticore", label: "GRN", colorHex: "#7BC462" },
];
const MAPS = [
  { id: "Kavkazi", displayName: "Bakurani" },
  { id: "Europe", displayName: "Ozeti" },
  { id: "NorthAmerica", displayName: "Zestafona" },
];
const EXPERIENCES = [
  { id: "Bakurani_KOTH_01", displayName: "King of the Hill" },
  { id: "Madrid_KOTH_01", displayName: "King of the Hill" },
  { id: "Detroit_KOTH_01", displayName: "King of the Hill" },
  { id: "KOTH_InfantryOnly", displayName: "Infantry" },
  { id: "KOTH_Hardcore", displayName: "Hardcore" },
];
const EXPERIENCES_BY_MAP = {
  Kavkazi: ["Bakurani_KOTH_01", "KOTH_InfantryOnly", "KOTH_Hardcore"],
  Europe: ["Madrid_KOTH_01", "KOTH_InfantryOnly", "KOTH_Hardcore"],
  NorthAmerica: ["Detroit_KOTH_01", "KOTH_InfantryOnly", "KOTH_Hardcore"],
};
const LIGHTINGS = ["DayStartClear", "DayEarlyClear", "DayEarlyFog", "DayClear", "DayLateClear", "DayLateGray", "DayLateGrayFog", "DayEndClear"]
  .map((id) => ({ id, displayName: id.replace(/([a-z])([A-Z])/g, "$1 $2") }));
const ALTERNATORS_BY_MAP = {
  Kavkazi: [
    { tag: "ZoneAlternator.Factory.Circle", displayName: "Bakurani Factory Circle" },
    { tag: "ZoneAlternator.Factory.Split", displayName: "Bakurani Factory Split" },
  ],
};
const NAMES = ["Ghostpepper", "Mad Marmalade", "T0XIC_AVENGER", "Sgt. Bricktop", "Nomad", "Willowisp", "KillustratorPro",
  "Baron von Blam", "QuietStorm", "Dutchie", "Rooikat", "Last_Mag", "Copperhead", "VelvetThunder", "Brick", "Saltmine",
  "Ostrich Wrangler", "0xDEADBEEF", "Pretty Average", "Whistler", "Marzipan", "Kodiak", "Snaggletooth", "Pelican"];

const state = {
  rotation: [
    { map: "Kavkazi", experiences: ["Bakurani_KOTH_01"], lighting: "DayLateClear", zoneAlternator: "ZoneAlternator.Factory.Circle", denied: false },
    { map: "Europe", experiences: ["KOTH_InfantryOnly"], lighting: "DayEarlyFog", zoneAlternator: "", denied: false },
    { map: "NorthAmerica", experiences: ["Detroit_KOTH_01"], lighting: "DayEndClear", zoneAlternator: "", denied: false },
  ],
  rotationIndex: 0,
  current: null, // { map, experiences, lighting, zoneAlternator }
  matchStart: Date.now(),
  scores: FACTIONS.map(() => 0),
  players: [],
  bans: [],
  reserved: [],
  sponsorUrl: "",
  audit: [],
  nextSteam: 76561198100000200,
};
state.current = { ...state.rotation[0] };

function log(event, detail = "") {
  state.audit.unshift({ timestampUtc: new Date().toISOString(), peer: "127.0.0.1:0", sessionId: "mock", event, detail });
  state.audit.length = Math.min(state.audit.length, 500);
}

function spawnPlayer() {
  const f = FACTIONS[Math.floor(Math.random() * FACTIONS.length)];
  state.players.push({
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    steamId: String(state.nextSteam++),
    faction: f.label,
    kills: 0, deaths: 0, cash: 500 + Math.floor(Math.random() * 1500), pingMs: 20 + Math.floor(Math.random() * 90),
  });
}
for (let i = 0; i < 12; i++) spawnPlayer();
log("SERVER", "mock started");

function newMatch(entry) {
  state.current = { ...entry };
  state.matchStart = Date.now();
  state.scores = FACTIONS.map(() => 0);
  for (const p of state.players) { p.kills = 0; p.deaths = 0; p.cash = 0; }
}

function nextIndex() { return (state.rotationIndex + 1) % state.rotation.length; }

function tick() {
  const cap = 100;
  state.scores = state.scores.map((s, i) => Math.min(cap, s + Math.random() * 0.8 * (i === 0 ? 1.2 : 1)));
  for (const p of state.players) {
    if (Math.random() < 0.12) { p.kills++; p.cash += 150; const v = state.players[Math.floor(Math.random() * state.players.length)]; if (v !== p) v.deaths++; }
    if (p.cash >= 200 && Math.random() < 0.05) p.cash -= Math.min(p.cash, 150 + Math.floor(Math.random() * 300));
    p.pingMs = Math.max(5, p.pingMs + Math.floor(Math.random() * 9) - 4);
  }
  // population follows a slow sine over ~2h plus noise
  const target = Math.round(MAX_PLAYERS * (0.35 + 0.3 * Math.sin(Date.now() / 3_600_000)));
  if (state.players.length < target && Math.random() < 0.5 && state.players.length < MAX_PLAYERS) spawnPlayer();
  else if (state.players.length > target && Math.random() < 0.5 && state.players.length > 0) state.players.splice(Math.floor(Math.random() * state.players.length), 1);
  if (state.scores.some((s) => s >= cap) || Date.now() - state.matchStart > 40 * 60_000) {
    state.rotationIndex = nextIndex();
    newMatch(state.rotation[state.rotationIndex]);
    log("MATCH", `rotation advanced to ${state.current.map}`);
  }
}
setInterval(tick, 3000);

// ---- http ------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Private-Network": "true", // Chrome: public site → localhost
  "Access-Control-Max-Age": "600",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}
const fail = (res, status, message) => json(res, status, { error: { message } });

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

const ROUTES = [
  "GET /v1/capabilities", "GET /v1/status", "GET /v1/players", "POST /v1/players/{steamId}/kick", "POST /v1/players/{steamId}/kill",
  "POST /v1/players/{steamId}/message", "PATCH /v1/players/{steamId}", "POST /v1/broadcast", "GET /v1/bans", "POST /v1/bans",
  "DELETE /v1/bans/{steamId}", "GET /v1/reserved-slots", "POST /v1/reserved-slots", "DELETE /v1/reserved-slots/{steamId}",
  "GET /v1/catalog/maps", "GET /v1/catalog/experiences", "GET /v1/catalog/lightings", "GET /v1/catalog/maps/{map}/experiences",
  "GET /v1/catalog/maps/{map}/alternators", "POST /v1/match/map", "POST /v1/match/end", "POST /v1/match/restart", "PUT /v1/world/lighting",
  "GET /v1/rotation", "POST /v1/rotation/entries", "DELETE /v1/rotation/entries/{index}", "POST /v1/rotation/entries/{index}/move",
  "POST /v1/rotation/save", "GET /v1/audit", "GET /v1/sponsor", "PUT /v1/sponsor", "GET /v1/config", "PATCH /v1/settings",
];

function findPlayer(res, steamId) {
  const p = state.players.find((x) => x.steamId === steamId);
  if (!p) fail(res, 404, `No player with steamId ${steamId}.`);
  return p;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const auth = req.headers.authorization || "";
  if (PASSWORD && auth !== `Bearer ${PASSWORD}`) return fail(res, 401, "Unauthorized");

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const M = req.method;
  const body = ["POST", "PUT", "PATCH"].includes(M) ? await readJson(req) : {};
  const cur = state.current;
  let m;

  if (M === "GET" && path === "/v1/capabilities") return json(res, 200, { name: NAME, version: "mock", routes: ROUTES, config: { writable: false } });

  if (M === "GET" && path === "/v1/status") {
    return json(res, 200, {
      serverName: NAME,
      map: cur.map,
      experiences: cur.experiences,
      lighting: cur.lighting,
      alternator: cur.zoneAlternator || "",
      scoreTick: { current: 24, min: 18, max: 30 },
      scoreCap: 100,
      matchSeconds: Math.floor((Date.now() - state.matchStart) / 1000),
      players: { current: state.players.length, max: MAX_PLAYERS },
      factionScores: FACTIONS.map((f, i) => ({ name: f.name, colorHex: f.colorHex, score: Math.round(state.scores[i] * 10) / 10 })),
      rotation: { nowIndex: state.rotationIndex, nextIndex: nextIndex() },
    });
  }

  // players
  if (M === "GET" && path === "/v1/players") return json(res, 200, { players: state.players });
  if ((m = /^\/v1\/players\/([^/]+)\/(kick|kill|message)$/.exec(path)) && M === "POST") {
    const p = findPlayer(res, decodeURIComponent(m[1])); if (!p) return;
    if (m[2] === "kick") { state.players = state.players.filter((x) => x !== p); log("COMMAND", `kick ${p.name} ${body.reason || ""}`.trim()); return json(res, 200, { message: `Kicked ${p.name}.` }); }
    if (m[2] === "kill") { p.deaths++; log("COMMAND", `kill ${p.name}`); return json(res, 200, { message: `Killed ${p.name}.` }); }
    log("COMMAND", `message ${p.name}: ${body.message || ""}`); return json(res, 200, { message: `Message sent to ${p.name}.` });
  }
  if ((m = /^\/v1\/players\/([^/]+)$/.exec(path)) && M === "PATCH") {
    const p = findPlayer(res, decodeURIComponent(m[1])); if (!p) return;
    const f = FACTIONS.find((x) => x.name === body.faction || x.label === body.faction);
    if (!f) return fail(res, 400, "Unknown faction.");
    p.faction = f.label; log("COMMAND", `team ${p.name} -> ${f.name}`);
    return json(res, 200, { message: `${p.name} moved to ${f.name}.`, faction: f.name });
  }
  if (M === "POST" && path === "/v1/broadcast") { log("COMMAND", `broadcast: ${body.message || ""}`); return json(res, 200, { message: "Broadcast sent." }); }

  // bans / reserved slots
  if (M === "GET" && path === "/v1/bans") return json(res, 200, { bans: state.bans });
  if (M === "POST" && path === "/v1/bans") {
    const steamId = String(body.steamId || ""); if (!steamId) return fail(res, 400, "steamId required.");
    const p = state.players.find((x) => x.steamId === steamId);
    state.players = state.players.filter((x) => x.steamId !== steamId);
    state.bans.unshift({ steamId, bannedAtUtc: new Date().toISOString(), bannedBy: "admin", reason: body.reason || "" });
    log("COMMAND", `ban ${p?.name || steamId} ${body.reason || ""}`.trim());
    return json(res, 200, { message: `Banned ${p?.name || steamId}.` });
  }
  if ((m = /^\/v1\/bans\/([^/]+)$/.exec(path)) && M === "DELETE") {
    const id = decodeURIComponent(m[1]); state.bans = state.bans.filter((b) => b.steamId !== id); log("COMMAND", `unban ${id}`);
    return json(res, 200, { message: `Unbanned ${id}.` });
  }
  if (M === "GET" && path === "/v1/reserved-slots") return json(res, 200, { reservedSlots: state.reserved });
  if (M === "POST" && path === "/v1/reserved-slots") {
    const id = String(body.steamId || ""); if (!id) return fail(res, 400, "steamId required.");
    if (!state.reserved.includes(id)) state.reserved.push(id); log("COMMAND", `reserve ${id}`);
    return json(res, 200, { message: `Reserved slot for ${id}.` });
  }
  if ((m = /^\/v1\/reserved-slots\/([^/]+)$/.exec(path)) && M === "DELETE") {
    const id = decodeURIComponent(m[1]); state.reserved = state.reserved.filter((x) => x !== id); log("COMMAND", `unreserve ${id}`);
    return json(res, 200, { message: `Removed reserved slot for ${id}.` });
  }

  // catalog
  if (M === "GET" && path === "/v1/catalog/maps") return json(res, 200, { maps: MAPS });
  if (M === "GET" && path === "/v1/catalog/experiences") return json(res, 200, { experiences: EXPERIENCES });
  if (M === "GET" && path === "/v1/catalog/lightings") return json(res, 200, { lightings: LIGHTINGS });
  if ((m = /^\/v1\/catalog\/maps\/([^/]+)\/experiences$/.exec(path)) && M === "GET") return json(res, 200, { experiences: EXPERIENCES_BY_MAP[decodeURIComponent(m[1])] || [] });
  if ((m = /^\/v1\/catalog\/maps\/([^/]+)\/alternators$/.exec(path)) && M === "GET") return json(res, 200, { alternators: ALTERNATORS_BY_MAP[decodeURIComponent(m[1])] || [] });

  // match / world
  if (M === "POST" && path === "/v1/match/map") {
    if (!MAPS.some((x) => x.id === body.map)) return fail(res, 400, "Unknown map.");
    newMatch({ map: body.map, experiences: body.experiences?.length ? body.experiences : [EXPERIENCES_BY_MAP[body.map][0]], lighting: body.lighting || "DayClear", zoneAlternator: body.zoneAlternator || "" });
    log("COMMAND", `changemap ${body.map}`); return json(res, 200, { message: `Changing map to ${body.map}.` });
  }
  if (M === "POST" && path === "/v1/match/end") { state.rotationIndex = nextIndex(); newMatch(state.rotation[state.rotationIndex]); log("COMMAND", "endmatch"); return json(res, 200, { message: "Match ended." }); }
  if (M === "POST" && path === "/v1/match/restart") { newMatch(cur); log("COMMAND", "restartmatch"); return json(res, 200, { message: "Match restarted." }); }
  if (M === "PUT" && path === "/v1/world/lighting") { cur.lighting = body.lighting || cur.lighting; log("COMMAND", `lighting ${cur.lighting}`); return json(res, 200, { message: `Lighting set to ${cur.lighting}.` }); }

  // rotation
  if (M === "GET" && path === "/v1/rotation") {
    return json(res, 200, {
      enabled: true, mode: "ordered",
      entries: state.rotation.map((e, i) => ({ ...e, status: i === state.rotationIndex ? "now" : i === nextIndex() ? "next" : "" })),
    });
  }
  if (M === "POST" && path === "/v1/rotation/entries") {
    if (!MAPS.some((x) => x.id === body.map)) return fail(res, 400, "Unknown map.");
    state.rotation.push({ map: body.map, experiences: body.experiences?.length ? body.experiences : [EXPERIENCES_BY_MAP[body.map][0]], lighting: body.lighting || "DayClear", zoneAlternator: body.zoneAlternator || "", denied: false });
    log("COMMAND", `addrotation ${body.map}`); return json(res, 200, { message: `Added rotation entry ${state.rotation.length - 1} (${body.map}).` });
  }
  if ((m = /^\/v1\/rotation\/entries\/(\d+)$/.exec(path)) && M === "DELETE") {
    const i = Number(m[1]); if (i >= state.rotation.length) return fail(res, 404, "No such entry."); if (state.rotation.length === 1) return fail(res, 400, "Cannot remove the last entry.");
    state.rotation.splice(i, 1); if (state.rotationIndex >= state.rotation.length) state.rotationIndex = 0;
    log("COMMAND", `removerotation ${i}`); return json(res, 200, { message: `Removed rotation entry ${i}.` });
  }
  if ((m = /^\/v1\/rotation\/entries\/(\d+)\/move$/.exec(path)) && M === "POST") {
    const i = Number(m[1]); const to = body.direction === "up" ? i - 1 : body.direction === "down" ? i + 1 : Number(body.to ?? body.index ?? i);
    if (i >= state.rotation.length || to < 0 || to >= state.rotation.length) return fail(res, 400, "Bad move.");
    const [e] = state.rotation.splice(i, 1); state.rotation.splice(to, 0, e);
    if (state.rotationIndex === i) state.rotationIndex = to; else if (i < state.rotationIndex && to >= state.rotationIndex) state.rotationIndex--; else if (i > state.rotationIndex && to <= state.rotationIndex) state.rotationIndex++;
    log("COMMAND", `moverotation ${i} -> ${to}`); return json(res, 200, { message: `Moved entry ${i} to ${to}.` });
  }
  if (M === "POST" && path === "/v1/rotation/save") { log("COMMAND", "saverotation"); return json(res, 200, { message: "Rotation saved." }); }

  // misc
  if (M === "GET" && path === "/v1/audit") { const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50)); return json(res, 200, { entries: state.audit.slice(0, limit) }); }
  if (M === "GET" && path === "/v1/sponsor") return json(res, 200, { imageUrl: state.sponsorUrl });
  if (M === "PUT" && path === "/v1/sponsor") { state.sponsorUrl = String(body.imageUrl || ""); log("COMMAND", "sponsor updated"); return json(res, 200, { message: "Sponsor image updated." }); }
  if (M === "GET" && path === "/v1/config") return json(res, 200, { revision: "mock-1", writable: false, text: `# mock server config\nServerName=${NAME}\nMaxPlayers=${MAX_PLAYERS}\n`, sections: [], warnings: ["This is the mock server; the config is read-only."] });
  if (M === "PATCH" && path === "/v1/settings") { log("COMMAND", `settings ${JSON.stringify(body)}`); return json(res, 200, { message: "Settings applied (mock).", applied: body }); }

  return fail(res, 404, `No route ${M} ${path}`);
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => fail(res, 500, err.message));
}).listen(PORT, "0.0.0.0", () => console.log(`mock wardogs rcon on :${PORT} (password: ${PASSWORD || "<none>"})`));
