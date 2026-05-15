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
 * `UrlField` (with `host: ''` and the raw string passed through
 * untouched as `redactedValue`). The doctor's threat surface is
 * "leak via JSON output," not "crash on bad URL."
 */
export function redactUrl(raw: string, source: string): UrlField {
  const fingerprint = computeFingerprint(raw);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Malformed URL — there's nothing to parse, but there's also
    // nothing safe to assume about it. Pass through verbatim;
    // the fingerprint still works.
    return {
      source,
      redactedValue: raw,
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
