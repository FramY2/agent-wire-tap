# agent-wire-tap (`@framy2/agent-wire-tap`)

<p align="center">
  <a href="https://github.com/FramY2/agent-wire-tap/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/FramY2/agent-wire-tap?style=flat&logo=github&color=F59E0B" /></a>
  <a href="https://github.com/FramY2/agent-wire-tap/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/FramY2/agent-wire-tap/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen" />
  <img alt="Zero API Cost" src="https://img.shields.io/badge/API%20Cost-%240.00-7657FF" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2DE2E6" />
</p>

**Zero-cost local loopback HTTP interceptor & CI context contract tester** for **Claude Code**, **OpenAI Codex CLI**, and custom coding agents.

Starts an ephemeral local loopback server (`127.0.0.1:0` injected via `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`), runs your coding agent for a single turn, captures the exact outbound wire payload (`instructions` / `system`, `AGENTS.md` / `CLAUDE.md` markers, `tools[]` schema count & byte footprint), returns a synthetic completion with **$0.00 API cost**, and verifies your CI context assertions.

Companion wire verifier to **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise)** (`@framy2/ctxwise`) and **[`FramY2/mcp-diet`](https://github.com/FramY2/mcp-diet)** (`@framy2/mcp-diet`).

---

## ⚡ Quickstart

```shell
# Verify in CI that Codex loads AGENTS.md, stays under 32 KiB wire payload, and exposes <= 12 tools:
npx @framy2/agent-wire-tap \
  --assert-contains "AGENTS.md" \
  --assert-not-contains "sk-ant-" \
  --assert-max-bytes 32768 \
  --assert-max-tools 12 \
  -- codex exec "ping"
```

---

## 🛠️ CLI Options

```text
Usage:
  agent-wire-tap [options] -- <agent-command> [agent-args...]

Options:
  --assert-contains <str>      Assert outbound wire payload contains marker (repeatable)
  --assert-not-contains <str>  Assert outbound wire payload never contains string/secret (repeatable)
  --assert-max-bytes <n>       Assert total outbound wire payload bytes <= n
  --assert-max-tools <n>       Assert tools[] count in outbound wire payload <= n
  --out <report.json>          Write structured JSON report to file
  --timeout-ms <ms>            Agent command timeout in ms (default: 15000)
  --json                       Print structured JSON report to stdout
  -v, --version                Print version
  -h, --help                   Print help
```

---

## 📦 Programmatic API

```ts
import {
  analyzeWirePayload,
  evaluateWireAssertions,
  runAgentCommandWithWireTap,
  startWireTapServer,
} from "@framy2/agent-wire-tap";
```

## License

MIT © [Christian Frascogna (@FramY2)](https://github.com/FramY2)
