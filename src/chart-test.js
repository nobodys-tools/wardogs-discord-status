// Renders a fake 24h chart to data/chart-test.png so the renderer can be eyeballed without Discord.
import { writeFileSync } from "node:fs";
import { renderChart, sparkline } from "./chart.js";

const buckets = 48;
const end = Date.now();
const start = end - 24 * 3600_000;
const series = Array.from({ length: buckets }, (_, i) => {
  if (i > 10 && i < 14) return null; // simulated outage
  return Math.round(20 + 18 * Math.sin((i / buckets) * Math.PI * 2 - 1) + Math.random() * 6);
});
const h = { start, end, series, peak: Math.max(...series.filter(Boolean)), avg: 22 };
const out = process.argv[2] || "data/chart-test.png";
writeFileSync(out, renderChart(h, 64, "#b91c1c"));
console.log("wrote", out);
console.log(sparkline(h, 64));
