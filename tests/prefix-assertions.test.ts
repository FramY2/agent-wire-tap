import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWireTapCliArgs } from "../src/cli.js";
import {
  analyzePromptPrefix,
  checkToolsSorted,
  inferWireContract,
} from "../src/prefix.js";
import {
  analyzeWirePayload,
  evaluateWireAssertions,
  replayTraceFile,
  runAgentCommandWithWireTap,
  startWireTapServer,
  type WireTapReport,
} from "../src/tap.js";

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

async function runCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args],
      {
        cwd: process.cwd(),
        env: process.env,
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
}

async function startAnthropicUsageUpstream(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_replay_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 1800,
            cache_creation_input_tokens: 200,
            output_tokens: 15,
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  closers.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, close };
}

describe("agent-wire-tap v0.3.0 — wireContract metadata & prefix assertions", () => {
  const snap = (body: Record<string, unknown>, url = "/v1/messages") =>
    analyzePromptPrefix(JSON.stringify(body), url)!;

  it("evaluates sorted vs unsorted tools[] using localeCompare <= 0 matching mcp-diet", () => {
    expect(checkToolsSorted([])).toEqual({ toolsSorted: true, firstUnsortedPair: null });
    expect(checkToolsSorted(["alpha", "alpha", "beta"])).toEqual({
      toolsSorted: true,
      firstUnsortedPair: null,
    });
    expect(checkToolsSorted(["alpha", "zebra", "beta"])).toEqual({
      toolsSorted: false,
      firstUnsortedPair: ["zebra", "beta"],
    });

    const emptySnap = snap({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(emptySnap.wireContract).toEqual({
      toolNames: [],
      toolsSorted: true,
      firstUnsortedPair: null,
      hasTools: false,
      cacheBreakpointCoversTools: true,
      lastToolBlockIndex: null,
      maxBreakpointBlockIndex: null,
      hasTopLevelCacheControl: false,
    });

    const sortedSnap = snap({
      model: "claude-sonnet-4-6",
      tools: [
        { name: "bash", input_schema: { type: "object" } },
        { name: "read_file", input_schema: { type: "object" } },
        {
          name: "write_file",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(sortedSnap.wireContract).toEqual({
      toolNames: ["bash", "read_file", "write_file"],
      toolsSorted: true,
      firstUnsortedPair: null,
      hasTools: true,
      cacheBreakpointCoversTools: true,
      lastToolBlockIndex: 3,
      maxBreakpointBlockIndex: 3,
      hasTopLevelCacheControl: false,
    });

    const unsortedSnap = snap({
      model: "claude-sonnet-4-6",
      tools: [
        { name: "alpha", input_schema: { type: "object" } },
        { name: "zebra", input_schema: { type: "object" } },
        {
          name: "beta",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(unsortedSnap.wireContract.toolsSorted).toBe(false);
    expect(unsortedSnap.wireContract.firstUnsortedPair).toEqual(["zebra", "beta"]);
    expect(unsortedSnap.wireContract.toolNames).toEqual(["alpha", "zebra", "beta"]);

    const passReport = evaluateWireAssertions(
      [
        analyzeWirePayload(
          "POST",
          "/v1/messages",
          JSON.stringify({
            model: "claude-sonnet-4-6",
            tools: [
              { name: "bash", input_schema: { type: "object" } },
              {
                name: "read_file",
                input_schema: { type: "object" },
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      ],
      { assertToolsSorted: true },
    );
    expect(passReport.status).toBe("passed");
    expect(passReport.assertions[0]?.kind).toBe("tools-sorted");

    const failReport = evaluateWireAssertions(
      [
        analyzeWirePayload(
          "POST",
          "/v1/messages",
          JSON.stringify({
            model: "claude-sonnet-4-6",
            tools: [
              { name: "read_file", input_schema: { type: "object" } },
              { name: "bash", input_schema: { type: "object" } },
            ],
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      ],
      { assertToolsSorted: true },
    );
    expect(failReport.status).toBe("failed");
    expect(failReport.failures[0]).toContain('"read_file" > "bash"');
  });

  it("fails cacheBreakpointCoversTools when host-injected tools trail tools[k].cache_control and no downstream breakpoint exists", () => {
    const trailingHostTool = {
      model: "claude-sonnet-4-6",
      system: "Plain string system prompt without cache_control",
      tools: [
        { name: "alpha", input_schema: { type: "object" } },
        {
          name: "beta",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
        // Host (e.g. Claude Code / harness) injects a tool after the mcp-diet breakpoint:
        { name: "host_injected_tool", input_schema: { type: "object" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };

    const snapshot = snap(trailingHostTool);
    expect(snapshot.wireContract).toMatchObject({
      hasTools: true,
      toolsSorted: true,
      lastToolBlockIndex: 3,
      maxBreakpointBlockIndex: 2,
      hasTopLevelCacheControl: false,
      cacheBreakpointCoversTools: false,
    });

    const report = evaluateWireAssertions(
      [analyzeWirePayload("POST", "/v1/messages", JSON.stringify(trailingHostTool))],
      { assertCacheBreakpointCoversTools: true },
    );
    expect(report.status).toBe("failed");
    expect(report.assertions[0]).toMatchObject({
      kind: "cache-breakpoint-covers-tools",
      passed: false,
    });
    expect(report.failures[0]).toContain("lastToolBlockIndex=3");
    expect(report.failures[0]).toContain("maxBreakpointBlockIndex=2");

    // Zero breakpoints anywhere with tools.length > 0 also fails.
    const noBpSnap = snap({
      model: "claude-sonnet-4-6",
      tools: [{ name: "alpha", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(noBpSnap.wireContract.cacheBreakpointCoversTools).toBe(false);
    expect(noBpSnap.wireContract.maxBreakpointBlockIndex).toBeNull();
  });

  it("passes cacheBreakpointCoversTools when tools[last], system, messages, or top-level body.cache_control covers tools[] (Anthropic prefix order)", () => {
    // 1) Breakpoint on system[0] covers all preceding tools (tools -> system -> messages).
    const systemCovered = snap({
      model: "claude-sonnet-4-6",
      tools: [
        { name: "alpha", input_schema: { type: "object" } },
        { name: "beta", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "host_injected", input_schema: { type: "object" } },
      ],
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(systemCovered.wireContract.lastToolBlockIndex).toBe(3);
    expect(systemCovered.wireContract.maxBreakpointBlockIndex).toBe(4);
    expect(systemCovered.wireContract.cacheBreakpointCoversTools).toBe(true);

    // 2) Breakpoint on messages[0].content[0] covers preceding tools and system.
    const messageCovered = snap({
      model: "claude-sonnet-4-6",
      tools: [{ name: "alpha", input_schema: { type: "object" } }],
      system: "Plain string",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect(messageCovered.wireContract.lastToolBlockIndex).toBe(1);
    expect(messageCovered.wireContract.maxBreakpointBlockIndex).toBe(3);
    expect(messageCovered.wireContract.cacheBreakpointCoversTools).toBe(true);

    // 3) Top-level automatic caching (body.cache_control) covers all blocks including tools.
    const topLevelCovered = snap({
      model: "claude-sonnet-4-6",
      cache_control: { type: "ephemeral" },
      tools: [{ name: "alpha", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(topLevelCovered.wireContract).toMatchObject({
      hasTools: true,
      hasTopLevelCacheControl: true,
      lastToolBlockIndex: 1,
      maxBreakpointBlockIndex: 2,
      cacheBreakpointCoversTools: true,
    });

    // 4) Top-level body.cache_control on a tools-only payload (no system/messages).
    const toolsOnlyTopLevel = snap({
      model: "claude-sonnet-4-6",
      cache_control: { type: "ephemeral" },
      tools: [{ name: "alpha", input_schema: { type: "object" } }],
    });
    expect(toolsOnlyTopLevel.wireContract).toMatchObject({
      hasTopLevelCacheControl: true,
      lastToolBlockIndex: 1,
      maxBreakpointBlockIndex: 1,
      cacheBreakpointCoversTools: true,
    });

    // 5) Empty tools[] passes vacuously.
    const emptyToolsReport = evaluateWireAssertions(
      [
        analyzeWirePayload(
          "POST",
          "/v1/messages",
          JSON.stringify({
            model: "claude-haiku-4-5",
            tools: [],
            messages: [{ role: "user", content: "title" }],
          }),
        ),
      ],
      { assertCacheBreakpointCoversTools: true },
    );
    expect(emptyToolsReport.status).toBe("passed");
  });

  it("checks case-insensitive layerHashes prefixes (min 4 hex chars) and assertNoPrefixDivergence", () => {
    const turn0 = {
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "alpha",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
        { name: "beta", input_schema: { type: "object" } },
      ],
      system: [
        {
          type: "text",
          text: "Deterministic system prompt",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "step 1" }],
    };
    const turn1AppendOnly = {
      ...turn0,
      messages: [
        { role: "user", content: "step 1" },
        { role: "assistant", content: "done 1" },
        { role: "user", content: "step 2" },
      ],
    };

    const snap0 = analyzePromptPrefix(JSON.stringify(turn0), "/v1/messages")!;
    const toolsPrefixUpper = snap0.blocks.length > 0
      ? evaluateWireAssertions([
          analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn0)),
        ]).requests[0]!.cacheDiagnostics!.layerHashes.tools.slice(0, 6).toUpperCase()
      : "";
    const systemPrefix = evaluateWireAssertions([
      analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn0)),
    ]).requests[0]!.cacheDiagnostics!.layerHashes.system.slice(0, 4);

    const passing = evaluateWireAssertions(
      [
        analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn0)),
        analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn1AppendOnly)),
      ],
      {
        assertToolsSorted: true,
        assertCacheBreakpointCoversTools: true,
        assertNoPrefixDivergence: true,
        assertLayerHashes: {
          tools: toolsPrefixUpper,
          system: systemPrefix,
        },
      },
    );
    expect(passing.status).toBe("passed");
    expect(passing.cacheDivergences).toHaveLength(0);

    // Diverged turn 1 (tool description mutated) fails both assertNoPrefixDivergence and assertLayerHashes.
    const turn1Mutated = {
      ...turn0,
      tools: [
        turn0.tools[0],
        { name: "beta", description: "mutated", input_schema: { type: "object" } },
      ],
      messages: turn1AppendOnly.messages,
    };
    const failing = evaluateWireAssertions(
      [
        analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn0)),
        analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn1Mutated)),
      ],
      {
        assertNoPrefixDivergence: true,
        assertLayerHashes: { tools: toolsPrefixUpper },
      },
    );
    expect(failing.status).toBe("failed");
    expect(failing.assertions.map((a) => [a.kind, a.passed])).toEqual([
      ["no-prefix-divergence", false],
      ["layer-hash", false],
    ]);
    expect(failing.failures[0]).toContain("tools[1]");
    expect(failing.failures[1]).toContain("request #1");

    // Programmatic invalid layer hash fails closed.
    const invalidProg = evaluateWireAssertions(
      [analyzeWirePayload("POST", "/v1/messages", JSON.stringify(turn0))],
      { assertLayerHashes: { tools: "abc" } },
    );
    expect(invalidProg.status).toBe("failed");
    expect(invalidProg.failures[0]).toContain("at least 4 hex chars");
  });

  it("parses and validates v0.3.0 CLI flags", () => {
    const parsed = parseWireTapCliArgs([
      "--assert-tools-sorted",
      "--assert-cache-breakpoint-covers-tools",
      "--assert-no-prefix-divergence",
      "--assert-layer-hash",
      "tools:ABCD12",
      "--assert-layer-hash=SYSTEM:0123ef",
      "--replay",
      "trace.jsonl",
      "--json",
    ]);
    expect(parsed.replayFile).toBe("trace.jsonl");
    expect(parsed.json).toBe(true);
    expect(parsed.assertions.assertToolsSorted).toBe(true);
    expect(parsed.assertions.assertCacheBreakpointCoversTools).toBe(true);
    expect(parsed.assertions.assertNoPrefixDivergence).toBe(true);
    expect(parsed.assertions.assertLayerHashes).toEqual({
      tools: "abcd12",
      system: "0123ef",
    });

    expect(() => parseWireTapCliArgs(["--assert-layer-hash", "tools:abc"])).toThrow(
      /at least 4 hex/,
    );
    expect(() => parseWireTapCliArgs(["--assert-layer-hash", "tools:zzzz"])).toThrow(
      /at least 4 hex/,
    );
    expect(() => parseWireTapCliArgs(["--assert-layer-hash", "badlayer:abcd"])).toThrow(
      /model\|system\|tools\|messages/,
    );
    expect(() => parseWireTapCliArgs(["--assert-layer-hash", "abcd"])).toThrow(
      /<layer>:<hexPrefix>/,
    );
    expect(() => parseWireTapCliArgs(["--replay", "t.jsonl", "--", "node", "a.js"])).toThrow(
      /do not combine/,
    );
    expect(() => parseWireTapCliArgs(["--replay=t.jsonl", "--passthrough"])).toThrow(
      /do not combine/,
    );
  });

  it("replays saved --trace .jsonl, JSON reports, and legacy v0.2.0 traces via replayTraceFile + CLI --replay (exit 0 and exit 2)", async () => {
    const dir = await tempDir("wire-tap-replay-");
    const upstream = await startAnthropicUsageUpstream();

    // 1) Capture a healthy sorted + covered 2-turn trace in passthrough mode.
    const passTrace = join(dir, "pass-trace.jsonl");
    const agentOk = join(dir, "agent-ok.mjs");
    const baseTools = [
      { name: "alpha", input_schema: { type: "object" } },
      {
        name: "beta",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ];
    await writeFile(
      agentOk,
      [
        "const base = process.env.ANTHROPIC_BASE_URL;",
        `const tools = ${JSON.stringify(baseTools)};`,
        "const turns = [",
        "  [{ role: 'user', content: 'hi' }],",
        "  [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'next' }],",
        "];",
        "for (const messages of turns) {",
        "  await fetch(`${base}/v1/messages`, {",
        "    method: 'POST',",
        "    headers: { 'content-type': 'application/json' },",
        "    body: JSON.stringify({ model: 'claude-sonnet-4-6', system: 'Stable', tools, messages }),",
        "  });",
        "}",
      ].join("\n"),
      "utf8",
    );

    const liveRun = await runAgentCommandWithWireTap({
      command: process.execPath,
      args: [agentOk],
      passthrough: { upstream: upstream.baseUrl },
      traceFile: passTrace,
    });
    expect(liveRun.exitCode).toBe(0);
    const expectedToolsPrefix =
      liveRun.report.requests[0]!.cacheDiagnostics!.layerHashes.tools.slice(0, 8);

    const replayedOk = await replayTraceFile(passTrace, {
      assertToolsSorted: true,
      assertCacheBreakpointCoversTools: true,
      assertNoPrefixDivergence: true,
      assertLayerHashes: { tools: expectedToolsPrefix.toUpperCase() },
    });
    expect(replayedOk.status).toBe("passed");
    expect(replayedOk.mode).toBe("passthrough");
    expect(replayedOk.requestsCaptured).toBe(2);
    expect(replayedOk.usageTotals).toMatchObject({
      requestsWithUsage: 2,
      cacheReadInputTokens: 3600,
      cacheCreationInputTokens: 400,
      outputTokens: 30,
    });
    expect(replayedOk.cacheDivergences).toHaveLength(0);

    // Saved JSON report can also be replayed directly.
    const reportJsonPath = join(dir, "saved-report.json");
    await writeFile(reportJsonPath, JSON.stringify(liveRun.report, null, 2), "utf8");
    const replayedJsonReport = await replayTraceFile(reportJsonPath, {
      assertToolsSorted: true,
      assertCacheBreakpointCoversTools: true,
      assertNoPrefixDivergence: true,
    });
    expect(replayedJsonReport.status).toBe("passed");
    expect(replayedJsonReport.usageTotals?.cacheReadInputTokens).toBe(3600);

    // CLI --replay exit code 0 on passing trace.
    const cliPass = await runCli([
      "--replay",
      passTrace,
      "--assert-tools-sorted",
      "--assert-cache-breakpoint-covers-tools",
      "--assert-no-prefix-divergence",
      "--assert-layer-hash",
      `tools:${expectedToolsPrefix}`,
      "--json",
    ]);
    expect(cliPass.code).toBe(0);
    const cliPassReport = JSON.parse(cliPass.stdout) as WireTapReport;
    expect(cliPassReport.status).toBe("passed");
    expect(cliPassReport.usageTotals?.cacheReadInputTokens).toBe(3600);

    // 2) Capture a failing trace (unsorted tools + trailing host-injected tool + prefix divergence).
    const failTrace = join(dir, "fail-trace.jsonl");
    const tapFail = await startWireTapServer({ traceFile: failTrace });
    closers.push(tapFail.close);
    await fetch(`${tapFail.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "zebra",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral" },
          },
          { name: "alpha", input_schema: { type: "object" } },
        ],
        system: "Unmarked system prompt",
        messages: [{ role: "user", content: "turn 0" }],
      }),
    });
    await fetch(`${tapFail.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "zebra",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral" },
          },
          { name: "alpha", input_schema: { type: "object" } },
        ],
        system: "Changed system prompt",
        messages: [{ role: "user", content: "turn 0" }],
      }),
    });
    await tapFail.close();

    const outReportPath = join(dir, "fail-report.json");
    const cliFail = await runCli([
      "--replay",
      failTrace,
      "--assert-tools-sorted",
      "--assert-cache-breakpoint-covers-tools",
      "--assert-no-prefix-divergence",
      "--assert-layer-hash",
      "tools:0000",
      "--out",
      outReportPath,
    ]);
    expect(cliFail.code).toBe(2);
    expect(cliFail.stdout).toContain("[FAIL]");
    const writtenFailReport = JSON.parse(
      await readFile(outReportPath, "utf8"),
    ) as WireTapReport;
    expect(writtenFailReport.status).toBe("failed");
    expect(writtenFailReport.failures).toHaveLength(4);
    expect(writtenFailReport.cacheDivergences).toHaveLength(1);

    // 3) Legacy v0.2.0 trace record (without wireContract) reconstructs wireContract accurately.
    const legacyTrace = join(dir, "legacy-v02.jsonl");
    const legacyRecord = {
      index: 0,
      mode: "mock",
      method: "POST",
      url: "/v1/messages",
      model: "claude-sonnet-4-6",
      bodyBytes: 512,
      estimatedTokens: 128,
      systemPromptChars: 10,
      toolsCount: 2,
      toolNames: ["read_file", "bash"],
      toolsSchemaBytes: 200,
      estimatedToolTokens: 50,
      cacheDiagnostics: {
        sessionKey: "/v1/messages",
        comparedToRequest: null,
        totalBlocks: 5,
        previousTotalBlocks: null,
        matchedPrefixBlocks: 0,
        firstDivergentLayer: "none" as const,
        firstDivergentIndex: null,
        reason: "first request",
        cacheBreakpoints: { count: 1, positions: ["tools[0]"] },
        divergedBeforeBreakpoint: false,
        invalidatedBreakpoints: [],
        layerBlockCounts: { model: 1, tools: 2, system: 1, messages: 1 },
        layerHashes: {
          model: "1111111111111111",
          tools: "2222222222222222",
          system: "3333333333333333",
          messages: "4444444444444444",
        },
        prefixHash: "5555555555555555",
      },
    };
    await writeFile(legacyTrace, `${JSON.stringify(legacyRecord)}\n`, "utf8");
    const inferred = inferWireContract(legacyRecord.cacheDiagnostics, legacyRecord.toolNames, 2);
    expect(inferred).toMatchObject({
      toolsSorted: false,
      firstUnsortedPair: ["read_file", "bash"],
      hasTools: true,
      lastToolBlockIndex: 2,
      maxBreakpointBlockIndex: 1,
      cacheBreakpointCoversTools: false,
    });
    const legacyReplay = await replayTraceFile(legacyTrace, {
      assertToolsSorted: true,
      assertCacheBreakpointCoversTools: true,
    });
    expect(legacyReplay.status).toBe("failed");
    expect(legacyReplay.failures).toHaveLength(2);

    // 4) Empty trace fails with exit code 2.
    const emptyTrace = join(dir, "empty.jsonl");
    await writeFile(emptyTrace, "\n", "utf8");
    const cliEmpty = await runCli(["--replay", emptyTrace, "--assert-tools-sorted"]);
    expect(cliEmpty.code).toBe(2);

    // 5) Version check reports 0.3.0.
    const ver = await runCli(["--version"]);
    expect(ver.code).toBe(0);
    expect(ver.stdout.trim()).toBe("0.3.0");
  }, 30_000);

  it("handles out-of-order trace indices, OpenAI tool sorting, fail-closed rawBody absence on replay, and live CLI exit codes", async () => {
    const dir = await tempDir("wire-tap-edge-");

    // 1) OpenAI Chat Completions / Responses tool sorting.
    const openaiSnap = analyzePromptPrefix(
      JSON.stringify({
        model: "gpt-6.1-sol",
        instructions: "AGENTS.md",
        tools: [
          { type: "function", function: { name: "read_file" } },
          { type: "web_search" },
        ],
        input: [{ role: "user", content: "hi" }],
      }),
      "/v1/responses",
    )!;
    expect(openaiSnap.wireContract.toolNames).toEqual(["read_file", "web_search"]);
    expect(openaiSnap.wireContract.toolsSorted).toBe(true);

    // 2) Out-of-order JSONL indices are re-ordered before evaluation, and assertNotContains
    // refuses a false pass when saved trace records omit rawBody.
    const passTrace = join(dir, "ordered.jsonl");
    const tap = await startWireTapServer({ traceFile: passTrace });
    closers.push(tap.close);
    await fetch(`${tap.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [{ name: "alpha", input_schema: {} }],
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "turn 0" }],
      }),
    });
    await fetch(`${tap.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [{ name: "alpha", input_schema: {} }],
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "turn 0" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "turn 1" },
        ],
      }),
    });
    await tap.close();

    const lines = (await readFile(passTrace, "utf8")).trim().split("\n");
    const reversedTrace = join(dir, "reversed.jsonl");
    await writeFile(reversedTrace, `${lines[1]}\n${lines[0]}\n`, "utf8");
    const reordered = await replayTraceFile(reversedTrace, {
      assertToolsSorted: true,
      assertCacheBreakpointCoversTools: true,
      assertNoPrefixDivergence: true,
    });
    expect(reordered.status).toBe("passed");
    expect(reordered.requests[0]!.cacheDiagnostics?.comparedToRequest).toBeNull();
    expect(reordered.requests[1]!.cacheDiagnostics?.comparedToRequest).toBe(0);

    const noRawLeakCheck = await replayTraceFile(reversedTrace, {
      assertNotContains: ["sk-ant-"],
    });
    expect(noRawLeakCheck.status).toBe("failed");
    expect(noRawLeakCheck.failures[0]).toContain("omit rawBody");

    // 3) Live CLI mock run exits 2 when host injects a tool after breakpoint, and 0 when fixed.
    const badAgent = join(dir, "bad-agent.mjs");
    await writeFile(
      badAgent,
      [
        "await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {",
        "  method: 'POST',",
        "  headers: { 'content-type': 'application/json' },",
        "  body: JSON.stringify({",
        "    model: 'claude-sonnet-4-6',",
        "    tools: [{ name: 'alpha', cache_control: { type: 'ephemeral' } }, { name: 'host_tool' }],",
        "    messages: [{ role: 'user', content: 'hi' }],",
        "  }),",
        "});",
      ].join("\n"),
      "utf8",
    );
    const liveFail = await runCli([
      "--assert-tools-sorted",
      "--assert-cache-breakpoint-covers-tools",
      "--",
      process.execPath,
      badAgent,
    ]);
    expect(liveFail.code).toBe(2);
    expect(liveFail.stdout).toContain("[PASS] All 1 LLM request(s) have deterministically sorted tools[]");
    expect(liveFail.stdout).toContain("[FAIL] Cache breakpoint does not cover all tools[]");
  }, 30_000);
});
