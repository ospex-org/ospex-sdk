/**
 * Tests for the doctor v2 PR 2 probes (`probeRpc`, `probeContractsDeployed`).
 * These probes hit viem's `createPublicClient` directly, so we exercise
 * them against a mocked HTTP transport rather than a live RPC.
 *
 * The probes' contract: never throw; always return a structured result
 * with `ok: boolean` (or `unavailable: true` for the contract check).
 * Tests verify that contract and a few flag edges (timeout, malformed
 * URL, unsupported chain id).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeContractsDeployed, probeRpc } from '../src/lib/doctorProbe.js';
import { runDoctorChecks } from '../src/lib/doctorChecks.js';

// Mock the viem transport. The probes pass `http(rpcUrl, { timeout })`
// → we replace that with a fetch mock so we control responses without
// a live RPC.
type MockHandler = (body: { method: string; params?: unknown[] }) => unknown;

function installFetchMock(handler: MockHandler): () => void {
  const original = globalThis.fetch;
  // viem uses fetch under the hood for the http transport.
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {};
    // viem batches sometimes; handle both single + array.
    const requests = Array.isArray(body) ? body : [body];
    const responses = requests.map((req: { id: number; method: string; params?: unknown[] }) => {
      try {
        const result = handler({ method: req.method, params: req.params });
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
        };
      }
    });
    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | undefined;

beforeEach(() => {
  restore = undefined;
});

afterEach(() => {
  if (restore !== undefined) {
    restore();
    restore = undefined;
  }
  vi.restoreAllMocks();
});

describe('probeRpc', () => {
  it('returns ok with chainId + blockNumber + blockAgeSec on healthy RPC', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    restore = installFetchMock(({ method }) => {
      if (method === 'eth_chainId') return '0x89'; // 137
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x2faf080', // 50_000_000
          timestamp: `0x${(nowSec - 5).toString(16)}`, // 5s ago
          hash: '0x' + '0'.repeat(64),
          parentHash: '0x' + '0'.repeat(64),
          // minimal block fields viem won't choke on
          nonce: '0x0000000000000000',
          sha3Uncles: '0x' + '0'.repeat(64),
          logsBloom: '0x' + '0'.repeat(512),
          transactionsRoot: '0x' + '0'.repeat(64),
          stateRoot: '0x' + '0'.repeat(64),
          receiptsRoot: '0x' + '0'.repeat(64),
          miner: '0x' + '0'.repeat(40),
          difficulty: '0x0',
          totalDifficulty: '0x0',
          extraData: '0x',
          size: '0x0',
          gasLimit: '0x0',
          gasUsed: '0x0',
          transactions: [],
          uncles: [],
          baseFeePerGas: '0x0',
          mixHash: '0x' + '0'.repeat(64),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await probeRpc('https://rpc.example.com/v2/key');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.chainId).toBe(137);
    expect(result.blockNumber).toBe(50_000_000n);
    expect(result.urlHost).toBe('rpc.example.com');
    expect(result.blockAgeSec).toBeGreaterThanOrEqual(4);
    expect(result.blockAgeSec).toBeLessThanOrEqual(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok with blockAgeSec clamped to 0 when block timestamp is in the future (clock skew)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    restore = installFetchMock(({ method }) => {
      if (method === 'eth_chainId') return '0x89';
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1',
          timestamp: `0x${(nowSec + 30).toString(16)}`, // 30s in future
          hash: '0x' + '0'.repeat(64),
          parentHash: '0x' + '0'.repeat(64),
          nonce: '0x0000000000000000',
          sha3Uncles: '0x' + '0'.repeat(64),
          logsBloom: '0x' + '0'.repeat(512),
          transactionsRoot: '0x' + '0'.repeat(64),
          stateRoot: '0x' + '0'.repeat(64),
          receiptsRoot: '0x' + '0'.repeat(64),
          miner: '0x' + '0'.repeat(40),
          difficulty: '0x0',
          totalDifficulty: '0x0',
          extraData: '0x',
          size: '0x0',
          gasLimit: '0x0',
          gasUsed: '0x0',
          transactions: [],
          uncles: [],
          baseFeePerGas: '0x0',
          mixHash: '0x' + '0'.repeat(64),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await probeRpc('https://rpc.example.com');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.blockAgeSec).toBe(0);
  });

  it('returns ok=false with error message when RPC errors', async () => {
    restore = installFetchMock(() => {
      throw new Error('HTTP 401 Unauthorized');
    });

    const result = await probeRpc('https://bad.example.com');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/401/);
    expect(result.urlHost).toBe('bad.example.com');
  });

  it('returns urlHost="unknown" for a malformed URL — never throws', async () => {
    const result = await probeRpc('not-a-url');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.urlHost).toBe('unknown');
  });
});

describe('probeContractsDeployed', () => {
  it('returns unavailable for an unsupported chain id', async () => {
    const result = await probeContractsDeployed('https://rpc.example.com', 999_999);
    expect('unavailable' in result).toBe(true);
    if (!('unavailable' in result)) throw new Error('unreachable');
    expect(result.reason).toMatch(/999999/);
  });

  it('returns ok with all contracts present when getCode returns non-empty bytecode', async () => {
    restore = installFetchMock(({ method }) => {
      if (method === 'eth_getCode') return '0x6080604052'; // any non-empty hex
      throw new Error(`unexpected method ${method}`);
    });

    const result = await probeContractsDeployed('https://rpc.example.com', 137);
    expect('unavailable' in result).toBe(false);
    if ('unavailable' in result) throw new Error('unreachable');
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.checked.length).toBeGreaterThan(0);
    for (const c of result.checked) expect(c.hasCode).toBe(true);
  });

  it('returns ok=false with data.missing when a contract has empty bytecode', async () => {
    const POSITION_MODULE_LOWER = '0x0dcd42f8609cd7884ddba3481b03a78dfc88366c';
    restore = installFetchMock(({ method, params }) => {
      if (method === 'eth_getCode') {
        const [address] = params as [string];
        // PositionModule returns empty; others return code.
        if (address.toLowerCase() === POSITION_MODULE_LOWER) return '0x';
        return '0x6080604052';
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await probeContractsDeployed('https://rpc.example.com', 137);
    expect('unavailable' in result).toBe(false);
    if ('unavailable' in result) throw new Error('unreachable');
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('PositionModule');
    expect(result.unknown).toEqual([]);
    // Confirmed missing entry has hasCode === false (not null).
    const positionEntry = result.checked.find((c) => c.name === 'PositionModule');
    expect(positionEntry?.hasCode).toBe(false);
  });

  // review blocker #2: a transport-level failure on individual
  // getCode lookups must NOT be conflated with confirmed-empty
  // bytecode. The probe records the failed entry as `hasCode: null`
  // and adds its name to `unknown[]` (not `missing[]`) so the
  // downstream classifier warns rather than hard-fails.
  it('records errored lookups as hasCode=null in `unknown[]`, not in `missing[]`', async () => {
    let calls = 0;
    restore = installFetchMock(({ method }) => {
      if (method === 'eth_getCode') {
        calls += 1;
        // Fail the second lookup; everything else succeeds.
        if (calls === 2) throw new Error('temporary failure');
        return '0x6080604052';
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await probeContractsDeployed('https://rpc.example.com', 137);
    expect('unavailable' in result).toBe(false);
    if ('unavailable' in result) throw new Error('unreachable');
    expect(result.unknown.length).toBe(1);
    expect(result.missing).toEqual([]);
    // The errored lookup must surface as hasCode === null (not false).
    const erroredEntry = result.checked.find((c) => c.hasCode === null);
    expect(erroredEntry).toBeDefined();
    expect(result.unknown).toContain(erroredEntry!.name);
    // ok is strict — any uncertainty disqualifies it.
    expect(result.ok).toBe(false);
  });
});

// Integration: pipe the REAL probe output into the REAL check
// classifier. Catches the class of bug where a hand-built probe shape
// passes a unit test but the actual probe path produces a different
// shape that misclassifies. A review blocker surfaced exactly
// that gap.
describe('probeContractsDeployed → checkNetworkContractsDeployed (integration)', () => {
  const HAPPY_RPC_PROBE = {
    ok: true as const,
    urlHost: 'rpc.example.com',
    durationMs: 1,
    chainId: 137,
    blockNumber: 1n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    blockAgeSec: 0,
  };

  it('lookup error on one address → check returns warn (not fail)', async () => {
    let calls = 0;
    restore = installFetchMock(({ method }) => {
      if (method === 'eth_getCode') {
        calls += 1;
        if (calls === 2) throw new Error('transient transport error');
        return '0x6080604052';
      }
      throw new Error(`unexpected method ${method}`);
    });

    const probe = await probeContractsDeployed('https://rpc.example.com', 137);
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: probe,
    });
    const c = checks.find((r) => r.id === 'network.contracts_deployed');
    expect(c?.status).toBe('warn');
    expect(c?.error).toBeUndefined();
  });

  it('confirmed empty bytecode on one address → check returns fail with contract_not_deployed', async () => {
    const POSITION_LOWER = '0x0dcd42f8609cd7884ddba3481b03a78dfc88366c';
    restore = installFetchMock(({ method, params }) => {
      if (method === 'eth_getCode') {
        const [address] = params as [string];
        if (address.toLowerCase() === POSITION_LOWER) return '0x';
        return '0x6080604052';
      }
      throw new Error(`unexpected method ${method}`);
    });

    const probe = await probeContractsDeployed('https://rpc.example.com', 137);
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: probe,
    });
    const c = checks.find((r) => r.id === 'network.contracts_deployed');
    expect(c?.status).toBe('fail');
    expect(c?.error?.code).toBe('contract_not_deployed');
  });
});
