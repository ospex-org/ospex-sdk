/**
 * M2.5 on-chain cancel — automatable subset of the manual playbook.
 *
 * Gated by OSPEX_INTEGRATION=1; the whole suite skips otherwise so unit
 * runs (`yarn workspace @ospex/sdk test`) stay hermetic.
 *
 * Required environment when OSPEX_INTEGRATION=1:
 *   OSPEX_TEST_RPC_URL   — mainnet or Amoy RPC (Alchemy / Infura recommended).
 *   OSPEX_TEST_CHAIN_ID  — 137 or 80002 (default 137).
 *   OSPEX_TEST_API_URL   — optional override; defaults to production.
 *
 * For tests that need a signer + funded wallet:
 *   OSPEX_TEST_PRIVATE_KEY — 0x-prefixed test wallet private key. NEVER
 *                            a mainnet key with real funds beyond gas;
 *                            tests assume the wallet is throwaway.
 *
 * Tests requiring an existing live commitment additionally need:
 *   OSPEX_TEST_LIVE_HASH — a commitment hash this wallet owns and
 *                          wants cancelled.
 *
 * The suite covers the read-only smoke (getNonceFloor) end-to-end any
 * time the RPC env is set. Write paths gate themselves further on the
 * private key + live hash. Anything that isn't covered automatically is
 * documented as a manual step in `docs/MANUAL_INTEGRATION_TESTING.md`
 * (Section 10).
 */

import { describe, expect, it } from 'vitest';
import { OspexChainError, OspexClient, type ChainId } from '../../src/index.js';
import { KeystoreSigner } from '../../src/signers/keystore.js';
import { polygon } from 'viem/chains';

const RUN = process.env.OSPEX_INTEGRATION === '1';
const RPC_URL = process.env.OSPEX_TEST_RPC_URL;
const CHAIN_ID = (process.env.OSPEX_TEST_CHAIN_ID
  ? Number(process.env.OSPEX_TEST_CHAIN_ID)
  : polygon.id) as ChainId;
const API_URL = process.env.OSPEX_TEST_API_URL;
const PRIVATE_KEY = process.env.OSPEX_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const LIVE_HASH = process.env.OSPEX_TEST_LIVE_HASH as `0x${string}` | undefined;

function makeClient(opts: { signer?: KeystoreSigner } = {}): OspexClient {
  if (!RPC_URL) throw new Error('OSPEX_TEST_RPC_URL required');
  const clientOptions: Record<string, unknown> = {
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
  };
  if (API_URL) clientOptions.apiUrl = API_URL;
  if (opts.signer) clientOptions.signer = opts.signer;
  return new OspexClient(clientOptions);
}

describe.skipIf(!RUN)('integration: M2.5 on-chain cancel', () => {
  it('reads getNonceFloor for a synthetic (maker, speculation) and returns 0n', async () => {
    if (!RPC_URL) throw new Error('OSPEX_TEST_RPC_URL required');
    const client = makeClient();
    // A maker that has never raised a nonce floor will read 0n.
    // Use the burn address as a stable "definitely never raised" maker.
    const floor = await client.commitments.getNonceFloor({
      maker: '0x0000000000000000000000000000000000000001' as `0x${string}`,
      contestId: 999_999_999n,
      scorer: '0x0000000000000000000000000000000000000002' as `0x${string}`,
      lineTicks: 0,
    });
    expect(floor).toBe(0n);
  });

  it('reads getFilledRisk for synthetic hashes against a real Multicall3', async () => {
    if (!RPC_URL) throw new Error('OSPEX_TEST_RPC_URL required');
    const client = makeClient();
    // Two hashes no commitment can occupy, so both read the storage default.
    // The point of running this against a live node is the parts a fake
    // cannot exercise: that Multicall3 exists at the address viem's chain
    // definition supplies, that the aggregate encodes/decodes, and that a
    // pinned block is served.
    const a = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const b = ('0x' + '22'.repeat(32)) as `0x${string}`;

    const head = await client.commitments.getFilledRisk({ hashes: [a, b] });
    expect(head.atBlock).toBeGreaterThan(0n);
    expect([...head.filledRisk.entries()]).toStrictEqual([
      [a, 0n],
      [b, 0n],
    ]);

    // Pin a few blocks back: proves the node SERVES a pinned aggregate.
    // Note what this case does NOT prove — `atBlock` is echoed from the
    // argument, so asserting it says only that the SDK copied what it was
    // handed. The block reaching the node is the next case's job.
    const pinned = await client.commitments.getFilledRisk({
      hashes: [a, b],
      blockNumber: head.atBlock - 5n,
    });
    expect(pinned.atBlock).toBe(head.atBlock - 5n);
  });

  it('refuses a block the node does not have — the pin reaches the wire', async () => {
    if (!RPC_URL) throw new Error('OSPEX_TEST_RPC_URL required');
    const client = makeClient();
    const a = ('0x' + '11'.repeat(32)) as `0x${string}`;

    const head = await client.commitments.getFilledRisk({ hashes: [a] });

    // A block far past the head. This is the discriminating case: if the pin
    // were dropped on the way to the node the read would simply succeed at
    // `latest`, so only a request that actually carried the block can fail.
    // The refusal is also the documented residual — a lagging node behind a
    // load balancer answers the same way, and the read refuses rather than
    // answering from a different block.
    await expect(
      client.commitments.getFilledRisk({ hashes: [a], blockNumber: head.atBlock + 5_000_000n }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  describe.skipIf(!PRIVATE_KEY || !LIVE_HASH)('write paths (require OSPEX_TEST_PRIVATE_KEY + OSPEX_TEST_LIVE_HASH)', () => {
    it('Test 1 — submit + cancelOnchain: tx succeeds, indexer projection within 30s', async () => {
      if (!PRIVATE_KEY || !LIVE_HASH) throw new Error('write env required');
      const signer = KeystoreSigner.fromPrivateKey(PRIVATE_KEY);
      const client = makeClient({ signer });
      const result = await client.commitments.cancelOnchain({ hash: LIVE_HASH });
      expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.commitmentHash.toLowerCase()).toBe(LIVE_HASH.toLowerCase());
      // Poll Supabase via the API for up to 30s for the indexer projection.
      const deadline = Date.now() + 30_000;
      let lastStatus: string | undefined;
      while (Date.now() < deadline) {
        const row = await client.commitments.get(LIVE_HASH);
        lastStatus = row.status;
        if (row.status === 'cancelled') return;
        await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`indexer never projected status=cancelled within 30s; last=${String(lastStatus)}`);
    }, 60_000);

    it('Test 2 — idempotent re-cancel: second cancelOnchain succeeds, status stays cancelled', async () => {
      if (!PRIVATE_KEY || !LIVE_HASH) throw new Error('write env required');
      const signer = KeystoreSigner.fromPrivateKey(PRIVATE_KEY);
      const client = makeClient({ signer });
      const result = await client.commitments.cancelOnchain({ hash: LIVE_HASH });
      expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      const row = await client.commitments.get(LIVE_HASH);
      expect(row.status).toBe('cancelled');
    }, 60_000);
  });

  // The remaining cases are documented in
  // docs/MANUAL_INTEGRATION_TESTING.md (Section 10):
  //   - Test 3: partial-fill cancel (needs a taker; out of scope for a single-wallet suite).
  //   - Test 4: third-party reject (needs a second wallet — orchestrate manually).
  //   - Test 5: bulk-cancel dry-run (CLI-only path; covered manually).
  //   - Test 6: bulk-cancel real (needs ≥2 commitments on one speculation; create manually).
  //   - Test 7: re-bulk reject (NonceMustIncrease) — runs naturally after Test 6.
  //   - Test 8: also-onchain composition — CLI flag, exercised manually.
});
