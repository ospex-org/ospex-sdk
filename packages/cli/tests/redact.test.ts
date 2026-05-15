/**
 * Tests for `lib/redact.ts`. This is a credential-leak surface — the
 * threat is a real RPC URL ending up in JSON / human output / chat
 * logs after going through the doctor. Tests bias toward
 * over-asserting redaction (false positives are strictly better
 * than leaks).
 */

import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/lib/redact.js';

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

describe('redactUrl — malformed input never throws', () => {
  it('returns a UrlField with host="" for an unparseable URL', () => {
    const r = redactUrl('not-a-url', 'flag');
    expect(r.host).toBe('');
    expect(r.redactedValue).toBe('not-a-url');
    expect(r.fingerprint).toMatch(/^sha256:/);
  });

  it('handles empty string without throwing', () => {
    const r = redactUrl('', 'unset');
    expect(r.host).toBe('');
    expect(r.redactedValue).toBe('');
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
