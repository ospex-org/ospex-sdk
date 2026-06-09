/**
 * Tests for the `ospex own-state *` command tree + the redaction contract
 * that makes its output safe to capture into a PUBLIC artifact.
 *
 * The command tree composes without a live API (we don't run the streaming
 * action here — that needs a signer + the owner-auth SSE backend). The
 * redaction tests are the load-bearing ones: they assert, adversarially,
 * that the EIP-712 `signature` and the `signedPayload` struct NEVER appear
 * in the default (redacted) projection — a concrete leak check, not a
 * cooperating-fake check (per the "doc claims need adversarial tests"
 * lesson).
 */
import { describe, expect, it } from 'vitest';
import { makeOwnStateCommand } from '../src/commands/own-state/index.js';
import {
  formatWatchLine,
  projectCommitment,
  redactOwnerCommitment,
  type WatchLine,
} from '../src/commands/own-state/watch.js';
import type { OwnerCommitment } from '@ospex/sdk';

// Synthetic 65-byte signature (130 hex chars) — generated here, never a
// real key. The redaction tests assert this exact string is unreachable.
const FAKE_SIG = `0x${'ab'.repeat(65)}` as const;
const HASH = `0x${'11'.repeat(32)}`;

function makeOwnerCommitment(overrides: Partial<OwnerCommitment> = {}): OwnerCommitment {
  const base = {
    ownerAuthorized: true,
    visibility: 'hidden',
    redacted: false,
    commitmentHash: HASH,
    maker: `0x${'cd'.repeat(20)}`,
    contestId: '42',
    scorer: `0x${'ef'.repeat(20)}`,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '5000000',
    filledRiskAmount: '1000000',
    remainingRiskAmount: '4000000',
    nonce: '1717000000',
    expiry: '2026-06-10T00:00:00.000Z',
    speculationKey: `0x${'12'.repeat(32)}`,
    signature: FAKE_SIG,
    status: 'partiallyFilled',
    storedStatus: 'partially_filled',
    source: 'indexer',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-06-09T00:00:00.000Z',
    speculationId: '7',
    sport: 'basketball_nba',
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Boston Celtics',
    updatedAtUnixSec: 1717000000,
    signedPayload: {
      commitmentHash: HASH,
      commitment: {
        maker: `0x${'cd'.repeat(20)}`,
        nonce: '1717000000',
        riskAmount: '5000000',
        // remaining struct fields are inert without the signature; a partial
        // struct is sufficient for the leak assertions below.
      },
      signature: FAKE_SIG,
    },
  };
  return { ...base, ...overrides } as unknown as OwnerCommitment;
}

describe('ospex own-state command tree', () => {
  it('registers the `watch` subcommand', () => {
    const root = makeOwnStateCommand();
    const names = root.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['watch']);
  });

  it('watch exposes the documented flags', () => {
    const root = makeOwnStateCommand();
    const watch = root.commands.find((c) => c.name() === 'watch');
    expect(watch).toBeDefined();
    if (watch === undefined) return;
    const help = watch.helpInformation();
    expect(help).toMatch(/--json/);
    expect(help).toMatch(/--address/);
    expect(help).toMatch(/--include-signed/);
    expect(help).toMatch(/--until-ready/);
    expect(help).toMatch(/--duration/);
    expect(help).toMatch(/--max-events/);
    // Signer flag group is installed (owner-auth needs a signer).
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--expected-address/);
  });
});

describe('own-state watch — redaction contract (default output is artifact-safe)', () => {
  it('drops `signature` and `signedPayload`, adds the redaction markers', () => {
    const redacted = redactOwnerCommitment(makeOwnerCommitment());
    expect('signature' in redacted).toBe(false);
    expect('signedPayload' in redacted).toBe(false);
    // The API-layer `redacted:false` marker is stripped (it would imply the
    // OUTPUT is unredacted, which is false once we strip the signature).
    expect('redacted' in redacted).toBe(false);
    expect(redacted.signatureRedacted).toBe(true);
    expect(redacted.signedPayloadPresent).toBe(true);
  });

  it('the signature string is unreachable anywhere in the serialized output', () => {
    const redacted = redactOwnerCommitment(makeOwnerCommitment());
    // Adversarial: the exact 130-hex signature must not survive ANYWHERE,
    // including nested inside a leftover struct.
    expect(JSON.stringify(redacted)).not.toContain(FAKE_SIG);
    expect(JSON.stringify(redacted)).not.toContain('ab'.repeat(65));
  });

  it('preserves every economic / lifecycle / identity field', () => {
    const redacted = redactOwnerCommitment(makeOwnerCommitment());
    expect(redacted.commitmentHash).toBe(HASH);
    expect(redacted.visibility).toBe('hidden');
    expect(redacted.riskAmount).toBe('5000000');
    expect(redacted.filledRiskAmount).toBe('1000000');
    expect(redacted.remainingRiskAmount).toBe('4000000');
    expect(redacted.nonce).toBe('1717000000');
    expect(redacted.status).toBe('partiallyFilled');
    expect(redacted.isLive).toBe(true);
    expect(redacted.awayTeam).toBe('Los Angeles Lakers');
    expect(redacted.homeTeam).toBe('Boston Celtics');
  });

  it('signedPayloadPresent is false when the owner row carries no signature', () => {
    const redacted = redactOwnerCommitment(
      makeOwnerCommitment({ signature: null, signedPayload: null }),
    );
    expect(redacted.signedPayloadPresent).toBe(false);
  });

  it('projectCommitment with includeSigned=true returns the raw payload', () => {
    const raw = projectCommitment(makeOwnerCommitment(), true) as OwnerCommitment;
    expect(raw.signature).toBe(FAKE_SIG);
    expect(raw.signedPayload).not.toBeNull();
  });

  it('projectCommitment with includeSigned=false redacts', () => {
    const out = projectCommitment(makeOwnerCommitment(), false);
    expect('signature' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain(FAKE_SIG);
  });
});

describe('own-state watch — human line formatting', () => {
  it('formats a ready line as the safe-to-trade boundary', () => {
    const line: WatchLine = {
      kind: 'ready',
      at: '2026-06-09T00:00:00.000Z',
      address: `0x${'cd'.repeat(20)}`,
      cursor: 'abc123',
    };
    expect(formatWatchLine(line)).toMatch(/\[READY\]/);
    expect(formatWatchLine(line)).toMatch(/safe to trade/);
  });

  it('a commitment line never prints the signature', () => {
    const line: WatchLine = {
      kind: 'commitment',
      at: '2026-06-09T00:00:00.000Z',
      address: `0x${'cd'.repeat(20)}`,
      cursor: 'abc123',
      commitment: redactOwnerCommitment(makeOwnerCommitment()),
    };
    const text = formatWatchLine(line);
    expect(text).toMatch(/\[CMT\]/);
    expect(text).not.toContain(FAKE_SIG);
    expect(text).toContain('vis=hidden');
  });
});
