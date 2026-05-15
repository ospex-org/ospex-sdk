/**
 * URL redactor for `ospex doctor` config provenance.
 *
 * Threat model: doctor envelopes are shared. JSON output gets pasted
 * into chat / issue trackers, human output gets screen-shared, both
 * land in terminal scrollback. Any URL with an embedded credential
 * (Alchemy / Infura API keys in path or query, HTTP-basic userinfo,
 * named secret query params) must NOT appear in raw form.
 *
 * The redactor produces a `UrlField` — a structured replacement that
 * agents can switch on safely:
 *
 *   - `redactedValue` — safe to log / paste; secrets stripped.
 *   - `host` — bare hostname for grouping (Alchemy vs Infura, etc.).
 *   - `fingerprint` — `sha256(<raw URL>).slice(0,16)`. Lets agents
 *      detect "did the configured URL change?" without ever seeing
 *      it. Hash is one-way — even disclosing the fingerprint leaks
 *      no credential bits.
 *
 * Conservative by default: an already-safe URL produces a
 * `redactedValue` byte-identical to the input. The redaction
 * algorithm is described in spec §10:
 *
 *   1. Strip userinfo (`https://user:pass@host` → `https://[redacted]@host`).
 *   2. Replace a credential-shaped trailing path segment (≥ 20 chars of
 *      `[0-9a-zA-Z_-]`) with `[redacted]`. Catches Alchemy's `/v2/<key>`
 *      and Infura's `/v3/<project-id>` patterns.
 *   3. Redact query params whose names match `apikey|api_key|key|token|secret`
 *      (case-insensitive).
 *   4. `host = URL(raw).hostname`.
 *   5. `fingerprint = "sha256:" + sha256(raw).slice(0, 16)`.
 *
 * Public surface — every URL the doctor emits goes through this.
 */

import { createHash } from 'node:crypto';

export interface UrlField {
  /** Where the value came from. Set by callers based on the precedence ladder. */
  source: string;
  /** Safe-to-log URL with credentials masked. Stable for the same input. */
  redactedValue: string;
  /** Hostname only (`URL.hostname`). Empty string when the URL is malformed. */
  host: string;
  /** `sha256:<first16hex>` of the raw URL. Lets agents detect changes without seeing the value. */
  fingerprint: string;
}

/**
 * Field names whose VALUES are redacted in query strings. Matched
 * case-insensitively. Be generous — false positives (over-redacting
 * a non-secret param) are strictly better than leaks.
 */
const SECRET_QUERY_NAMES = new Set([
  'apikey',
  'api_key',
  'key',
  'token',
  'secret',
]);

const CREDENTIAL_PATH_SEGMENT = /^[0-9a-zA-Z_-]{20,}$/;
const REDACTED = '[redacted]';
// URL's `userinfo` and `query` components percent-encode the `[` and
// `]` characters. We want the final string to render as literal
// `[redacted]` for human + JSON output, so we plug a sentinel into
// the URL parser and swap it back to brackets after `toString()`.
// The sentinel must be ASCII-safe in URLs to avoid further encoding.
const REDACTION_SENTINEL = '__OSPEX_REDACTED__';
const REDACTION_SENTINEL_ENCODED = REDACTION_SENTINEL; // no encoding needed
const REDACTION_PATTERN = new RegExp(REDACTION_SENTINEL_ENCODED, 'g');

/**
 * Redact one URL. Never throws — a malformed input still produces a
 * `UrlField` (with `host: ''` and the sentinel `'[invalid url]'` as
 * `redactedValue`; the fingerprint is still computed from the raw
 * bytes so agents can detect URL changes between runs). The doctor's
 * threat surface is "leak via JSON output," not "crash on bad URL,"
 * and a malformed URL is more likely than not to contain something
 * sensitive — fail closed.
 */
export function redactUrl(raw: string, source: string): UrlField {
  const fingerprint = computeFingerprint(raw);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Malformed URL — we can't structurally parse out credentials,
    // and a passthrough would leak any secret-bearing substring
    // (e.g. `not-a-url?apikey=secret`). Fail closed: emit a sentinel
    // so the envelope and rendered output never contain the raw
    // value. Agents can detect the case via `host === ''` and use
    // `fingerprint` (computed from the raw input) to spot config
    // changes between runs. Hermes PR 54 blocker #2.
    return {
      source,
      redactedValue: '[invalid url]',
      host: '',
      fingerprint,
    };
  }

  // (1) Strip userinfo. Use the sentinel so the URL parser doesn't
  // percent-encode the brackets in `[redacted]`.
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = REDACTION_SENTINEL;
    parsed.password = '';
  }

  // (2) Mask credential-shaped trailing path segment. Path components
  // accept literal brackets — no sentinel dance needed here.
  parsed.pathname = redactCredentialPathSegment(parsed.pathname);

  // (3) Redact secret-named query params. Same sentinel trick — query
  // values are percent-encoded by the URL serialiser.
  const params = parsed.searchParams;
  for (const name of params.keys()) {
    if (SECRET_QUERY_NAMES.has(name.toLowerCase())) {
      params.set(name, REDACTION_SENTINEL);
    }
  }

  // Swap the sentinel back to the literal `[redacted]` so JSON
  // envelopes and human output show what users expect to see.
  const redactedValue = parsed.toString().replace(REDACTION_PATTERN, REDACTED);

  return {
    source,
    redactedValue,
    host: parsed.hostname,
    fingerprint,
  };
}

/**
 * Replace a credential-shaped last path segment with `[redacted]`.
 * Only the LAST segment is touched — earlier segments like `/v2/`
 * or `/projects/` are version markers, not secrets.
 *
 * Heuristic: ≥20 chars from `[0-9a-zA-Z_-]`. Catches Alchemy's hex
 * keys, Infura's UUIDs, and most service-issued opaque tokens
 * without over-redacting normal path segments like `health` or
 * `v1/config/public`.
 */
function redactCredentialPathSegment(pathname: string): string {
  if (pathname === '' || pathname === '/') return pathname;
  // Preserve trailing slash if present.
  const hasTrailingSlash = pathname.endsWith('/');
  const trimmed = hasTrailingSlash ? pathname.slice(0, -1) : pathname;
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return pathname;
  const lastSegment = trimmed.slice(lastSlash + 1);
  if (!CREDENTIAL_PATH_SEGMENT.test(lastSegment)) return pathname;
  const prefix = trimmed.slice(0, lastSlash + 1);
  return `${prefix}${REDACTED}${hasTrailingSlash ? '/' : ''}`;
}

function computeFingerprint(raw: string): string {
  const hex = createHash('sha256').update(raw, 'utf8').digest('hex');
  return `sha256:${hex.slice(0, 16)}`;
}

/**
 * Strip credential-bearing portions of `rawUrl` out of a free-form
 * error message before it lands in `checks[].details`. The probes
 * cannot control what viem / node:fetch put in `err.message` —
 * viem's `HttpRequestError`, for instance, includes the full request
 * URL in its message body. Without this sanitiser those URLs ride
 * through the doctor envelope and the human Checks section verbatim.
 *
 * Defense in depth:
 *   1. Exact substring replace of `rawUrl` with its redacted form —
 *      handles the common viem case `URL: <rawUrl>`.
 *   2. If the URL parses, also zap any credential-shaped path
 *      segment, named secret query value, and userinfo password —
 *      catches the cases where viem mangles the URL slightly
 *      (appended params, percent-encoding, etc.).
 *   3. If the URL doesn't parse, the substring replace is still
 *      applied. We rely on the malformed-URL caller having a
 *      sentinel-only `redactedValue` so the substitute is safe.
 *
 * Never throws — sanitisation is best-effort and failure here would
 * be worse than the leak this defends against (the caller still
 * returns a structured error result either way).
 */
export function sanitizeMessageForUrl(
  message: string,
  rawUrl: string | null | undefined,
): string {
  if (rawUrl === null || rawUrl === undefined || rawUrl === '') return message;
  let result = message;

  // (1) Exact substring match.
  const field = redactUrl(rawUrl, 'unset');
  if (result.includes(rawUrl)) {
    result = result.split(rawUrl).join(field.redactedValue);
  }

  // (2) Per-component scrub for partial URL fragments that viem may emit.
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/');
    for (const seg of segments) {
      if (seg.length === 0) continue;
      if (CREDENTIAL_PATH_SEGMENT.test(seg) && result.includes(seg)) {
        result = result.split(seg).join(REDACTED);
      }
    }
    for (const [name, value] of parsed.searchParams) {
      if (
        SECRET_QUERY_NAMES.has(name.toLowerCase()) &&
        value !== '' &&
        result.includes(value)
      ) {
        result = result.split(value).join(REDACTED);
      }
    }
    if (parsed.password !== '' && result.includes(parsed.password)) {
      result = result.split(parsed.password).join(REDACTED);
    }
  } catch {
    // Malformed URL — step (1) is all we can do safely.
  }

  return result;
}
