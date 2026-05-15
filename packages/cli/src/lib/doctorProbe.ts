/**
 * Direct RPC probes for `ospex doctor` v2 PR 2. The doctor needs to
 * distinguish four failure modes the v1 path collapsed together:
 *
 *   - RPC is unreachable (timeout / network error)
 *   - RPC is reachable but reports a different chain than the SDK expects
 *   - RPC is on the expected chain but doesn't have the SDK's contracts
 *     deployed (typically a fresh fork or wrong-environment-same-chainid)
 *   - All of the above are fine and the chain reads will succeed
 *
 * These helpers run independently of `OspexClient` so they can produce
 * a structured result even when the higher-level client can't be
 * constructed (e.g. unsupported chain id, or we deliberately want to
 * test the RPC before wiring it into the SDK).
 *
 * Both probes set a hard transport timeout via `http(url, { timeout })`.
 * `durationMs` is wall-clock-from-call-start so agents can detect
 * slow-but-up RPCs.
 */

import { createPublicClient, http, type Hex } from 'viem';
import { getAddresses, type ChainId, type OspexAddresses } from '@ospex/sdk';

const DEFAULT_TIMEOUT_MS = 5_000;

// ── RPC liveness probe ────────────────────────────────────────────────

export interface RpcProbeSuccess {
  ok: true;
  urlHost: string;
  durationMs: number;
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  blockAgeSec: number;
}

export interface RpcProbeFailure {
  ok: false;
  urlHost: string;
  durationMs: number;
  error: string;
}

export type RpcProbeResult = RpcProbeSuccess | RpcProbeFailure;

/**
 * Probe the RPC for chain id + latest block, in parallel. One round-
 * trip wall time. On any error (timeout, transport, malformed JSON-RPC
 * response), returns the failure shape with the error message — never
 * throws, so the caller doesn't need its own try/catch.
 *
 * `blockAgeSec` is `floor(now - block.timestamp)`, clamped to 0. A
 * negative would mean the block is from the future (clock skew on
 * either side); we treat that as fresh.
 */
export async function probeRpc(
  rpcUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RpcProbeResult> {
  const start = Date.now();
  const urlHost = safeHost(rpcUrl);
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: timeoutMs }),
    });
    const [chainId, block] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    const durationMs = Date.now() - start;
    const nowSec = Math.floor(Date.now() / 1000);
    const blockAgeSec = Math.max(0, nowSec - Number(block.timestamp));
    return {
      ok: true,
      urlHost,
      durationMs,
      chainId,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      blockAgeSec,
    };
  } catch (err) {
    return {
      ok: false,
      urlHost,
      durationMs: Date.now() - start,
      error: errorMessage(err),
    };
  }
}

// ── Contract-code sanity probe ────────────────────────────────────────

export interface ContractCodeEntry {
  name: string;
  address: `0x${string}`;
  hasCode: boolean;
}

export interface ContractCheckSuccess {
  ok: boolean; // false when any contract is missing
  checked: ContractCodeEntry[];
  missing: string[];
  /** True if any individual `getBytecode` call failed — agents can
   *  treat partial probes differently from clean fails. */
  partial: boolean;
}

export interface ContractCheckUnavailable {
  unavailable: true;
  reason: string;
}

export type ContractCheckResult = ContractCheckSuccess | ContractCheckUnavailable;

const KNOWN_CHAIN_IDS: Record<number, true> = { 137: true, 80002: true };

/**
 * Probe whether the RPC has bytecode at each of the SDK's expected
 * contract addresses for the configured chain. Catches:
 *
 *   - Wrong-environment-same-chainid (private fork that returned
 *     chainId 137 but doesn't have prod deployments)
 *   - Stale address books (SDK pointing at a moved contract)
 *   - Local Anvil instances impersonating Polygon
 *
 * Address selection uses the EXPECTED chain id. If chain id mismatch
 * is already flagged elsewhere (see `network.chain_id_match`), this
 * check is informational — `checkNetworkContractsDeployed` short-
 * circuits to `skip` in that case via `dependsOn`. When chain id
 * matches, this is the load-bearing "does the RPC actually serve the
 * protocol?" check.
 *
 * Returns `unavailable` for chains the SDK has no address book for —
 * the doctor surfaces this as `skip` rather than `fail`, since we
 * can't probe what we don't know about.
 */
export async function probeContractsDeployed(
  rpcUrl: string,
  expectedChainId: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ContractCheckResult> {
  if (KNOWN_CHAIN_IDS[expectedChainId] !== true) {
    return {
      unavailable: true,
      reason: `no Ospex deployment configured for chain id ${expectedChainId}`,
    };
  }
  let addresses: OspexAddresses;
  try {
    addresses = getAddresses(expectedChainId as ChainId);
  } catch (err) {
    return { unavailable: true, reason: errorMessage(err) };
  }

  const targets: Array<{ name: string; address: `0x${string}` }> = [
    { name: 'USDC', address: addresses.usdc },
    { name: 'LINK', address: addresses.linkToken },
    { name: 'PositionModule', address: addresses.positionModule },
    { name: 'TreasuryModule', address: addresses.treasuryModule },
    { name: 'OracleModule', address: addresses.oracleModule },
    { name: 'OspexCore', address: addresses.ospexCore },
  ];

  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: timeoutMs }),
  });

  // Per-address try/catch so a single failed lookup doesn't blank the
  // whole report. A partial result is more useful than nothing.
  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const code = await client.getBytecode({ address: t.address });
      return { ...t, hasCode: code !== undefined && code !== '0x' };
    }),
  );

  let partial = false;
  const checked: ContractCodeEntry[] = settled.map((res, i) => {
    if (res.status === 'fulfilled') return res.value;
    partial = true;
    // Treat lookup failure as "couldn't determine" — surface as
    // hasCode=false so the user is alerted; the `partial` flag
    // distinguishes "we know it's missing" from "we couldn't ask".
    return { ...targets[i]!, hasCode: false };
  });

  const missing = checked.filter((c) => !c.hasCode).map((c) => c.name);
  return { ok: missing.length === 0, checked, missing, partial };
}

// ── helpers ───────────────────────────────────────────────────────────

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export viem `Hex` so test imports stay co-located with the probe.
export type { Hex };
