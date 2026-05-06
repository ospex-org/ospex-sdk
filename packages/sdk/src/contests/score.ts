/**
 * `client.contests.score(args)` — submits an
 * `OracleModule.scoreContestFromOracle` transaction. Mirrors the
 * `create` pipeline minus the USDC fee (no fee at score time):
 *
 *  1. Fetch script approvals (cached).
 *  2. Resolve score JS source (caller override or fetch from approvals.score.sourceUrl).
 *  3. Hash-verify against approvals.score.scriptHash. The on-chain check at
 *     `OracleModule.scoreContestFromOracle` is `keccak256(source) ==
 *     contest.scoreContestSourceHash`, so this gate also catches the
 *     case where the contest was created with a different (older)
 *     score hash — the actual on-chain assertion that matters is
 *     against the stored hash.
 *  4. Resolve encrypted secrets URL.
 *  5. Pre-flight LINK balance + allowance.
 *  6. Build calldata and submit.
 *
 * Scoring is asynchronous: the Chainlink callback typically lands
 * 30–90 s later and emits `CONTEST_SCORES_SET`. The SDK does not block
 * waiting for it — the caller can poll `client.contests.get(contestId)`
 * until `status === 'scored'`.
 */
import {
  encodeFunctionData,
  parseEventLogs,
  type Hash,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { oracleModuleAbi } from '../contracts/abi/index.js';
import {
  LINK_PAYMENT_PER_CALL_WEI,
  OSPEX_DEFAULT_GAS_LIMIT,
  OSPEX_SCORE_CONTEST_TX_GAS,
  OSPEX_SHARED_SUBSCRIPTION_ID,
} from '../contracts/constants.js';
import { OspexSubscriptionError, OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { Hex } from '../types/signer.js';
import { assertLinkSufficient } from './helpers/approvals.js';
import { fetchEncryptedSecrets } from './helpers/fetchSecrets.js';
import { assertSourceMatches, fetchSource } from './helpers/fetchSource.js';
import type { ContestsContext } from './context.js';
import type { ScriptsCache } from './scripts.js';

export interface ScoreContestArgs {
  contestId: bigint | string | number;
  subscriptionId?: bigint;
  gasLimit?: number;
  encryptedSecretsUrls?: Hex;
  scoreSource?: string;
}

export interface ScoreContestResult {
  contestId: bigint;
  txHash: Hash;
  receipt: TransactionReceipt;
  requestId: Hex | null;
}

export async function score(
  ctx: ContestsContext,
  args: ScoreContestArgs,
  scriptsCache: ScriptsCache,
): Promise<ScoreContestResult> {
  const id = typeof args.contestId === 'bigint' ? args.contestId : BigInt(args.contestId);
  if (id <= 0n) {
    throw new OspexValidationError('contestId must be a positive integer.', { field: 'contestId' });
  }

  const chainId = ctx.getChainId();
  const subscriptionId = resolveSubscriptionId(args.subscriptionId, chainId);

  const approvals = await scriptsCache.get(ctx);

  const scoreSource =
    args.scoreSource !== undefined
      ? assertSourceMatches(args.scoreSource, approvals.score.scriptHash, 'score source override')
      : await fetchSource(ctx, {
          url: approvals.score.sourceUrl,
          expectedHash: approvals.score.scriptHash,
          label: 'score source (contestScoring.js)',
        });

  const encryptedSecretsUrls =
    args.encryptedSecretsUrls ?? (await fetchEncryptedSecrets(ctx));

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const owner = (await signer.getAddress()).toLowerCase() as Hex;

  const linkRequired = LINK_PAYMENT_PER_CALL_WEI[chainId];
  if (linkRequired === undefined) {
    throw new OspexSubscriptionError(`No LINK payment configured for chain id ${chainId}.`, {
      reason: 'subscription_id_missing',
    });
  }
  await assertLinkSufficient(publicClient, addresses.linkToken, owner, addresses.oracleModule, linkRequired);

  const data = encodeFunctionData({
    abi: oracleModuleAbi,
    functionName: 'scoreContestFromOracle',
    args: [id, scoreSource, encryptedSecretsUrls, subscriptionId, args.gasLimit ?? OSPEX_DEFAULT_GAS_LIMIT],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: addresses.oracleModule,
    data,
    gas: OSPEX_SCORE_CONTEST_TX_GAS,
  });

  const requestId = parseRequestIdFromReceipt(receipt.logs, addresses.oracleModule);
  return { contestId: id, txHash, receipt, requestId };
}

function resolveSubscriptionId(override: bigint | undefined, chainId: 137 | 80002): bigint {
  if (override !== undefined) return override;
  const shared = OSPEX_SHARED_SUBSCRIPTION_ID[chainId];
  if (shared === null || shared === undefined) {
    throw new OspexSubscriptionError(
      `No shared Chainlink Functions subscription is configured for chain ${chainId}. Pass subscriptionId explicitly.`,
      { reason: 'subscription_id_missing' },
    );
  }
  return shared;
}

function parseRequestIdFromReceipt(logs: readonly Log[], oracleModule: Hex): Hex | null {
  const target = oracleModule.toLowerCase();
  const filtered = logs.filter((l) => l.address.toLowerCase() === target);
  try {
    const parsed = parseEventLogs({
      abi: oracleModuleAbi,
      eventName: 'RequestSent',
      logs: filtered,
    }) as unknown as Array<{ args: { id?: Hex } }>;
    const event = parsed[0];
    if (event === undefined) return null;
    return event.args.id ?? null;
  } catch {
    return null;
  }
}
