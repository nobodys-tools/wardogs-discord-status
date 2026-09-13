// Polls every configured server on a fixed interval, records samples, then notifies listeners.
import { config } from "./config.js";
import { addSample, listServers, pruneSamples } from "./db.js";
import { querySnapshot } from "./rcon.js";

/** serverId -> { snap, error, at, since } (since = when the current online/offline streak began) */
const live = new Map();
const listeners = [];
let timer = null;
let running = false;
let lastPrune = 0;

export function liveOf(serverId) {
  return live.get(Number(serverId)) || null;
}

export function allLive() {
  return live;
}

export function onRound(fn) {
  listeners.push(fn);
}

export async function pollServer(server) {
  const prev = live.get(server.id);
  try {
    const snap = await querySnapshot(server);
    try { addSample(server.id, snap); } catch (err) { console.error(`[db] sample for ${server.name} not stored: ${err.message}`); }
    const wasOnline = prev?.snap && !prev.error;
    live.set(server.id, { snap, error: null, at: Date.now(), since: wasOnline ? prev.since : Date.now() });
    if (!wasOnline) console.log(`[rcon] ${server.name}: online ${snap.players}/${snap.maxPlayers} ${snap.mapDisplay}`);
    return live.get(server.id);
  } catch (err) {
    const wasOffline = !!prev?.error;
    live.set(server.id, { snap: prev?.snap || null, error: err.message, at: Date.now(), since: wasOffline ? prev.since : Date.now() });
    if (!wasOffline) console.warn(`[rcon] ${server.name}: offline — ${err.message}`);
    return live.get(server.id);
  }
}

/** Polls every server once and notifies listeners. Returns false if a round was already in progress. */
export async function pollAll() {
  if (running) return false;
  running = true;
  try {
    const servers = listServers();
    const ids = new Set(servers.map((s) => s.id));
    for (const id of live.keys()) if (!ids.has(id)) live.delete(id); // removed servers
    await Promise.all(servers.map(pollServer));

    if (Date.now() - lastPrune > 6 * 3600_000) {
      const removed = pruneSamples(Date.now() - config.historyDays * 86400_000);
      if (removed) console.log(`[db] pruned ${removed} old samples`);
      lastPrune = Date.now();
    }

    for (const fn of listeners) {
      try { await fn(); } catch (err) { console.error("[poller] listener failed:", err); }
    }
  } catch (err) {
    console.error("[poller] round failed:", err);
  } finally {
    running = false;
  }
  return true;
}

export function startPoller() {
  const tick = async () => {
    await pollAll();
    timer = setTimeout(tick, config.pollInterval * 1000);
  };
  tick();
  console.log(`[poller] polling every ${config.pollInterval}s`);
}

export function stopPoller() {
  if (timer) clearTimeout(timer);
  timer = null;
}
