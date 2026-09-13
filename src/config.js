import path from "node:path";

const env = process.env;

function int(name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(name, fallback = false) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const config = {
  discordToken: env.DISCORD_TOKEN || "",
  // Optional: register commands only in this guild (instant) instead of globally (up to 1h to appear).
  discordGuildId: env.DISCORD_GUILD_ID || "",
  // Guilds allowed to manage servers (RCON credentials). Defaults to DISCORD_GUILD_ID. Empty = any guild (warned at start).
  adminGuildIds: String(env.ADMIN_GUILD_IDS ?? env.DISCORD_GUILD_ID ?? "").split(/[,\s]+/).filter(Boolean),

  dataDir: env.DATA_DIR || path.join(process.cwd(), "data"),

  // Seconds between RCON polls (min 10).
  pollInterval: Math.max(10, int("POLL_INTERVAL", 30)),
  // Per-request RCON timeout.
  rconTimeoutMs: int("RCON_TIMEOUT_MS", 8000),
  // Keep this many days of samples in the DB.
  historyDays: int("HISTORY_DAYS", 7),

  // Optional web UI.
  webEnabled: bool("WEB_ENABLED", false),
  webPort: int("WEB_PORT", 8080),
  webUser: env.WEB_USER || "admin",
  webPassword: env.WEB_PASSWORD || "",
  // Public base URL of the web UI (used for the "Connect" link button). e.g. https://wd.example.com
  publicUrl: /^https?:\/\/\S+$/i.test(String(env.PUBLIC_URL || "")) ? String(env.PUBLIC_URL).replace(/\/$/, "") : "",

  defaultBanner: env.DEFAULT_BANNER_URL || "",
  defaultColor: env.DEFAULT_COLOR || "#b91c1c",
};
