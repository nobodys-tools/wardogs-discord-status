// Optional web UI (basic-auth) for managing servers and panels, plus /connect/<id> steam redirects.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import { PANEL_DEFAULTS, PANEL_OPTION_KEYS } from "./db.js";
import { liveOf, pollServer } from "./poller.js";
import * as bot from "./bot.js";
import { MAX_SERVERS_PER_PANEL, buildPanelPayloads } from "./panel.js";
import { previewHtml } from "./preview.js";
import * as v from "./validate.js";

// panelId -> { at, files: Map<name, Buffer> } — chart images for the preview page, short-lived.
const previewFiles = new Map();
setInterval(() => {
  for (const [id, e] of previewFiles) if (Date.now() - e.at > 5 * 60_000) previewFiles.delete(id);
}, 60_000).unref();

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0f1115;color:#e7e9ee;font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px;border-bottom:1px solid #2a2f3a;padding-bottom:6px}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:14px 16px;margin:10px 0}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;text-align:left;border-bottom:1px solid #232733;vertical-align:top}th{color:#9aa3b5;font-weight:600;font-size:12px;text-transform:uppercase}
input,select{background:#0f1115;color:#e7e9ee;border:1px solid #333a48;border-radius:6px;padding:6px 8px;font:inherit}input[type=checkbox]{width:auto}
button{background:#b91c1c;color:#fff;border:0;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}button.sec{background:#2a2f3a}
form.inline{display:inline}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px}label{display:block;color:#9aa3b5;font-size:12px}label input,label select{width:100%;margin-top:2px}
.ok{color:#4ade80}.bad{color:#f87171}.muted{color:#9aa3b5}.msg{background:#1f2937;border-left:3px solid #b91c1c;padding:8px 12px;border-radius:6px;margin:0 0 14px}
.act{display:flex;align-items:flex-end}.act button{height:34px}
.toggles{display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0}.toggles label{display:inline-flex;gap:4px;align-items:center;color:#e7e9ee}
a{color:#93c5fd}
`;

function page(title, body, msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<h1>Wardogs Monitor</h1><p class="muted">Servers &amp; panels</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${body}</main></body></html>`;
}

function liveCell(server) {
  const l = liveOf(server.id);
  if (!l) return `<span class="muted">not polled yet</span>`;
  if (l.error || !l.snap) return `<span class="bad">offline</span> <span class="muted">${esc(l.error || "")}</span>`;
  const s = l.snap;
  return `<span class="ok">${s.players}/${s.maxPlayers}</span> · ${esc(s.mapDisplay)}${s.mode ? ` · ${esc(s.mode)}` : ""}`;
}

function indexPage(msg) {
  const servers = db.listServers();
  const panels = db.listPanels();

  const serverRows = servers.map((s) => `<tr>
<td><form method="post" action="/servers/${s.id}" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
  <label>Name<input name="name" value="${esc(s.name)}" required></label>
  <label>Host<input name="host" value="${esc(s.host)}" required></label>
  <label>Port<input name="port" type="number" value="${s.port}" required></label>
  <label>Password<input name="password" type="password" placeholder="(unchanged)"></label>
  <label>Connect ip:port<input name="connect" value="${esc(s.connect)}"></label>
  <label>Monitor bot token<input name="monitor_token" type="password" placeholder="${s.monitor_token ? "(set — leave blank to keep)" : "(none)"}"></label>
  <div class="act"><button>Save</button></div>
</form>
<div style="margin-top:6px">${liveCell(s)}
  <form class="inline" method="post" action="/servers/${s.id}/delete" onsubmit="return confirm('Delete this server and its history?')"><button class="sec">Delete</button></form>
  ${s.monitor_token ? `<form class="inline" method="post" action="/servers/${s.id}/clear-monitor"><button class="sec">Remove monitor token</button></form>` : ""}
</div></td></tr>`).join("");

  const addServer = `<div class="card"><form method="post" action="/servers" class="grid">
  <label>Name<input name="name" required maxlength="32"></label>
  <label>Host<input name="host" required></label>
  <label>Port<input name="port" type="number" required min="1" max="65535"></label>
  <label>Password<input name="password" type="password" required></label>
  <label>Connect ip:port<input name="connect"></label>
  <div class="act"><button>Add server</button></div>
</form></div>`;

  const panelCards = panels.map((p) => {
    const attached = new Set(db.panelServerIds(p.id));
    const ids = db.panelMessageIds(p);
    const link = ids.length ? `<a href="https://discord.com/channels/${p.guild_id}/${p.channel_id}/${ids[0]}" target="_blank">open message${ids.length > 1 ? `s (${ids.length})` : ""}</a>` : `<span class="bad">no message</span>`;
    const toggles = PANEL_OPTION_KEYS.filter((k) => typeof PANEL_DEFAULTS[k] === "boolean")
      .map((k) => `<label><input type="checkbox" name="opt_${k}" ${p.options[k] ? "checked" : ""}> ${k}</label>`).join("");
    const serverChecks = servers.map((s) => `<label><input type="checkbox" name="srv_${s.id}" ${attached.has(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`).join("");
    return `<div class="card"><form method="post" action="/panels/${p.id}">
  <b>Panel #${p.id}</b> · guild ${esc(p.guild_id)} · channel ${esc(p.channel_id)} · ${link} · <a href="/panels/${p.id}/preview" target="_blank">preview</a>
  <div class="grid" style="margin-top:8px">
    <label>Title<input name="title" value="${esc(p.options.title)}"></label>
    <label>Banner URL<input name="banner" value="${esc(p.options.banner)}" placeholder="https://…/image.png"></label>
    <label>Accent color<input name="color" value="${esc(p.options.color)}" placeholder="${esc(config.defaultColor)}"></label>
    <label>Move to channel id<input name="channel_id" placeholder="(unchanged)"></label>
  </div>
  <div class="toggles">${toggles}</div>
  <div>Servers (max ${MAX_SERVERS_PER_PANEL}):</div><div class="toggles">${serverChecks || '<span class="muted">none yet</span>'}</div>
  <button>Save &amp; refresh</button>
</form>
<form class="inline" method="post" action="/panels/${p.id}/delete" onsubmit="return confirm('Delete panel #${p.id}?')"><button class="sec">Delete panel</button></form></div>`;
  }).join("");

  const addPanel = `<div class="card"><form method="post" action="/panels" class="grid">
  <label>Guild id<input name="guild_id" required></label>
  <label>Channel id<input name="channel_id" required></label>
  <label>Title<input name="title" placeholder="${esc(PANEL_DEFAULTS.title)}"></label>
  <div class="act"><button>Create panel</button></div>
</form><p class="muted">Enable Developer Mode in Discord → right-click a channel → Copy ID. The bot must be able to view, send, embed and attach files in that channel. Or just run <code>/wd panel create</code> in Discord.</p></div>`;

  return page("Wardogs Monitor", `
<h2>Servers</h2><table><tbody>${serverRows || '<tr><td class="muted">No servers yet.</td></tr>'}</tbody></table>${addServer}
<h2>Panels</h2>${panelCards || '<p class="muted">No panels yet.</p>'}${addPanel}
<p class="muted">Bot status: ${bot.client.isReady() ? `<span class="ok">online as ${esc(bot.client.user.tag)}</span> · <a href="${esc(bot.inviteUrl())}" target="_blank">invite link</a> (adds the bot to a Discord server with only the permissions it needs)` : '<span class="bad">not connected</span>'} · poll every ${config.pollInterval}s</p>`, msg);
}

function connectPage(server) {
  const url = `steam://connect/${server.connect}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${esc(url)}"><title>${esc(server.name)}</title><style>${CSS}</style></head>
<body><main><div class="card"><h1>${esc(server.name)}</h1><p>Launching Wardogs… If nothing happens, <a id="go" href="${esc(url)}">click here</a> (Steam must be running).</p><p class="muted">${esc(server.connect)}</p></div></main><script>location.href=document.getElementById("go").href</script></body></html>`;
}

// ---- helpers ------------------------------------------------------------

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const a = Buffer.from(header.slice(6), "base64"), b = Buffer.from(`${config.webUser}:${config.webPassword}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on("error", reject);
  });
}

function redirect(res, to, msg) {
  res.writeHead(303, { Location: msg ? `${to}?msg=${encodeURIComponent(msg)}` : to });
  res.end();
}

function send(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// ---- routes -------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // Public: steam connect redirect + health.
  if (path === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, bot: bot.client.isReady() })); }
  let m = /^\/connect\/(\d+)$/.exec(path);
  if (m && req.method === "GET") {
    const server = db.getServer(m[1]);
    if (!server?.connect) return send(res, 404, page("Not found", "<p>Unknown server.</p>"));
    return send(res, 200, connectPage(server));
  }

  if (!config.webPassword) return send(res, 503, page("Disabled", "<p>Set <code>WEB_PASSWORD</code> to enable the admin UI.</p>"));
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Wardogs Monitor"', "Content-Type": "text/plain" });
    return res.end("Authentication required");
  }

  if (req.method === "GET" && path === "/") return send(res, 200, indexPage(url.searchParams.get("msg")));

  if (req.method === "GET" && (m = /^\/panels\/(\d+)\/preview$/.exec(path))) {
    const panel = db.getPanel(m[1]);
    if (!panel) return send(res, 404, page("Not found", "<p>Unknown panel.</p>"));
    const payloads = buildPanelPayloads(panel, db.panelServers(panel.id), liveOf);
    previewFiles.set(panel.id, { at: Date.now(), files: new Map(payloads.flatMap((p) => p.files).map((f) => [f.name, f.attachment])) });
    const botName = bot.client.isReady() ? bot.client.user.displayName : "Wardogs Monitor";
    return send(res, 200, previewHtml(panel, payloads, botName, (name) => `/panels/${panel.id}/files/${encodeURIComponent(name)}?t=${Date.now()}`, { refreshSeconds: config.pollInterval }));
  }
  if (req.method === "GET" && (m = /^\/panels\/(\d+)\/files\/([\w.-]+)$/.exec(path))) {
    const entry = previewFiles.get(Number(m[1]));
    const buf = entry?.files.get(m[2]);
    if (!buf) return send(res, 404, page("Not found", "<p>Open the preview page first.</p>"));
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    return res.end(buf);
  }

  if (req.method !== "POST") return send(res, 404, page("Not found", "<p>Nope.</p>"));
  // Same-origin guard for the form posts: browsers send Sec-Fetch-Site and/or Origin; both must agree with us.
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return send(res, 403, page("Forbidden", "<p>Cross-site request blocked.</p>"));
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* malformed */ }
    if (originHost !== req.headers.host) return send(res, 403, page("Forbidden", "<p>Cross-site request blocked.</p>"));
  }
  const form = await readForm(req);

  try {
    if (path === "/servers") {
      const name = v.serverName(form.name);
      if (db.getServerByName(name)) throw new Error(`Server "${name}" already exists.`);
      if (!form.password) throw new Error("Password can't be empty.");
      const server = db.addServer({ name, host: v.host(form.host), port: v.port(form.port), password: form.password, connect: v.connect(form.connect) });
      await pollServer(server);
      await bot.refreshAllPanels({ force: true });
      return redirect(res, "/", `Added ${server.name}.`);
    }
    if ((m = /^\/servers\/(\d+)$/.exec(path))) {
      const server = db.getServer(m[1]);
      if (!server) throw new Error("Unknown server.");
      const name = v.serverName(form.name);
      const other = db.getServerByName(name);
      if (other && other.id !== server.id) throw new Error("Name already in use.");
      const fields = { name, host: v.host(form.host), port: v.port(form.port), connect: v.connect(form.connect) };
      if (form.password) fields.password = form.password;
      if (form.monitor_token) fields.monitor_token = v.token(form.monitor_token);
      db.updateServer(server.id, fields);
      await pollServer(db.getServer(server.id));
      await bot.refreshAllPanels({ force: true });
      return redirect(res, "/", `Saved ${name}.`);
    }
    if ((m = /^\/servers\/(\d+)\/clear-monitor$/.exec(path))) {
      db.updateServer(m[1], { monitor_token: "" });
      return redirect(res, "/", "Monitor token removed.");
    }
    if ((m = /^\/servers\/(\d+)\/delete$/.exec(path))) {
      const server = db.getServer(m[1]);
      if (server) { db.removeServer(server.id); await bot.refreshAllPanels({ force: true }); }
      return redirect(res, "/", "Server deleted.");
    }
    if (path === "/panels") {
      const title = v.title(form.title);
      const panel = await bot.createPanel({
        guildId: v.snowflake(form.guild_id, "Guild id"), channelId: v.snowflake(form.channel_id, "Channel id"),
        options: title ? { title } : {},
        serverIds: db.listServers().slice(0, MAX_SERVERS_PER_PANEL).map((s) => s.id),
      });
      return redirect(res, "/", `Panel #${panel.id} created.`);
    }
    if ((m = /^\/panels\/(\d+)$/.exec(path))) {
      let panel = db.getPanel(m[1]);
      if (!panel) throw new Error("Unknown panel.");
      const patch = { title: v.title(form.title) || PANEL_DEFAULTS.title, banner: v.bannerUrl(form.banner), color: v.color(form.color) };
      for (const k of PANEL_OPTION_KEYS) if (typeof PANEL_DEFAULTS[k] === "boolean") patch[k] = form[`opt_${k}`] === "on";
      db.setPanelOptions(panel.id, patch);
      const ids = db.listServers().filter((s) => form[`srv_${s.id}`] === "on").map((s) => s.id);
      if (ids.length > MAX_SERVERS_PER_PANEL) throw new Error(`Max ${MAX_SERVERS_PER_PANEL} servers per panel.`);
      db.setPanelServerList(panel.id, ids);
      panel = db.getPanel(panel.id);
      const newChannel = form.channel_id?.trim() ? v.snowflake(form.channel_id, "Channel id") : "";
      if (newChannel && newChannel !== panel.channel_id) await bot.movePanel(panel, newChannel);
      else await bot.refreshPanel(panel, { force: true });
      return redirect(res, "/", `Panel #${panel.id} saved.`);
    }
    if ((m = /^\/panels\/(\d+)\/delete$/.exec(path))) {
      const panel = db.getPanel(m[1]);
      if (panel) await bot.removePanel(panel);
      return redirect(res, "/", "Panel deleted.");
    }
    return send(res, 404, page("Not found", "<p>Nope.</p>"));
  } catch (err) {
    return redirect(res, "/", `Error: ${err.message}`);
  }
}

export function startWeb() {
  if (!config.webEnabled) return null;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[web]", err);
      if (!res.headersSent) send(res, 500, page("Error", `<p>${esc(err.message)}</p>`));
    });
  });
  server.listen(config.webPort, "0.0.0.0", () => {
    console.log(`[web] listening on :${config.webPort}${config.webPassword ? "" : " (admin UI disabled — set WEB_PASSWORD)"}${config.publicUrl ? ` public ${config.publicUrl}` : ""}`);
  });
  return server;
}
