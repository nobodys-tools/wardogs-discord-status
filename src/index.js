import { config } from "./config.js";
import { startBot, refreshAllPanels } from "./bot.js";
import { onRound, startPoller, stopPoller } from "./poller.js";
import { refreshMonitors, stopMonitors } from "./monitor.js";
import { startWeb } from "./web.js";

if (!config.discordToken) {
  console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

onRound(() => refreshAllPanels());
onRound(() => refreshMonitors());

// A long-running bot should log, not die, on a stray rejection (discord.js emits a few on flaky networks).
process.on("unhandledRejection", (err) => console.error("[unhandled rejection]", err));

const web = startWeb();
web?.on("error", (err) => {
  console.error(`[web] cannot listen on :${config.webPort} — ${err.message}`);
});
startPoller();
startBot().catch((err) => {
  console.error("[bot] login failed:", err.message);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    stopPoller();
    stopMonitors();
    process.exit(0);
  });
}
