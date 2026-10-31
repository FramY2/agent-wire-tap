#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  renderWireTapReport,
  runAgentCommandWithWireTap,
  type WireTapAssertions,
} from "./tap.js";

export interface ParsedWireTapCliArgs {
  help: boolean;
  version: boolean;
  json: boolean;
  outFile?: string;
  timeoutMs: number;
  assertions: WireTapAssertions;
  command: string | null;
  commandArgs: string[];
}

export function parseWireTapCliArgs(argv: string[]): ParsedWireTapCliArgs {
  const assertContains: string[] = [];
  const assertNotContains: string[] = [];
  let assertMaxBytes: number | undefined;
  let assertMaxTools: number | undefined;
  let json = false;
  let outFile: string | undefined;
  let timeoutMs = 15_000;
  let help = false;
  let version = false;

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
    } else if (arg.startsWith("--timeout-ms=")) {
      const val = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      timeoutMs = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      command = arg;
    }
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
    },
    command,
    commandArgs,
  };
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "agent-wire-tap — Zero-cost local loopback HTTP interceptor & CI contract tester for coding agents",
      "",
      "Usage:",
      "  agent-wire-tap [options] -- <agent-command> [agent-args...]",
      "",
      "Options:",
      "  --assert-contains <str>      Assert outbound wire payload contains marker (repeatable)",
      "  --assert-not-contains <str>  Assert outbound wire payload never contains string/secret (repeatable)",
      "  --assert-max-bytes <n>       Assert total outbound wire payload bytes <= n",
      "  --assert-max-tools <n>       Assert tools[] count in outbound wire payload <= n",
      "  --out <report.json>          Write structured JSON report to file",
      "  --timeout-ms <ms>            Agent command timeout in ms (default: 15000)",
      "  --json                       Print structured JSON report to stdout",
      "  -v, --version                Print version",
      "  -h, --help                   Print help",
      "",
    ].join("\n"),
  );
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
  if (!parsed.command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const { report } = await runAgentCommandWithWireTap({
    command: parsed.command,
    args: parsed.commandArgs,
    timeoutMs: parsed.timeoutMs,
    assertions: parsed.assertions,
  });

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

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((err: unknown) => {
    process.stderr.write(`agent-wire-tap error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
