import { StringDecoder } from "node:string_decoder";

export type LlmProvider = "anthropic" | "openai";

/**
 * Real token usage reported by the upstream provider, normalized across
 * Anthropic Messages and OpenAI Responses / Chat Completions.
 *
 * - Anthropic: `inputTokens` is the UNCACHED remainder; the full prompt is
 *   `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`.
 * - OpenAI: `inputTokens` (`input_tokens` / `prompt_tokens`) already INCLUDES
 *   `cacheReadInputTokens` (`*_tokens_details.cached_tokens`); OpenAI does not
 *   report cache writes, so `cacheCreationInputTokens` stays `null`.
 */
export interface UpstreamUsage {
  provider: LlmProvider;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalPromptTokens: number | null;
  /** cacheReadInputTokens / totalPromptTokens (0..1), or null if unknown. */
  cacheHitRatio: number | null;
}

/** Routes `/v1/messages` (and `/v1/messages/count_tokens`) to Anthropic, everything else to OpenAI. */
export function detectProvider(urlOrPath: string): LlmProvider {
  const path = urlOrPath.split("?")[0] ?? "";
  if (/\/threads\//.test(path)) return "openai";
  return /(^|\/)messages(\/[a-z_]+)?\/?$/i.test(path) ? "anthropic" : "openai";
}

/** True for the LLM inference endpoints whose prompts are prefix-cached. */
export function isLlmEndpoint(urlOrPath: string): boolean {
  const path = (urlOrPath.split("?")[0] ?? "").replace(/\/+$/, "");
  return (
    /(^|\/)messages(\/count_tokens)?$/i.test(path) ||
    /(^|\/)responses$/i.test(path) ||
    /(^|\/)chat\/completions$/i.test(path)
  );
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class UsageAccumulator {
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  cacheReadInputTokens: number | null = null;
  cacheCreationInputTokens: number | null = null;

  constructor(readonly provider: LlmProvider) {}

  /** Merges one raw `usage` object; later non-null values win (cumulative SSE counters). */
  mergeUsageObject(raw: unknown): void {
    const usage = rec(raw);
    if (!usage) return;
    const set = (
      key:
        | "inputTokens"
        | "outputTokens"
        | "cacheReadInputTokens"
        | "cacheCreationInputTokens",
      value: number | undefined,
    ) => {
      if (value !== undefined) this[key] = value;
    };

    if (this.provider === "anthropic") {
      set("inputTokens", num(usage.input_tokens));
      set("outputTokens", num(usage.output_tokens));
      set("cacheReadInputTokens", num(usage.cache_read_input_tokens));
      set("cacheCreationInputTokens", num(usage.cache_creation_input_tokens));
      return;
    }

    // OpenAI Chat Completions
    if (num(usage.prompt_tokens) !== undefined || num(usage.completion_tokens) !== undefined) {
      set("inputTokens", num(usage.prompt_tokens));
      set("outputTokens", num(usage.completion_tokens));
      set("cacheReadInputTokens", num(rec(usage.prompt_tokens_details)?.cached_tokens));
      return;
    }
    // OpenAI Responses
    set("inputTokens", num(usage.input_tokens));
    set("outputTokens", num(usage.output_tokens));
    set("cacheReadInputTokens", num(rec(usage.input_tokens_details)?.cached_tokens));
  }

  /**
   * Merges the usage carried by a JSON response body or one SSE `data:` payload:
   * top-level `usage` (JSON bodies, Anthropic `message_delta`, Chat Completions
   * final chunk), `message.usage` (Anthropic `message_start`), or
   * `response.usage` (OpenAI `response.completed`).
   */
  mergePayload(payload: unknown): void {
    const obj = rec(payload);
    if (!obj) return;
    this.mergeUsageObject(rec(obj.message)?.usage);
    this.mergeUsageObject(rec(obj.response)?.usage);
    this.mergeUsageObject(obj.usage);
  }

  hasData(): boolean {
    return (
      this.inputTokens !== null ||
      this.outputTokens !== null ||
      this.cacheReadInputTokens !== null ||
      this.cacheCreationInputTokens !== null
    );
  }

  toUsage(): UpstreamUsage | null {
    if (!this.hasData()) return null;
    let totalPromptTokens: number | null;
    if (this.provider === "anthropic") {
      const parts = [
        this.inputTokens,
        this.cacheReadInputTokens,
        this.cacheCreationInputTokens,
      ].filter((v): v is number => v !== null);
      totalPromptTokens = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
    } else {
      totalPromptTokens = this.inputTokens;
    }
    const cacheHitRatio =
      totalPromptTokens !== null && totalPromptTokens > 0
        ? Math.round(((this.cacheReadInputTokens ?? 0) / totalPromptTokens) * 10_000) /
          10_000
        : null;
    return {
      provider: this.provider,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      totalPromptTokens,
      cacheHitRatio,
    };
  }
}

export interface UsageSink {
  push(chunk: Buffer): void;
  end(): void;
}

const MAX_SSE_EVENT_BUFFER = 8 * 1024 * 1024;
const MAX_JSON_BODY_BUFFER = 32 * 1024 * 1024;

/** Incremental `text/event-stream` parser feeding `data:` JSON payloads to a UsageAccumulator. */
export class SseUsageParser implements UsageSink {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly acc: UsageAccumulator) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const rawEvent = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.handleEvent(rawEvent);
    }
    if (this.buffer.length > MAX_SSE_EVENT_BUFFER) this.buffer = "";
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim().length > 0) this.handleEvent(this.buffer);
    this.buffer = "";
  }

  private handleEvent(rawEvent: string): void {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      this.acc.mergePayload(JSON.parse(data));
    } catch {
      // Non-JSON data line
    }
  }
}

/** Buffers a (decompressed) JSON response body and extracts its top-level usage at end. */
export class JsonUsageCollector implements UsageSink {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private overflow = false;

  constructor(private readonly acc: UsageAccumulator) {}

  push(chunk: Buffer): void {
    if (this.overflow) return;
    this.size += chunk.length;
    if (this.size > MAX_JSON_BODY_BUFFER) {
      this.overflow = true;
      this.chunks.length = 0;
      return;
    }
    this.chunks.push(chunk);
  }

  end(): void {
    if (this.overflow || this.chunks.length === 0) return;
    try {
      this.acc.mergePayload(JSON.parse(Buffer.concat(this.chunks).toString("utf8")));
    } catch {
      // Non-JSON body (e.g. HTML error page)
    }
  }
}

/** Convenience helper: extract usage from a complete JSON body or SSE transcript. */
export function extractUsage(
  provider: LlmProvider,
  body: string,
  contentType = "application/json",
): UpstreamUsage | null {
  const acc = new UsageAccumulator(provider);
  const sink: UsageSink = contentType.toLowerCase().includes("text/event-stream")
    ? new SseUsageParser(acc)
    : new JsonUsageCollector(acc);
  sink.push(Buffer.from(body, "utf8"));
  sink.end();
  return acc.toUsage();
}
