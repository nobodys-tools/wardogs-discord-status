// Fills the last N hours of fake player-count samples for a server so the 24h chart has something to show.
//   docker compose exec bot node scripts/backfill.js <server name> [hours=24] [--clear]
import { db, getServerByName, listServers } from "../src/db.js";

const [name, hoursArg, ...flags] = process.argv.slice(2);
const server = name ? getServerByName(name) : null;
if (!server) {
  console.error(`Usage: backfill.js <server name> [hours] [--clear]\nServers: ${listServers().map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}
const hours = Number(hoursArg) || 24;
const stepMs = 5 * 60_000;
const now = Date.now();
// slot cap: whatever the last real poll reported, else 64
const max = db.prepare("SELECT max_players FROM samples WHERE server_id = ? ORDER BY ts DESC LIMIT 1").get(server.id)?.max_players || 64;

if (flags.includes("--clear")) {
  db.prepare("DELETE FROM samples WHERE server_id = ?").run(server.id);
}

const ins = db.prepare("INSERT INTO samples (server_id, ts, players, max_players, map) VALUES (?, ?, ?, ?, ?)");
const maps = ["Kavkazi", "Europe", "NorthAmerica"];
let n = 0;
for (let ts = now - hours * 3600_000; ts < now - 60_000; ts += stepMs) {
  const hour = new Date(ts).getHours() + new Date(ts).getMinutes() / 60;
  // evening peak around 20:00, quiet around 05:00, plus noise and one short outage
  const daily = 0.5 - 0.45 * Math.cos(((hour - 20) / 24) * Math.PI * 2);
  if (hour > 4.5 && hour < 5) continue; // outage gap
  const players = Math.max(0, Math.min(max, Math.round(max * daily * (0.85 + Math.random() * 0.3))));
  ins.run(server.id, ts, players, max, maps[Math.floor(ts / (40 * 60_000)) % maps.length]);
  n++;
}
console.log(`inserted ${n} samples for ${server.name} covering the last ${hours}h`);
