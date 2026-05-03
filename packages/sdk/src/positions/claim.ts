/**
 * `client.positions.claim({ speculationId, positionType })` — call
 * `PositionModule.claimPosition(speculationId, uint8)`.
 *
 * Permissionless for the position holder (the contract reads
 * `s_positions[speculationId][msg.sender][positionType]` and reverts
 * with NotSettled / AlreadyClaimed / NoPayout otherwise). No allowance
 * is required — `claimPosition` transfers USDC OUT of PositionModule
 * to the caller, never in.
 *
 * Returns the actual `payout` parsed from the `POSITION_CLAIMED`
 * `CoreEventEmitted` log on OspexCore. The SDK doesn't trust local
 * estimates here; the on-chain payout is authoritative.
 */

import {
  decodeAbiParameters,
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  toBytes,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { positionModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError, OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { PositionsContext } from './context.js';

export interface ClaimArgs {
  speculationId: bigint;
  positionType: 0 | 1;
}

export interface ClaimResult {
  txHash: Hash;
  blockNumber: bigint;
  /** wei6 — USDC has 6 decimals. */
  payoutWei6: bigint;
  /** Convenience number in USDC. Lossy for sub-cent values; use
   * `payoutWei6` for display whenever exact precision matters. */
  payoutUSDC: number;
  receipt: TransactionReceipt;
}

const EVENT_POSITION_CLAIMED = keccak256(toBytes('POSITION_CLAIMED'));

const CORE_EVENT_EMITTED_ABI = [
  {
    type: 'event',
    name: 'CoreEventEmitted',
    inputs: [
      { name: 'eventType', type: 'bytes32', indexed: true },
      { name: 'emitter', type: 'address', indexed: true },
      { name: 'eventData', type: 'bytes', indexed: false },
    ],
    anonymous: false,
  },
] as const;

export async function claim(
  ctx: PositionsContext,
  args: ClaimArgs,
): Promise<ClaimResult> {
  if (args.speculationId <= 0n) {
    throw new OspexValidationError('speculationId must be a positive bigint.', { field: 'speculationId' });
  }
  if (args.positionType !== 0 && args.positionType !== 1) {
    throw new OspexValidationError('positionType must be 0 (upper) or 1 (lower).', { field: 'positionType' });
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { positionModule, ospexCore } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  const data = encodeFunctionData({
    abi: positionModuleAbi,
    functionName: 'claimPosition',
    args: [args.speculationId, args.positionType],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: positionModule,
    data,
  });

  const user = (await signer.getAddress()).toLowerCase();
  const payoutWei6 = parsePayoutFromReceipt(receipt, ospexCore, args.speculationId, args.positionType, user);
  if (payoutWei6 == null) {
    throw new OspexChainError(
      'claimPosition tx confirmed but no matching POSITION_CLAIMED event found in the receipt.',
      { txHash },
    );
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    payoutWei6,
    payoutUSDC: Number(payoutWei6) / 1e6,
    receipt,
  };
}

function parsePayoutFromReceipt(
  receipt: TransactionReceipt,
  ospexCore: `0x${string}`,
  speculationId: bigint,
  positionType: 0 | 1,
  user: string,
): bigint | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ospexCore.toLowerCase()) continue;
    let parsed: ReturnType<typeof decodeEventLog>;
    try {
      parsed = decodeEventLog({
        abi: CORE_EVENT_EMITTED_ABI,
        topics: log.topics,
        data: log.data,
      });
    } catch {
      continue;
    }
    if (parsed.eventName !== 'CoreEventEmitted') continue;
    const args = parsed.args as {
      eventType: `0x${string}`;
      emitter: `0x${string}`;
      eventData: `0x${string}`;
    };
    if (args.eventType.toLowerCase() !== EVENT_POSITION_CLAIMED.toLowerCase()) continue;

    const decoded = decodeAbiParameters(
      [
        { name: 'speculationId', type: 'uint256' },
        { name: 'user', type: 'address' },
        { name: 'positionType', type: 'uint8' },
        { name: 'payout', type: 'uint256' },
      ],
      args.eventData,
    );
    const [decodedSpecId, decodedUser, decodedPosType, payout] = decoded as readonly [
      bigint,
      `0x${string}`,
      number,
      bigint,
    ];
    if (
      decodedSpecId === speculationId &&
      decodedPosType === positionType &&
      decodedUser.toLowerCase() === user
    ) {
      return payout;
    }
  }
  return null;
}
