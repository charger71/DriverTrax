// Asserts that every asset index.html loads also appears in sw.js's
// APP_SHELL, so the PWA can cold-start offline.
//
// This exists because supabase-js shipped for months absent from APP_SHELL.
// Cross-origin scripts are the dangerous case: the service worker's runtime
// cache can backfill same-origin misses, but a CDN asset that isn't
// precached may never be cached at all — and without supabase-js, auth.js
// bails and every feature module trips its own DT_AUTH guard. The app boots
// to an empty shell with no visible error.
//
// No dependencies: plain Node, run straight from CI.
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const sw = readFileSync("sw.js", "utf8");

const shellBlock = sw.slice(sw.indexOf("const APP_SHELL"), sw.indexOf("];", sw.indexOf("const APP_SHELL")));
if (!shellBlock) {
  console.error("Could not find APP_SHELL in sw.js.");
  process.exit(1);
}
const norm = (u) => u.replace(/^\.\//, "");
const shell = new Set([...shellBlock.matchAll(/"([^"]+)"/g)].map((m) => norm(m[1])));

const assets = [
  ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1])
];

// Ignore anything not actually fetched at load time.
const skip = (u) => u.startsWith("data:") || u.startsWith("#");

const missing = [...new Set(assets.filter((u) => !skip(u) && !shell.has(norm(u))))];

if (missing.length) {
  console.error("These assets are loaded by index.html but missing from sw.js APP_SHELL:\n");
  for (const m of missing) console.error("  " + m);
  console.error("\nAdd them to APP_SHELL and bump CACHE_VERSION, or the app can't start offline.");
  process.exit(1);
}

console.log(`All ${assets.length} index.html asset(s) are present in APP_SHELL.`);
