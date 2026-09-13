# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
**Security → Report a vulnerability** (private advisory) on this repository, or contact the
maintainer through the profile listed on the repository. You should get a reply within a few days.

## What this bot handles

- **Discord bot token** — from `.env` only; never stored elsewhere, never logged.
- **RCON passwords / monitor-bot tokens** — stored in plain text in `data/monitor.db` because the
  bot needs them to poll. Keep `data/` private; it is git- and docker-ignored.
- **Web UI** — HTTP basic auth, no TLS. It is an admin tool for a LAN or a reverse proxy with
  its own auth; the Docker port is bound to `127.0.0.1` by default. Do not expose it to the
  internet as-is.
- **Slash commands** — limited to the guild owner and Administrators (checked at runtime), and
  server/RCON management is limited to `ADMIN_GUILD_IDS`.

## Scope notes

The bot fetches `http://<host>:<port>/v1/...` for every configured server. Anyone who can run
`/wd server add` can therefore make the bot request arbitrary hosts on its network — that is why
server management is restricted to trusted guilds.
