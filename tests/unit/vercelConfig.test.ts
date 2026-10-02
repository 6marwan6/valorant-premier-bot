import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("vercel.json", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { functions: Record<string, { includeFiles?: string }> };

  it("ships opusscript's .wasm with the interactions function (/mari-voice crashed with ENOENT without it: Vercel's file tracing misses a .wasm read by path at runtime)", () => {
    expect(config.functions["api/interactions.ts"]?.includeFiles).toBe("node_modules/opusscript/build/**");
    expect(existsSync("node_modules/opusscript/build/opusscript_native_wasm.wasm")).toBe(true);
  });
});
