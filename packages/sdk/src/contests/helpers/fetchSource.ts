/**
 * Fetches a Chainlink Functions JS source string over HTTPS and
 * verifies its keccak256 hash matches the on-chain-approved hash
 * before it's submitted as calldata.
 *
 * The verify-revert path in OracleModule (
 * `keccak256(abi.encodePacked(params.createContestSourceJS)) ==
 * approvals.verifyApproval.scriptHash`) makes this gate critical —
 * a hash mismatch wastes the user's LINK + USDC fee with a revert.
 * We assert before any tx is built. Same gate is used for scoring.
 */
import { keccak256, toBytes } from 'viem';
import { OspexAPIError, OspexScriptApprovalError } from '../../errors.js';
import type { Hex } from '../../types/signer.js';
import type { ContestsContext } from '../context.js';

export interface FetchSourceParams {
  url: string;
  /** Expected keccak256 hash. Must match exactly or the call throws. */
  expectedHash: Hex;
  /** Optional human-readable label used in the error message. */
  label?: string;
}

export async function fetchSource(
  ctx: ContestsContext,
  params: FetchSourceParams,
): Promise<string> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  const label = params.label ?? params.url;

  let response: Response;
  try {
    response = await fetchImpl(params.url, { method: 'GET' });
  } catch (err) {
    throw new OspexAPIError(`Failed to fetch script source from ${params.url}.`, {
      path: params.url,
      cause: err,
    });
  }
  if (!response.ok) {
    throw new OspexAPIError(
      `Script source fetch returned HTTP ${response.status} ${response.statusText} from ${params.url}.`,
      { status: response.status, path: params.url },
    );
  }

  const source = await response.text();
  return assertSourceMatches(source, params.expectedHash, label);
}

/**
 * Hash a source string the same way OracleModule does
 * (`keccak256(abi.encodePacked(string))`) and compare to the expected
 * hash. Throws OspexScriptApprovalError on mismatch.
 */
export function assertSourceMatches(source: string, expectedHash: Hex, label: string): string {
  const actual = keccak256(toBytes(source));
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new OspexScriptApprovalError(
      `Hash mismatch on ${label}. Expected ${expectedHash}, got ${actual}. ` +
        'The fetched source has drifted from the protocol-approved version. Refusing to submit.',
      { reason: 'hash_mismatch', expectedHash, actualHash: actual },
    );
  }
  return source;
}
