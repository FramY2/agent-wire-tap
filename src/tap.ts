import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
          if (typeof rec.content === "string") return rec.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
      toolsSchemaBytes = Buffer.byteLength(
        JSON.stringify(parsed.tools),
        "utf8",
      );
      for (const tool of parsed.tools) {
        if (!tool || typeof tool !== "object") continue;
        const rec = tool as Record<string, unknown>;
        if (typeof rec.name === "string") {
          toolNames.push(rec.name);
        } else if (
          rec.function &&
          typeof rec.function === "object" &&
          typeof (rec.function as Record<string, unknown>).name === "string"
        ) {
          toolNames.push(
            (rec.function as Record<string, unknown>).name as string,
          );
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
    toolsCount: toolNames.length,
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
      res.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
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

export function evaluateWireAssertions(
  requests: CapturedWireRequest[],
  assertions: WireTapAssertions = {},
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
    const passed = combinedRaw.includes(needle);
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
    const passed = !combinedRaw.includes(forbidden);
    results.push({
      kind: "not-contains",
      target: forbidden,
      passed,
      message: passed
        ? `Wire payload does not contain forbidden string "${forbidden}".`
        : `Forbidden string "${forbidden}" was leaked in the outbound wire payload.`,
    });
  }

  if (assertions.assertMaxBytes !== undefined) {
    const passed = totalPayloadBytes <= assertions.assertMaxBytes;
    results.push({
      kind: "max-bytes",
      target: assertions.assertMaxBytes,
      passed,
      message: passed
        ? `Total wire payload (${totalPayloadBytes} bytes) is within budget (<= ${assertions.assertMaxBytes} bytes).`
        : `Total wire payload (${totalPayloadBytes} bytes) exceeded budget (> ${assertions.assertMaxBytes} bytes).`,
    });
  }

  if (assertions.assertMaxTools !== undefined) {
    const passed = maxToolsCount <= assertions.assertMaxTools;
    results.push({
      kind: "max-tools",
      target: assertions.assertMaxTools,
      passed,
      message: passed
        ? `Maximum tools schema count (${maxToolsCount}) is within budget (<= ${assertions.assertMaxTools} tools).`
        : `Maximum tools schema count (${maxToolsCount}) exceeded budget (> ${assertions.assertMaxTools} tools).`,
    });
  }

  const failures = results.filter((r) => !r.passed).map((r) => r.message);

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
  };
}

export interface EphemeralWireTapServer {
  baseUrl: string;
  port: number;
  requests: CapturedWireRequest[];
  close: () => Promise<void>;
}

export async function startWireTapServer(
  syntheticText?: string,
): Promise<EphemeralWireTapServer> {
  const requests: CapturedWireRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push(
        analyzeWirePayload(req.method ?? "POST", req.url ?? "/", rawBody),
      );
      writeSyntheticReply(req, res, rawBody, syntheticText);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    port: addr.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function runAgentCommandWithWireTap(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  assertions?: WireTapAssertions;
}): Promise<{
  report: WireTapReport;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const tap = await startWireTapServer();
  const timeoutMs = options.timeoutMs ?? 15_000;

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      OPENAI_BASE_URL: `${tap.baseUrl}/v1`,
      OPENAI_API_BASE: `${tap.baseUrl}/v1`,
      ANTHROPIC_BASE_URL: tap.baseUrl,
      OPENAI_API_KEY:
        options.env?.OPENAI_API_KEY ??
        process.env.OPENAI_API_KEY ??
        "sk-wiretap-local-loopback-000000000000",
      ANTHROPIC_API_KEY:
        options.env?.ANTHROPIC_API_KEY ??
        process.env.ANTHROPIC_API_KEY ??
        "sk-ant-wiretap-local-loopback-000000000000",
      WIRE_TAP_BASE_URL: tap.baseUrl,
    };

    const execResult = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: false,
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

    const report = evaluateWireAssertions(tap.requests, options.assertions);
    return {
      report,
      ...execResult,
    };
  } finally {
    await tap.close();
  }
}

export function renderWireTapReport(report: WireTapReport): string {
  const lines = [
    `agent-wire-tap · ${report.status} · ${report.requestsCaptured} requests · ${report.totalPayloadBytes.toLocaleString("en-US")} bytes (~${report.estimatedTotalTokens.toLocaleString("en-US")} tokens) · max ${report.maxToolsCount} tools`,
  ];

  for (const req of report.requests) {
    lines.push(
      `- ${req.method} ${req.url} · model=${req.model ?? "unknown"} · ${req.bodyBytes.toLocaleString("en-US")} bytes (~${req.estimatedTokens.toLocaleString("en-US")} tokens) · system=${req.systemPromptChars.toLocaleString("en-US")} chars · tools=${req.toolsCount}`,
    );
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
