/**
 * Tests for `lib/redact.ts`. This is a credential-leak surface — the
 * threat is a real RPC URL ending up in JSON / human output / chat
 * logs after going through the doctor. Tests bias toward
 * over-asserting redaction (false positives are strictly better
 * than leaks).
 */

import { describe, expect, it } from 'vitest';
import {
  redactUrl,
  sanitizeMessageForUrl,
  sanitizeUntargetedMessage,
} from '../src/lib/redact.js';

describe('redactUrl — Alchemy-style URLs', () => {
  it('strips a hex API key from the trailing path segment', () => {
    const raw = 'https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789';
    const r = redactUrl(raw, 'env-OSPEX_RPC_URL');
    expect(r.redactedValue).toBe('https://polygon-mainnet.g.alchemy.com/v2/[redacted]');
    expect(r.host).toBe('polygon-mainnet.g.alchemy.com');
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.source).toBe('env-OSPEX_RPC_URL');
  });

  it('strips an Infura-style uuid trailing segment', () => {
    const raw = 'https://polygon-mainnet.infura.io/v3/abc123def456abc123def456abc123de';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toBe('https://polygon-mainnet.infura.io/v3/[redacted]');
  });

  it('preserves a known non-credential path like /v1/config/public', () => {
    const raw = 'https://api.ospex.org/v1/config/public';
    const r = redactUrl(raw, 'default');
    // `public` is only 6 chars — below the 20-char threshold.
    expect(r.redactedValue).toBe(raw);
  });

  it('leaves api.ospex.org alone (no credentials in path)', () => {
    const raw = 'https://api.ospex.org';
    const r = redactUrl(raw, 'default');
    expect(r.redactedValue).toBe('https://api.ospex.org/');
    // Trailing slash is URL parser-canonicalised — expected behavior.
  });
});

describe('redactUrl — userinfo', () => {
  it('strips HTTP-basic credentials in the authority', () => {
    const raw = 'https://user:pass@rpc.example.com/path';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toContain('[redacted]@rpc.example.com');
    expect(r.redactedValue).not.toContain('user:pass');
    expect(r.redactedValue).not.toContain('user');
    expect(r.redactedValue).not.toContain('pass');
  });

  it('strips username-only userinfo too', () => {
    const raw = 'https://token@rpc.example.com';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).not.toContain('token@');
    expect(r.redactedValue).toContain('[redacted]@rpc.example.com');
  });
});

describe('redactUrl — query params', () => {
  it('redacts apikey, api_key, key, token, secret (case-insensitive)', () => {
    for (const name of ['apikey', 'api_key', 'API_KEY', 'key', 'Key', 'token', 'TOKEN', 'secret']) {
      const raw = `https://rpc.example.com/?${name}=supersecretvaluestring`;
      const r = redactUrl(raw, 'env-OSPEX_RPC_URL');
      expect(r.redactedValue, `${name} should be redacted`).not.toContain('supersecretvaluestring');
      expect(r.redactedValue).toContain('[redacted]');
    }
  });

  it('preserves non-secret query params verbatim', () => {
    const raw = 'https://api.example.com/?page=1&limit=50';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toContain('page=1');
    expect(r.redactedValue).toContain('limit=50');
  });

  it('redacts secret param while preserving other params side-by-side', () => {
    const raw = 'https://rpc.example.com/?network=polygon&apikey=abc123';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toContain('network=polygon');
    expect(r.redactedValue).toContain('apikey=[redacted]');
    expect(r.redactedValue).not.toContain('abc123');
  });
});

describe('redactUrl — combined credentials', () => {
  it('strips userinfo, path key, AND query secret together', () => {
    const raw = 'https://user:pw@rpc.example.com/v2/abc123def456abc123def456abc?token=xyz789xyz789';
    const r = redactUrl(raw, 'env-OSPEX_RPC_URL');
    expect(r.redactedValue).not.toContain('user:pw');
    expect(r.redactedValue).not.toContain('abc123def456abc123def456abc');
    expect(r.redactedValue).not.toContain('xyz789xyz789');
    expect(r.host).toBe('rpc.example.com');
  });
});

describe('redactUrl — fingerprint', () => {
  it('is deterministic — same URL produces same fingerprint across runs', () => {
    const raw = 'https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789';
    expect(redactUrl(raw, 'a').fingerprint).toBe(redactUrl(raw, 'b').fingerprint);
  });

  it('is sensitive to the URL — different URLs produce different fingerprints', () => {
    const a = redactUrl('https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789', 'env');
    const b = redactUrl('https://polygon-mainnet.g.alchemy.com/v2/000000000000000000000000000000000', 'env');
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('encodes as `sha256:<first16hex>`', () => {
    const r = redactUrl('https://api.example.com', 'default');
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.fingerprint.length).toBe('sha256:'.length + 16);
  });
});

describe('redactUrl — malformed input fails closed', () => {
  // Hermes PR 54 blocker #2: a malformed URL with secret-bearing
  // substrings (`not-a-url?apikey=secret`) used to pass through as
  // `redactedValue` and leak the secret into shared envelopes. The
  // redactor now substitutes a sentinel instead — the raw value
  // never reaches output.
  it('returns sentinel `[invalid url]` for an unparseable URL', () => {
    const r = redactUrl('not-a-url', 'flag');
    expect(r.host).toBe('');
    expect(r.redactedValue).toBe('[invalid url]');
    expect(r.fingerprint).toMatch(/^sha256:/);
  });

  it('does not leak secret-bearing substrings of a malformed URL', () => {
    const raw = 'not-a-url?apikey=secretvalue1234567890';
    const r = redactUrl(raw, 'env-OSPEX_RPC_URL');
    expect(r.redactedValue).toBe('[invalid url]');
    expect(r.redactedValue).not.toContain('secretvalue1234567890');
    expect(r.host).toBe('');
    // Fingerprint is still computable from the raw bytes — agents can
    // detect "the configured URL changed" without ever seeing it.
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('handles empty string without throwing — sentinel still applies', () => {
    const r = redactUrl('', 'unset');
    expect(r.host).toBe('');
    expect(r.redactedValue).toBe('[invalid url]');
  });
});

describe('redactUrl — does not over-redact safe URLs', () => {
  it('a short path segment under the threshold is left alone', () => {
    // 19 chars — one less than the 20-char threshold.
    const raw = 'https://rpc.example.com/v2/abcdefghijklmnopqrs';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toBe(raw);
  });

  it('a 20-char path segment IS redacted (threshold boundary)', () => {
    const raw = 'https://rpc.example.com/v2/abcdefghijklmnopqrst';
    const r = redactUrl(raw, 'config');
    expect(r.redactedValue).toBe('https://rpc.example.com/v2/[redacted]');
  });

  it('only the LAST path segment is touched — earlier segments preserved', () => {
    // Earlier segment is also ≥20 chars but it's not the tail.
    const raw = 'https://rpc.example.com/abcdefghijklmnopqrstu/v2';
    const r = redactUrl(raw, 'config');
    // /v2 is only 2 chars — below threshold; earlier segment preserved.
    expect(r.redactedValue).toContain('/abcdefghijklmnopqrstu/');
    expect(r.redactedValue).toContain('/v2');
  });
});

// Hermes PR 54 blocker #1. Probe error messages (especially viem's
// HttpRequestError) include the raw URL verbatim. Without
// sanitisation the URL — and any embedded credential — propagates
// into checks[].details and the human Checks section. The sanitiser
// scrubs the URL out before the error message lands in the envelope.
describe('sanitizeMessageForUrl', () => {
  it('replaces an exact URL match with its redacted form', () => {
    const raw = 'https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789';
    const message = `HTTP request failed.\n\nURL: ${raw}\n\nDetails: connect ECONNREFUSED`;
    const sanitized = sanitizeMessageForUrl(message, raw);
    expect(sanitized).not.toContain('abcdef0123456789abcdef0123456789');
    expect(sanitized).toContain('/v2/[redacted]');
    expect(sanitized).toContain('connect ECONNREFUSED'); // useful context preserved
  });

  it('scrubs the credential-shaped path segment even when the URL appears mangled', () => {
    // Simulates a downstream library appending extra params or
    // re-encoding the URL such that exact-substring match misses.
    const raw = 'https://rpc.example.com/v2/secrethexkey0123456789abcdef';
    const message = 'Request to /v2/secrethexkey0123456789abcdef returned 401 (no exact URL)';
    const sanitized = sanitizeMessageForUrl(message, raw);
    expect(sanitized).not.toContain('secrethexkey0123456789abcdef');
    expect(sanitized).toContain('[redacted]');
  });

  it('scrubs secret query values referenced by name', () => {
    const raw = 'https://rpc.example.com/?apikey=secretvalue1234567890';
    const message = 'request failed: apikey=secretvalue1234567890 was rejected';
    const sanitized = sanitizeMessageForUrl(message, raw);
    expect(sanitized).not.toContain('secretvalue1234567890');
  });

  it('scrubs HTTP-basic password when it appears in the message', () => {
    const raw = 'https://user:supersecretpw@rpc.example.com';
    const message = 'auth header had user:supersecretpw — rejected';
    const sanitized = sanitizeMessageForUrl(message, raw);
    expect(sanitized).not.toContain('supersecretpw');
  });

  it('returns the message verbatim when rawUrl is null/undefined/empty', () => {
    const message = 'an error without an associated URL';
    expect(sanitizeMessageForUrl(message, null)).toBe(message);
    expect(sanitizeMessageForUrl(message, undefined)).toBe(message);
    expect(sanitizeMessageForUrl(message, '')).toBe(message);
  });

  it('handles a malformed rawUrl without throwing (substring path only)', () => {
    const raw = 'not-a-url?apikey=secretvalue1234567890';
    const message = `failed to dial ${raw}`;
    const sanitized = sanitizeMessageForUrl(message, raw);
    // Exact-substring step still fires — `[invalid url]` is the
    // safer substitute for the raw input.
    expect(sanitized).not.toContain('secretvalue1234567890');
    expect(sanitized).toContain('[invalid url]');
  });

  it('Hermes PR 54 blocker #1 repro — viem-style HttpRequestError', () => {
    // Mirrors the smoke output Hermes posted: an Alchemy key
    // appearing verbatim in the error message because viem's
    // HttpRequestError adds `URL: <raw>` to its message body.
    const raw = 'http://127.0.0.1:9/v2/supersecretkey0123456789abcdef';
    const message =
      'HTTP request failed.\n\nURL: ' +
      raw +
      '\nRequest body: {"method":"eth_chainId","params":[]}\n\nDetails: connect ECONNREFUSED 127.0.0.1:9\nVersion: viem@2.x';
    const sanitized = sanitizeMessageForUrl(message, raw);
    expect(sanitized).not.toContain('supersecretkey0123456789abcdef');
  });
});

describe('sanitizeUntargetedMessage — used by the JSON envelope cause-chain', () => {
  it('redacts an Alchemy-shaped URL embedded in prose', () => {
    const msg =
      'HTTP request failed.\nURL: https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789';
    const out = sanitizeUntargetedMessage(msg);
    expect(out).not.toContain('abcdef0123456789abcdef0123456789');
    expect(out).toContain('[redacted]');
    // Surrounding text is preserved.
    expect(out).toContain('HTTP request failed.');
    expect(out).toContain('URL:');
  });

  it('handles multiple URLs in the same message', () => {
    const msg =
      'two: https://polygon-mainnet.g.alchemy.com/v2/keyaaaaaaaaaaaaaaaaaaaaaa ' +
      'and https://polygon-mainnet.infura.io/v3/keybbbbbbbbbbbbbbbbbbbbbb';
    const out = sanitizeUntargetedMessage(msg);
    expect(out).not.toContain('keyaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).not.toContain('keybbbbbbbbbbbbbbbbbbbbbb');
  });

  it('redacts query-string credentials (apikey=, token=, etc.)', () => {
    const out = sanitizeUntargetedMessage('GET https://api.example.com/rpc?apikey=topsecretvalue123');
    expect(out).not.toContain('topsecretvalue123');
    expect(out).toContain('[redacted]');
  });

  it('redacts api_key / authorization / bearer / token / password / passphrase pairs', () => {
    const cases = [
      'authorization: Bearer abcd1234',
      'Authorization=Bearer xyz9999',
      'api_key=topsecret',
      'apikey:topsecret',
      'token = abcdefgh',
      'password: hunter2',
      'passphrase=letmein',
    ];
    for (const c of cases) {
      const out = sanitizeUntargetedMessage(c);
      expect(out).not.toMatch(/abcd1234|xyz9999|topsecret|abcdefgh|hunter2|letmein/);
      expect(out).toContain('[redacted]');
    }
  });

  it('redacts postgres / postgresql connection URLs wholesale', () => {
    const out = sanitizeUntargetedMessage(
      'connect failed: postgres://user:pass@db.example.com:5432/mydb?sslmode=require',
    );
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('db.example.com');
    expect(out).toContain('[redacted]');
  });

  it('preserves trailing punctuation (period, comma) outside the URL', () => {
    const out = sanitizeUntargetedMessage(
      'Error from https://api.example.com/v1/health, retry suggested.',
    );
    // Punctuation outside the URL stays.
    expect(out).toContain(', retry suggested.');
  });

  it('is idempotent on an already-clean message', () => {
    const clean = 'NONCE_TOO_LOW: nonce 5 already used';
    expect(sanitizeUntargetedMessage(clean)).toBe(clean);
  });
});
