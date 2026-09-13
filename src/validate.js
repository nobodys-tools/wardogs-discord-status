// Input validation shared by the slash commands and the web UI. Each returns the cleaned value or throws.

export function serverName(v) {
  v = String(v ?? "").trim();
  if (!v || v.length > 32) throw new Error("Name must be 1–32 characters.");
  if (/[`*_~|<>@#]/.test(v)) throw new Error("Name may not contain markdown characters (` * _ ~ | < > @ #).");
  return v;
}

export function host(v) {
  v = String(v ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) || v.length > 253) {
    throw new Error("Host must be a hostname or IPv4 address (no scheme, path or port).");
  }
  return v;
}

export function port(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Port must be 1–65535.");
  return n;
}

/** Game address for steam://connect — "ip-or-host:port" or empty. */
export function connect(v) {
  v = String(v ?? "").trim();
  if (!v || ["none", "-", "off"].includes(v.toLowerCase())) return "";
  const m = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error("Connect address must look like 1.2.3.4:7777 or host:port.");
  return `${m[1].toLowerCase()}:${Number(m[2])}`;
}

export function token(v) {
  v = String(v ?? "").trim();
  if (!v || ["none", "-", "off", '""'].includes(v.toLowerCase())) return "";
  if (!/^[\w.-]{40,120}$/.test(v)) throw new Error("That doesn't look like a Discord bot token.");
  return v;
}

export function snowflake(v, what = "ID") {
  v = String(v ?? "").trim();
  if (!/^\d{17,20}$/.test(v)) throw new Error(`${what} must be a Discord ID (17–20 digits).`);
  return v;
}

export function bannerUrl(v) {
  v = String(v ?? "").trim();
  if (!v || ["none", "-", "off"].includes(v.toLowerCase())) return "";
  if (!/^https?:\/\/[^\s"'<>]{1,500}$/i.test(v)) throw new Error("Banner must be an http(s) image URL (or empty).");
  return v;
}

export function color(v) {
  v = String(v ?? "").trim();
  if (!v) return "";
  if (!/^#?[0-9a-f]{6}$/i.test(v)) throw new Error("Color must be a hex value like #b91c1c.");
  return `#${v.replace("#", "").toLowerCase()}`;
}

export function title(v) {
  v = String(v ?? "").trim();
  if (v.length > 80) throw new Error("Title must be at most 80 characters.");
  return v;
}

export function clip(text, max) {
  text = String(text ?? "");
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
