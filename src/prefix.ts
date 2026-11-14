import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { detectProvider, type LlmProvider } from "./usage.js";

/**
 * Prompt layers in the order providers build the cacheable prefix.
 *
 * Anthropic documents the cache prefix order as `tools` -> `system` ->
 * `messages`; OpenAI's automatic prefix cache likewise covers tool
 * definitions before the conversation. The `model` is compared first because
 * prompt caches are scoped per model: switching models is always a full miss.
 */
export type PromptLayer = "model" | "tools" | "system" | "messages";
export type DivergentLayer = "none" | PromptLayer;

export const PROMPT_LAYER_ORDER: readonly PromptLayer[] = [
  "model",
  "tools",
  "system",
  "messages",
];

const LAYER_RANK: Record<PromptLayer, number> = {
  model: 0,
  tools: 1,
  system: 2,
  messages: 3,
};

export interface PromptBlock {
  layer: PromptLayer;
  /** e.g. `model`, `tools[4]`, `system[1]`, `instructions`, `messages[6]`, `input[2]` */
  path: string;
  /** SHA-256 of the block exactly as serialized on the wire (minus `cache_control`). */
  hash: string;
  /** SHA-256 of the block with object keys sorted (detects pure key-order churn). */
  canonicalHash: string;
  /** In-memory only; NEVER written to traces or reports. */
  serialized: string;
  name?: string;
  role?: string;
}

export interface CacheBreakpointPosition {
  path: string;
  layer: PromptLayer;
  /** Index into the flattened ordered block list. */
  blockIndex: number;
  ttl?: string;
}

export interface WireContractMetadata {
  /** Tool names in exact wire order (from `tools[]`). */
  toolNames: string[];
  /** True when `toolNames` is sorted ascending via `localeCompare <= 0` (matching `mcp-diet`). */
  toolsSorted: boolean;
  /** First adjacent pair `[prev, curr]` with `prev.localeCompare(curr) > 0`, or `null` when sorted. */
  firstUnsortedPair: [string, string] | null;
  /** True when `tools[]` has at least one tool entry. */
  hasTools: boolean;
  /**
   * True when `hasTools` is false OR at least one `cache_control` breakpoint
   * sits at or after `lastToolBlockIndex` (on `tools[last]`, `system`, `messages`,
   * or top-level `body.cache_control`).
   */
  cacheBreakpointCoversTools: boolean;
  /** Flattened block index of `tools[tools.length - 1]`, or `null` when `hasTools` is false. */
  lastToolBlockIndex: number | null;
  /** Highest flattened block index carrying a `cache_control` breakpoint, or `null` if none exist. */
  maxBreakpointBlockIndex: number | null;
  /** True when top-level `body.cache_control` is present. */
  hasTopLevelCacheControl: boolean;
}

export interface PromptPrefixSnapshot {
  provider: LlmProvider;
  model: string | null;
  blocks: PromptBlock[];
  breakpoints: CacheBreakpointPosition[];
  wireContract: WireContractMetadata;
}

export interface CacheBreakpointSummary {
  count: number;
  positions: string[];
}

/** Turn-over-turn prompt-prefix / prompt-cache diagnostics attached to each LLM request. */
export interface CacheDiagnostics {
  /** Endpoint path (+ hashed session id / prompt_cache_key when present). */
  sessionKey: string;
  /** Index (in `requests[]`) of the baseline request this one was diffed against. */
  comparedToRequest: number | null;
  totalBlocks: number;
  previousTotalBlocks: number | null;
  matchedPrefixBlocks: number;
  firstDivergentLayer: DivergentLayer;
  firstDivergentIndex: string | null;
  reason: string;
  /** `cache_control` breakpoints present in THIS request. */
  cacheBreakpoints: CacheBreakpointSummary;
  /** True when the divergence sits at/before a breakpoint of the baseline request (its cache entry can no longer be read). */
  divergedBeforeBreakpoint: boolean;
  /** Baseline breakpoints whose cached prefix was invalidated by the divergence. */
  invalidatedBreakpoints: string[];
  layerBlockCounts: Record<PromptLayer, number>;
  /** First 16 hex chars of SHA-256 over each layer's ordered block hashes. */
  layerHashes: Record<PromptLayer, string>;
  /** First 16 hex chars of SHA-256 over the entire ordered prefix. */
  prefixHash: string;
  /** Serialized wire-contract invariants (tool sort order + breakpoint coverage). */
  wireContract: WireContractMetadata;
}

const SCHEMA_KEYS = new Set(["input_schema", "parameters", "schema", "json_schema"]);

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Removes `cache_control` markers (but never touches JSON-schema bodies). */
export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  const obj = asRecord(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === "cache_control") continue;
    out[key] = SCHEMA_KEYS.has(key) ? child : stripCacheControl(child);
  }
  return out;
}

/** JSON.stringify with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = asRecord(value);
  if (obj) {
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolName(tool: unknown): string | undefined {
  const obj = asRecord(tool);
  if (!obj) return undefined;
  if (typeof obj.name === "string" && obj.name.trim()) return obj.name;
  const fn = asRecord(obj.function);
  if (fn && typeof fn.name === "string" && fn.name.trim()) return fn.name;
  if (typeof obj.type === "string" && obj.type.trim()) return obj.type;
  return undefined;
}

function cacheControlTtl(value: unknown): string | undefined {
  const cc = asRecord(value);
  return cc && typeof cc.ttl === "string" ? cc.ttl : undefined;
}

/** Checks whether `toolNames` is sorted ascending via `localeCompare <= 0` (matching `mcp-diet`). */
export function checkToolsSorted(toolNames: readonly string[]): {
  toolsSorted: boolean;
  firstUnsortedPair: [string, string] | null;
} {
  for (let i = 1; i < toolNames.length; i++) {
    const prev = toolNames[i - 1]!;
    const curr = toolNames[i]!;
    if (prev.localeCompare(curr) > 0) {
      return { toolsSorted: false, firstUnsortedPair: [prev, curr] };
    }
  }
  return { toolsSorted: true, firstUnsortedPair: null };
}

/**
 * Reconstructs `WireContractMetadata` from `CacheDiagnostics` when replaying
 * older v0.2.0 traces/reports that did not persist `wireContract`.
 */
export function inferWireContract(
  diag: Omit<CacheDiagnostics, "wireContract"> & { wireContract?: WireContractMetadata },
  fallbackToolNames: readonly string[] = [],
  fallbackToolsCount = 0,
): WireContractMetadata {
  if (diag.wireContract) return diag.wireContract;
  const toolNames = [...fallbackToolNames];
  const { toolsSorted, firstUnsortedPair } = checkToolsSorted(toolNames);
  const modelCount = diag.layerBlockCounts.model;
  const toolsCount = Math.max(diag.layerBlockCounts.tools, fallbackToolsCount);
  const systemCount = diag.layerBlockCounts.system;
  const hasTools = toolsCount > 0;
  const lastToolBlockIndex = hasTools ? modelCount + toolsCount - 1 : null;
  const hasTopLevelCacheControl = diag.cacheBreakpoints.positions.some((p) =>
    p.startsWith("auto:"),
  );

  let maxBreakpointBlockIndex: number | null = null;
  for (const rawPos of diag.cacheBreakpoints.positions) {
    let idx: number | null = null;
    if (rawPos.startsWith("auto:")) {
      idx = diag.totalBlocks > 0 ? diag.totalBlocks - 1 : null;
    } else {
      const toolMatch = /^tools\[(\d+)\]$/.exec(rawPos);
      const sysMatch = /^system\[(\d+)\]$/.exec(rawPos);
      const msgMatch = /^(?:messages|input)\[(\d+)\](?:\.content\[\d+\])?$/.exec(rawPos);
      if (toolMatch) {
        idx = modelCount + Number(toolMatch[1]);
      } else if (sysMatch) {
        idx = modelCount + toolsCount + Number(sysMatch[1]);
      } else if (rawPos === "instructions") {
        idx = modelCount + toolsCount + Math.max(0, systemCount - 1);
      } else if (msgMatch) {
        idx = modelCount + toolsCount + systemCount + Number(msgMatch[1]);
      }
    }
    if (idx !== null) {
      maxBreakpointBlockIndex =
        maxBreakpointBlockIndex === null ? idx : Math.max(maxBreakpointBlockIndex, idx);
    }
  }

  const cacheBreakpointCoversTools =
    lastToolBlockIndex === null ||
    (maxBreakpointBlockIndex !== null && maxBreakpointBlockIndex >= lastToolBlockIndex);

  return {
    toolNames,
    toolsSorted,
    firstUnsortedPair,
    hasTools,
    cacheBreakpointCoversTools,
    lastToolBlockIndex,
    maxBreakpointBlockIndex,
    hasTopLevelCacheControl,
  };
}

/**
 * Normalizes an LLM request body into an ordered list of SHA-256-hashed
 * prefix blocks (`model`, `tools[i]`, `system[i]` / `instructions`,
 * `messages[i]` / `input[i]`) plus the positions of every explicit
 * `cache_control` breakpoint. Returns `null` for non-JSON bodies.
 */
export function analyzePromptPrefix(
  rawBody: string,
  url = "/v1/messages",
): PromptPrefixSnapshot | null {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(rawBody));
  } catch {
    return null;
  }
  if (!parsed) return null;

  const blocks: PromptBlock[] = [];
  const breakpoints: CacheBreakpointPosition[] = [];

  const addBlock = (
    layer: PromptLayer,
    path: string,
    value: unknown,
    extra: { name?: string; role?: string } = {},
  ): number => {
    const stripped = stripCacheControl(value);
    const serialized = JSON.stringify(stripped) ?? "null";
    blocks.push({
      layer,
      path,
      hash: sha256(`${layer}\u0000${serialized}`),
      canonicalHash: sha256(`${layer}\u0000${stableStringify(stripped)}`),
      serialized,
      ...extra,
    });
    return blocks.length - 1;
  };
  const addBreakpoint = (
    layer: PromptLayer,
    path: string,
    blockIndex: number,
    cacheControl: unknown,
  ) => {
    const ttl = cacheControlTtl(cacheControl);
    breakpoints.push({ layer, path, blockIndex, ...(ttl ? { ttl } : {}) });
  };

  // Anthropic prefix order: model -> tools -> system -> messages.
  const model = typeof parsed.model === "string" ? parsed.model : null;
  addBlock("model", "model", model);

  const toolNames: string[] = [];
  let lastToolBlockIndex: number | null = null;
  if (Array.isArray(parsed.tools)) {
    parsed.tools.forEach((tool, i) => {
      const name = toolName(tool);
      if (name) toolNames.push(name);
      const idx = addBlock("tools", `tools[${i}]`, tool, name ? { name } : {});
      lastToolBlockIndex = idx;
      const cc = asRecord(asRecord(tool)?.cache_control);
      if (cc) addBreakpoint("tools", `tools[${i}]`, idx, cc);
    });
  }

  if (typeof parsed.system === "string") {
    addBlock("system", "system[0]", parsed.system);
  } else if (Array.isArray(parsed.system)) {
    parsed.system.forEach((block, i) => {
      const idx = addBlock("system", `system[${i}]`, block);
      const cc = asRecord(asRecord(block)?.cache_control);
      if (cc) addBreakpoint("system", `system[${i}]`, idx, cc);
    });
  }
  if (typeof parsed.instructions === "string") {
    addBlock("system", "instructions", parsed.instructions);
  }

  const field = Array.isArray(parsed.messages)
    ? "messages"
    : parsed.input !== undefined
      ? "input"
      : null;
  if (field) {
    const items = parsed[field];
    if (Array.isArray(items)) {
      items.forEach((item, i) => {
        const msg = asRecord(item);
        const role = typeof msg?.role === "string" ? msg.role : undefined;
        const path = `${field}[${i}]`;
        const idx = addBlock("messages", path, item, role ? { role } : {});
        const msgCc = asRecord(msg?.cache_control);
        if (msgCc) addBreakpoint("messages", path, idx, msgCc);
        if (Array.isArray(msg?.content)) {
          msg.content.forEach((part, j) => {
            const cc = asRecord(asRecord(part)?.cache_control);
            if (cc) addBreakpoint("messages", `${path}.content[${j}]`, idx, cc);
          });
        }
      });
    } else {
      addBlock("messages", field, items);
    }
  }

  // Anthropic top-level automatic caching: breakpoint on the last cacheable block.
  const topLevelCacheControl = asRecord(parsed.cache_control);
  const hasTopLevelCacheControl = Boolean(topLevelCacheControl);
  if (topLevelCacheControl && blocks.length > 0) {
    const last = blocks.length - 1;
    addBreakpoint(
      blocks[last]!.layer,
      `auto:${blocks[last]!.path}`,
      last,
      topLevelCacheControl,
    );
  }

  const { toolsSorted, firstUnsortedPair } = checkToolsSorted(toolNames);
  const hasTools = lastToolBlockIndex !== null;
  const maxBreakpointBlockIndex =
    breakpoints.length > 0
      ? breakpoints.reduce((max, bp) => Math.max(max, bp.blockIndex), -1)
      : null;
  const cacheBreakpointCoversTools =
    lastToolBlockIndex === null ||
    (maxBreakpointBlockIndex !== null && maxBreakpointBlockIndex >= lastToolBlockIndex);

  return {
    provider: detectProvider(url),
    model,
    blocks,
    breakpoints,
    wireContract: {
      toolNames,
      toolsSorted,
      firstUnsortedPair,
      hasTools,
      cacheBreakpointCoversTools,
      lastToolBlockIndex,
      maxBreakpointBlockIndex,
      hasTopLevelCacheControl,
    },
  };
}

const VOLATILE_VALUE =
  /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(:\d{2})?|\b\d{10,13}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,? /i;

function firstDiffOffset(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function describeContentChange(prev: PromptBlock, curr: PromptBlock): string {
  const offset = firstDiffOffset(prev.serialized, curr.serialized);
  const windowOf = (s: string) => s.slice(Math.max(0, offset - 48), offset + 48);
  const prevWin = windowOf(prev.serialized);
  const currWin = windowOf(curr.serialized);
  const hints: string[] = [];
  if (VOLATILE_VALUE.test(prevWin) || VOLATILE_VALUE.test(currWin)) {
    hints.push("looks like a volatile date/time/timestamp/UUID value changed");
  }
  if (/system-reminder/.test(prevWin) || /system-reminder/.test(currWin)) {
    hints.push("injected <system-reminder> content changed");
  }
  const thinking = /"type":"(redacted_)?thinking"/;
  if (thinking.test(prev.serialized) && !thinking.test(curr.serialized)) {
    hints.push("thinking blocks were stripped from this turn");
  }
  if (prev.canonicalHash === curr.canonicalHash) {
    hints.push("semantically identical JSON serialized with a different key order");
  }
  const where = `changed at char ${offset} (${prev.serialized.length} -> ${curr.serialized.length} chars)`;
  return hints.length > 0 ? `${where} — ${hints.join("; ")}` : where;
}

function changedTopLevelKeys(prev: PromptBlock, curr: PromptBlock): string[] {
  try {
    const a = asRecord(JSON.parse(prev.serialized)) ?? {};
    const b = asRecord(JSON.parse(curr.serialized)) ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
  } catch {
    return [];
  }
}

function explainDivergence(
  prev: PromptPrefixSnapshot,
  curr: PromptPrefixSnapshot,
  index: number,
): { layer: PromptLayer; path: string; reason: string } {
  const p = prev.blocks[index];
  const c = curr.blocks[index];

  // Current request ended early: blocks were removed / history truncated.
  if (!c && p) {
    return {
      layer: p.layer,
      path: p.path,
      reason: `request is shorter than the baseline: ${prev.blocks.length - index} block(s) starting at ${p.path} were removed (history truncated/compacted or ${p.layer} dropped)`,
    };
  }
  if (!c || !p) {
    return { layer: "messages", path: "?", reason: "unknown divergence" };
  }

  if (p.layer !== c.layer) {
    // One side has more blocks in the earlier layer.
    const earlier = LAYER_RANK[p.layer] < LAYER_RANK[c.layer] ? p : c;
    const prevCount = prev.blocks.filter((b) => b.layer === earlier.layer).length;
    const currCount = curr.blocks.filter((b) => b.layer === earlier.layer).length;
    const verb = currCount > prevCount ? "added" : "removed";
    return {
      layer: earlier.layer,
      path: earlier.path,
      reason: `${earlier.layer} block count changed from ${prevCount} to ${currCount} (${earlier.path} ${verb})`,
    };
  }

  switch (c.layer) {
    case "model":
      return {
        layer: "model",
        path: "model",
        reason: `model changed from ${p.serialized} to ${c.serialized} (prompt caches are scoped per model: full cache miss)`,
      };
    case "tools": {
      const prevNames = prev.blocks.filter((b) => b.layer === "tools").map((b) => b.name);
      const currNames = curr.blocks.filter((b) => b.layer === "tools").map((b) => b.name);
      let reason: string;
      if (c.name !== undefined && c.name === p.name) {
        if (c.canonicalHash === p.canonicalHash) {
          reason = `tool "${c.name}" JSON key order changed (semantically identical schema serialized non-deterministically)`;
        } else {
          const keys = changedTopLevelKeys(p, c);
          reason = `tool "${c.name}" schema/definition mutated${keys.length ? ` (changed: ${keys.join(", ")})` : ""}`;
        }
      } else if (c.name !== undefined && !prevNames.includes(c.name)) {
        reason = `tool "${c.name}" inserted at ${c.path}${p.name ? ` (previously "${p.name}")` : ""}`;
      } else if (p.name !== undefined && !currNames.includes(p.name)) {
        reason = `tool "${p.name}" removed from ${p.path}`;
      } else if (c.name !== undefined) {
        const from = prevNames.indexOf(c.name);
        reason = `tool order changed: "${c.name}" moved from tools[${from}] to ${c.path}`;
      } else {
        reason = `${c.path} definition changed`;
      }
      return { layer: "tools", path: c.path, reason };
    }
    case "system":
      return {
        layer: "system",
        path: c.path,
        reason: `system prompt block ${c.path} ${describeContentChange(p, c)}`,
      };
    case "messages": {
      const roleNote =
        p.role !== c.role
          ? ` role changed ${p.role ?? "?"} -> ${c.role ?? "?"};`
          : c.role
            ? ` (role=${c.role})`
            : "";
      return {
        layer: "messages",
        path: c.path,
        reason: `earlier conversation item ${c.path}${roleNote} ${describeContentChange(p, c)}`,
      };
    }
  }
}

function layerSummary(snapshot: PromptPrefixSnapshot): {
  layerBlockCounts: Record<PromptLayer, number>;
  layerHashes: Record<PromptLayer, string>;
  prefixHash: string;
} {
  const layerBlockCounts = { model: 0, tools: 0, system: 0, messages: 0 };
  const layerHashes = { model: "", tools: "", system: "", messages: "" };
  for (const layer of PROMPT_LAYER_ORDER) {
    const hashes = snapshot.blocks.filter((b) => b.layer === layer).map((b) => b.hash);
    layerBlockCounts[layer] = hashes.length;
    layerHashes[layer] = sha256(hashes.join(",")).slice(0, 16);
  }
  return {
    layerBlockCounts,
    layerHashes,
    prefixHash: sha256(snapshot.blocks.map((b) => b.hash).join(",")).slice(0, 16),
  };
}

/** Diffs two prompt-prefix snapshots block-by-block (pure function). */
export function diffPromptPrefix(
  previous: PromptPrefixSnapshot | null,
  current: PromptPrefixSnapshot,
): Omit<CacheDiagnostics, "sessionKey" | "comparedToRequest"> {
  const cacheBreakpoints: CacheBreakpointSummary = {
    count: current.breakpoints.length,
    positions: current.breakpoints.map((b) => b.path),
  };
  const base = {
    totalBlocks: current.blocks.length,
    cacheBreakpoints,
    ...layerSummary(current),
    wireContract: current.wireContract,
  };

  if (!previous) {
    return {
      ...base,
      previousTotalBlocks: null,
      matchedPrefixBlocks: 0,
      firstDivergentLayer: "none",
      firstDivergentIndex: null,
      reason: "first request in this session/endpoint (cold-cache baseline)",
      divergedBeforeBreakpoint: false,
      invalidatedBreakpoints: [],
    };
  }

  const max = Math.min(previous.blocks.length, current.blocks.length);
  let matched = 0;
  while (matched < max && previous.blocks[matched]!.hash === current.blocks[matched]!.hash) {
    matched++;
  }

  if (matched === previous.blocks.length) {
    const appended = current.blocks.length - previous.blocks.length;
    return {
      ...base,
      previousTotalBlocks: previous.blocks.length,
      matchedPrefixBlocks: matched,
      firstDivergentLayer: "none",
      firstDivergentIndex: null,
      reason:
        appended === 0
          ? "identical prompt prefix (full prompt-cache reuse expected)"
          : `append-only: ${appended} new block(s) after the unchanged baseline prefix (cache-friendly)`,
      divergedBeforeBreakpoint: false,
      invalidatedBreakpoints: [],
    };
  }

  const { layer, path, reason } = explainDivergence(previous, current, matched);
  const invalidated = previous.breakpoints.filter((b) => b.blockIndex >= matched);
  const divergedBeforeBreakpoint = invalidated.length > 0;
  let fullReason = reason;
  if (divergedBeforeBreakpoint) {
    fullReason += ` — divergence is BEFORE cache_control breakpoint ${invalidated[0]!.path}, invalidating ${invalidated.length} cached prefix(es) downstream`;
  } else if (previous.breakpoints.length > 0) {
    fullReason += " — after the last cache_control breakpoint (cached prefix still reusable)";
  } else if (current.provider === "openai") {
    fullReason += " — OpenAI automatic prefix caching can only reuse tokens before this point";
  }

  return {
    ...base,
    previousTotalBlocks: previous.blocks.length,
    matchedPrefixBlocks: matched,
    firstDivergentLayer: layer,
    firstDivergentIndex: path,
    reason: fullReason,
    divergedBeforeBreakpoint,
    invalidatedBreakpoints: invalidated.map((b) => b.path),
  };
}

const SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-session-id",
  "session_id",
  "session-id",
  "conversation_id",
  "conversation-id",
];

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

/**
 * Groups requests into comparison lanes: endpoint path, plus a HASHED session
 * id header (Claude Code / Codex) and OpenAI `prompt_cache_key` when present.
 */
export function deriveSessionKey(
  url: string,
  headers: IncomingHttpHeaders = {},
  rawBody?: string,
): string {
  const parts = [(url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/"];
  for (const name of SESSION_HEADERS) {
    const value = headers[name];
    const str = Array.isArray(value) ? value.join(",") : value;
    if (str) parts.push(`session:${shortHash(str)}`);
  }
  if (rawBody) {
    try {
      const parsed = asRecord(JSON.parse(rawBody));
      if (typeof parsed?.prompt_cache_key === "string") {
        parts.push(`prompt_cache_key:${shortHash(parsed.prompt_cache_key)}`);
      }
    } catch {
      // ignore
    }
  }
  return parts.join("|");
}

interface LaneEntry {
  requestIndex: number;
  snapshot: PromptPrefixSnapshot;
}

/**
 * Stateful turn-over-turn tracker. Each request is diffed against the previous
 * request in the same lane that used the SAME model (so interleaved side
 * calls on a cheaper model don't pollute the main loop's diagnostics); the
 * first request on a new model is diffed against the lane's last request,
 * which reports `firstDivergentLayer: "model"`.
 */
export class PromptCacheTracker {
  private readonly lanes = new Map<
    string,
    { last?: LaneEntry; byModel: Map<string, LaneEntry> }
  >();

  observe(
    requestIndex: number,
    sessionKey: string,
    snapshot: PromptPrefixSnapshot,
  ): CacheDiagnostics {
    let lane = this.lanes.get(sessionKey);
    if (!lane) {
      lane = { byModel: new Map() };
      this.lanes.set(sessionKey, lane);
    }
    const modelKey = snapshot.model ?? "";
    const baseline = lane.byModel.get(modelKey) ?? lane.last ?? null;
    const diff = diffPromptPrefix(baseline?.snapshot ?? null, snapshot);
    const entry = { requestIndex, snapshot };
    lane.last = entry;
    lane.byModel.set(modelKey, entry);
    return {
      sessionKey,
      comparedToRequest: baseline?.requestIndex ?? null,
      ...diff,
    };
  }
}
