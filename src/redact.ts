import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/** Placeholder written instead of any credential-bearing value. */
export const REDACTED = "[REDACTED]";

/**
 * Headers whose values are ALWAYS replaced with `[REDACTED]` before they are
 * written to trace files, stdout, or JSON reports.
 */
const ALWAYS_REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "x-amz-security-token",
]);

/** Defense-in-depth: any other header whose NAME looks credential-like. */
const SENSITIVE_HEADER_NAME = /(api[-_]?key|secret|token|passw(or)?d|credential|auth)/i;

/** Query-string parameter names whose values must never be persisted. */
const SENSITIVE_QUERY_PARAM =
  /(^|[-_])(key|api[-_]?key|token|access[-_]?token|secret|signature|sig|password|auth)$/i;

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_REDACTED_HEADERS.has(lower) || SENSITIVE_HEADER_NAME.test(lower);
}

/**
 * Returns a lowercase-keyed copy of `headers` that is safe to persist:
 * credential headers (`Authorization`, `x-api-key`, `Proxy-Authorization`,
 * `Cookie`, `Set-Cookie`, ...) are replaced by `[REDACTED]`.
 */
export function redactHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders | Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const name = rawName.toLowerCase();
    if (isSensitiveHeader(name)) {
      out[name] = REDACTED;
      continue;
    }
    out[name] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  return out;
}

/**
 * Strips `user:password@` credentials and redacts credential-like query
 * parameters (`?key=`, `?api_key=`, `?token=`, ...) from absolute or
 * path-relative URLs.
 */
export function redactUrl(url: string): string {
  let result = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i, `$1${REDACTED}@`);
  const queryStart = result.indexOf("?");
  if (queryStart === -1) return result;
  const hashStart = result.indexOf("#", queryStart);
  const query = result.slice(
    queryStart + 1,
    hashStart === -1 ? undefined : hashStart,
  );
  const redactedQuery = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep raw name
      }
      return SENSITIVE_QUERY_PARAM.test(name)
        ? `${pair.slice(0, eq)}=${REDACTED}`
        : pair;
    })
    .join("&");
  result = `${result.slice(0, queryStart + 1)}${redactedQuery}${
    hashStart === -1 ? "" : result.slice(hashStart)
  }`;
  return result;
}
