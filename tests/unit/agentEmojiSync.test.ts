import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { AGENTS, agentEmojiName, agentIconUrl } from "../../src/modules/agents/agentData.js";
import { EMOJI_PIXELS, MAX_EMOJI_BYTES, portraitCandidates, syncAgentEmojis, type SyncDeps } from "../../src/modules/agents/agentEmojiSync.js";

const jett = AGENTS.find((a) => a.key === "jett")!;
const png = (n = 10) => Buffer.alloc(n, 1);

function deps(over: Partial<SyncDeps> = {}): SyncDeps & { uploads: Array<{ name: string; size: number }> } {
  const uploads: Array<{ name: string; size: number }> = [];
  return {
    existingNames: [],
    fetchMeta: vi.fn(async () => ({ displayIconSmall: "https://cdn/x/small.png", displayIcon: "https://cdn/x/big.png" })),
    fetchBytes: vi.fn(async () => png(50)),
    toEmojiPng: vi.fn(async (b: Buffer) => b),
    upload: vi.fn(async (name: string, p: Buffer) => void uploads.push({ name, size: p.length })),
    ...over,
    uploads,
  };
}

describe("portraitCandidates", () => {
  it("orders the metadata's images, ends with the app's known-good thumbnail, drops blanks, non-https and duplicates", () => {
    expect(portraitCandidates(jett, { displayIconSmall: "https://a/small.png", displayIcon: null, killfeedPortrait: "http://insecure/k.png" })).toEqual(["https://a/small.png", agentIconUrl(jett)]);
    expect(portraitCandidates(jett, { displayIcon: agentIconUrl(jett) })).toEqual([agentIconUrl(jett)]);
    expect(portraitCandidates(jett, null)).toEqual([agentIconUrl(jett)]);
  });
});

describe("syncAgentEmojis", () => {
  it("uploads one emoji per agent named agent_<key>, skipping agents that already have one", async () => {
    const d = deps({ existingNames: ["agent_jett", "logo"] });
    const r = await syncAgentEmojis(d);
    expect(r.uploaded).toHaveLength(AGENTS.length - 1);
    expect(r.alreadyThere).toBe(1);
    expect(r.failed).toEqual([]);
    expect(d.uploads.map((u) => u.name)).not.toContain("agent_jett");
    expect(d.uploads.map((u) => u.name)).toContain(agentEmojiName("sova"));
  });

  it("falls to the next image when one 404s (the original bug: a guessed small-icon URL 404'd for every agent)", async () => {
    const fetchBytes = vi.fn(async (url: string) => {
      if (url.endsWith("small.png")) throw new Error("HTTP 404");
      return png(80);
    });
    const d = deps({ fetchBytes });
    const r = await syncAgentEmojis(d);
    expect(r.failed).toEqual([]);
    expect(fetchBytes).toHaveBeenCalledWith("https://cdn/x/big.png");
  });

  it("still works when the metadata call itself fails, using the app's own thumbnail URL", async () => {
    const fetchBytes = vi.fn(async () => png(40));
    const d = deps({ fetchMeta: vi.fn(async () => { throw new Error("HTTP 500"); }), fetchBytes, existingNames: AGENTS.filter((a) => a.key !== "jett").map((a) => agentEmojiName(a.key)) });
    const r = await syncAgentEmojis(d);
    expect(r.uploaded).toEqual(["jett"]);
    expect(fetchBytes).toHaveBeenCalledWith(agentIconUrl(jett));
  });

  it("reports why when no image works, naming every URL it tried, and carries on with the other agents", async () => {
    const fetchBytes = vi.fn(async (url: string) => {
      if (url.includes(jett.uuid) || url.includes("/jett/")) throw new Error("HTTP 404");
      return png(30);
    });
    const d = deps({ fetchBytes, fetchMeta: vi.fn(async (uuid: string) => (uuid === jett.uuid ? { displayIconSmall: "https://cdn/jett/small.png" } : {})) });
    const r = await syncAgentEmojis(d);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.agent).toBe("jett");
    expect(r.failed[0]!.reason).toContain("small.png: HTTP 404");
    expect(r.failed[0]!.reason).toContain("displayicon.png: HTTP 404");
    expect(r.uploaded).toHaveLength(AGENTS.length - 1);
  });

  it("rejects an image that is still over Discord's limit after resizing, and tries the next source", async () => {
    const toEmojiPng = vi.fn(async (b: Buffer) => (b.length === 1 ? Buffer.alloc(MAX_EMOJI_BYTES + 1) : b));
    const fetchBytes = vi.fn(async (url: string) => (url.endsWith("small.png") ? Buffer.alloc(1) : png(60)));
    const r = await syncAgentEmojis(deps({ toEmojiPng, fetchBytes }));
    expect(r.failed).toEqual([]);
  });

  it("reports a Discord rejection as such, and does not retry other images for it", async () => {
    const upload = vi.fn(async () => { throw new Error("Invalid Form Body"); });
    const fetchBytes = vi.fn(async () => png(20));
    const r = await syncAgentEmojis(deps({ upload, fetchBytes, existingNames: AGENTS.filter((a) => a.key !== "jett").map((a) => agentEmojiName(a.key)) }));
    expect(r.failed).toEqual([{ agent: "jett", reason: "Discord rejected the upload: Invalid Form Body" }]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("a real 1024px portrait comes out as a 128px PNG far under Discord's limit (the resize the script uses)", async () => {
    const big = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 1 } } }).png().toBuffer();
    const out = await sharp(big).resize(EMOJI_PIXELS, EMOJI_PIXELS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 128, 128]);
    expect(out.length).toBeLessThan(MAX_EMOJI_BYTES);
  });
});
