/**
 * `client.positions.settleSpeculation({ speculationId })` — call
 * `SpeculationModule.settleSpeculation(speculationId)`.
 *
 * Permissionless on-chain (any EOA can settle), so no allowance / no
 * EIP-712 signing — just a tx send. The contract finalizes the
 * speculation by reading the parent contest's score (set by the
 * Chainlink callback) and asking the registered scorer to compute
 * `winSide`. Required before `claimPosition` will succeed for any
 * holder of that speculation.
 *
 * Returns the on-chain `winSide` enum string parsed from the
 * `SPECULATION_SETTLED` `CoreEventEmitted` log on OspexCore.
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
import { speculationModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { PositionsContext } from './context.js';

export interface SettleArgs {
  speculationId: bigint;
}

export interface SettleResult {
  txHash: Hash;
  blockNumber: bigint;
  /** Decoded from the on-chain SPECULATION_SETTLED event. */
  winSide: 'tbd' | 'away' | 'home' | 'over' | 'under' | 'push' | 'void';
  receipt: TransactionReceipt;
}

const WIN_SIDE_ENUM = [
  'tbd',
  'away',
  'home',
  'over',
  'under',
  'push',
  'void',
] as const;

// keccak256("SPECULATION_SETTLED") — matches the constant in
// SpeculationModule.sol; recomputed at module load so an upstream
// renaming would surface as a "missing log" instead of a silent
// mis-decode.
const EVENT_SPECULATION_SETTLED = keccak256(toBytes('SPECULATION_SETTLED'));

// Hand-written single-event ABI for OspexCore's CoreEventEmitted —
// MatchingModule.json doesn't expose it because OspexCore.sol is the
// emitter. Rather than copy a second artifact in for a single event,
// we declare the minimal shape inline.
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

export async function settleSpeculation(
  ctx: PositionsContext,
  args: SettleArgs,
): Promise<SettleResult> {
  if (args.speculationId <= 0n) {
    throw new OspexChainError('settleSpeculation: speculationId must be a positive bigint.');
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { speculationModule, ospexCore } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  const data = encodeFunctionData({
    abi: speculationModuleAbi,
    functionName: 'settleSpeculation',
    args: [args.speculationId],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: speculationModule,
    data,
  });

  const winSide = parseWinSideFromReceipt(receipt, ospexCore, args.speculationId) ?? 'tbd';

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    winSide,
    receipt,
  };
}

function parseWinSideFromReceipt(
  receipt: TransactionReceipt,
  ospexCore: `0x${string}`,
  speculationId: bigint,
): SettleResult['winSide'] | null {
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
    if (args.eventType.toLowerCase() !== EVENT_SPECULATION_SETTLED.toLowerCase()) continue;

    const decoded = decodeAbiParameters(
      [
        { name: 'speculationId', type: 'uint256' },
        { name: 'winSide', type: 'uint8' },
        { name: 'scorer', type: 'address' },
      ],
      args.eventData,
    );
    const [decodedSpecId, winSideRaw] = decoded as readonly [bigint, number, `0x${string}`];
    if (decodedSpecId !== speculationId) continue;
    return WIN_SIDE_ENUM[winSideRaw] ?? 'tbd';
  }
  return null;
}
