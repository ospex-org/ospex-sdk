/**
 * Review #2 regression guard.
 *
 * The chain-read helpers (`readBalancesSafe`, `readApprovalsSafe`)
 * sit between the SDK's `client.{balances,approvals}.read(...)` and
 * the doctor envelope. viem's `HttpRequestError` thrown from inside
 * the SDK includes the raw RPC URL in `err.message` — without
 * sanitisation that URL (and any embedded API key) lands verbatim
 * in `balances.*.details` / `allowances.*.details`, both in the
 * JSON envelope and the rendered human Checks section.
 *
 * The first PR 54 fix sanitised the *probe* paths (`probeRpc` etc.)
 * but missed these helpers. This file exists so any future leak in
 * the chain-read path is caught by CI before it ships.
 *
 * The tests do NOT spin up a real OspexClient — they pass a stub
 * whose `.read({owner})` throws a viem-shaped error with the URL
 * inline. The assertion is purely "no raw secret in the captured
 * error message".
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalsSnapshot, BalancesSnapshot, OspexClient } from '@ospex/sdk';
import {
  readApprovalsSafe,
  readBalancesSafe,
  type SafeReadResult,
} from '../src/commands/doctor.js';

const OWNER = '0x0000000000000000000000000000000000000001' as `0x${string}`;
const RAW_URL =
  'https://polygon-mainnet.g.alchemy.com/v2/supersecretkey0123456789abcdef';
const RAW_SECRET = 'supersecretkey0123456789abcdef';

/**
 * Build the kind of error message viem's `HttpRequestError` emits.
 * Includes the raw URL in the body so the captured `err.message`
 * leaks it without sanitisation.
 */
function viemStyleError(url: string): Error {
  return new Error(
    'HTTP request failed.\n\n' +
      `URL: ${url}\n` +
      'Request body: {"method":"eth_call","params":[...]}\n\n' +
      'Details: HTTP 500 Internal Server Error\n' +
      'Version: viem@2.x',
  );
}

function makeStubClientThrowingOnBalances(url: string): OspexClient {
  return {
    balances: {
      read: async () => {
        throw viemStyleError(url);
      },
    },
  } as unknown as OspexClient;
}

function makeStubClientThrowingOnApprovals(url: string): OspexClient {
  return {
    approvals: {
      read: async () => {
        throw viemStyleError(url);
      },
    },
  } as unknown as OspexClient;
}

describe('readBalancesSafe — URL leak guard', () => {
  it('sanitises a viem HttpRequestError before returning the error string', async () => {
    const client = makeStubClientThrowingOnBalances(RAW_URL);
    const result: SafeReadResult<BalancesSnapshot> = await readBalancesSafe(
      client,
      OWNER,
      RAW_URL,
    );
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
    // The raw API key MUST NOT appear anywhere in the captured error.
    expect(result.error).not.toContain(RAW_SECRET);
    expect(result.error).not.toContain(RAW_URL);
    // The redacted form should appear in its place.
    expect(result.error).toContain('/v2/[redacted]');
  });

  it('returns the error verbatim when rpcUrl is null (nothing to sanitise against)', async () => {
    const client = makeStubClientThrowingOnBalances(RAW_URL);
    const result = await readBalancesSafe(client, OWNER, null);
    // Without a rpcUrl, the sanitiser is a no-op — the caller must
    // not provide a URL it can't trust as the redaction target.
    // This is the "no URL configured" path; in practice the doctor
    // only enters chain reads when rpcUrl is non-null, so this is
    // mainly documentation that the helper's contract is "sanitise
    // when given a URL, pass through otherwise."
    expect(result.error).toContain(RAW_URL);
  });
});

describe('readApprovalsSafe — URL leak guard', () => {
  it('sanitises a viem HttpRequestError before returning the error string', async () => {
    const client = makeStubClientThrowingOnApprovals(RAW_URL);
    const result: SafeReadResult<ApprovalsSnapshot> = await readApprovalsSafe(
      client,
      OWNER,
      RAW_URL,
    );
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(RAW_SECRET);
    expect(result.error).not.toContain(RAW_URL);
    expect(result.error).toContain('/v2/[redacted]');
  });
});

// A reviewer's exact repro: an RPC that returns 200 OK for probe methods
// (eth_chainId / getBlockByNumber / getCode) but then fails on the
// chain-read methods (eth_getBalance / eth_call). The probe-side
// sanitisation didn't cover this — the SDK call path threw with the
// URL inline. The doctor envelope MUST NOT contain the raw key for
// any of the failure cases.
describe('review #2 — RPC probe ok but chain reads fail', () => {
  it('balance read error path strips the secret from the doctor-facing string', async () => {
    const url =
      'http://127.0.0.1:9/v2/anothersupersecret0123456789ab';
    const client = makeStubClientThrowingOnBalances(url);
    const balance = await readBalancesSafe(client, OWNER, url);
    const approval = await readApprovalsSafe(
      makeStubClientThrowingOnApprovals(url),
      OWNER,
      url,
    );
    for (const r of [balance, approval]) {
      expect(r.error).not.toContain('anothersupersecret0123456789ab');
    }
  });
});
