# agent-wire-tap (`@framy2/agent-wire-tap`)

<p align="center">
  <a href="https://github.com/FramY2/agent-wire-tap/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/FramY2/agent-wire-tap?style=flat&logo=github&color=F59E0B" /></a>
  <a href="https://github.com/FramY2/agent-wire-tap/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FramY2/agent-wire-tap/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen" />
  <img alt="Zero API Cost" src="https://img.shields.io/badge/API%20Cost-%240.00-7657FF" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2DE2E6" />
</p>

**Local loopback HTTP wire interceptor, CI context contract tester & live prompt-cache debugger** for **Claude Code**, **OpenAI Codex CLI**, and custom coding agents.

Two modes:
1. **Mock / CI Contract Mode (default, `$0.00` API cost):** Starts an ephemeral local loopback server (`127.0.0.1:0` injected via `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`), captures outbound requests (`instructions` / `system`, `AGENTS.md` / `CLAUDE.md`, `tools[]` count & bytes), returns synthetic JSON/SSE replies, and asserts your context contracts.
2. **Live `--passthrough` Reverse Proxy Mode (`v0.2.0`):** Forwards real requests to Anthropic / OpenAI (or any custom upstream), streams JSON & SSE responses chunk-by-chunk, extracts real `cache_read_input_tokens` / `cache_creation_input_tokens` / `cached_tokens` usage, and runs **turn-over-turn prompt prefix SHA-256 diffing** to pinpoint why prompt caching broke (`tools[i]`, `system[i]`, `model`, `messages[i]`, and `cache_control` breakpoint invalidation) — while **never** writing `Authorization`, `x-api-key`, `Proxy-Authorization`, or `Cookie` secrets to disk or stdout (`[REDACTED]`).

Companion wire verifier to **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise)** (`@framy2/ctxwise`) and **[`FramY2/mcp-diet`](https://github.com/FramY2/mcp-diet)** (`@framy2/mcp-diet`).

---

## ⚡ Quickstart

### 1. CI Contract Testing (Zero API Cost)

```shell
# Verify in CI that Codex loads AGENTS.md, stays under 32 KiB wire payload, and exposes <= 12 tools:
npx @framy2/agent-wire-tap \
  --assert-contains "AGENTS.md" \
  --assert-not-contains "sk-ant-" \
  --assert-max-bytes 32768 \
  --assert-max-tools 12 \
  -- codex exec "ping"
```

### 2. Live `--passthrough` & Prompt-Cache Miss Debugging

Start the proxy once on `http://127.0.0.1:8787` (auto-routes `/v1/messages` -> `https://api.anthropic.com` and `/v1/responses` + `/v1/chat/completions` -> `https://api.openai.com`):

```shell
npx @framy2/agent-wire-tap --passthrough --trace cache-trace.jsonl
```

Then point **Claude Code** or **Codex** at the proxy in another terminal:

```shell
# Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# OpenAI Codex CLI
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex
```

Or wrap a single run directly (also supports explicit upstreams like `--passthrough https://api.anthropic.com` or `--anthropic-upstream` / `--openai-upstream`):

```shell
npx @framy2/agent-wire-tap --passthrough --trace cache-trace.jsonl -- claude -p "fix tests"
```

Example live diagnostic output when a tool schema or volatile timestamp mutates before a `cache_control` breakpoint:

```text
#0 POST /v1/messages -> 200 · 412ms · SSE · model=claude-sonnet-4-6 · in=12 cache_read=0 cache_write=14,200 out=120 (hit 0.0%)
  ↳ prefix baseline · 18 blocks · 3 cache_control breakpoint(s) · hash 8a3f9c02e1d4b710
#1 POST /v1/messages -> 200 · 380ms · SSE · model=claude-sonnet-4-6 · in=48 cache_read=14,200 cache_write=0 out=95 (hit 99.7%)
  ↳ prefix 18/20 blocks match #0 · 3 cache_control breakpoint(s) · append-only: 2 new block(s) after the unchanged baseline prefix (cache-friendly)
#2 POST /v1/messages -> 200 · 510ms · SSE · model=claude-sonnet-4-6 · in=220 cache_read=0 cache_write=14,450 out=110 (hit 0.0%)
  ↳ PREFIX DIVERGED at tools[4] (tools) vs #1 · 5/20 blocks match · BEFORE cache_control breakpoint (cache invalidated) · tool "mcp__github__search" schema/definition mutated (changed: description) — divergence is BEFORE cache_control breakpoint tools[11], invalidating 3 cached prefix(es) downstream
```

### Security Invariant

Credentials (`Authorization`, `x-api-key`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, and URL credential/query tokens) are forwarded upstream in memory so live agents authenticate normally, **and are ALWAYS replaced with `[REDACTED]`** in JSONL trace files (`--trace`), stdout logs, and JSON reports (`--out` / `--json`). Raw request bodies (`rawBody`) are never written to `--trace` or `--out` reports.

---

## 🛠️ CLI Options

```text
Usage:
  agent-wire-tap [options] -- <agent-command> [agent-args...]   Run one agent turn (mock or passthrough)
  agent-wire-tap --passthrough [upstream-url] [options]         Long-running live reverse proxy (default port 8787)

Options:
  --assert-contains <str>      Assert outbound wire payload contains marker (repeatable)
  --assert-not-contains <str>  Assert outbound wire payload never contains string/secret (repeatable)
  --assert-max-bytes <n>       Assert total outbound wire payload bytes <= n
  --assert-max-tools <n>       Assert tools[] count in outbound wire payload <= n
  --out <report.json>          Write structured JSON report to file
  --timeout-ms <ms>            Agent command timeout in ms (default: 15000; 600000 with --passthrough)
  --json                       Print structured JSON report to stdout

Live passthrough & prompt-cache diagnostics:
  --passthrough [url]          Forward requests to the REAL upstream and stream replies back (JSON + SSE).
                               Without a url: /v1/messages -> https://api.anthropic.com,
                               /v1/responses + /v1/chat/completions -> https://api.openai.com
  --anthropic-upstream <url>   Override the Anthropic upstream (implies --passthrough)
  --openai-upstream <url>      Override the OpenAI upstream (implies --passthrough)
  --trace <file.jsonl>         Write one redacted JSONL record per exchange (usage + cacheDiagnostics)
  --port <n>                   Proxy port (default: ephemeral; 8787 in long-running proxy mode)
  --host <host>                Proxy bind host (default: 127.0.0.1)

  -v, --version                Print version
  -h, --help                   Print help
```

---

## 📦 Programmatic API

```ts
import {
  analyzePromptPrefix,
  analyzeWirePayload,
  diffPromptPrefix,
  evaluateWireAssertions,
  PromptCacheTracker,
  redactHeaders,
  runAgentCommandWithWireTap,
  startWireTapServer,
} from "@framy2/agent-wire-tap";
```

## 🧩 Companion Tools / Ecosystem

- **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise) (`@framy2/ctxwise`)**: Local-first AI Context Firewall, MCP Schema Tree-Shaker (`mcp-xray`, `mcp-prune`), multi-agent rule sync (`CLAUDE.md` ↔ `AGENTS.md` ↔ Cursor), Codex `32 KiB` doctor, and SARIF 2.1.0 Secret Shield.
- **[`FramY2/mcp-diet`](https://github.com/FramY2/mcp-diet) (`@framy2/mcp-diet`)**: Zero-dependency stdio MCP proxy & runtime firewall — deterministic `tools/list` tree-shaking (`--allow`, `--deny`, `--read-only`, `--max-desc`), oversized `tools/call` crash guard (`--max-result-kb` for `anthropics/claude-code#105703`), and live secret redaction (`--redact-secrets`).
- **[Interactive Context & MCP Token Tax Calculator](https://framy2.github.io/ctxwise/)**: 100% client-side web calculator for MCP schema token tax, 50-turn session costs, and secret scanning.

---

## License

MIT © [Christian Frascogna (@FramY2)](https://github.com/FramY2)
