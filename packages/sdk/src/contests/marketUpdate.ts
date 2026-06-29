/**
 * `client.contests.requestMarketUpdate({ contestId })` — submits a
 * `CreOracleReceiver.requestMarketUpdate` transaction (R5 / CRE).
 *
 * Permissionless and free (no USDC fee, no LINK, no Chainlink subscription,
 * no EIP-712 script approval, no encrypted secrets — all retired with the
 * Functions oracle). The contest must already be `Verified`; the call reverts
 * (`CreOracleReceiver__ContestNotVerified`) otherwise. We do NOT pre-check the
 * status — let the revert surface, mirroring `score`'s premature-revert handling.
 *
 * The refresh is asynchronous: the on-chain call bumps the contest's market
 * request nonce and emits a `CreOracleRequested` log, which an off-chain
 * Chainlink CRE workflow resolves by fetching current odds and reporting back
 * via the KeystoneForwarder. The SDK does not block waiting for it — the
 * refreshed market lines land on chain ~30-90s later (poll the upstream
 * reference odds via `client.odds.snapshot(contestId)`).
 *
 * The returned `requestNonce` is the new latest market nonce for the contest,
 * parsed from the emitted `CreOracleRequested` event (the on-chain report binds
 * its echoed nonce to this request, so this is the value a downstream watcher
 * matches against `CreReportProcessed`).
 */
import {
  encodeFunctionData,
  parseEventLogs,
  type Hash,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { creOracleReceiverAbi } from '../contracts/abi/index.js';
import { OSPEX_SCORE_CONTEST_TX_GAS } from '../contracts/constants.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { Hex } from '../types/signer.js';
import type { ContestsContext } from './context.js';

/**
 * `CreOracleRequested.requestType` value for a market-update request.
 * Mirrors the on-chain `OracleRequestType` enum
 * (`ContestCreate=0, ContestMarketsUpdate=1, ContestScore=2`); a single
 * `requestMarketUpdate` tx can also surface unrelated logs, so the receipt
 * parser filters on this discriminator.
 */
const MARKET_UPDATE_REQUEST_TYPE = 1;

export interface RequestMarketUpdateArgs {
  contestId: bigint | string | number;
}

export interface RequestMarketUpdateResult {
  contestId: bigint;
  /** New latest market request nonce for the contest (uint64). */
  requestNonce: bigint;
  txHash: Hash;
  receipt: TransactionReceipt;
}

export async function requestMarketUpdate(
  ctx: ContestsContext,
  args: RequestMarketUpdateArgs,
): Promise<RequestMarketUpdateResult> {
  const id = typeof args.contestId === 'bigint' ? args.contestId : BigInt(args.contestId);
  if (id <= 0n) {
    throw new OspexValidationError('contestId must be a positive integer.', { field: 'contestId' });
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();

  const data = encodeFunctionData({
    abi: creOracleReceiverAbi,
    functionName: 'requestMarketUpdate',
    args: [id],
  });

  // Hardcoded outer-tx gas (OSPEX_SCORE_CONTEST_TX_GAS, shared with requestScore)
  // bypasses estimateGas; EIP-1559 refunds the unused portion. requestMarketUpdate
  // is a light tx (a nonce bump + events) but the budget stays a safe ceiling.
  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId: ctx.getChainId(),
    to: addresses.creOracleReceiver,
    data,
    gas: OSPEX_SCORE_CONTEST_TX_GAS,
  });

  const requestNonce = parseRequestNonceFromReceipt(receipt.logs, addresses.creOracleReceiver);

  return { contestId: id, requestNonce, txHash, receipt };
}

export function parseRequestNonceFromReceipt(
  logs: readonly Log[],
  creOracleReceiver: Hex,
): bigint {
  const target = creOracleReceiver.toLowerCase();
  const filtered = logs.filter((l) => l.address.toLowerCase() === target);
  const parsed = parseEventLogs({
    abi: creOracleReceiverAbi,
    eventName: 'CreOracleRequested',
    logs: filtered,
  }) as unknown as Array<{ args: { requestType?: number; requestNonce?: bigint } }>;
  const event = parsed.find((e) => e.args.requestType === MARKET_UPDATE_REQUEST_TYPE);
  if (event === undefined) {
    throw new OspexValidationError(
      'requestMarketUpdate tx receipt did not contain a market-update CreOracleRequested event from CreOracleReceiver.',
    );
  }
  const requestNonce = event.args.requestNonce;
  if (typeof requestNonce !== 'bigint') {
    throw new OspexValidationError('CreOracleRequested event was missing the requestNonce field.');
  }
  return requestNonce;
}
