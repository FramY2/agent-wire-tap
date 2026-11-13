import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { parseWireTapCliArgs } from "../src/cli.js";
import {
  analyzePromptPrefix,
  deriveSessionKey,
  diffPromptPrefix,
  PromptCacheTracker,
} from "../src/prefix.js";
import { resolveUpstreamUrl } from "../src/proxy.js";
import { REDACTED, redactHeaders, redactUrl } from "../src/redact.js";
import {
  evaluateWireAssertions,
  formatExchangeLine,
  renderWireTapReport,
  runAgentCommandWithWireTap,
  startWireTapServer,
} from "../src/tap.js";
import { detectProvider, extractUsage } from "../src/usage.js";

// ---------------------------------------------------------------------------
// Secrets that must be forwarded upstream but NEVER persisted/logged.
// ---------------------------------------------------------------------------
const SECRET_API_KEY = "sk-ant-api03-SUPERSECRET-x-api-key-0123456789";
const SECRET_BEARER = "sk-proj-SUPERSECRET-bearer-token-abcdef";
const SECRET_COOKIE = "SUPERSECRET-cookie-session-value";
const SECRET_PROXY_AUTH = "Basic U1VQRVJTRUNSRVQtcHJveHk=";
const SECRET_SET_COOKIE = "SUPERSECRET-upstream-set-cookie";
const ALL_SECRETS = [
  SECRET_API_KEY,
  SECRET_BEARER,
  SECRET_COOKIE,
  SECRET_PROXY_AUTH,
  SECRET_SET_COOKIE,
];

const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface UpstreamHit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeUpstream {
  baseUrl: string;
  hits: UpstreamHit[];
  /** Makes the next SSE response stop after its first event until released. */
  holdNextStream: () => { release: () => void; released: () => boolean };
  close: () => Promise<void>;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Local node:http stand-in for api.anthropic.com / api.openai.com (zero network). */
async function startFakeUpstream(): Promise<FakeUpstream> {
  const hits: UpstreamHit[] = [];
  let hold: { promise: Promise<void>; release: () => void; done: boolean } | null =
    null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // ignore
      }
      const stream = parsed.stream === true;
      const path = (req.url ?? "").split("?")[0];

      if (path === "/v1/messages" && stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "set-cookie": `upstream_sid=${SECRET_SET_COOKIE}; HttpOnly`,
        });
        res.write(
          sse("message_start", {
            type: "message_start",
            message: {
              id: "msg_up_1",
              model: parsed.model,
              usage: {
                input_tokens: 5,
                cache_read_input_tokens: 9000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
          }),
        );
        const gate = hold;
        hold = null;
        if (gate) await gate.promise;
        res.write(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "real upstream says hi" },
          }),
        );
        res.write(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 77 },
          }),
        );
        res.end(sse("message_stop", { type: "message_stop" }));
        return;
      }

      if (path === "/v1/messages") {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `upstream_sid=${SECRET_SET_COOKIE}; HttpOnly`,
        });
        res.end(
          JSON.stringify({
            id: "msg_up_json",
            type: "message",
            content: [{ type: "text", text: "json upstream" }],
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 300,
              output_tokens: 42,
            },
          }),
        );
        return;
      }

      if (path === "/v1/responses" && stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse("response.created", { type: "response.created", response: { id: "resp_1" } }));
        res.end(
          sse("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              usage: {
                input_tokens: 2048,
                input_tokens_details: { cached_tokens: 1536 },
                output_tokens: 64,
              },
            },
          }),
        );
        return;
      }

      if (path === "/v1/chat/completions") {
        // gzip-compressed JSON body: the proxy must forward bytes untouched
        // AND decompress a side copy to extract usage.
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        res.end(
          gzipSync(
            JSON.stringify({
              id: "chatcmpl_up",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "gz ok" } }],
              usage: {
                prompt_tokens: 1500,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 1024 },
              },
            }),
          ),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path }));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const upstream: FakeUpstream = {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    holdNextStream: () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      const state = { promise, release: () => {}, done: false };
      state.release = () => {
        state.done = true;
        release();
      };
      hold = state;
      return { release: state.release, released: () => state.done };
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  closers.push(upstream.close);
  return upstream;
}

function secretHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": SECRET_API_KEY,
    authorization: `Bearer ${SECRET_BEARER}`,
    cookie: `sid=${SECRET_COOKIE}`,
    "proxy-authorization": SECRET_PROXY_AUTH,
  };
}

function expectNoSecrets(text: string): void {
  for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
}

// ---------------------------------------------------------------------------
// Claude-Code-like Anthropic request builder for turn-over-turn diffs.
// ---------------------------------------------------------------------------
function claudeRequest(overrides: {
  model?: string;
  tools?: unknown[];
  system?: unknown[];
  messages?: unknown[];
} = {}): Record<string, unknown> {
  return {
    model: overrides.model ?? "claude-sonnet-4-6",
    max_tokens: 1024,
    tools: overrides.tools ?? [
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write_file", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Run bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    system: overrides.system ?? [
      { type: "text", text: "You are Claude Code. Session started 2026-11-11T17:00:00Z." },
      { type: "text", text: "# CLAUDE.md\nAlways run tests.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: overrides.messages ?? [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
    ],
  };
}

describe("agent-wire-tap v0.2 — live --passthrough reverse proxy", () => {
  it("streams Anthropic SSE through chunk-by-chunk (no buffering) and extracts real cache usage from message_start/message_delta", async () => {
    const upstream = await startFakeUpstream();
    const tap = await startWireTapServer({ passthrough: { upstream: upstream.baseUrl } });
    closers.push(tap.close);
    const gate = upstream.holdNextStream();

    const res = await fetch(`${tap.baseUrl}/v1/messages`, {
      method: "POST",
      headers: secretHeaders(),
      body: JSON.stringify({ ...claudeRequest(), stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstText = decoder.decode(first.value);
    // The first event reached the client while upstream is STILL holding the stream open.
    expect(firstText).toContain("event: message_start");
    expect(gate.released()).toBe(false);
    gate.release();

    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).toContain("real upstream says hi");
    expect(rest).toContain("event: message_stop");

    await tap.close();
    const record = tap.requests[0]!;
    expect(record.upstream?.status).toBe(200);
    expect(record.upstream?.streamed).toBe(true);
    expect(record.upstream?.url).toBe(`${upstream.baseUrl}/v1/messages`);
    expect(record.upstream?.usage).toEqual({
      provider: "anthropic",
      inputTokens: 5,
      outputTokens: 77,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 0,
      totalPromptTokens: 9005,
      cacheHitRatio: 0.9994,
    });

    // Credentials were forwarded upstream untouched; Proxy-Authorization is hop-by-hop.
    const hit = upstream.hits[0]!;
    expect(hit.headers["x-api-key"]).toBe(SECRET_API_KEY);
    expect(hit.headers.authorization).toBe(`Bearer ${SECRET_BEARER}`);
    expect(hit.headers.cookie).toBe(`sid=${SECRET_COOKIE}`);
    expect(hit.headers["proxy-authorization"]).toBeUndefined();
    expect(hit.headers.host).toBe(new URL(upstream.baseUrl).host);
    expect(JSON.parse(hit.body).model).toBe("claude-sonnet-4-6");
  });

  it("STRICT SECURITY: redacts Authorization / x-api-key / Proxy-Authorization / Cookie / Set-Cookie in traces, stdout lines, and reports", async () => {
    const upstream = await startFakeUpstream();
    const dir = await tempDir("wire-tap-redact-");
    const traceFile = join(dir, "nested", "trace.jsonl");
    const lines: string[] = [];
    const tap = await startWireTapServer({
      passthrough: { upstream: upstream.baseUrl },
      traceFile,
      onExchange: (record, index) => lines.push(formatExchangeLine(record, index)),
    });
    closers.push(tap.close);

    for (const stream of [false, true]) {
      const res = await fetch(`${tap.baseUrl}/v1/messages?key=${SECRET_API_KEY}`, {
        method: "POST",
        headers: secretHeaders(),
        body: JSON.stringify({ ...claudeRequest(), stream }),
      });
      await res.text();
    }
    await tap.close();

    const [jsonRecord, sseRecord] = tap.requests;
    for (const record of [jsonRecord!, sseRecord!]) {
      expect(record.upstream!.requestHeaders["x-api-key"]).toBe(REDACTED);
      expect(record.upstream!.requestHeaders.authorization).toBe(REDACTED);
      expect(record.upstream!.requestHeaders.cookie).toBe(REDACTED);
      expect(record.upstream!.requestHeaders["proxy-authorization"]).toBe(REDACTED);
      expect(record.upstream!.requestHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(record.upstream!.responseHeaders["set-cookie"]).toBe(REDACTED);
      expect(record.url).toBe(`/v1/messages?key=${REDACTED}`);
    }
    expect(jsonRecord!.upstream!.usage?.cacheReadInputTokens).toBe(4000);
    expect(jsonRecord!.upstream!.usage?.cacheCreationInputTokens).toBe(300);
    expect(jsonRecord!.upstream!.usage?.totalPromptTokens).toBe(4312);

    const trace = await readFile(traceFile, "utf8");
    const traceLines = trace.trim().split("\n");
    expect(traceLines).toHaveLength(2);
    expect(trace).toContain(REDACTED);
    expect(trace).not.toContain("rawBody");
    expect(JSON.parse(traceLines[1]!).upstream.usage.cacheReadInputTokens).toBe(9000);
    expectNoSecrets(trace);

    const report = evaluateWireAssertions(tap.requests, {}, { mode: tap.mode });
    expect(report.mode).toBe("passthrough");
    expectNoSecrets(JSON.stringify(report));
    expectNoSecrets(renderWireTapReport(report));
    expectNoSecrets(lines.join("\n"));
  });

  it("auto-routes /v1/messages vs /v1/responses + /v1/chat/completions to separate upstreams and extracts OpenAI cached_tokens (SSE response.completed + gzip JSON)", async () => {
    const anthropic = await startFakeUpstream();
    const openai = await startFakeUpstream();
    const tap = await startWireTapServer({
      passthrough: { anthropicUpstream: anthropic.baseUrl, openaiUpstream: `${openai.baseUrl}/v1` },
    });
    closers.push(tap.close);

    const responsesRes = await fetch(`${tap.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET_BEARER}` },
      body: JSON.stringify({ model: "gpt-6.1-sol", stream: true, instructions: "AGENTS.md", input: [{ role: "user", content: "ping" }] }),
    });
    expect(await responsesRes.text()).toContain("response.completed");

    const chatRes = await fetch(`${tap.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] }),
    });
    const chatJson = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
    expect(chatJson.choices[0]!.message.content).toBe("gz ok");

    const messagesRes = await fetch(`${tap.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claudeRequest()),
    });
    expect(((await messagesRes.json()) as { id: string }).id).toBe("msg_up_json");

    await tap.close();
    expect(openai.hits.map((h) => h.url)).toEqual(["/v1/responses", "/v1/chat/completions"]);
    expect(anthropic.hits.map((h) => h.url)).toEqual(["/v1/messages"]);

    const [responses, chat, messages] = tap.requests;
    expect(responses!.upstream!.usage).toMatchObject({
      provider: "openai",
      inputTokens: 2048,
      cacheReadInputTokens: 1536,
      outputTokens: 64,
      totalPromptTokens: 2048,
      cacheHitRatio: 0.75,
    });
    expect(chat!.upstream!.streamed).toBe(false);
    expect(chat!.upstream!.usage).toMatchObject({
      provider: "openai",
      inputTokens: 1500,
      cacheReadInputTokens: 1024,
      outputTokens: 20,
    });
    expect(messages!.upstream!.usage?.provider).toBe("anthropic");

    const report = evaluateWireAssertions(tap.requests);
    expect(report.usageTotals).toMatchObject({
      requestsWithUsage: 3,
      cacheReadInputTokens: 1536 + 1024 + 4000,
      cacheCreationInputTokens: 300,
      outputTokens: 64 + 20 + 42,
    });
    expect(renderWireTapReport(report)).toContain("Prompt cache (real upstream usage, 3 requests)");
  });

  it("returns a 502 wire_tap_upstream_error when the upstream is unreachable", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((r) => dead.close(() => r()));

    const tap = await startWireTapServer({ passthrough: { upstream: `http://127.0.0.1:${port}` } });
    closers.push(tap.close);
    const res = await fetch(`${tap.baseUrl}/v1/messages`, {
      method: "POST",
      headers: secretHeaders(),
      body: JSON.stringify(claudeRequest()),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("wire_tap_upstream_error");
    await tap.close();
    expect(tap.requests[0]!.upstream!.status).toBe(502);
    expect(tap.requests[0]!.upstream!.error).toContain("could not reach upstream");
    expectNoSecrets(JSON.stringify(evaluateWireAssertions(tap.requests)));
  });

  it("detects turn-over-turn prefix divergence through the live proxy: tools[1] mutation and system[0] timestamp BEFORE cache_control breakpoints", async () => {
    const upstream = await startFakeUpstream();
    const tap = await startWireTapServer({ passthrough: { upstream: upstream.baseUrl } });
    closers.push(tap.close);

    const turn1Messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      { role: "user", content: [{ type: "text", text: "fix the bug", cache_control: { type: "ephemeral" } }] },
    ];
    const mutatedTools = [
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write_file", description: "Write a file (now with 3 MCP servers connected)", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Run bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ];
    const bodies = [
      claudeRequest(),
      claudeRequest({ messages: turn1Messages }),
      claudeRequest({ messages: turn1Messages, tools: mutatedTools }),
      claudeRequest({
        messages: turn1Messages,
        tools: mutatedTools,
        system: [
          { type: "text", text: "You are Claude Code. Session started 2026-11-11T18:00:00Z." },
          { type: "text", text: "# CLAUDE.md\nAlways run tests.", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      }),
    ];
    for (const body of bodies) {
      const res = await fetch(`${tap.baseUrl}/v1/messages`, {
        method: "POST",
        headers: secretHeaders(),
        body: JSON.stringify(body),
      });
      await res.json();
    }
    await tap.close();

    const [d0, d1, d2, d3] = tap.requests.map((r) => r.cacheDiagnostics!);
    expect(d0!.comparedToRequest).toBeNull();
    expect(d0!.firstDivergentLayer).toBe("none");
    expect(d0!.totalBlocks).toBe(1 + 3 + 2 + 1);
    expect(d0!.cacheBreakpoints).toEqual({
      count: 3,
      positions: ["tools[2]", "system[1]", "messages[0].content[0]"],
    });

    // Append-only turn (cache_control moved to the newest message): no divergence.
    expect(d1!.comparedToRequest).toBe(0);
    expect(d1!.firstDivergentLayer).toBe("none");
    expect(d1!.matchedPrefixBlocks).toBe(7);
    expect(d1!.totalBlocks).toBe(9);
    expect(d1!.reason).toContain("append-only");

    // tools[1] mutated before the tools[2] / system[1] breakpoints.
    expect(d2!.firstDivergentLayer).toBe("tools");
    expect(d2!.firstDivergentIndex).toBe("tools[1]");
    expect(d2!.matchedPrefixBlocks).toBe(2);
    expect(d2!.divergedBeforeBreakpoint).toBe(true);
    expect(d2!.invalidatedBreakpoints).toEqual(["tools[2]", "system[1]", "messages[2].content[0]"]);
    expect(d2!.reason).toContain('tool "write_file" schema/definition mutated (changed: description)');
    expect(d2!.reason).toContain("BEFORE cache_control breakpoint tools[2]");

    // system[0] volatile timestamp changed before the system[1] breakpoint.
    expect(d3!.comparedToRequest).toBe(2);
    expect(d3!.firstDivergentLayer).toBe("system");
    expect(d3!.firstDivergentIndex).toBe("system[0]");
    expect(d3!.matchedPrefixBlocks).toBe(4);
    expect(d3!.divergedBeforeBreakpoint).toBe(true);
    expect(d3!.reason).toContain("volatile date/time/timestamp/UUID");
    expect(d3!.layerHashes.tools).toBe(d2!.layerHashes.tools);
    expect(d3!.layerHashes.system).not.toBe(d2!.layerHashes.system);

    const report = evaluateWireAssertions(tap.requests);
    expect(report.cacheDivergences.map((d) => [d.requestIndex, d.firstDivergentIndex])).toEqual([
      [2, "tools[1]"],
      [3, "system[0]"],
    ]);
    const rendered = renderWireTapReport(report);
    expect(rendered).toContain("Prompt-prefix divergences (cache-miss suspects):");
    expect(rendered).toContain("PREFIX DIVERGED at tools[1] (tools)");
    expectNoSecrets(rendered);
  });
});

describe("agent-wire-tap v0.2 — prompt prefix hashing & divergence detector (pure)", () => {
  const snap = (body: Record<string, unknown>, url = "/v1/messages") =>
    analyzePromptPrefix(JSON.stringify(body), url)!;

  it("hashes ordered segments, ignores moved cache_control markers, and flags tool reorder / insert / removal / key-order churn", () => {
    const base = snap(claudeRequest());
    expect(base.blocks.map((b) => b.path)).toEqual([
      "model",
      "tools[0]",
      "tools[1]",
      "tools[2]",
      "system[0]",
      "system[1]",
      "messages[0]",
    ]);
    expect(base.blocks.every((b) => /^[0-9a-f]{64}$/.test(b.hash))).toBe(true);
    expect(base.breakpoints.find((b) => b.path === "system[1]")?.ttl).toBe("1h");

    // Moving cache_control alone does not change the prefix.
    const moved = snap(
      claudeRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(diffPromptPrefix(base, moved).firstDivergentLayer).toBe("none");

    const [t0, t1, t2] = claudeRequest().tools as Array<Record<string, unknown>>;
    const reordered = diffPromptPrefix(base, snap(claudeRequest({ tools: [t1, t0, t2] })));
    expect(reordered.firstDivergentLayer).toBe("tools");
    expect(reordered.firstDivergentIndex).toBe("tools[0]");
    expect(reordered.reason).toContain('tool order changed: "write_file" moved from tools[1] to tools[0]');

    const inserted = diffPromptPrefix(
      base,
      snap(claudeRequest({ tools: [t0, { name: "mcp__github__search", input_schema: {} }, t1, t2] })),
    );
    expect(inserted.firstDivergentIndex).toBe("tools[1]");
    expect(inserted.reason).toContain('tool "mcp__github__search" inserted at tools[1]');

    const removed = diffPromptPrefix(base, snap(claudeRequest({ tools: [t0, t2] })));
    expect(removed.firstDivergentIndex).toBe("tools[1]");
    expect(removed.reason).toContain('tool "write_file" removed from tools[1]');

    const keyOrder = diffPromptPrefix(
      base,
      snap(
        claudeRequest({
          tools: [t0, { input_schema: t1!.input_schema, description: t1!.description, name: t1!.name }, t2],
        }),
      ),
    );
    expect(keyOrder.firstDivergentIndex).toBe("tools[1]");
    expect(keyOrder.reason).toContain("JSON key order changed");
  });

  it("reports model switches, truncation, and divergence AFTER the last breakpoint (cache still reusable)", () => {
    const base = snap(claudeRequest());
    const model = diffPromptPrefix(base, snap(claudeRequest({ model: "claude-opus-4-7" })));
    expect(model.firstDivergentLayer).toBe("model");
    expect(model.firstDivergentIndex).toBe("model");
    expect(model.matchedPrefixBlocks).toBe(0);
    expect(model.reason).toContain('model changed from "claude-sonnet-4-6" to "claude-opus-4-7"');

    const long = snap(
      claudeRequest({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      }),
    );
    const truncated = diffPromptPrefix(long, snap(claudeRequest({ messages: [{ role: "user", content: "a" }] })));
    expect(truncated.firstDivergentLayer).toBe("messages");
    expect(truncated.firstDivergentIndex).toBe("messages[1]");
    expect(truncated.reason).toContain("request is shorter than the baseline");

    const edited = diffPromptPrefix(
      long,
      snap(
        claudeRequest({
          messages: [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c (edited)" },
          ],
        }),
      ),
    );
    expect(edited.firstDivergentIndex).toBe("messages[2]");
    expect(edited.divergedBeforeBreakpoint).toBe(false);
    expect(edited.reason).toContain("after the last cache_control breakpoint");
  });

  it("supports OpenAI Responses (instructions + input[]) and Chat Completions, and keeps per-model / per-session lanes", () => {
    const responses = snap(
      { model: "gpt-6.1-sol", instructions: "AGENTS.md v1", tools: [{ type: "web_search" }], input: [{ role: "user", content: "x" }] },
      "/v1/responses",
    );
    expect(responses.provider).toBe("openai");
    expect(responses.blocks.map((b) => b.path)).toEqual(["model", "tools[0]", "instructions", "input[0]"]);
    const changed = diffPromptPrefix(
      responses,
      snap(
        { model: "gpt-6.1-sol", instructions: "AGENTS.md v2", tools: [{ type: "web_search" }], input: [{ role: "user", content: "x" }] },
        "/v1/responses",
      ),
    );
    expect(changed.firstDivergentLayer).toBe("system");
    expect(changed.firstDivergentIndex).toBe("instructions");
    expect(changed.reason).toContain("OpenAI automatic prefix caching");

    const tracker = new PromptCacheTracker();
    const lane = deriveSessionKey("/v1/messages", { "x-claude-code-session-id": "abc" });
    expect(lane).toMatch(/^\/v1\/messages\|session:[0-9a-f]{12}$/);
    expect(lane).not.toContain("abc");
    const main1 = tracker.observe(0, lane, snap(claudeRequest()));
    const haiku = tracker.observe(1, lane, snap(claudeRequest({ model: "claude-haiku-4-5", tools: [] })));
    const main2 = tracker.observe(
      2,
      lane,
      snap(
        claudeRequest({
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: "yo" },
          ],
        }),
      ),
    );
    expect(main1.comparedToRequest).toBeNull();
    expect(haiku.comparedToRequest).toBe(0);
    expect(haiku.firstDivergentLayer).toBe("model");
    // Interleaved side call on another model does not pollute the main loop's lane.
    expect(main2.comparedToRequest).toBe(0);
    expect(main2.firstDivergentLayer).toBe("none");

    const otherSession = tracker.observe(
      3,
      deriveSessionKey("/v1/messages", { "x-claude-code-session-id": "zzz" }),
      snap(claudeRequest({ model: "claude-opus-4-7" })),
    );
    expect(otherSession.comparedToRequest).toBeNull();
  });

  it("computes cache diagnostics in mock mode too (zero API cost)", async () => {
    const tap = await startWireTapServer();
    closers.push(tap.close);
    for (const body of [claudeRequest(), claudeRequest({ model: "claude-opus-4-7" })]) {
      await (await fetch(`${tap.baseUrl}/v1/messages`, { method: "POST", body: JSON.stringify(body) })).json();
    }
    await tap.close();
    expect(tap.mode).toBe("mock");
    expect(tap.requests[1]!.cacheDiagnostics?.firstDivergentLayer).toBe("model");
    expect(tap.requests[1]!.upstream).toBeUndefined();
    const report = evaluateWireAssertions(tap.requests);
    expect(report.mode).toBe("mock");
    expect(report.usageTotals).toBeNull();
    expect(report.cacheDivergences).toHaveLength(1);
  });
});

describe("agent-wire-tap v0.2 — usage extraction, redaction & routing helpers", () => {
  it("extracts usage from Anthropic / OpenAI JSON bodies and SSE streams", () => {
    expect(
      extractUsage(
        "anthropic",
        sse("message_start", { type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 1 } } }) +
          sse("message_delta", { type: "message_delta", usage: { output_tokens: 9 } }),
        "text/event-stream",
      ),
    ).toMatchObject({ inputTokens: 3, cacheReadInputTokens: 100, cacheCreationInputTokens: 7, outputTokens: 9, totalPromptTokens: 110 });

    // Chat Completions streaming with stream_options.include_usage (CRLF framing).
    expect(
      extractUsage(
        "openai",
        'data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":896}}}\r\n\r\ndata: [DONE]\r\n\r\n',
        "text/event-stream",
      ),
    ).toMatchObject({ inputTokens: 900, cacheReadInputTokens: 896, outputTokens: 5, cacheCreationInputTokens: null });

    expect(
      extractUsage("openai", JSON.stringify({ usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 } })),
    ).toMatchObject({ inputTokens: 10, cacheReadInputTokens: 0, cacheHitRatio: 0 });
    expect(extractUsage("anthropic", "<html>bad gateway</html>")).toBeNull();
  });

  it("redacts credential headers and query params; routes providers correctly", () => {
    const redacted = redactHeaders({
      Authorization: "Bearer x",
      "X-Api-Key": "k",
      "Proxy-Authorization": "p",
      Cookie: "c",
      "set-cookie": ["a=1", "b=2"],
      "x-goog-api-key": "g",
      "anthropic-beta": "prompt-caching-2024-07-31",
    });
    expect(redacted).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      "proxy-authorization": REDACTED,
      cookie: REDACTED,
      "set-cookie": REDACTED,
      "x-goog-api-key": REDACTED,
      "anthropic-beta": "prompt-caching-2024-07-31",
    });
    expect(redactUrl("https://user:pw@example.com/v1/x?api_key=s&key=t&api-version=2024")).toBe(
      `https://${REDACTED}@example.com/v1/x?api_key=${REDACTED}&key=${REDACTED}&api-version=2024`,
    );
    expect(redactUrl("/v1/messages")).toBe("/v1/messages");

    expect(detectProvider("/v1/messages")).toBe("anthropic");
    expect(detectProvider("/v1/messages/count_tokens")).toBe("anthropic");
    expect(detectProvider("/v1/responses")).toBe("openai");
    expect(detectProvider("/v1/chat/completions")).toBe("openai");
    expect(resolveUpstreamUrl("/v1/messages?beta=true").href).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(resolveUpstreamUrl("/v1/responses").href).toBe("https://api.openai.com/v1/responses");
    expect(resolveUpstreamUrl("/v1/responses", { openaiUpstream: "https://api.openai.com/v1" }).href).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(resolveUpstreamUrl("/v1/messages", { upstream: "http://127.0.0.1:9999/corp/anthropic/" }).href).toBe(
      "http://127.0.0.1:9999/corp/anthropic/v1/messages",
    );
  });

  it("parses --passthrough / upstream / trace / port flags without breaking mock-mode defaults", () => {
    const mock = parseWireTapCliArgs(["--", "codex", "exec", "ping"]);
    expect(mock.passthrough).toBeNull();
    expect(mock.timeoutMs).toBe(15_000);
    expect(mock.host).toBe("127.0.0.1");

    const auto = parseWireTapCliArgs(["--passthrough", "--trace", "t.jsonl", "--", "claude", "-p", "hi"]);
    expect(auto.passthrough).toEqual({});
    expect(auto.traceFile).toBe("t.jsonl");
    expect(auto.timeoutMs).toBe(600_000);
    expect(auto.command).toBe("claude");
    expect(auto.commandArgs).toEqual(["-p", "hi"]);

    const fixed = parseWireTapCliArgs(["--passthrough", "http://127.0.0.1:9999/", "--port=8787", "--timeout-ms=1000"]);
    expect(fixed.passthrough).toEqual({ upstream: "http://127.0.0.1:9999" });
    expect(fixed.port).toBe(8787);
    expect(fixed.timeoutMs).toBe(1000);
    expect(fixed.command).toBeNull();

    expect(parseWireTapCliArgs(["--passthrough=https://api.anthropic.com"]).passthrough).toEqual({
      upstream: "https://api.anthropic.com",
    });
    expect(
      parseWireTapCliArgs(["--anthropic-upstream", "http://a.local", "--openai-upstream=http://o.local"]).passthrough,
    ).toEqual({ anthropicUpstream: "http://a.local", openaiUpstream: "http://o.local" });

    expect(() => parseWireTapCliArgs(["--passthrough=ftp://x"])).toThrow(/http/);
    expect(() => parseWireTapCliArgs(["--passthrough", "http://x", "--openai-upstream", "http://y"])).toThrow(/do not combine/);
    expect(() => parseWireTapCliArgs(["--port", "70000"])).toThrow(/--port/);
  });
});

describe("agent-wire-tap v0.2 — end-to-end agent runs in passthrough mode", () => {
  const fakeAgentSource = [
    "const base = process.env.ANTHROPIC_BASE_URL;",
    "const injected = String(process.env.OPENAI_API_KEY ?? '').includes('wiretap-local-loopback');",
    "const tools = [{ name: 'read_file', input_schema: { type: 'object' } }, { name: 'bash', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }];",
    "const turns = [",
    "  { system: [{ type: 'text', text: 'Date: 2026-11-11 17:00' }], messages: [{ role: 'user', content: 'hi' }] },",
    "  { system: [{ type: 'text', text: 'Date: 2026-11-11 17:05' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'go' }] },",
    "];",
    "for (const turn of turns) {",
    "  const res = await fetch(`${base}/v1/messages`, {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, authorization: `Bearer ${process.env.WIRE_TAP_TEST_BEARER}` },",
    "    body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, tools, ...turn }),",
    "  });",
    "  await res.text();",
    "}",
    "process.stdout.write(JSON.stringify({ injected }));",
  ].join("\n");

  it("runAgentCommandWithWireTap({ passthrough }) forwards the agent's own credentials, never injects fake keys, and reports usage + divergences", async () => {
    const upstream = await startFakeUpstream();
    const dir = await tempDir("wire-tap-e2e-");
    const agent = join(dir, "agent.mjs");
    await writeFile(agent, fakeAgentSource, "utf8");
    const traceFile = join(dir, "trace.jsonl");

    const { report, exitCode, stdout } = await runAgentCommandWithWireTap({
      command: process.execPath,
      args: [agent],
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY, WIRE_TAP_TEST_BEARER: SECRET_BEARER },
      passthrough: { upstream: upstream.baseUrl },
      traceFile,
      assertions: { assertMaxTools: 2 },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ injected: false });
    expect(upstream.hits.map((h) => h.headers["x-api-key"])).toEqual([SECRET_API_KEY, SECRET_API_KEY]);
    expect(report.status).toBe("passed");
    expect(report.mode).toBe("passthrough");
    expect(report.usageTotals?.cacheReadInputTokens).toBe(18_000);
    expect(report.usageTotals?.outputTokens).toBe(154);
    expect(report.cacheDivergences).toHaveLength(1);
    expect(report.cacheDivergences[0]).toMatchObject({
      requestIndex: 1,
      firstDivergentLayer: "system",
      firstDivergentIndex: "system[0]",
      divergedBeforeBreakpoint: false,
    });

    const trace = await readFile(traceFile, "utf8");
    expect(trace.trim().split("\n")).toHaveLength(2);
    expectNoSecrets(trace);
    expectNoSecrets(JSON.stringify(report));
  });

  it("CLI: `agent-wire-tap --passthrough <url> --trace --json -- node agent.mjs` never prints or persists secrets", async () => {
    const upstream = await startFakeUpstream();
    const dir = await tempDir("wire-tap-cli-");
    const agent = join(dir, "agent.mjs");
    await writeFile(agent, fakeAgentSource, "utf8");
    const traceFile = join(dir, "trace.jsonl");
    const outFile = join(dir, "report.json");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "src", "cli.ts"),
          "--passthrough",
          upstream.baseUrl,
          "--trace",
          traceFile,
          "--out",
          outFile,
          "--json",
          "--",
          process.execPath,
          agent,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, ANTHROPIC_API_KEY: SECRET_API_KEY, WIRE_TAP_TEST_BEARER: SECRET_BEARER },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.stderr).toContain("PREFIX DIVERGED at system[0]");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { mode: string; requestsCaptured: number };
    expect(report.mode).toBe("passthrough");
    expect(report.requestsCaptured).toBe(2);
    expectNoSecrets(result.stdout);
    expectNoSecrets(result.stderr);
    expectNoSecrets(await readFile(traceFile, "utf8"));
    expectNoSecrets(await readFile(outFile, "utf8"));
  }, 30_000);
});
