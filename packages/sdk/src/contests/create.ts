/**
 * `client.contests.create({ gameId, ... })` — submits an
 * `OracleModule.createContestFromOracle` transaction. Full pipeline:
 *
 *  1. Resolve `gameId` to the game row via `GET /v1/games/:gameId` and
 *     extract `externalIds.{rundown, sportspage, jsonodds}`. Refuse if
 *     the game's `canCreateContest` flag is false.
 *  2. Resolve the Chainlink subscription (caller override or shared default).
 *  3. Fetch script approvals (cached).
 *  4. Resolve verify JS source (caller override or fetch from approvals.verify.sourceUrl).
 *  5. Hash-verify the source against approvals.verify.scriptHash. Refuse on mismatch.
 *  6. Resolve encrypted secrets URL (caller override or ospex-api-server).
 *  7. Pre-flight LINK + USDC balance + allowance.
 *  8. Build calldata and submit.
 *  9. Parse `ContestCreated` event from the receipt for the assigned contestId.
 *
 * Returns the assigned `contestId` plus the txHash. `requestId` (the
 * Chainlink Functions request id) is parsed when present in receipt
 * logs; null when the FunctionsClient `RequestSent` event isn't in
 * the OracleModule ABI we ship with.
 *
 * `gameId` here is the `jsonodds_id` (stable). The user-facing CLI
 * surfaces `client.games.list()` so consumers can discover the gameId
 * for a target game; they pass it through `--game-id` and the SDK
 * does all the external-ID resolution behind the scenes.
 */
import {
  encodeFunctionData,
  parseEventLogs,
  type Hash,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { contestModuleAbi, oracleModuleAbi } from '../contracts/abi/index.js';
import {
  LINK_PAYMENT_PER_CALL_WEI,
  OSPEX_DEFAULT_GAS_LIMIT,
  OSPEX_SHARED_SUBSCRIPTION_ID,
} from '../contracts/constants.js';
import {
  OspexScriptApprovalError,
  OspexSubscriptionError,
  OspexValidationError,
} from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { ApprovedScripts } from '../types/contest.js';
import type { Hex } from '../types/signer.js';
import { assertLinkSufficient, assertUsdcSufficient } from './helpers/approvals.js';
import { fetchEncryptedSecrets } from './helpers/fetchSecrets.js';
import { assertSourceMatches, fetchSource } from './helpers/fetchSource.js';
import { readContestCreationFee } from './helpers/treasury.js';
import type { ContestsContext } from './context.js';
import type { ScriptsCache } from './scripts.js';

export interface CreateContestArgs {
  /**
   * The `gameId` field from `client.games.list()` / `client.games.get()` —
   * stable jsonodds_id of the target game. The SDK resolves the row
   * via `GET /v1/games/:gameId` and pulls the three external IDs the
   * contract requires.
   */
  gameId: string;
  /** Defaults to OSPEX_SHARED_SUBSCRIPTION_ID for the configured chain. */
  subscriptionId?: bigint;
  /** Defaults to OSPEX_DEFAULT_GAS_LIMIT (300_000 — Polygon Functions Router cap). */
  gasLimit?: number;
  /** Skip the ospex-api-server fetch when provided. */
  encryptedSecretsUrls?: Hex;
  /** Skip the GitHub source fetch when provided. */
  verifySource?: string;
}

export interface CreateContestResult {
  contestId: bigint;
  txHash: Hash;
  receipt: TransactionReceipt;
  requestId: Hex | null;
}

export async function create(
  ctx: ContestsContext,
  args: CreateContestArgs,
  scriptsCache: ScriptsCache,
): Promise<CreateContestResult> {
  // 1. Resolve gameId to the game row → pull external IDs.
  if (typeof args.gameId !== 'string' || args.gameId === '') {
    throw new OspexValidationError(
      'gameId is required. Get one from `client.games.list()` / `ospex games list`.',
    );
  }
  const game = await ctx.gamesApi.get(args.gameId);
  if (!game.canCreateContest) {
    const reasons: string[] = [];
    if (game.contestCreated) reasons.push('contest already created');
    if (game.status !== 'upcoming') reasons.push(`status is "${game.status}", not "upcoming"`);
    if (game.externalIds.sportspage === null) reasons.push('sportspage_id missing');
    if (game.externalIds.rundown === null) reasons.push('rundown_id missing');
    throw new OspexValidationError(
      `Game ${args.gameId} cannot have a contest created: ${reasons.join(', ') || 'unknown reason'}.`,
    );
  }
  const rundownId = game.externalIds.rundown ?? '';
  const sportspageId = game.externalIds.sportspage ?? '';
  const jsonoddsId = game.externalIds.jsonodds;

  // 2. Resolve subscription.
  const chainId = ctx.getChainId();
  const subscriptionId = resolveSubscriptionId(args.subscriptionId, chainId);

  // 3. Approvals.
  const approvals = await scriptsCache.get(ctx);
  assertVerifyNotExpired(approvals);

  // 4 + 5. Verify source — fetch (or use override) and hash-check.
  const verifySource =
    args.verifySource !== undefined
      ? assertSourceMatches(args.verifySource, approvals.verify.scriptHash, 'verify source override')
      : await fetchSource(ctx, {
          url: approvals.verify.sourceUrl,
          expectedHash: approvals.verify.scriptHash,
          label: 'verify source (createContest.js)',
        });

  // 6. Encrypted secrets.
  const encryptedSecretsUrls =
    args.encryptedSecretsUrls ?? (await fetchEncryptedSecrets(ctx));

  // 7. Pre-flight allowances + balances.
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const owner = (await signer.getAddress()).toLowerCase() as Hex;

  const linkRequired = LINK_PAYMENT_PER_CALL_WEI[chainId];
  if (linkRequired === undefined) {
    throw new OspexSubscriptionError(
      `No LINK payment configured for chain id ${chainId}.`,
      { reason: 'subscription_id_missing' },
    );
  }

  const contestFee = await readContestCreationFee(publicClient, addresses.treasuryModule);
  await Promise.all([
    assertLinkSufficient(publicClient, addresses.linkToken, owner, addresses.oracleModule, linkRequired),
    assertUsdcSufficient(publicClient, addresses.usdc, owner, addresses.treasuryModule, contestFee),
  ]);

  // 8. Build calldata.
  const data = encodeFunctionData({
    abi: oracleModuleAbi,
    functionName: 'createContestFromOracle',
    args: [
      {
        rundownId,
        sportspageId,
        jsonoddsId,
        createContestSourceJS: verifySource,
        encryptedSecretsUrls,
        subscriptionId,
        gasLimit: args.gasLimit ?? OSPEX_DEFAULT_GAS_LIMIT,
      },
      approvals.marketUpdate.scriptHash,
      approvals.score.scriptHash,
      buildApprovalsStruct(approvals),
    ],
  });

  // 9. Submit.
  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: addresses.oracleModule,
    data,
  });

  // 10. Parse contestId and (best-effort) requestId.
  const contestId = parseContestIdFromReceipt(receipt.logs, addresses.contestModule);
  const requestId = parseRequestIdFromReceipt(receipt.logs, addresses.oracleModule);

  return { contestId, txHash, receipt, requestId };
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

function assertVerifyNotExpired(approvals: ApprovedScripts): void {
  const { validUntil } = approvals.verify;
  if (validUntil !== 0 && Math.floor(Date.now() / 1000) >= validUntil) {
    throw new OspexScriptApprovalError(
      `Verify approval expired at ${new Date(validUntil * 1000).toISOString()}. Re-sign before creating new contests.`,
      { reason: 'expired' },
    );
  }
}

function buildApprovalsStruct(approvals: ApprovedScripts): {
  verifyApproval: ApprovalTuple;
  verifyApprovalSig: Hex;
  marketUpdateApproval: ApprovalTuple;
  marketUpdateApprovalSig: Hex;
  scoreApproval: ApprovalTuple;
  scoreApprovalSig: Hex;
} {
  return {
    verifyApproval: toApprovalTuple(approvals.verify),
    verifyApprovalSig: approvals.verify.signature,
    marketUpdateApproval: toApprovalTuple(approvals.marketUpdate),
    marketUpdateApprovalSig: approvals.marketUpdate.signature,
    scoreApproval: toApprovalTuple(approvals.score),
    scoreApprovalSig: approvals.score.signature,
  };
}

interface ApprovalTuple {
  scriptHash: Hex;
  purpose: number;
  leagueId: number;
  version: number;
  validUntil: bigint;
}

function toApprovalTuple(entry: ApprovedScripts['verify']): ApprovalTuple {
  return {
    scriptHash: entry.scriptHash,
    purpose: entry.purpose,
    leagueId: entry.leagueId,
    version: entry.version,
    validUntil: BigInt(entry.validUntil),
  };
}

function parseContestIdFromReceipt(logs: readonly Log[], contestModule: Hex): bigint {
  const target = contestModule.toLowerCase();
  const filtered = logs.filter((l) => l.address.toLowerCase() === target);
  const parsed = parseEventLogs({
    abi: contestModuleAbi,
    eventName: 'ContestCreated',
    logs: filtered,
  }) as unknown as Array<{ args: { contestId?: bigint } }>;
  const event = parsed[0];
  if (event === undefined) {
    throw new OspexValidationError(
      'createContestFromOracle tx receipt did not contain a ContestCreated event from ContestModule.',
    );
  }
  const contestId = event.args.contestId;
  if (typeof contestId !== 'bigint') {
    throw new OspexValidationError('ContestCreated event was missing the contestId field.');
  }
  return contestId;
}

function parseRequestIdFromReceipt(logs: readonly Log[], oracleModule: Hex): Hex | null {
  const target = oracleModule.toLowerCase();
  const filtered = logs.filter((l) => l.address.toLowerCase() === target);
  // FunctionsClient (Chainlink) emits `RequestSent(bytes32 indexed id)` —
  // included if the OracleModule ABI inherits the event. Fallback to null
  // when not present (no functional impact; requestId is only useful for
  // Chainlink dashboard cross-reference).
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
