/**
 * `client.contests.create({ gameId })` — submits a
 * `CreOracleReceiver.createContestAndRequestVerify` transaction (R5 / CRE).
 *
 *  1. Resolve `gameId` to the game row via `GET /v1/games/:gameId` and
 *     extract `externalIds.{rundown, sportspage, jsonodds}`. Refuse if
 *     the game's `canCreateContest` flag is false.
 *  2. Pre-flight the USDC contest-creation fee allowance to TreasuryModule
 *     (the caller pays the fee on creation; the call reverts if the
 *     allowance is short). There is NO LINK, NO Chainlink subscription, NO
 *     EIP-712 script approval, and NO encrypted secrets — those were the
 *     retired Functions oracle. CRE execution is funded off-chain by the
 *     workflow owner.
 *  3. Build calldata and submit the permissionless request.
 *  4. Parse `ContestCreated` from the receipt for the assigned contestId.
 *
 * The contest is created `Unverified`; an off-chain Chainlink CRE workflow
 * resolves the emitted `CreOracleRequested` log and reports back via the
 * KeystoneForwarder, flipping it to `Verified` (watch via
 * `client.contests.waitForVerified` / `getContest`).
 *
 * `gameId` here is the `jsonodds_id` (stable). The user-facing CLI surfaces
 * `client.games.list()` so consumers can discover the gameId for a target
 * game; they pass it through `--game-id` and the SDK does the external-ID
 * resolution behind the scenes.
 */
import {
  encodeFunctionData,
  parseEventLogs,
  type Hash,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { contestModuleAbi, creOracleReceiverAbi } from '../contracts/abi/index.js';
import { OSPEX_CREATE_CONTEST_TX_GAS } from '../contracts/constants.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { Hex } from '../types/signer.js';
import { assertUsdcSufficient } from './helpers/approvals.js';
import { readContestCreationFee } from './helpers/treasury.js';
import type { ContestsContext } from './context.js';

export interface CreateContestArgs {
  /**
   * The `gameId` field from `client.games.list()` / `client.games.get()` —
   * stable jsonodds_id of the target game. The SDK resolves the row
   * via `GET /v1/games/:gameId` and pulls the three external IDs the
   * contract requires.
   */
  gameId: string;
}

export interface CreateContestResult {
  contestId: bigint;
  txHash: Hash;
  receipt: TransactionReceipt;
}

export async function create(
  ctx: ContestsContext,
  args: CreateContestArgs,
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

  // 2. Pre-flight the USDC contest-creation fee allowance to TreasuryModule.
  // createContestAndRequestVerify charges the caller the ContestCreation fee
  // (TreasuryModule.processFee does a USDC transferFrom); a short allowance
  // reverts on chain. The fee is 0-skippable — assertUsdcSufficient is a
  // no-op when the configured rate is 0.
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const owner = (await signer.getAddress()).toLowerCase() as Hex;

  const contestFee = await readContestCreationFee(publicClient, addresses.treasuryModule);
  await assertUsdcSufficient(publicClient, addresses.usdc, owner, addresses.treasuryModule, contestFee);

  // 3. Build calldata for the permissionless CRE request entrypoint.
  const data = encodeFunctionData({
    abi: creOracleReceiverAbi,
    functionName: 'createContestAndRequestVerify',
    args: [rundownId, sportspageId, jsonoddsId],
  });

  // 4. Submit. Hardcoded outer-tx gas (OSPEX_CREATE_CONTEST_TX_GAS) bypasses
  // estimateGas (unreliable in this region on some Polygon RPCs); EIP-1559
  // refunds the unused portion.
  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId: ctx.getChainId(),
    to: addresses.creOracleReceiver,
    data,
    gas: OSPEX_CREATE_CONTEST_TX_GAS,
  });

  // 5. Parse the assigned contestId from the ContestCreated event.
  const contestId = parseContestIdFromReceipt(receipt.logs, addresses.contestModule);

  return { contestId, txHash, receipt };
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
      'createContestAndRequestVerify tx receipt did not contain a ContestCreated event from ContestModule.',
    );
  }
  const contestId = event.args.contestId;
  if (typeof contestId !== 'bigint') {
    throw new OspexValidationError('ContestCreated event was missing the contestId field.');
  }
  return contestId;
}
