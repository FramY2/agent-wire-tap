import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { redactHeaders, redactUrl } from "./redact.js";
import {
  detectProvider,
  JsonUsageCollector,
  SseUsageParser,
  UsageAccumulator,
  type UpstreamUsage,
  type UsageSink,
} from "./usage.js";

export const DEFAULT_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
export const DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com";

/**
 * Live pass-through configuration. With no fields set, `/v1/messages` is
 * auto-routed to `https://api.anthropic.com` and `/v1/responses` +
 * `/v1/chat/completions` (and everything else) to `https://api.openai.com`.
 */
export interface PassthroughOptions {
  /** Single fixed upstream base URL for ALL requests (overrides auto-routing). */
  upstream?: string;
  anthropicUpstream?: string;
  openaiUpstream?: string;
}

/** Per-exchange upstream metadata recorded on each captured request (secrets redacted). */
export interface UpstreamExchange {
  url: string;
  status: number | null;
  durationMs: number | null;
  streamed: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  usage: UpstreamUsage | null;
  error?: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Validates an `http(s)://` upstream base URL and strips trailing slashes. */
export function normalizeUpstreamUrl(value: string, flag = "upstream"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${flag} must be an absolute http(s) URL, got "${redactUrl(value)}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${flag} must use http:// or https://, got "${parsed.protocol}".`);
  }
  return value.replace(/\/+$/, "");
}

/** Resolves the upstream URL for an incoming request path (+query). */
export function resolveUpstreamUrl(reqUrl: string, options: PassthroughOptions = {}): URL {
  const base =
    options.upstream ??
    (detectProvider(reqUrl) === "anthropic"
      ? (options.anthropicUpstream ?? DEFAULT_ANTHROPIC_UPSTREAM)
      : (options.openaiUpstream ?? DEFAULT_OPENAI_UPSTREAM));
  const baseUrl = new URL(base);
  const incoming = new URL(reqUrl, "http://wire-tap.local");
  let basePath = baseUrl.pathname.replace(/\/+$/, "");
  // Tolerate `--openai-upstream https://api.openai.com/v1` + client path `/v1/...`.
  if (basePath.endsWith("/v1") && /^\/v1(\/|$)/.test(incoming.pathname)) {
    basePath = basePath.slice(0, -3);
  }
  const target = new URL(baseUrl.origin);
  target.pathname = `${basePath}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return new Set(
    value
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const extra = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || extra.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function createDecoder(encoding: string | string[] | undefined): Transform | null {
  const value = (Array.isArray(encoding) ? encoding.join(",") : (encoding ?? ""))
    .trim()
    .toLowerCase();
  if (value === "gzip" || value === "x-gzip") return createGunzip();
  if (value === "deflate") return createInflate();
  if (value === "br") return createBrotliDecompress();
  return null;
}

export interface UpstreamAgents {
  http: HttpAgent;
  https: HttpsAgent;
  destroy: () => void;
}

export function createUpstreamAgents(): UpstreamAgents {
  const http = new HttpAgent({ keepAlive: true });
  const https = new HttpsAgent({ keepAlive: true });
  return {
    http,
    https,
    destroy: () => {
      http.destroy();
      https.destroy();
    },
  };
}

/**
 * Forwards one buffered client request to `target` and streams the upstream
 * response (JSON or SSE, any content-encoding) back to the client chunk by
 * chunk, while a side-channel parser extracts real token/cache usage.
 * Credentials are forwarded to the upstream untouched but only ever
 * RECORDED in redacted form. Resolves once the exchange has fully finished.
 */
export function forwardToUpstream(params: {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  target: URL;
  agents?: UpstreamAgents;
}): Promise<Omit<UpstreamExchange, "url" | "requestHeaders">> {
  const { req, res, body, target, agents } = params;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const isHttps = target.protocol === "https:";
  const headers = forwardableHeaders(req.headers);
  headers.host = target.host;
  if (body.length > 0 || !["GET", "HEAD"].includes(req.method ?? "GET")) {
    headers["content-length"] = String(body.length);
  }
  req.socket.setNoDelay(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Omit<UpstreamExchange, "url" | "requestHeaders">) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const upstreamOptions = {
      method: req.method ?? "POST",
      headers,
      ...(agents ? { agent: isHttps ? agents.https : agents.http } : {}),
    };
    const onResponse = (upRes: IncomingMessage) => {
      const status = upRes.statusCode ?? 502;
      const responseHeaders = forwardableHeaders(upRes.headers);
      // Keep upstream content-length: we forward the exact upstream bytes.
      if (upRes.headers["content-length"] !== undefined) {
        responseHeaders["content-length"] = upRes.headers["content-length"];
      }
      res.writeHead(status, upRes.statusMessage, responseHeaders);
      res.flushHeaders();

      const contentType = String(upRes.headers["content-type"] ?? "").toLowerCase();
      const streamed = contentType.includes("text/event-stream");
      const acc = new UsageAccumulator(detectProvider(target.pathname));
      const sink: UsageSink = streamed ? new SseUsageParser(acc) : new JsonUsageCollector(acc);
      const decoder = createDecoder(upRes.headers["content-encoding"]);
      let decoderFailed = false;
      const decoderDone = new Promise<void>((done) => {
        if (!decoder) return done();
        decoder.on("data", (chunk: Buffer) => sink.push(chunk));
        decoder.once("end", () => done());
        decoder.once("close", () => done());
        decoder.once("error", () => {
          decoderFailed = true;
          done();
        });
      });

      const result = (error?: string) => ({
        status,
        durationMs: elapsed(),
        streamed,
        responseHeaders: redactHeaders(upRes.headers),
        usage: acc.toUsage(),
        ...(error ? { error } : {}),
      });

      upRes.on("data", (chunk: Buffer) => {
        if (!res.write(chunk)) {
          upRes.pause();
          res.once("drain", () => upRes.resume());
        }
        if (decoder) {
          if (!decoderFailed) decoder.write(chunk);
        } else {
          sink.push(chunk);
        }
      });
      upRes.once("end", () => {
        res.end();
        if (decoder && !decoderFailed) decoder.end();
        void decoderDone.then(() => {
          sink.end();
          finish(result());
        });
      });
      upRes.once("error", (err: Error) => {
        res.destroy(err);
        finish(result(`upstream response error: ${err.message}`));
      });
      upRes.once("aborted", () => {
        res.destroy();
        finish(result("upstream response aborted"));
      });
    };

    const upReq = isHttps
      ? httpsRequest(target, upstreamOptions, onResponse)
      : httpRequest(target, upstreamOptions, onResponse);

    upReq.on("error", (err: Error) => {
      const message = `agent-wire-tap could not reach upstream ${redactUrl(target.origin + target.pathname)}: ${err.message}`;
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "wire_tap_upstream_error", message },
          }),
        );
      } else {
        res.destroy(err);
      }
      finish({
        status: res.headersSent && res.statusCode !== 502 ? res.statusCode : 502,
        durationMs: elapsed(),
        streamed: false,
        responseHeaders: {},
        usage: null,
        error: message,
      });
    });

    // Client went away mid-flight: stop the upstream call too.
    res.once("close", () => {
      if (!res.writableFinished) upReq.destroy(new Error("client disconnected"));
    });

    upReq.end(body);
  });
}
