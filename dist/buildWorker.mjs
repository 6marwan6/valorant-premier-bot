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
  external: [
    "zlib-sync", "bufferutil", "utf-8-validate", "pg-native",
    // Voice (worker/voice.ts): native add-ons / WASM that can't be inlined. They are
    // loaded with dynamic import() at runtime and installed from dist/package.json.
    "@discordjs/voice", "@snazzah/davey", "opusscript", "kokoro-js", "@huggingface/transformers", "onnxruntime-node", "sharp",
  ],
  // Inlined so src/config/logger.ts skips the pino-pretty transport (a
  // worker thread that can't be bundled). Production logging is plain JSON.
  define: { "process.env.NODE_ENV": '"production"' },
  // Some CommonJS dependencies call require(); ESM output needs this shim.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);require('dotenv').config();" },
  // Whitespace only: keeps function/variable names readable in error stack traces.
  minifyWhitespace: true,
  logLevel: "warning",
});

// The host's start script runs `node <MAIN_FILE>` for *.js files. `"type": "module"`
// makes Node treat gateway.js as ESM (it uses top-level await). No dependencies,
// so the host's automatic `npm install` finishes instantly.
// Only the runtime packages that can't be bundled. The host must run `npm install` once
// (with ONNXRUNTIME_NODE_INSTALL_CUDA=skip, so the ~340 MB GPU libraries aren't fetched).
writeFileSync(
  "dist/package.json",
  JSON.stringify(
    {
      name: "mari-worker",
      private: true,
      type: "module",
      dependencies: {
        "@discordjs/voice": "^0.19.2",
        "@snazzah/davey": "^0.1.12",
        dotenv: "^16.4.7",
        "kokoro-js": "^1.2.1",
        opusscript: "^0.0.8",
      },
    },
    null,
    2,
  ) + "\n",
);

console.log("Built dist/gateway.js and dist/package.json");
