// Builds the Components-V2 message payload for one panel (one message, N servers).
import {
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import { config } from "./config.js";
import { renderCashChart, renderChart, sparkline } from "./chart.js";
import { history, matchBaseline, matchSamples, matchStartOf } from "./db.js";

export const MAX_SERVERS_PER_PANEL = 20;

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtCash = (n) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${fmtInt(n)}`;
};
const ts = (ms, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function colorInt(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  return m ? parseInt(m[1], 16) : 0xb91c1c;
}

function bar(value, cap, width = 10) {
  if (!cap) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / cap) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function clip(text, max) {
  text = String(text);
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function escapeMd(text) {
  // Backslash first in the class so a trailing "\" in a name can't cancel the escape that follows it.
  return String(text).replace(/([\\*_`~|>[\]])/g, "\\$1");
}

/**
 * Text block for one server.
 * @param server   db row
 * @param live     { snap, error, at, since } from the poller
 * @param opts     panel options
 * @param hist     db.history() result
 */
function serverBlock(server, live, opts, hist) {
  const snap = live?.snap || null;
  const online = !!snap && !live?.error;
  const lines = [];

  const title = escapeMd(snap?.serverName || server.name);
  if (online) {
    lines.push(`### 🟢 ${title}`);
    const cap = snap.maxPlayers > 0 ? ` / ${snap.maxPlayers}` : "";
    let l = `👥 **${snap.players}${cap}** players`;
    if (opts.history && hist.samples > 0) {
      l += `  ·  24h peak **${hist.peak}**${hist.peakAt ? ` (${ts(hist.peakAt, "t")})` : ""}  ·  avg **${hist.avg.toFixed(1)}**`;
    }
    lines.push(l);

    if (opts.map || opts.mode || opts.lighting) {
      const parts = [];
      if (opts.map && snap.mapDisplay) parts.push(`**${escapeMd(snap.mapDisplay)}**`);
      if (opts.mode && snap.mode) parts.push(escapeMd(snap.mode));
      if (opts.lighting && snap.lighting) parts.push(escapeMd(snap.lighting));
      if (opts.map && snap.alternator) parts.push(escapeMd(snap.alternator));
      if (parts.length) lines.push(`🗺️ ${parts.join("  ·  ")}`);
    }

    if (opts.match || opts.nextmap) {
      const parts = [];
      if (opts.match && snap.matchSeconds > 0) {
        const startedAt = snap.at - snap.matchSeconds * 1000;
        parts.push(`match started ${ts(startedAt)} (${ts(startedAt, "t")})`);
      }
      if (opts.nextmap && snap.nextMap) {
        parts.push(`next: **${escapeMd(snap.nextMap)}**${snap.nextMode ? ` (${escapeMd(snap.nextMode)})` : ""}`);
      }
      if (parts.length) lines.push(`⏱️ ${parts.join("  ·  ")}`);
    }

    if (opts.score && snap.factions.length) {
      const cap = snap.scoreCap || 0;
      const rows = snap.factions.map((f) =>
        `${f.emoji} ${escapeMd(f.name)} ${bar(f.score, cap)} **${Math.round(f.score)}**${f.players ? ` (${f.players}p)` : ""}`
      );
      let head = "🏆 Score";
      if (cap) head += ` to **${cap}**`;
      if (opts.tick && snap.scoreTick) head += `  ·  tick ${snap.scoreTick}${snap.scoreTickMax ? ` (${snap.scoreTickMin}–${snap.scoreTickMax})` : ""}`;
      lines.push(head);
      lines.push(rows.join("\n"));
    }

    if (opts.economy && snap.playerList.length) {
      const base = matchBaseline(server.id, matchStartOf(snap));
      const delta = (nowV, startV) => {
        if (!base) return "";
        const d = Math.round(nowV - startV);
        if (!d) return "  —";
        let out = `  ${d > 0 ? "▲" : "▼"} ${fmtCash(Math.abs(d))}`;
        if (startV > 0) out += ` (${d > 0 ? "+" : "-"}${(Math.abs(d) / startV * 100).toFixed(0)}%)`;
        return out;
      };
      lines.push(`💰 Cash this match${base ? ` (since ${ts(base.ts)})` : ""}`);
      lines.push(`Total **${fmtCash(snap.totalCash)}**${delta(snap.totalCash, base?.totalCash ?? 0)}`);
      for (const f of snap.factions) {
        if (!f.players && !(base?.factionCash?.[f.name])) continue;
        lines.push(`${f.emoji} ${escapeMd(f.name)} **${fmtCash(f.cash)}**${delta(f.cash, base?.factionCash?.[f.name] ?? 0)}`);
      }
    }

    if (opts.top && snap.playerList.length) {
      const top = [...snap.playerList]
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .filter((p) => p.kills > 0)
        .slice(0, 3)
        .map((p) => `${p.emoji} ${escapeMd(clip(p.name, 20))} ${p.kills}/${p.deaths}`);
      const richest = [...snap.playerList].sort((a, b) => b.cash - a.cash)[0];
      if (richest && richest.cash > 0) top.push(`💰 ${escapeMd(clip(richest.name, 20))} ${fmtCash(richest.cash)}`);
      if (top.length) lines.push(`🎯 ${top.join("  ·  ")}`);
    }

    if (opts.players && snap.playerList.length) {
      // One block per team (in score order), players sorted by kills. Unassigned players last.
      const groups = snap.factions.map((f) => ({ f, list: snap.playerList.filter((p) => p.faction === f.name) }));
      const rest = snap.playerList.filter((p) => !snap.factions.some((f) => f.name === p.faction));
      if (rest.length) groups.push({ f: { emoji: "⚪", name: "Unassigned" }, list: rest });
      const fmtPlayer = (p) => `${escapeMd(clip(p.name, 20))} \`${p.kills}/${p.deaths}\``;
      for (const { f, list } of groups) {
        if (!list.length) continue;
        list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const shown = list.slice(0, 16).map(fmtPlayer);
        if (list.length > 16) shown.push(`+${list.length - 16} more`);
        lines.push(`${f.emoji} **${escapeMd(f.name)}** · ${list.length}\n${shown.join("  ·  ")}`);
      }
    }

    if (!opts.chart && opts.history) {
      lines.push(`\`${sparkline(hist, snap.maxPlayers)}\` 24h`);
    }
  } else if (!live) {
    lines.push(`### ⏳ ${title}`);
    lines.push("Waiting for first poll…");
  } else {
    lines.push(`### 🔴 ${title}`);
    // Error details stay in the logs / `/wd server list`; the public panel only says "unreachable".
    lines.push(`Unreachable${live?.since ? ` since ${ts(live.since)}` : ""}`);
    if (opts.history && hist.samples > 0) {
      lines.push(`👥 24h peak **${hist.peak}**  ·  avg **${hist.avg.toFixed(1)}**`);
    }
    if (!opts.chart && opts.history) lines.push(`\`${sparkline(hist, snap?.maxPlayers || 0)}\` 24h`);
  }

  if (server.connect && !(config.webEnabled && config.publicUrl)) {
    lines.push(`🔗 \`steam://connect/${server.connect}\``);
  }

  // A single block must fit one message on its own (Discord: 4000 chars of text per message).
  return clip(lines.join("\n"), MAX_BLOCK_CHARS);
}

const MAX_BLOCK_CHARS = 3600;

// Discord limits per Components-V2 message.
const MAX_TEXT_CHARS = 3900;   // hard limit 4000 across all text displays
const MAX_COMPONENTS = 38;     // hard limit 40 (container counts too)
const MAX_FILES = 10;

/**
 * Builds one or more message payloads for a panel. Servers are packed into as many messages as
 * needed to stay under Discord's per-message limits; the header goes on the first message, the
 * footer on the last.
 * @param panel    db panel row (with .options)
 * @param servers  db server rows attached to the panel
 * @param liveOf   (serverId) => live state
 * @returns {Array<object>} payloads for channel.send / message.edit
 */
export function buildPanelPayloads(panel, servers, liveOf) {
  const opts = panel.options;
  const accent = opts.color || config.defaultColor;
  const shown = servers.slice(0, MAX_SERVERS_PER_PANEL);
  const banner = opts.banner || config.defaultBanner;

  // --- per-server blocks ---------------------------------------------------
  const blocks = shown.map((server) => {
    const live = liveOf(server.id);
    const hist = history(server.id, { hours: 24, buckets: 48 });
    const text = serverBlock(server, live, opts, hist);
    const files = []; // [{ file, description }]
    if (opts.chart && hist.samples > 0) {
      files.push({
        file: new AttachmentBuilder(renderChart(hist, live?.snap?.maxPlayers || 0, accent), { name: `chart-${server.id}.png` }),
        description: `${server.name} — players, last 24h`,
      });
    }
    if (opts.cashchart && live?.snap && !live.error) {
      const rows = matchSamples(server.id, matchStartOf(live.snap));
      if (rows.length >= 2) {
        files.push({
          file: new AttachmentBuilder(renderCashChart(rows, live.snap.factions, accent), { name: `cash-${server.id}.png` }),
          description: `${server.name} — cash, this match`,
        });
      }
    }
    const button = server.connect && config.webEnabled && config.publicUrl
      ? new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Connect").setURL(`${config.publicUrl}/connect/${server.id}`)
      : null;
    // separator + text (+ section + button) (+ one gallery per image)
    const components = 2 + (button ? 2 : 0) + files.length;
    return { server, text, files, button, components, chars: text.length };
  });

  const totalOnline = shown.reduce((sum, s) => { const l = liveOf(s.id); return sum + (l?.snap && !l.error ? l.snap.players : 0); }, 0);
  const totalCap = shown.reduce((sum, s) => sum + (liveOf(s.id)?.snap?.maxPlayers || 0), 0);
  const headerText = `# ${escapeMd(opts.title)}
**${totalOnline}**${totalCap ? ` / ${totalCap}` : ""} players online across ${shown.length} server${shown.length === 1 ? "" : "s"}`;
  const footerText = `-# Updated ${ts(Date.now())} · refreshes every ${config.pollInterval}s · panel #${panel.id}`;

  // --- pack blocks into messages ------------------------------------------
  const pages = [];
  let page = null;
  const newPage = () => {
    page = { blocks: [], chars: 0, components: 1, files: 0 }; // 1 = container
    if (!pages.length) { page.chars += headerText.length; page.components += 1 + (banner ? 1 : 0); }
    pages.push(page);
  };
  newPage();
  for (const b of blocks) {
    const fits = page.chars + b.chars <= MAX_TEXT_CHARS && page.components + b.components <= MAX_COMPONENTS && page.files + b.files.length <= MAX_FILES;
    if (!fits && page.blocks.length) newPage();
    page.blocks.push(b);
    page.chars += b.chars; page.components += b.components; page.files += b.files.length;
  }
  // footer needs room on the last page
  const last = pages[pages.length - 1];
  if (opts.footer && (last.chars + footerText.length > MAX_TEXT_CHARS || last.components + 2 > MAX_COMPONENTS)) newPage();

  // --- render pages --------------------------------------------------------
  return pages.map((pg, i) => {
    const container = new ContainerBuilder().setAccentColor(colorInt(accent));
    const files = [];
    if (i === 0) {
      if (banner) {
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner).setDescription(opts.title))
        );
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
      if (!shown.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent("_No servers attached yet. Use `/wd panel add`._"));
    }
    for (const b of pg.blocks) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      const text = new TextDisplayBuilder().setContent(b.text);
      if (b.button) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setButtonAccessory(b.button));
      else container.addTextDisplayComponents(text);
      for (const { file, description } of b.files) {
        files.push(file);
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`).setDescription(description)
          )
        );
      }
    }
    if (i === pages.length - 1 && opts.footer) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));
    }
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      files,
      attachments: [], // drop previously uploaded charts on edit
      allowedMentions: { parse: [] },
    };
  });
}

// Cheap change detector so we don't edit when nothing moved (charts still refresh every minute via the caller).
export function panelFingerprint(servers, liveOf) {
  return servers.map((s) => {
    const l = liveOf(s.id);
    const snap = l?.snap;
    if (!snap || l.error) return `${s.id}:off`;
    return [s.id, snap.players, snap.map, snap.matchSeconds > 0 ? Math.floor((snap.at - snap.matchSeconds * 1000) / 60000) : 0,
      snap.factions.map((f) => Math.round(f.score)).join("/"), Math.round(snap.totalCash / 100)].join(":");
  }).join("|");
}
