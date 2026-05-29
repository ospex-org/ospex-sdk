/**
 * M5/PR1 — SDK type split for public commitments. Covers the public
 * {@link Commitment} discriminated union, the `toCommitment` decoder branching
 * on the M2 `redacted` discriminant, the {@link requireVisibleCommitment}
 * narrow helper, and the call-site refusals that depend on it
 * (`prepareMatch`, `checkCommitmentFillability`).
 *
 * The hidden-row wire shape mirrors `CommitmentHiddenBody` in
 * `ospex-core-api/src/v1/commitments.ts` and the PUBLIC_HIDDEN_ALLOWLIST
 * locked in own-state-sse-plan.md §2.3 — these tests assert the SDK accepts
 * exactly what the server emits and projects it to the public type with the
 * allow-list intact.
 */

import { describe, expect, it } from 'vitest';
import { toCommitment } from '../src/api/commitments.js';
import { requireVisibleCommitment } from '../src/commitments/requireVisible.js';
import {
  isHiddenCommitment,
  isVisibleCommitment,
} from '../src/types/commitment.js';
import { OspexValidationError } from '../src/errors.js';
import { checkCommitmentFillability } from '../src/commitments/checkFillability.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type {
  CommitmentBody,
  CommitmentHiddenBody,
} from '../src/api/types.js';
import type {
  Commitment,
  PublicHiddenCommitment,
  PublicVisibleCommitment,
} from '../src/types/commitment.js';
import type { Hex } from '../src/types/signer.js';

const HASH = ('0x' + 'aa'.repeat(32)) as Hex;
const MAKER = ('0x' + 'bb'.repeat(20)) as Hex;

function makeVisibleBody(overrides: Partial<CommitmentBody> = {}): CommitmentBody {
  return {
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: '0x' + 'cc'.repeat(20),
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: '0x' + 'dd'.repeat(32),
    signature: '0x' + 'ee'.repeat(65),
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

function makeHiddenBody(overrides: Partial<CommitmentHiddenBody> = {}): CommitmentHiddenBody {
  return {
    redacted: true,
    payloadAvailable: false,
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    positionType: 0,
    status: 'cancelled',
    storedStatus: 'open',
    filledRiskAmount: '0',
    expiry: '2099-01-01T00:00:00.000Z',
    bookVisible: false,
    nonceInvalidated: false,
    ...overrides,
  };
}

// ─── Decoder branching ───────────────────────────────────────────────────

describe('toCommitment — discriminant branching', () => {
  it('decodes a legacy wire body (no `redacted` flag) as PublicVisibleCommitment', () => {
    // M2 of the migration stack is what introduced the `redacted` discriminant.
    // The SDK must remain compatible with pre-M2 core-api deploys — those omit
    // the flag entirely and only ever served visible-shape bodies.
    const c = toCommitment(makeVisibleBody());
    expect(c.visibility).toBe('visible');
    expect(c.redacted).toBe(false);
    expect(isVisibleCommitment(c)).toBe(true);
    expect(isHiddenCommitment(c)).toBe(false);
  });

  it('decodes redacted:false as PublicVisibleCommitment with the matchable payload', () => {
    const c = toCommitment(makeVisibleBody({ redacted: false, bookVisible: true }));
    expect(c.visibility).toBe('visible');
    if (c.redacted !== false) throw new Error('narrow guard');
    expect(c.signature).toBe('0x' + 'ee'.repeat(65));
    expect(c.nonce).toBe('17000000001');
    expect(c.oddsTick).toBe(200);
    // `isLive` was derived at decode time — narrowing inside the visible branch
    // guarantees the field exists.
    expect(c.isLive).toBe(true);
  });

  it('decodes redacted:true as PublicHiddenCommitment with only the allow-list fields', () => {
    const c = toCommitment(makeHiddenBody());
    expect(c.visibility).toBe('hidden');
    expect(c.redacted).toBe(true);
    if (c.redacted !== true) throw new Error('narrow guard');
    expect(c.payloadAvailable).toBe(false);
    expect(c.bookVisible).toBe(false);
    expect(c.commitmentHash).toBe(HASH);
    expect(c.maker).toBe(MAKER);
    expect(c.contestId).toBe('42');
    // Disallow-listed fields stay strictly absent — the public hidden body
    // must not leak signature/nonce/odds/risk per the locked allow-list.
    expect((c as unknown as { signature?: unknown }).signature).toBeUndefined();
    expect((c as unknown as { nonce?: unknown }).nonce).toBeUndefined();
    expect((c as unknown as { oddsTick?: unknown }).oddsTick).toBeUndefined();
    expect((c as unknown as { riskAmount?: unknown }).riskAmount).toBeUndefined();
    expect((c as unknown as { scorer?: unknown }).scorer).toBeUndefined();
    expect((c as unknown as { lineTicks?: unknown }).lineTicks).toBeUndefined();
    expect((c as unknown as { marketType?: unknown }).marketType).toBeUndefined();
    expect((c as unknown as { speculationKey?: unknown }).speculationKey).toBeUndefined();
    expect((c as unknown as { remainingRiskAmount?: unknown }).remainingRiskAmount).toBeUndefined();
    expect((c as unknown as { isLive?: unknown }).isLive).toBeUndefined();
  });

  it('strips the `bookVisible` and `redacted` wire-only fields from the public visible shape', () => {
    // Both discriminants are sourced from the wire shape but the public
    // `PublicVisibleCommitment` carries them under the canonical names
    // (`visibility` + `redacted: false`) rather than the wire-level
    // `bookVisible`. The mapper must not leak the wire-only `bookVisible`
    // field onto the public type.
    const c = toCommitment(makeVisibleBody({ bookVisible: true }));
    expect((c as unknown as { bookVisible?: unknown }).bookVisible).toBeUndefined();
  });
});

// ─── Predicates ──────────────────────────────────────────────────────────

describe('isVisibleCommitment / isHiddenCommitment', () => {
  it('narrows a Commitment union to PublicVisibleCommitment', () => {
    const c: Commitment = toCommitment(makeVisibleBody());
    if (!isVisibleCommitment(c)) throw new Error('expected visible');
    // The narrow grants TypeScript access to the matchable payload fields —
    // the runtime test mirrors that with concrete reads.
    expect(c.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(c.oddsTick).toBe(200);
  });

  it('narrows a Commitment union to PublicHiddenCommitment', () => {
    const c: Commitment = toCommitment(makeHiddenBody());
    if (!isHiddenCommitment(c)) throw new Error('expected hidden');
    expect(c.payloadAvailable).toBe(false);
    expect(c.bookVisible).toBe(false);
  });
});

// ─── requireVisibleCommitment ────────────────────────────────────────────

describe('requireVisibleCommitment', () => {
  const visible: PublicVisibleCommitment = toCommitment(
    makeVisibleBody(),
  ) as PublicVisibleCommitment;
  const hidden: PublicHiddenCommitment = toCommitment(
    makeHiddenBody(),
  ) as PublicHiddenCommitment;

  it('returns the same commitment when visible', () => {
    expect(requireVisibleCommitment(visible)).toBe(visible);
  });

  it('throws OspexValidationError with field "commitment" when redacted', () => {
    expect(() => requireVisibleCommitment(hidden)).toThrowError(OspexValidationError);
    try {
      requireVisibleCommitment(hidden);
    } catch (err) {
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe('commitment');
      expect((err as OspexValidationError).message).toContain(hidden.commitmentHash);
      // Operators / agents are pointed at the owner-auth path. The exact
      // wording is part of the public error contract callers may surface
      // verbatim.
      expect((err as OspexValidationError).message).toContain('ownState.getCommitment');
    }
  });

  it('weaves the custom purpose into the message', () => {
    try {
      requireVisibleCommitment(hidden, { purpose: 'cancel on chain' });
    } catch (err) {
      expect((err as OspexValidationError).message).toContain('Cannot cancel on chain');
    }
  });
});

// ─── Call-site refusals — checkCommitmentFillability ─────────────────────

describe('checkCommitmentFillability — redaction short-circuit', () => {
  it('returns not-fillable with COMMITMENT_REDACTED when the commitment is hidden', async () => {
    // No chain reads should happen — the redaction verdict is definitive for
    // an anonymous caller regardless of funding. Pass a context whose chain
    // reads would explode if reached.
    const hidden = toCommitment(makeHiddenBody()) as PublicHiddenCommitment;
    const ctx = {
      api: { request: () => Promise.reject(new Error('no API read expected')) },
      requireChainClient: () => ({
        readContract: () => Promise.reject(new Error('no chain read expected')),
        getBlockNumber: () => Promise.reject(new Error('no chain read expected')),
      }),
      requireSigner: () => {
        throw new Error('no signer read expected');
      },
      getAddresses: () => ({
        usdc: '0x' + '11'.repeat(20),
        positionModule: '0x' + '22'.repeat(20),
        treasuryModule: '0x' + '33'.repeat(20),
        matchingModule: '0x' + '44'.repeat(20),
      }),
      getChainId: () => 137,
    } as unknown as CommitmentsContext;

    const result = await checkCommitmentFillability(ctx, { commitment: hidden });
    expect(result.outcome).toBe('not-fillable');
    expect(result.fillableNow).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reasons).toEqual([{ code: 'COMMITMENT_REDACTED' }]);
    // Short-circuited before chain reads → no fill block, no checkedAtBlock.
    expect(result.fill).toBeUndefined();
    expect(result.checkedAtBlock).toBeUndefined();
  });
});
