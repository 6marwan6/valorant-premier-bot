/**
 * Bundles worker/gateway.ts and everything it imports into ONE file,
 * dist/gateway.js, so the host (Wispbyte free tier) needs no `npm install`
 * and no TypeScript runtime — which is what ran it out of memory.
 *
 * Run: npm run build:worker   (then upload dist/gateway.js + dist/package.json)
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["worker/gateway.ts"],
  outfile: "dist/gateway.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Optional native add-ons discord.js/pg can use when installed; without
  // them both fall back to pure JS.
  external: ["zlib-sync", "bufferutil", "utf-8-validate", "pg-native"],
  // Inlined so src/config/logger.ts skips the pino-pretty transport (a
  // worker thread that can't be bundled). Production logging is plain JSON.
  define: { "process.env.NODE_ENV": '"production"' },
  // Some CommonJS dependencies call require(); ESM output needs this shim.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Whitespace only: keeps function/variable names readable in error stack traces.
  minifyWhitespace: true,
  logLevel: "warning",
});

// The host's start script runs `node <MAIN_FILE>` for *.js files. `"type": "module"`
// makes Node treat gateway.js as ESM (it uses top-level await). No dependencies,
// so the host's automatic `npm install` finishes instantly.
writeFileSync("dist/package.json", JSON.stringify({ name: "mari-worker", private: true, type: "module" }, null, 2) + "\n");

console.log("Built dist/gateway.js and dist/package.json");
