// Rough HTML rendering of a panel payload (Components V2 JSON) for the web UI preview.
import { config } from "./config.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Minimal Discord-markdown → HTML: headings, bold, inline code, code blocks, subtext, timestamps, escapes.
function md(text) {
  const blocks = String(text).split(/```/);
  return blocks.map((part, i) => {
    if (i % 2 === 1) return `<pre>${esc(part.replace(/^\n/, ""))}</pre>`;
    return part.split("\n").map((line) => {
      let cls = "";
      if (line.startsWith("### ")) { cls = "h3"; line = line.slice(4); }
      else if (line.startsWith("## ")) { cls = "h2"; line = line.slice(3); }
      else if (line.startsWith("# ")) { cls = "h1"; line = line.slice(2); }
      else if (line.startsWith("-# ")) { cls = "sub"; line = line.slice(3); }
      let html = esc(line)
        .replace(/\\([*_`~|\[\]])/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/&lt;t:(\d+):([RtTdDfF])&gt;/g, (_, s, style) => `<span class="ts" data-ts="${s}" data-style="${style}"></span>`);
      return `<div class="${cls}">${html || "&nbsp;"}</div>`;
    }).join("");
  }).join("");
}

function render(component, ctx) {
  switch (component.type) {
    case 17: { // container
      const color = component.accent_color != null ? `#${component.accent_color.toString(16).padStart(6, "0")}` : config.defaultColor;
      return `<div class="container" style="border-left-color:${esc(color)}">${(component.components || []).map((c) => render(c, ctx)).join("")}</div>`;
    }
    case 10: return `<div class="text">${md(component.content)}</div>`;
    case 14: return `<hr class="${component.divider ? "" : "blank"}">`;
    case 9: { // section
      const acc = component.accessory;
      const btn = acc?.type === 2 ? `<a class="btn" href="${esc(acc.url || "#")}" target="_blank">${esc(acc.label || "")}</a>` : "";
      return `<div class="section"><div>${(component.components || []).map((c) => render(c, ctx)).join("")}</div>${btn}</div>`;
    }
    case 12: { // media gallery
      return `<div class="gallery">${(component.items || []).map((item) => {
        let url = item.media?.url || "";
        if (url.startsWith("attachment://")) url = ctx.attachmentUrl(url.slice("attachment://".length));
        return `<img src="${esc(url)}" alt="${esc(item.description || "")}" title="${esc(item.description || "")}">`;
      }).join("")}</div>`;
    }
    default: return "";
  }
}

const CSS = `
body{background:#313338;color:#dbdee1;font:15px/1.375 "gg sans",system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:20px}
.wrap{max-width:640px}
.author{display:flex;align-items:center;gap:10px;margin-bottom:6px}.avatar{width:40px;height:40px;border-radius:50%;background:#b91c1c;display:grid;place-items:center;font-weight:700;color:#fff}
.name{font-weight:600;color:#f2f3f5}.tag{background:#5865f2;color:#fff;font-size:10px;border-radius:4px;padding:1px 4px;margin-left:4px;vertical-align:middle}.time{color:#949ba4;font-size:12px;margin-left:6px}
.container{background:#2b2d31;border:1px solid #3f4147;border-left:4px solid #b91c1c;border-radius:8px;padding:12px 16px;margin-left:50px}
.text{margin:2px 0}.h1{font-size:24px;font-weight:700;color:#f2f3f5;margin:4px 0}.h2{font-size:20px;font-weight:700;color:#f2f3f5}.h3{font-size:17px;font-weight:700;color:#f2f3f5;margin-top:2px}
.sub{font-size:12px;color:#949ba4}code{background:#1e1f22;border-radius:3px;padding:1px 4px;font-size:13px}pre{background:#1e1f22;border-radius:4px;padding:8px;font-size:13px;white-space:pre-wrap}
hr{border:0;border-top:1px solid #3f4147;margin:10px 0}hr.blank{border-color:transparent;margin:4px 0}
.section{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}.btn{flex:none;background:#4e5058;color:#fff;text-decoration:none;padding:6px 14px;border-radius:4px;font-size:14px;font-weight:500}
.gallery img{display:block;max-width:100%;border-radius:6px;margin:8px 0}
.note{color:#949ba4;font-size:12px;margin:12px 0 0 50px}
.msgsep{color:#949ba4;font-size:12px;margin:14px 0 6px 50px}
`;

const SCRIPT = `
for (const el of document.querySelectorAll('.ts')) {
  const d = new Date(Number(el.dataset.ts) * 1000), s = el.dataset.style;
  if (s === 'R') { const m = Math.round((d - Date.now()) / 60000); el.textContent = Math.abs(m) < 1 ? 'just now' : Math.abs(m) < 60 ? (m < 0 ? -m + ' minutes ago' : 'in ' + m + ' minutes') : (m < 0 ? Math.round(-m/60) + ' hours ago' : 'in ' + Math.round(m/60) + ' hours'); }
  else if (s === 't') el.textContent = d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  else el.textContent = d.toLocaleString();
}`;

/**
 * @param panel     db panel
 * @param payloads  result of buildPanelPayloads() — one entry per Discord message
 * @param botName   bot display name
 * @param attachmentUrl  (fileName) => url the browser can load
 */
export function previewHtml(panel, payloads, botName, attachmentUrl, { refreshSeconds = 30 } = {}) {
  const body = payloads.map((payload, i) =>
    `${i ? '<div class="msgsep">— message ' + (i + 1) + ' of ' + payloads.length + ' —</div>' : ""}${render(payload.components[0].toJSON(), { attachmentUrl })}`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}"><title>Preview · panel #${panel.id}</title><style>${CSS}</style></head><body>
<div class="wrap">
<div class="author"><div class="avatar">W</div><div><span class="name">${esc(botName)}</span><span class="tag">APP</span><span class="time">Today</span></div></div>
${body}
<p class="note">Rough preview of panel #${panel.id} (${payloads.length} message${payloads.length === 1 ? "" : "s"}) — Discord's own rendering differs slightly. Reloads every ${refreshSeconds}s.</p>
</div><script>${SCRIPT}</script></body></html>`;
}
