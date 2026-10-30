import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWireTapCliArgs } from "../src/cli.js";
import {
  analyzeWirePayload,
  evaluateWireAssertions,
  renderWireTapReport,
  runAgentCommandWithWireTap,
  startWireTapServer,
} from "../src/tap.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("agent-wire-tap — payload analysis & contract assertions", () => {
  it("analyzes OpenAI Responses, Chat Completions, and Anthropic Messages wire payloads", () => {
    const anthropicPayload = JSON.stringify({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "# CLAUDE.md\nAlways run unit tests first." },
      ],
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { name: "bash", input_schema: { type: "object" } },
        { name: "read_file", input_schema: { type: "object" } },
      ],
    });

    const analyzed = analyzeWirePayload(
      "POST",
      "/v1/messages",
      anthropicPayload,
    );
    expect(analyzed.model).toBe("claude-sonnet-4-6");
    expect(analyzed.systemPromptChars).toBe(40);
    expect(analyzed.toolsCount).toBe(2);
    expect(analyzed.toolNames).toEqual(["bash", "read_file"]);
    expect(analyzed.estimatedTokens).toBeGreaterThan(20);

    const report = evaluateWireAssertions([analyzed], {
      assertContains: ["CLAUDE.md", "Always run unit tests"],
      assertNotContains: ["sk-ant-api03-secret"],
      assertMaxBytes: 10_000,
      assertMaxTools: 5,
    });
    expect(report.status).toBe("passed");
    expect(report.failures).toHaveLength(0);
    expect(renderWireTapReport(report)).toContain("[PASS]");
  });

  it("reports contract failures when forbidden strings leak or budgets are exceeded", () => {
    const leakyPayload = JSON.stringify({
      model: "gpt-6.1-sol",
      instructions: "Secret token: sk-proj-leaked123456",
      tools: [{ name: "t1" }, { name: "t2" }, { name: "t3" }],
    });
    const captured = analyzeWirePayload("POST", "/v1/responses", leakyPayload);

    const report = evaluateWireAssertions([captured], {
      assertContains: ["MISSING_MARKER"],
      assertNotContains: ["sk-proj-leaked123456"],
      assertMaxBytes: 10,
      assertMaxTools: 1,
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toHaveLength(4);
    expect(renderWireTapReport(report)).toContain("[FAIL]");
  });

  it("intercepts live outbound agent HTTP calls on ephemeral loopback with zero API cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-wire-tap-test-"));
    tempDirs.push(dir);
    const fakeAgentScript = join(dir, "fake-agent.mjs");

    await writeFile(
      fakeAgentScript,
      [
        "const baseUrl = process.env.OPENAI_BASE_URL;",
        'const res = await fetch(`${baseUrl}/responses`, {',
        '  method: "POST",',
        '  headers: { "content-type": "application/json" },',
        "  body: JSON.stringify({",
        '    model: "gpt-6.1-sol",',
        '    instructions: "AGENTS.md: Use strict TypeScript.",',
        '    input: [{ role: "user", content: "ping" }],',
        '    tools: [{ name: "read_file", parameters: { type: "object" } }]',
        "  })",
        "});",
        "const json = await res.json();",
        "process.stdout.write(JSON.stringify(json));",
      ].join("\n"),
      "utf8",
    );

    const { report, exitCode, stdout } = await runAgentCommandWithWireTap({
      command: process.execPath,
      args: [fakeAgentScript],
      assertions: {
        assertContains: ["AGENTS.md: Use strict TypeScript."],
        assertNotContains: ["PRODUCTION_DB_PASSWORD"],
        assertMaxBytes: 4096,
        assertMaxTools: 3,
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[agent-wire-tap] synthetic loopback response");
    expect(report.status).toBe("passed");
    expect(report.requestsCaptured).toBe(1);
    expect(report.modelsObserved).toEqual(["gpt-6.1-sol"]);
    expect(report.toolNamesObserved).toEqual(["read_file"]);
  });

  it("supports SSE streaming synthetic responses for Anthropic /v1/messages and OpenAI /v1/responses", async () => {
    const tap = await startWireTapServer("streamed ok");
    try {
      const anthropicRes = await fetch(`${tap.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const anthropicSse = await anthropicRes.text();
      expect(anthropicSse).toContain("event: message_start");
      expect(anthropicSse).toContain("streamed ok");

      const openaiRes = await fetch(`${tap.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-6.1-sol",
          stream: true,
          input: "hi",
        }),
      });
      const openaiSse = await openaiRes.text();
      expect(openaiSse).toContain("event: response.completed");
      expect(openaiSse).toContain("streamed ok");
    } finally {
      await tap.close();
    }
  });

  it("parses CLI flags accurately", () => {
    const parsed = parseWireTapCliArgs([
      "--assert-contains",
      "AGENTS.md",
      "--assert-not-contains=sk-ant-",
      "--assert-max-bytes",
      "32768",
      "--assert-max-tools=10",
      "--json",
      "--out",
      "wire-report.json",
      "--",
      "codex",
      "exec",
      "ping",
    ]);

    expect(parsed.json).toBe(true);
    expect(parsed.outFile).toBe("wire-report.json");
    expect(parsed.assertions.assertContains).toEqual(["AGENTS.md"]);
    expect(parsed.assertions.assertNotContains).toEqual(["sk-ant-"]);
    expect(parsed.assertions.assertMaxBytes).toBe(32768);
    expect(parsed.assertions.assertMaxTools).toBe(10);
    expect(parsed.command).toBe("codex");
    expect(parsed.commandArgs).toEqual(["exec", "ping"]);
  });
});
