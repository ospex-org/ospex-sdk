/**
 * Unit tests for the v1 → v2 envelope transform that `ospex auth check
 * --json` runs before writing to stdout. The original `buildEnvelope`
 * still returns the v1-shaped `AuthCheckJsonEnvelope` (heavily tested
 * in `auth-check.test.ts`); these tests pin the transform itself —
 * which fields hoist, which stay in payload, how warnings get codes,
 * and how walletRole flips with `--sign-challenge`.
 */

import { describe, expect, it } from 'vitest';
import {
  liftAuthCheckWarnings,
  toAgentEnvelope,
  type AuthCheckJsonEnvelope,
} from '../src/commands/auth/check.js';

const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as const;

function baseV1Envelope(
  overrides: Partial<AuthCheckJsonEnvelope> = {},
): AuthCheckJsonEnvelope {
  return {
    schemaVersion: 1,
    ok: true,
    strict: false,
    resolution: {
      keystore: {
        provenance: 'flag-account',
        path: '/tmp/keystore.json',
        account: 'maker-a',
        exists: true,
      },
      password: {
        provenance: 'flag-password-file',
        path: '/tmp/pw',
        exists: true,
      },
      expectedAddress: { provenance: 'flag', value: TEST_ADDRESS },
      foundryKeystoresDir: { provenance: 'flag', value: '/tmp/keystores' },
    },
    unlock: {
      attempted: true,
      succeeded: true,
      address: TEST_ADDRESS,
      skippedReason: null,
    },
    passwordFilePermissions: {
      checked: true,
      platformSkipped: false,
      mode: 0o600,
      octal: '600',
      loose: false,
    },
    challenge: { requested: false, signed: false, signature: null },
    warnings: [],
    errors: [],
    ...overrides,
  };
}

describe('toAgentEnvelope (auth check v1 → v2)', () => {
  it('hoists ok / warnings / errors to the outer envelope', () => {
    const v1 = baseV1Envelope({
      ok: false,
      warnings: ['Password file /tmp/pw is readable by group/other (mode 0644).'],
      errors: [{ code: 'decryption_failed', message: 'wrong passphrase' }],
    });
    const v2 = toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: false });
    expect(v2.schemaVersion).toBe(2);
    expect(v2.ok).toBe(false);
    expect(v2.action).toBe('auth.check');
    expect(v2.stage).toBe('read');
    expect(v2.errors).toEqual([
      { code: 'decryption_failed', message: 'wrong passphrase' },
    ]);
    expect(v2.warnings).toEqual([
      {
        code: 'password-file-permissions-loose',
        message: 'Password file /tmp/pw is readable by group/other (mode 0644).',
        severity: 'warning',
      },
    ]);
  });

  it('moves resolution / unlock / passwordFilePermissions / challenge into payload', () => {
    const v1 = baseV1Envelope();
    const v2 = toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: false });
    expect(v2.payload.strict).toBe(false);
    expect(v2.payload.resolution).toEqual(v1.resolution);
    expect(v2.payload.unlock).toEqual(v1.unlock);
    expect(v2.payload.passwordFilePermissions).toEqual(v1.passwordFilePermissions);
    expect(v2.payload.challenge).toEqual(v1.challenge);
    // Outer envelope MUST NOT carry the inner schemaVersion: 1.
    expect((v2.payload as { schemaVersion?: unknown }).schemaVersion).toBeUndefined();
  });

  it('derives network from chainId', () => {
    expect(
      toAgentEnvelope(baseV1Envelope(), { chainId: 137, signChallengeRequested: false }).network,
    ).toBe('polygon');
    expect(
      toAgentEnvelope(baseV1Envelope(), { chainId: 80002, signChallengeRequested: false }).network,
    ).toBe('amoy');
  });

  it('walletRole flips to "signer" when --sign-challenge is requested', () => {
    const v1 = baseV1Envelope();
    expect(
      toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: false }).walletRole,
    ).toBe('subject');
    expect(
      toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: true }).walletRole,
    ).toBe('signer');
  });

  it('emits walletRole: "none" when no address was resolved', () => {
    const v1 = baseV1Envelope({
      unlock: { attempted: false, succeeded: null, address: null, skippedReason: null },
    });
    const v2 = toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: false });
    expect(v2.wallet).toBeNull();
    expect(v2.walletRole).toBe('none');
    expect(v2.signer).toBeNull();
  });

  it('populates wallet + signer with the unlocked address', () => {
    const v1 = baseV1Envelope();
    const v2 = toAgentEnvelope(v1, { chainId: 137, signChallengeRequested: false });
    expect(v2.wallet).toBe(TEST_ADDRESS);
    expect(v2.signer).toBe(TEST_ADDRESS);
  });
});

describe('liftAuthCheckWarnings', () => {
  it('maps loose-perms messages to `password-file-permissions-loose`', () => {
    const out = liftAuthCheckWarnings([
      'Password file /tmp/pw is readable by group/other (mode 0644). Tighten with `chmod 600`.',
    ]);
    expect(out).toEqual([
      {
        code: 'password-file-permissions-loose',
        message: expect.stringContaining('readable by group/other'),
        severity: 'warning',
      },
    ]);
  });

  it('defaults unknown messages to `auth-check-warning`', () => {
    const out = liftAuthCheckWarnings(['something unfamiliar happened']);
    expect(out).toEqual([
      {
        code: 'auth-check-warning',
        message: 'something unfamiliar happened',
        severity: 'warning',
      },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(liftAuthCheckWarnings([])).toEqual([]);
  });
});
