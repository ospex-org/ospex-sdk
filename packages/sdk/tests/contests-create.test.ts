/**
 * create() input validation. The full happy path requires a viem
 * PublicClient + Signer + on-chain readContract chain that's prohibitive
 * to mock for unit tests. We cover:
 *   - validation gate (no external ids → throws)
 *   - approvals expired → throws OspexScriptApprovalError(reason='expired')
 * Integration of the full pipeline is exercised manually per
 * docs/MANUAL_INTEGRATION_TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { create } from '../src/contests/create.js';
import { OspexScriptApprovalError, OspexValidationError } from '../src/errors.js';
import { ScriptsCache } from '../src/contests/scripts.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { ApprovedScripts } from '../src/types/contest.js';
import type { ContestsApi } from '../src/api/contests.js';

function buildApprovals(verifyValidUntil: number): ApprovedScripts {
  const stub: ApprovedScripts['verify'] = {
    scriptHash: '0x01c48e15068b68b7d5986d5013edd83a243ac31a761567e9db0e57b513c26c01',
    purpose: 0,
    leagueId: 0,
    version: 1,
    validUntil: verifyValidUntil,
    signature: '0xdead',
    sourceUrl: 'https://example.com/verify.js',
  };
  return {
    network: 'polygon',
    approvedSigner: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
    verify: stub,
    marketUpdate: { ...stub, purpose: 1, validUntil: 0 },
    score: { ...stub, purpose: 2, validUntil: 0 },
  };
}

function makeCtx(approvals: ApprovedScripts): ContestsContext {
  const contestsApi = {
    scripts: async () => approvals,
  } as unknown as ContestsApi;
  return {
    contestsApi,
    getChainId: () => 137 as const,
  } as unknown as ContestsContext;
}

describe('contests.create — validation', () => {
  it('throws OspexValidationError when all three external ids are empty', async () => {
    const cache = new ScriptsCache();
    const ctx = makeCtx(buildApprovals(2_000_000_000));
    await expect(create(ctx, {}, cache)).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('throws OspexScriptApprovalError(reason=expired) when verify approval is past validUntil', async () => {
    const cache = new ScriptsCache();
    // Past timestamp — 2020-01-01.
    const ctx = makeCtx(buildApprovals(1_577_836_800));
    await expect(
      create(ctx, { jsonoddsId: 'abc' }, cache),
    ).rejects.toBeInstanceOf(OspexScriptApprovalError);
    try {
      await create(ctx, { jsonoddsId: 'abc' }, cache);
    } catch (err) {
      expect((err as OspexScriptApprovalError).reason).toBe('expired');
    }
  });

  it('treats validUntil=0 as permanent (no expiry check failure)', async () => {
    const cache = new ScriptsCache();
    const approvals = buildApprovals(0);
    const ctx = makeCtx(approvals);
    // Will fail later at fetchSource (no network) — but NOT with
    // OspexScriptApprovalError(reason=expired), proving the expiry
    // check accepted validUntil=0.
    await expect(create(ctx, { jsonoddsId: 'abc' }, cache)).rejects.toThrow();
    try {
      await create(ctx, { jsonoddsId: 'abc' }, cache);
    } catch (err) {
      const isExpired =
        err instanceof OspexScriptApprovalError && err.reason === 'expired';
      expect(isExpired).toBe(false);
    }
  });
});
