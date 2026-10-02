import { describe, expect, it, vi } from "vitest";
import { KeyPool, fetchWithKeys, parseKeyList } from "../../src/modules/voice/keyPool.js";

const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });

describe("parseKeyList", () => {
  it("splits on commas, spaces, semicolons and new lines; trims and de-duplicates", () => {
    expect(parseKeyList(" a, b;c\n d  ,a ")).toEqual(["a", "b", "c", "d"]);
    expect(parseKeyList("single")).toEqual(["single"]);
  });
  it("empty / missing means no keys", () => {
    expect(parseKeyList("")).toEqual([]);
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList(" , ; ")).toEqual([]);
  });
});

describe("fetchWithKeys", () => {
  it("uses the first key and stays on it while it works", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    const send = vi.fn(async () => res(200));
    await fetchWithKeys(pool, send);
    await fetchWithKeys(pool, send);
    expect(send.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["k1", "k1"]);
  });

  it("moves to the next key when one hits its limit (429), and stays there afterwards", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    const send = vi.fn(async (key: string) => (key === "k1" ? res(429, { "retry-after": "30" }) : res(200)));
    expect((await fetchWithKeys(pool, send)).status).toBe(200);
    expect(send.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["k1", "k2"]);
    send.mockClear();
    await fetchWithKeys(pool, send);
    expect(send.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["k2"]); // k1 is cooling down
  });

  it("treats 401 and 402 (bad key, out of credit) as key problems too", async () => {
    for (const status of [401, 402]) {
      const pool = new KeyPool(["bad", "good"]);
      const out = await fetchWithKeys(pool, async (k) => (k === "bad" ? res(status) : res(200)));
      expect(out.status).toBe(200);
    }
  });

  it("does NOT switch keys for errors that aren't about the key (400, 403, 500)", async () => {
    for (const status of [400, 403, 500]) {
      const pool = new KeyPool(["k1", "k2"]);
      const send = vi.fn(async () => res(status));
      expect((await fetchWithKeys(pool, send)).status).toBe(status);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("returns the last refusal when every key is refused, and does not loop", async () => {
    const pool = new KeyPool(["k1", "k2", "k3"]);
    const send = vi.fn(async () => res(429));
    expect((await fetchWithKeys(pool, send)).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("a key comes back after its cooldown, and goes first again (list order)", async () => {
    let now = 0;
    const pool = new KeyPool(["k1", "k2"], () => now);
    const send = vi.fn(async (key: string) => (key === "k1" && now < 60_000 ? res(429) : res(200)));
    await fetchWithKeys(pool, send); // k1 refused, k2 used
    send.mockClear();
    now = 61_000; // default 60 s cooldown over
    await fetchWithKeys(pool, send);
    expect(send.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["k1"]);
  });

  it("when everything is cooling down it still tries the one that recovers soonest", async () => {
    const now = 0;
    const pool = new KeyPool(["k1", "k2"], () => now);
    pool.penalize(0, 429, 100);
    pool.penalize(1, 429, 10);
    expect(pool.order()).toEqual([1, 0]);
    expect(pool.available).toBe(0);
  });

  it("logs the switch by position, never the key", async () => {
    const pool = new KeyPool(["secret-one", "secret-two"]);
    const warn = vi.fn();
    await fetchWithKeys(pool, async (k) => (k === "secret-one" ? res(429) : res(200)), { service: "groq", logger: { warn } });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("apikey.failover");
    expect(logged).not.toContain("secret");
  });

  it("a single key behaves like a plain call", async () => {
    const pool = new KeyPool(["only"]);
    const send = vi.fn(async () => res(429));
    expect((await fetchWithKeys(pool, send)).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
