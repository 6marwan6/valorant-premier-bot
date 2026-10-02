/**
 * Several API keys for one service, used in order, with automatic failover (2026-10-01 (d)).
 *
 * Put a list in the env var, separated by commas, spaces, semicolons or new lines:
 *   GROQ_API_KEY=gsk_one,gsk_two
 * Mari stays on the first key until a request is refused for a KEY reason (429 rate/daily limit, 401 bad key,
 * 402 out of credit), puts that key on a cooldown, and retries the same request on the next key. When the
 * cooldown ends the key becomes usable again (first key first). Network errors and 4xx/5xx that aren't about
 * the key are NOT a reason to switch: they come back to the caller untouched.
 *
 * State is per process (the voice worker, or one serverless instance), which is fine for failover: at worst a
 * cold instance spends one request learning that a key is exhausted. Keys are never logged; only their position.
 */

/** "a, b;c\nd" -> ["a","b","c","d"] (trimmed, de-duplicated, empties dropped). */
export function parseKeyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];
}

/** Statuses that mean "this key can't serve this request right now", as opposed to "this request is wrong". */
export const KEY_PROBLEM_STATUSES = new Set([401, 402, 429]);

const DEFAULT_LIMIT_COOLDOWN_MS = 60_000;
const MAX_LIMIT_COOLDOWN_MS = 6 * 60 * 60_000;
const BAD_KEY_COOLDOWN_MS = 60 * 60_000;
const OUT_OF_CREDIT_COOLDOWN_MS = 6 * 60 * 60_000;

export class KeyPool {
  private readonly until: number[];

  constructor(
    private readonly keys: string[],
    private readonly now: () => number = Date.now,
  ) {
    this.until = keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /** Indexes in the order they should be tried: usable keys first (list order), then cooling ones by soonest recovery. */
  order(): number[] {
    const t = this.now();
    const usable: number[] = [];
    const cooling: number[] = [];
    this.keys.forEach((_, i) => (this.until[i]! <= t ? usable : cooling).push(i));
    cooling.sort((a, b) => this.until[a]! - this.until[b]!);
    return [...usable, ...cooling];
  }

  key(index: number): string {
    return this.keys[index]!;
  }

  /** How many keys are usable right now. */
  get available(): number {
    const t = this.now();
    return this.until.filter((u) => u <= t).length;
  }

  /** Cooldown after a refusal: `retryAfterSeconds` from the response if given (bounded), else a default by status. */
  penalize(index: number, status: number, retryAfterSeconds?: number): number {
    let ms: number;
    if (status === 401) ms = BAD_KEY_COOLDOWN_MS;
    else if (status === 402) ms = OUT_OF_CREDIT_COOLDOWN_MS;
    else if (retryAfterSeconds && retryAfterSeconds > 0) ms = Math.min(MAX_LIMIT_COOLDOWN_MS, Math.max(1_000, retryAfterSeconds * 1000));
    else ms = DEFAULT_LIMIT_COOLDOWN_MS;
    this.until[index] = this.now() + ms;
    return ms;
  }
}

export interface FailoverLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Runs `send(key)` with each key in turn until one isn't refused for a key reason. Returns that Response, or
 * the last refusal if every key is refused (the caller then handles it like any other failed request).
 * With a single key this is just one call, so it is safe to use everywhere.
 */
export async function fetchWithKeys(
  pool: KeyPool,
  send: (key: string) => Promise<Response>,
  opts: { service: string; logger?: FailoverLogger } = { service: "api" },
): Promise<Response> {
  const order = pool.order();
  let last: Response | null = null;
  for (let n = 0; n < order.length; n++) {
    const index = order[n]!;
    const res = await send(pool.key(index));
    if (!KEY_PROBLEM_STATUSES.has(res.status)) return res;
    last = res;
    const retryAfter = Number(res.headers.get("retry-after") ?? 0) || undefined;
    const cooldownMs = pool.penalize(index, res.status, retryAfter);
    opts.logger?.warn(
      { event: "apikey.failover", service: opts.service, keyPosition: index + 1, of: pool.size, status: res.status, cooldownSeconds: Math.round(cooldownMs / 1000), nextAvailable: n + 1 < order.length },
      pool.size > 1 && n + 1 < order.length
        ? `${opts.service} key ${index + 1}/${pool.size} was refused (${res.status}); trying the next key`
        : `${opts.service} key ${index + 1}/${pool.size} was refused (${res.status})`,
    );
  }
  return last!;
}
