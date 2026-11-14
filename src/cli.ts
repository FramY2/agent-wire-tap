#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PROMPT_LAYER_ORDER, type PromptLayer } from "./prefix.js";
import {
  normalizeUpstreamUrl,
  DEFAULT_ANTHROPIC_UPSTREAM,
  DEFAULT_OPENAI_UPSTREAM,
  type PassthroughOptions,
} from "./proxy.js";
import {
  evaluateWireAssertions,
  formatExchangeLine,
  renderWireTapReport,
  replayTraceFile,
  runAgentCommandWithWireTap,
  startWireTapServer,
  type WireTapAssertions,
  type WireTapReport,
} from "./tap.js";

export const DEFAULT_SERVE_PORT = 8787;
export const DEFAULT_PASSTHROUGH_TIMEOUT_MS = 600_000;

export interface ParsedWireTapCliArgs {
  help: boolean;
  version: boolean;
  json: boolean;
  outFile?: string;
  timeoutMs: number;
  assertions: WireTapAssertions;
  command: string | null;
  commandArgs: string[];
  /** Non-null when `--passthrough` / `--anthropic-upstream` / `--openai-upstream` is set. */
  passthrough: PassthroughOptions | null;
  traceFile?: string;
  replayFile?: string;
  port?: number;
  host: string;
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (value === undefined || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  return port;
}

function parseLayerHashArg(
  raw: string | undefined,
  out: Record<string, string>,
): void {
  if (!raw) {
    throw new Error(
      "--assert-layer-hash requires <model|system|tools|messages>:<hexPrefix>.",
    );
  }
  const colon = raw.indexOf(":");
  if (colon <= 0) {
    throw new Error(
      `--assert-layer-hash must be <layer>:<hexPrefix>, got "${raw}".`,
    );
  }
  const layer = raw.slice(0, colon).trim().toLowerCase();
  const hexPrefix = raw.slice(colon + 1).trim().toLowerCase();
  if (!PROMPT_LAYER_ORDER.includes(layer as PromptLayer)) {
    throw new Error(
      `--assert-layer-hash layer must be one of model|system|tools|messages, got "${raw.slice(0, colon)}".`,
    );
  }
  if (!/^[0-9a-f]{4,}$/i.test(hexPrefix)) {
    throw new Error(
      `--assert-layer-hash hexPrefix must be at least 4 hex characters, got "${raw.slice(colon + 1)}".`,
    );
  }
  out[layer] = hexPrefix;
}

export function parseWireTapCliArgs(argv: string[]): ParsedWireTapCliArgs {
  const assertContains: string[] = [];
  const assertNotContains: string[] = [];
  let assertMaxBytes: number | undefined;
  let assertMaxTools: number | undefined;
  let assertToolsSorted = false;
  let assertCacheBreakpointCoversTools = false;
  let assertNoPrefixDivergence = false;
  const assertLayerHashes: Record<string, string> = {};
  let json = false;
  let outFile: string | undefined;
  let timeoutMs = 15_000;
  let timeoutExplicit = false;
  let help = false;
  let version = false;
  let passthroughEnabled = false;
  let passthroughUrl: string | undefined;
  let anthropicUpstream: string | undefined;
  let openaiUpstream: string | undefined;
  let traceFile: string | undefined;
  let replayFile: string | undefined;
  let port: number | undefined;
  let host = "127.0.0.1";

  let command: string | null = null;
  const commandArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      const rest = argv.slice(i + 1);
      command = rest[0] ?? null;
      commandArgs.push(...rest.slice(1));
      break;
    }

    if (command !== null) {
      commandArgs.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--assert-contains") {
      const val = argv[++i];
      if (!val) throw new Error("--assert-contains requires a string value.");
      assertContains.push(val);
    } else if (arg.startsWith("--assert-contains=")) {
      assertContains.push(arg.slice("--assert-contains=".length));
    } else if (arg === "--assert-not-contains") {
      const val = argv[++i];
      if (!val)
        throw new Error("--assert-not-contains requires a string value.");
      assertNotContains.push(val);
    } else if (arg.startsWith("--assert-not-contains=")) {
      assertNotContains.push(arg.slice("--assert-not-contains=".length));
    } else if (arg === "--assert-max-bytes") {
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--assert-max-bytes must be a positive integer.");
      }
      assertMaxBytes = val;
    } else if (arg.startsWith("--assert-max-bytes=")) {
      const val = Number(arg.slice("--assert-max-bytes=".length));
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--assert-max-bytes must be a positive integer.");
      }
      assertMaxBytes = val;
    } else if (arg === "--assert-max-tools") {
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val < 0) {
        throw new Error("--assert-max-tools must be a non-negative integer.");
      }
      assertMaxTools = val;
    } else if (arg.startsWith("--assert-max-tools=")) {
      const val = Number(arg.slice("--assert-max-tools=".length));
      if (!Number.isInteger(val) || val < 0) {
        throw new Error("--assert-max-tools must be a non-negative integer.");
      }
      assertMaxTools = val;
    } else if (arg === "--assert-tools-sorted") {
      assertToolsSorted = true;
    } else if (arg === "--assert-cache-breakpoint-covers-tools") {
      assertCacheBreakpointCoversTools = true;
    } else if (arg === "--assert-no-prefix-divergence") {
      assertNoPrefixDivergence = true;
    } else if (arg === "--assert-layer-hash") {
      parseLayerHashArg(argv[++i], assertLayerHashes);
    } else if (arg.startsWith("--assert-layer-hash=")) {
      parseLayerHashArg(
        arg.slice("--assert-layer-hash=".length),
        assertLayerHashes,
      );
    } else if (arg === "--replay" || arg.startsWith("--replay=")) {
      const val = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!val) throw new Error("--replay requires a trace or report file path.");
      replayFile = val;
    } else if (arg === "--out") {
      const val = argv[++i];
      if (!val) throw new Error("--out requires a file path.");
      outFile = val;
    } else if (arg.startsWith("--out=")) {
      outFile = arg.slice("--out=".length);
    } else if (arg === "--timeout-ms") {
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      timeoutMs = val;
      timeoutExplicit = true;
    } else if (arg.startsWith("--timeout-ms=")) {
      const val = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      timeoutMs = val;
      timeoutExplicit = true;
    } else if (arg === "--passthrough") {
      passthroughEnabled = true;
      const next = argv[i + 1];
      if (next !== undefined && /^https?:\/\//i.test(next)) {
        passthroughUrl = normalizeUpstreamUrl(next, "--passthrough");
        i++;
      }
    } else if (arg.startsWith("--passthrough=")) {
      passthroughEnabled = true;
      passthroughUrl = normalizeUpstreamUrl(
        arg.slice("--passthrough=".length),
        "--passthrough",
      );
    } else if (arg === "--anthropic-upstream" || arg.startsWith("--anthropic-upstream=")) {
      const val = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!val) throw new Error("--anthropic-upstream requires a URL.");
      passthroughEnabled = true;
      anthropicUpstream = normalizeUpstreamUrl(val, "--anthropic-upstream");
    } else if (arg === "--openai-upstream" || arg.startsWith("--openai-upstream=")) {
      const val = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!val) throw new Error("--openai-upstream requires a URL.");
      passthroughEnabled = true;
      openaiUpstream = normalizeUpstreamUrl(val, "--openai-upstream");
    } else if (arg === "--trace" || arg.startsWith("--trace=")) {
      const val = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!val) throw new Error("--trace requires a file path.");
      traceFile = val;
    } else if (arg === "--port") {
      port = parsePort(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--host" || arg.startsWith("--host=")) {
      const val = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!val) throw new Error("--host requires a hostname or IP.");
      host = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      command = arg;
    }
  }

  if (passthroughUrl && (anthropicUpstream || openaiUpstream)) {
    throw new Error(
      "--passthrough <url> routes ALL traffic to one upstream; do not combine it with --anthropic-upstream / --openai-upstream.",
    );
  }
  if (replayFile && (command !== null || passthroughEnabled)) {
    throw new Error(
      "--replay analyzes an offline trace/report file; do not combine it with --passthrough or a live agent command.",
    );
  }
  const passthrough: PassthroughOptions | null = passthroughEnabled
    ? {
        ...(passthroughUrl ? { upstream: passthroughUrl } : {}),
        ...(anthropicUpstream ? { anthropicUpstream } : {}),
        ...(openaiUpstream ? { openaiUpstream } : {}),
      }
    : null;
  if (passthrough && !timeoutExplicit) {
    // Real model turns take far longer than synthetic loopback replies.
    timeoutMs = DEFAULT_PASSTHROUGH_TIMEOUT_MS;
  }

  return {
    help,
    version,
    json,
    outFile,
    timeoutMs,
    assertions: {
      assertContains,
      assertNotContains,
      assertMaxBytes,
      assertMaxTools,
      ...(assertToolsSorted ? { assertToolsSorted: true } : {}),
      ...(assertCacheBreakpointCoversTools
        ? { assertCacheBreakpointCoversTools: true }
        : {}),
      ...(assertNoPrefixDivergence ? { assertNoPrefixDivergence: true } : {}),
      ...(Object.keys(assertLayerHashes).length > 0
        ? { assertLayerHashes }
        : {}),
    },
    command,
    commandArgs,
    passthrough,
    traceFile,
    replayFile,
    port,
    host,
  };
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.3.0";
  } catch {
    return "0.3.0";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "agent-wire-tap — Zero-cost local loopback HTTP interceptor, CI contract tester & prompt-cache debugger for coding agents",
      "",
      "Usage:",
      "  agent-wire-tap [options] -- <agent-command> [agent-args...]   Run one agent turn (mock or passthrough)",
      "  agent-wire-tap --passthrough [upstream-url] [options]         Long-running live reverse proxy (default port 8787)",
      "  agent-wire-tap --replay <trace.jsonl|report.json> [options]   Analyze saved trace/report offline (exit 2 on failure)",
      "",
      "Options:",
      "  --assert-contains <str>                 Assert outbound wire payload contains marker (repeatable)",
      "  --assert-not-contains <str>             Assert outbound wire payload never contains string/secret (repeatable)",
      "  --assert-max-bytes <n>                  Assert total outbound wire payload bytes <= n",
      "  --assert-max-tools <n>                  Assert tools[] count in outbound wire payload <= n",
      "  --assert-tools-sorted                   Assert tools[] are sorted ascending (localeCompare <= 0)",
      "  --assert-cache-breakpoint-covers-tools  Assert cache_control covers tools[] (tools[last], system, messages, or top-level)",
      "  --assert-no-prefix-divergence           Assert zero turn-over-turn prompt-prefix divergences",
      "  --assert-layer-hash <layer:hexPrefix>   Assert model|system|tools|messages layer hash starts with hex prefix (min 4 chars, repeatable)",
      "  --replay <file>                         Evaluate assertions offline against a saved --trace .jsonl or JSON report",
      "  --out <report.json>                     Write structured JSON report to file",
      "  --timeout-ms <ms>                       Agent command timeout in ms (default: 15000; 600000 with --passthrough)",
      "  --json                                  Print structured JSON report to stdout",
      "",
      "Live passthrough & prompt-cache diagnostics:",
      "  --passthrough [url]          Forward requests to the REAL upstream and stream replies back (JSON + SSE).",
      `                               Without a url: /v1/messages -> ${DEFAULT_ANTHROPIC_UPSTREAM},`,
      `                               /v1/responses + /v1/chat/completions -> ${DEFAULT_OPENAI_UPSTREAM}`,
      "  --anthropic-upstream <url>   Override the Anthropic upstream (implies --passthrough)",
      "  --openai-upstream <url>      Override the OpenAI upstream (implies --passthrough)",
      "  --trace <file.jsonl>         Write one redacted JSONL record per exchange (usage + cacheDiagnostics)",
      `  --port <n>                   Proxy port (default: ephemeral; ${DEFAULT_SERVE_PORT} in long-running proxy mode)`,
      "  --host <host>                Proxy bind host (default: 127.0.0.1)",
      "",
      "  -v, --version                Print version",
      "  -h, --help                   Print help",
      "",
      "Authorization, x-api-key, Proxy-Authorization, Cookie and Set-Cookie values are forwarded",
      "upstream untouched but are ALWAYS written as [REDACTED] in traces, stdout and reports.",
      "",
    ].join("\n"),
  );
}

async function emitReport(
  parsed: ParsedWireTapCliArgs,
  report: WireTapReport,
): Promise<void> {
  if (parsed.outFile) {
    const dest = resolve(parsed.outFile);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderWireTapReport(report));
  }

  if (report.status === "failed") {
    process.exitCode = 2;
  }
}

/** Long-running live reverse proxy: runs until SIGINT / SIGTERM, then reports. */
async function serveProxy(parsed: ParsedWireTapCliArgs): Promise<WireTapReport> {
  const log = parsed.json ? process.stderr : process.stdout;
  const passthrough = parsed.passthrough ?? {};
  const tap = await startWireTapServer({
    passthrough,
    host: parsed.host,
    port: parsed.port ?? DEFAULT_SERVE_PORT,
    ...(parsed.traceFile ? { traceFile: parsed.traceFile } : {}),
    onExchange: (record, index) => {
      log.write(`${formatExchangeLine(record, index)}\n`);
    },
  });

  const routes = passthrough.upstream
    ? [`  all requests -> ${passthrough.upstream}`]
    : [
        `  /v1/messages                       -> ${passthrough.anthropicUpstream ?? DEFAULT_ANTHROPIC_UPSTREAM}`,
        `  /v1/responses, /v1/chat/completions -> ${passthrough.openaiUpstream ?? DEFAULT_OPENAI_UPSTREAM}`,
      ];
  log.write(
    [
      `agent-wire-tap ${getVersion()} · live passthrough proxy listening on ${tap.baseUrl}`,
      ...routes,
      "",
      `  Claude Code: ANTHROPIC_BASE_URL=${tap.baseUrl} claude`,
      `  Codex:       OPENAI_BASE_URL=${tap.baseUrl}/v1 codex`,
      ...(parsed.traceFile ? [`  Trace:       ${resolve(parsed.traceFile)}`] : []),
      "",
      "Press Ctrl+C to stop and print the prompt-cache report.",
      "",
    ].join("\n"),
  );

  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  await tap.close();
  return evaluateWireAssertions(tap.requests, parsed.assertions, {
    mode: "passthrough",
  });
}

async function main(): Promise<void> {
  const parsed = parseWireTapCliArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (parsed.replayFile) {
    await emitReport(
      parsed,
      await replayTraceFile(parsed.replayFile, parsed.assertions),
    );
    return;
  }
  if (!parsed.command) {
    if (parsed.passthrough) {
      await emitReport(parsed, await serveProxy(parsed));
      return;
    }
    printHelp();
    process.exitCode = 1;
    return;
  }

  const { report } = await runAgentCommandWithWireTap({
    command: parsed.command,
    args: parsed.commandArgs,
    timeoutMs: parsed.timeoutMs,
    assertions: parsed.assertions,
    ...(parsed.passthrough
      ? {
          passthrough: parsed.passthrough,
          onExchange: (record, index) => {
            process.stderr.write(`${formatExchangeLine(record, index)}\n`);
          },
        }
      : {}),
    ...(parsed.traceFile ? { traceFile: parsed.traceFile } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    host: parsed.host,
  });

  await emitReport(parsed, report);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((err: unknown) => {
    process.stderr.write(`agent-wire-tap error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
