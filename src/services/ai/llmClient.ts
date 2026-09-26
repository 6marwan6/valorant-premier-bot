import type { Env } from "../../config/env.js";
import type { Logger } from "../../config/logger.js";

/**
 * Provider-agnostic LLM access — plan section 57 ("The exact models should
 * remain configurable") and section 6 (no provider chosen for its own
 * sake). Everything above this file (aiService, aiContextBuilder) only
 * knows `LlmClient`; swapping Qwen for GLM (or anything else that speaks
 * OpenAI-style Chat Completions) is an env change, not a code change.
 */
export interface LlmRequest {
  system: string;
  user: string;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

/** `kind` lets callers log a reason without ever touching the response body (plan section 51). */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "network" | "empty",
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface OpenAiCompatibleConfig {
  apiKey: string;
  /** e.g. https://dashscope-intl.aliyuncs.com/compatible-mode/v1 — `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
  /** Provider-specific body fields (thinking/reasoning controls, response_format...). Merged last, so it can override defaults. */
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  maxTokens: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const controller = new AbortController();
    // The abort signal covers the response body read too, so a provider that
    // sends headers and then stalls can't hang the invocation (same failure
    // class as the DB timeouts in database/client.ts).
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          max_tokens: this.config.maxTokens,
          temperature: 0.9,
          ...this.config.extraBody,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LlmError(`LLM request failed with HTTP ${response.status}`, "http", response.status);
      }

      const json = (await response.json()) as ChatCompletionResponse;
      // Reasoning models put their chain of thought in a separate
      // `reasoning_content` field; only the final `content` is ever used.
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new LlmError("LLM returned no content", "empty");
      }

      return {
        text,
        model: json.model ?? this.config.model,
        inputTokens: json.usage?.prompt_tokens ?? null,
        outputTokens: json.usage?.completion_tokens ?? null,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(`LLM request timed out after ${this.config.timeoutMs}ms`, "timeout");
      }
      throw new LlmError(`LLM request failed: ${err instanceof Error ? err.message : String(err)}`, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

type LlmEnv = Pick<
  Env,
  "LLM_API_KEY" | "LLM_BASE_URL" | "LLM_MODEL" | "LLM_EXTRA_BODY" | "LLM_TIMEOUT_MS" | "LLM_MAX_TOKENS"
>;

/**
 * Returns null (AI disabled) rather than throwing when the LLM isn't fully
 * configured or LLM_EXTRA_BODY is malformed: plan design principle #8 —
 * attendance must keep working no matter what the AI layer's state is, so
 * a bad AI env var must never take down the whole interaction handler.
 *
 * Both ways this can come back disabled are logged (this used to fall
 * through to `return null` completely silently for a missing key/URL/model
 * — the single most likely explanation for "the AI never seems to run and
 * nothing in the logs says why"). Logged once per cold start, not per
 * request, since createLlmClient runs once when AppContext is built.
 */
export function createLlmClient(env: LlmEnv, logger?: Pick<Logger, "error" | "warn" | "info">): LlmClient | null {
  if (!env.LLM_API_KEY || !env.LLM_BASE_URL || !env.LLM_MODEL) {
    const missing = [
      !env.LLM_API_KEY && "LLM_API_KEY",
      !env.LLM_BASE_URL && "LLM_BASE_URL",
      !env.LLM_MODEL && "LLM_MODEL",
    ].filter((v): v is string => Boolean(v));
    logger?.warn(
      { event: "ai.config.missing", missing },
      `AI disabled — missing env var(s): ${missing.join(", ")}. Attendance and DMs still work, just without AI (plan design principle #8).`,
    );
    return null;
  }

  let extraBody: Record<string, unknown> = {};
  if (env.LLM_EXTRA_BODY) {
    try {
      const parsed: unknown = JSON.parse(env.LLM_EXTRA_BODY);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("must be a JSON object");
      }
      extraBody = parsed as Record<string, unknown>;
    } catch (err) {
      logger?.error(
        { event: "ai.config.invalidExtraBody", err: err instanceof Error ? err.message : String(err) },
        "LLM_EXTRA_BODY is not a valid JSON object — AI disabled",
      );
      return null;
    }
  }

  // Never logs the API key itself — just enough to confirm "yes, AI is on,
  // and here's what it's pointed at" is visible without grepping through
  // every request.
  let baseHost: string;
  try {
    baseHost = new URL(env.LLM_BASE_URL).host;
  } catch {
    baseHost = env.LLM_BASE_URL;
  }
  logger?.info(
    { event: "ai.config.enabled", model: env.LLM_MODEL, baseHost, timeoutMs: env.LLM_TIMEOUT_MS, maxTokens: env.LLM_MAX_TOKENS },
    "AI enabled",
  );

  return new OpenAiCompatibleLlmClient({
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    extraBody,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
  });
}
