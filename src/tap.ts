import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import {
  analyzePromptPrefix,
  deriveSessionKey,
  PromptCacheTracker,
  type CacheDiagnostics,
  type DivergentLayer,
} from "./prefix.js";
import {
  createUpstreamAgents,
  forwardToUpstream,
  resolveUpstreamUrl,
  type PassthroughOptions,
  type UpstreamExchange,
} from "./proxy.js";
import { redactHeaders, redactUrl } from "./redact.js";
import { isLlmEndpoint } from "./usage.js";

export interface CapturedWireRequest {
  method: string;
  url: string;
  model: string | null;
  bodyBytes: number;
  estimatedTokens: number;
  systemPromptChars: number;
  toolsCount: number;
  toolNames: string[];
  toolsSchemaBytes: number;
  estimatedToolTokens: number;
  rawBody: string;
  /** Turn-over-turn prompt-prefix hash & cache_control diagnostics (LLM endpoints only). */
  cacheDiagnostics?: CacheDiagnostics;
  /** Present in `--passthrough` mode: real upstream exchange (credentials redacted). */
  upstream?: UpstreamExchange;
}

export type WireTapMode = "mock" | "passthrough";

export interface WireTapUsageTotals {
  requestsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalPromptTokens: number;
  /** cacheReadInputTokens / totalPromptTokens across all requests with usage (0..1). */
  cacheHitRatio: number | null;
}

export interface WireTapCacheDivergence {
  requestIndex: number;
  comparedToRequest: number | null;
  url: string;
  model: string | null;
  matchedPrefixBlocks: number;
  totalBlocks: number;
  firstDivergentLayer: Exclude<DivergentLayer, "none">;
  firstDivergentIndex: string | null;
  divergedBeforeBreakpoint: boolean;
  reason: string;
}

export interface WireTapAssertions {
  assertContains?: string[];
  assertNotContains?: string[];
  assertMaxBytes?: number;
  assertMaxTools?: number;
}

export interface WireTapAssertionResult {
  kind: "contains" | "not-contains" | "max-bytes" | "max-tools";
  target: string | number;
  passed: boolean;
  message: string;
}

export interface WireTapReport {
  status: "passed" | "failed";
  requestsCaptured: number;
  totalPayloadBytes: number;
  estimatedTotalTokens: number;
  maxToolsCount: number;
  modelsObserved: string[];
  toolNamesObserved: string[];
  requests: Array<Omit<CapturedWireRequest, "rawBody">>;
  assertions: WireTapAssertionResult[];
  failures: string[];
  /** `mock` (synthetic $0 replies, default) or `passthrough` (live upstream). */
  mode: WireTapMode;
  /** Real upstream token & prompt-cache usage totals (passthrough mode), else null. */
  usageTotals: WireTapUsageTotals | null;
  /** Requests whose prompt prefix diverged from the previous turn. */
  cacheDivergences: WireTapCacheDivergence[];
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (typeof rec.text === "string") return rec.text;
          if (rec.content !== undefined) {
            return extractTextFromContent(rec.content);
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function decodeRequestBody(rawBuffer: Buffer, encodingHeader?: string): string {
  const encoding = (encodingHeader ?? "").toLowerCase().trim();
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(rawBuffer).toString("utf8");
    }
    if (encoding === "deflate") {
      return inflateSync(rawBuffer).toString("utf8");
    }
    if (encoding === "br") {
      return brotliDecompressSync(rawBuffer).toString("utf8");
    }
  } catch {
    // Fallback to raw UTF-8 if header mismatched actual payload
  }
  return rawBuffer.toString("utf8");
}

export function analyzeWirePayload(
  method: string,
  url: string,
  rawBody: string,
): CapturedWireRequest {
  const bodyBytes = Buffer.byteLength(rawBody, "utf8");
  const estimatedTokens = Math.ceil(bodyBytes / 4);

  let model: string | null = null;
  let systemPromptChars = 0;
  let toolsCount = 0;
  const toolNames: string[] = [];
  let toolsSchemaBytes = 0;

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof parsed.model === "string") {
      model = parsed.model;
    }

    if (typeof parsed.instructions === "string") {
      systemPromptChars += parsed.instructions.length;
    }
    if (parsed.system !== undefined) {
      systemPromptChars += extractTextFromContent(parsed.system).length;
    }

    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed.input)
        ? parsed.input
        : [];
    for (const msg of messages) {
      if (msg && typeof msg === "object") {
        const rec = msg as Record<string, unknown>;
        if (rec.role === "system" || rec.role === "developer") {
          systemPromptChars += extractTextFromContent(rec.content).length;
        }
      }
    }

    if (Array.isArray(parsed.tools)) {
      toolsCount = parsed.tools.length;
      toolsSchemaBytes = Buffer.byteLength(
        JSON.stringify(parsed.tools),
        "utf8",
      );
      for (const tool of parsed.tools) {
        if (!tool || typeof tool !== "object") continue;
        const rec = tool as Record<string, unknown>;
        if (typeof rec.name === "string" && rec.name.trim().length > 0) {
          toolNames.push(rec.name);
        } else if (
          rec.function &&
          typeof rec.function === "object" &&
          typeof (rec.function as Record<string, unknown>).name === "string" &&
          ((rec.function as Record<string, unknown>).name as string).trim()
            .length > 0
        ) {
          toolNames.push(
            (rec.function as Record<string, unknown>).name as string,
          );
        } else if (typeof rec.type === "string" && rec.type.trim().length > 0) {
          toolNames.push(rec.type);
        }
      }
    }
  } catch {
    // Non-JSON payload
  }

  return {
    method,
    url,
    model,
    bodyBytes,
    estimatedTokens,
    systemPromptChars,
    toolsCount,
    toolNames,
    toolsSchemaBytes,
    estimatedToolTokens: Math.ceil(toolsSchemaBytes / 4),
    rawBody,
  };
}

function writeSyntheticReply(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  syntheticText = "[agent-wire-tap] synthetic loopback response",
): void {
  const url = req.url ?? "/";
  let isStream = false;
  let model = "wire-tap-mock";
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    isStream = parsed.stream === true;
    if (typeof parsed.model === "string") model = parsed.model;
  } catch {
    // Default non-stream
  }

  if (url.includes("/messages")) {
    // Anthropic Messages API
    if (isStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const events = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_wiretap_01",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: syntheticText },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ];
      for (const ev of events) res.write(ev);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_wiretap_01",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: syntheticText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    return;
  }

  if (url.includes("/responses")) {
    // OpenAI Responses API
    if (isStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const completed = {
        type: "response.completed",
        response: {
          id: "resp_wiretap_01",
          object: "response",
          status: "completed",
          model,
          output: [
            {
              id: "msg_wiretap_01",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: syntheticText,
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        },
      };
      res.write(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      );
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_wiretap_01",
        object: "response",
        status: "completed",
        model,
        output: [
          {
            id: "msg_wiretap_01",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: syntheticText,
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      }),
    );
    return;
  }

  // Default: OpenAI Chat Completions API
  if (isStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = {
      id: "chatcmpl_wiretap_01",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: syntheticText },
          finish_reason: "stop",
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl_wiretap_01",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: syntheticText },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

export function summarizeUsage(
  requests: Array<Pick<CapturedWireRequest, "upstream">>,
): WireTapUsageTotals | null {
  const usages = requests
    .map((r) => r.upstream?.usage)
    .filter((u): u is NonNullable<typeof u> => Boolean(u));
  if (usages.length === 0) return null;
  const sum = (pick: (u: (typeof usages)[number]) => number | null) =>
    usages.reduce((acc, u) => acc + (pick(u) ?? 0), 0);
  const totalPromptTokens = sum((u) => u.totalPromptTokens);
  const cacheReadInputTokens = sum((u) => u.cacheReadInputTokens);
  return {
    requestsWithUsage: usages.length,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadInputTokens,
    cacheCreationInputTokens: sum((u) => u.cacheCreationInputTokens),
    totalPromptTokens,
    cacheHitRatio:
      totalPromptTokens > 0
        ? Math.round((cacheReadInputTokens / totalPromptTokens) * 10_000) / 10_000
        : null,
  };
}

export function summarizeCacheDivergences(
  requests: Array<Pick<CapturedWireRequest, "url" | "model" | "cacheDiagnostics">>,
): WireTapCacheDivergence[] {
  const out: WireTapCacheDivergence[] = [];
  requests.forEach((r, requestIndex) => {
    const d = r.cacheDiagnostics;
    if (!d || d.firstDivergentLayer === "none") return;
    out.push({
      requestIndex,
      comparedToRequest: d.comparedToRequest,
      url: r.url,
      model: r.model,
      matchedPrefixBlocks: d.matchedPrefixBlocks,
      totalBlocks: d.totalBlocks,
      firstDivergentLayer: d.firstDivergentLayer,
      firstDivergentIndex: d.firstDivergentIndex,
      divergedBeforeBreakpoint: d.divergedBeforeBreakpoint,
      reason: d.reason,
    });
  });
  return out;
}

export function evaluateWireAssertions(
  requests: CapturedWireRequest[],
  assertions: WireTapAssertions = {},
  meta: { mode?: WireTapMode } = {},
): WireTapReport {
  const combinedRaw = requests.map((r) => r.rawBody).join("\n");
  const totalPayloadBytes = requests.reduce((sum, r) => sum + r.bodyBytes, 0);
  const estimatedTotalTokens = requests.reduce(
    (sum, r) => sum + r.estimatedTokens,
    0,
  );
  const maxToolsCount = requests.reduce(
    (max, r) => Math.max(max, r.toolsCount),
    0,
  );
  const modelsObserved = [
    ...new Set(
      requests.map((r) => r.model).filter((m): m is string => Boolean(m)),
    ),
  ];
  const toolNamesObserved = [
    ...new Set(requests.flatMap((r) => r.toolNames)),
  ].sort();

  const results: WireTapAssertionResult[] = [];

  for (const needle of assertions.assertContains ?? []) {
    const passed = requests.length > 0 && combinedRaw.includes(needle);
    results.push({
      kind: "contains",
      target: needle,
      passed,
      message: passed
        ? `Wire payload contains "${needle}".`
        : `Expected wire payload to contain "${needle}", but it was not found.`,
    });
  }

  for (const forbidden of assertions.assertNotContains ?? []) {
    const passed = requests.length > 0 && !combinedRaw.includes(forbidden);
    results.push({
      kind: "not-contains",
      target: forbidden,
      passed,
      message: passed
        ? `Wire payload does not contain forbidden string "${forbidden}".`
        : requests.length === 0
          ? `Cannot verify absence of "${forbidden}" because 0 wire requests were captured.`
          : `Forbidden string "${forbidden}" was leaked in the outbound wire payload.`,
    });
  }

  if (assertions.assertMaxBytes !== undefined) {
    const passed =
      requests.length > 0 && totalPayloadBytes <= assertions.assertMaxBytes;
    results.push({
      kind: "max-bytes",
      target: assertions.assertMaxBytes,
      passed,
      message: passed
        ? `Total wire payload (${totalPayloadBytes} bytes) is within budget (<= ${assertions.assertMaxBytes} bytes).`
        : requests.length === 0
          ? `Cannot verify max-bytes budget (<= ${assertions.assertMaxBytes} bytes) because 0 wire requests were captured.`
          : `Total wire payload (${totalPayloadBytes} bytes) exceeded budget (> ${assertions.assertMaxBytes} bytes).`,
    });
  }

  if (assertions.assertMaxTools !== undefined) {
    const passed =
      requests.length > 0 && maxToolsCount <= assertions.assertMaxTools;
    results.push({
      kind: "max-tools",
      target: assertions.assertMaxTools,
      passed,
      message: passed
        ? `Maximum tools schema count (${maxToolsCount}) is within budget (<= ${assertions.assertMaxTools} tools).`
        : requests.length === 0
          ? `Cannot verify max-tools budget (<= ${assertions.assertMaxTools} tools) because 0 wire requests were captured.`
          : `Maximum tools schema count (${maxToolsCount}) exceeded budget (> ${assertions.assertMaxTools} tools).`,
    });
  }

  const failures = results.filter((r) => !r.passed).map((r) => r.message);
  if (requests.length === 0 && failures.length === 0) {
    failures.push("No outbound wire requests were captured during execution.");
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    requestsCaptured: requests.length,
    totalPayloadBytes,
    estimatedTotalTokens,
    maxToolsCount,
    modelsObserved,
    toolNamesObserved,
    requests: requests.map(({ rawBody: _raw, ...rest }) => rest),
    assertions: results,
    failures,
    mode: meta.mode ?? (requests.some((r) => r.upstream) ? "passthrough" : "mock"),
    usageTotals: summarizeUsage(requests),
    cacheDivergences: summarizeCacheDivergences(requests),
  };
}

export interface EphemeralWireTapServer {
  baseUrl: string;
  port: number;
  requests: CapturedWireRequest[];
  mode: WireTapMode;
  close: () => Promise<void>;
}

export interface WireTapServerOptions {
  /** Text returned by synthetic mock replies (mock mode only). */
  syntheticText?: string;
  /** Enable live pass-through reverse-proxy mode (`true` = auto-route to official APIs). */
  passthrough?: PassthroughOptions | boolean;
  /** Bind host (default `127.0.0.1`). */
  host?: string;
  /** Bind port (default `0` = ephemeral). */
  port?: number;
  /** JSONL trace file: one redacted record per completed exchange (truncated on start). */
  traceFile?: string;
  /** Called after each exchange completes (response fully delivered). */
  onExchange?: (record: CapturedWireRequest, index: number) => void;
}

/** The persisted/serialized shape of a captured request: never contains `rawBody`. */
export function toTraceRecord(
  record: CapturedWireRequest,
  index: number,
  mode: WireTapMode,
): Record<string, unknown> {
  const { rawBody: _raw, ...rest } = record;
  return { timestamp: new Date().toISOString(), index, mode, ...rest };
}

export async function startWireTapServer(
  options: string | WireTapServerOptions = {},
): Promise<EphemeralWireTapServer> {
  const opts: WireTapServerOptions =
    typeof options === "string" ? { syntheticText: options } : options;
  const passthrough: PassthroughOptions | null =
    opts.passthrough === true
      ? {}
      : opts.passthrough && typeof opts.passthrough === "object"
        ? opts.passthrough
        : null;
  const mode: WireTapMode = passthrough ? "passthrough" : "mock";
  const requests: CapturedWireRequest[] = [];
  const tracker = new PromptCacheTracker();
  const agents = passthrough ? createUpstreamAgents() : null;
  const pending = new Set<Promise<void>>();

  const traceFile = opts.traceFile ? resolvePath(opts.traceFile) : null;
  let traceChain: Promise<void> = Promise.resolve();
  if (traceFile) {
    await mkdir(dirname(traceFile), { recursive: true });
    await writeFile(traceFile, "", "utf8");
  }

  const completeExchange = (record: CapturedWireRequest, index: number) => {
    if (traceFile) {
      const line = `${JSON.stringify(toTraceRecord(record, index, mode))}\n`;
      traceChain = traceChain
        .then(() => appendFile(traceFile, line, "utf8"))
        .catch(() => undefined);
    }
    try {
      opts.onExchange?.(record, index);
    } catch {
      // Observer errors must never break the proxy.
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBuffer = Buffer.concat(chunks);
      const rawBody = decodeRequestBody(
        rawBuffer,
        typeof req.headers["content-encoding"] === "string"
          ? req.headers["content-encoding"]
          : undefined,
      );
      const reqUrl = req.url ?? "/";
      const record = analyzeWirePayload(
        req.method ?? "POST",
        redactUrl(reqUrl),
        rawBody,
      );
      const index = requests.length;
      if (isLlmEndpoint(reqUrl)) {
        const snapshot = analyzePromptPrefix(rawBody, reqUrl);
        if (snapshot) {
          record.cacheDiagnostics = tracker.observe(
            index,
            deriveSessionKey(reqUrl, req.headers, rawBody),
            snapshot,
          );
        }
      }
      requests.push(record);

      if (!passthrough || !agents) {
        writeSyntheticReply(req, res, rawBody, opts.syntheticText);
        completeExchange(record, index);
        return;
      }

      const target = resolveUpstreamUrl(reqUrl, passthrough);
      record.upstream = {
        url: redactUrl(target.href),
        status: null,
        durationMs: null,
        streamed: false,
        requestHeaders: redactHeaders(req.headers),
        responseHeaders: {},
        usage: null,
      };
      const exchange = forwardToUpstream({
        req,
        res,
        body: rawBuffer,
        target,
        agents,
      }).then((result) => {
        Object.assign(record.upstream!, result);
        completeExchange(record, index);
      });
      pending.add(exchange);
      void exchange.finally(() => pending.delete(exchange));
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const displayHost =
    host === "0.0.0.0" || host === "::"
      ? "127.0.0.1"
      : host.includes(":")
        ? `[${host}]`
        : host;
  const baseUrl = `http://${displayHost}:${addr.port}`;

  return {
    baseUrl,
    port: addr.port,
    requests,
    mode,
    close: async () => {
      if (pending.size > 0) {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((r) => setTimeout(r, 2_000).unref()),
        ]);
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        if (pending.size > 0) server.closeAllConnections?.();
      });
      agents?.destroy();
      await traceChain;
    },
  };
}

function resolveWindowsSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }
  const lower = command.toLowerCase();
  if (lower === "npx" || lower === "npm") {
    const cliScript = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      lower === "npx" ? "npx-cli.js" : "npm-cli.js",
    );
    if (existsSync(cliScript)) {
      return {
        command: process.execPath,
        args: [cliScript, ...args],
        shell: false,
      };
    }
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { command, args, shell: true };
  }
  if (!lower.endsWith(".exe") && !lower.includes("/") && !lower.includes("\\")) {
    const pathDirs = (env.PATH ?? env.Path ?? "").split(delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      if (existsSync(join(dir, `${command}.exe`))) {
        return { command, args, shell: false };
      }
      if (
        existsSync(join(dir, `${command}.cmd`)) ||
        existsSync(join(dir, `${command}.bat`))
      ) {
        return { command, args, shell: true };
      }
    }
  }
  return { command, args, shell: false };
}

export async function runAgentCommandWithWireTap(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  assertions?: WireTapAssertions;
  /** Live pass-through to the real upstream APIs instead of synthetic replies. */
  passthrough?: PassthroughOptions | boolean;
  /** JSONL trace file (one redacted record per exchange). */
  traceFile?: string;
  /** Fixed proxy port (default: ephemeral). */
  port?: number;
  host?: string;
  onExchange?: (record: CapturedWireRequest, index: number) => void;
}): Promise<{
  report: WireTapReport;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const tap = await startWireTapServer({
    ...(options.passthrough ? { passthrough: options.passthrough } : {}),
    ...(options.traceFile ? { traceFile: options.traceFile } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.onExchange ? { onExchange: options.onExchange } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 15_000;
  let closed = false;

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      OPENAI_BASE_URL: `${tap.baseUrl}/v1`,
      OPENAI_API_BASE: `${tap.baseUrl}/v1`,
      ANTHROPIC_BASE_URL: tap.baseUrl,
      WIRE_TAP_BASE_URL: tap.baseUrl,
    };
    if (tap.mode === "mock") {
      // Mock mode only: placeholder keys so agents start without real credentials.
      // In passthrough mode the agent's own credentials (API key or OAuth) are
      // forwarded untouched, so nothing is injected.
      env.OPENAI_API_KEY =
        options.env?.OPENAI_API_KEY ??
        process.env.OPENAI_API_KEY ??
        "sk-wiretap-local-loopback-000000000000";
      env.ANTHROPIC_API_KEY =
        options.env?.ANTHROPIC_API_KEY ??
        process.env.ANTHROPIC_API_KEY ??
        "sk-ant-wiretap-local-loopback-000000000000";
    }

    const resolved = resolveWindowsSpawn(options.command, options.args, env);

    const execResult = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: resolved.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ exitCode: 124, stdout, stderr });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      });
    });

    // Let in-flight exchanges finish (usage parsed, trace flushed) before reporting.
    closed = true;
    await tap.close();
    const report = evaluateWireAssertions(tap.requests, options.assertions, {
      mode: tap.mode,
    });
    return {
      report,
      ...execResult,
    };
  } finally {
    if (!closed) await tap.close();
  }
}

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "?";
}

/** One-line human summary of a single exchange (used by the live proxy log). */
export function formatExchangeLine(
  req: Omit<CapturedWireRequest, "rawBody">,
  index: number,
): string {
  const parts = [`#${index} ${req.method} ${req.url}`];
  if (req.upstream) {
    parts[0] += ` -> ${req.upstream.status ?? "ERR"}`;
    if (req.upstream.durationMs !== null) parts.push(`${req.upstream.durationMs}ms`);
    if (req.upstream.streamed) parts.push("SSE");
  }
  parts.push(`model=${req.model ?? "unknown"}`);
  const u = req.upstream?.usage;
  if (u) {
    parts.push(
      `in=${fmt(u.inputTokens)} cache_read=${fmt(u.cacheReadInputTokens)} cache_write=${fmt(u.cacheCreationInputTokens)} out=${fmt(u.outputTokens)}${
        u.cacheHitRatio !== null ? ` (hit ${(u.cacheHitRatio * 100).toFixed(1)}%)` : ""
      }`,
    );
  }
  if (req.upstream?.error) parts.push(`error: ${req.upstream.error}`);
  const lines = [parts.join(" · ")];
  const diag = formatCacheDiagnosticsLine(req.cacheDiagnostics);
  if (diag) lines.push(diag);
  return lines.join("\n");
}

function formatCacheDiagnosticsLine(d: CacheDiagnostics | undefined): string | null {
  if (!d) return null;
  const bps = `${d.cacheBreakpoints.count} cache_control breakpoint(s)`;
  if (d.comparedToRequest === null) {
    return `  ↳ prefix baseline · ${d.totalBlocks} blocks · ${bps} · hash ${d.prefixHash}`;
  }
  if (d.firstDivergentLayer === "none") {
    return `  ↳ prefix ${d.matchedPrefixBlocks}/${d.totalBlocks} blocks match #${d.comparedToRequest} · ${bps} · ${d.reason}`;
  }
  return `  ↳ PREFIX DIVERGED at ${d.firstDivergentIndex} (${d.firstDivergentLayer}) vs #${d.comparedToRequest} · ${d.matchedPrefixBlocks}/${d.totalBlocks} blocks match${
    d.divergedBeforeBreakpoint ? " · BEFORE cache_control breakpoint (cache invalidated)" : ""
  } · ${d.reason}`;
}

export function renderWireTapReport(report: WireTapReport): string {
  const lines = [
    `agent-wire-tap · ${report.status} · ${report.requestsCaptured} requests · ${report.totalPayloadBytes.toLocaleString("en-US")} bytes (~${report.estimatedTotalTokens.toLocaleString("en-US")} tokens) · max ${report.maxToolsCount} tools`,
  ];

  for (const req of report.requests) {
    lines.push(
      `- ${req.method} ${req.url} · model=${req.model ?? "unknown"} · ${req.bodyBytes.toLocaleString("en-US")} bytes (~${req.estimatedTokens.toLocaleString("en-US")} tokens) · system=${req.systemPromptChars.toLocaleString("en-US")} chars · tools=${req.toolsCount}`,
    );
    if (req.upstream) {
      const u = req.upstream.usage;
      lines.push(
        `  ↳ upstream ${req.upstream.url} -> ${req.upstream.status ?? "ERR"}${
          req.upstream.durationMs !== null ? ` · ${req.upstream.durationMs}ms` : ""
        }${req.upstream.streamed ? " · SSE" : ""}${
          u
            ? ` · in=${fmt(u.inputTokens)} cache_read=${fmt(u.cacheReadInputTokens)} cache_write=${fmt(u.cacheCreationInputTokens)} out=${fmt(u.outputTokens)}`
            : ""
        }${req.upstream.error ? ` · error: ${req.upstream.error}` : ""}`,
      );
    }
    const diag = formatCacheDiagnosticsLine(req.cacheDiagnostics);
    if (diag && req.cacheDiagnostics?.comparedToRequest !== null) lines.push(diag);
  }

  const totals = report.usageTotals;
  if (totals) {
    lines.push(
      "",
      `Prompt cache (real upstream usage, ${totals.requestsWithUsage} requests): prompt=${fmt(totals.totalPromptTokens)} · cache_read=${fmt(totals.cacheReadInputTokens)} · cache_write=${fmt(totals.cacheCreationInputTokens)} · uncached_in=${fmt(totals.inputTokens)} · out=${fmt(totals.outputTokens)}${
        totals.cacheHitRatio !== null ? ` · hit ratio ${(totals.cacheHitRatio * 100).toFixed(1)}%` : ""
      }`,
    );
  }

  if (report.cacheDivergences.length > 0) {
    lines.push("", "Prompt-prefix divergences (cache-miss suspects):");
    for (const d of report.cacheDivergences) {
      lines.push(
        `- request #${d.requestIndex} vs #${d.comparedToRequest ?? "?"} · ${d.firstDivergentIndex} (${d.firstDivergentLayer}) · ${d.matchedPrefixBlocks}/${d.totalBlocks} blocks match${
          d.divergedBeforeBreakpoint ? " · BEFORE cache_control breakpoint" : ""
        } · ${d.reason}`,
      );
    }
  }

  if (report.assertions.length > 0) {
    lines.push("", "Contract assertions:");
    for (const assertion of report.assertions) {
      lines.push(
        `- [${assertion.passed ? "PASS" : "FAIL"}] ${assertion.message}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
