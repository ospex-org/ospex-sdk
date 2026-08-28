/**
 * `ospex approvals setup [flags]` — orchestrates 1–3 sequential ERC-20
 * approvals against the Ospex spenders so a user can configure their
 * worst-case risk exposure in a single command.
 *
 * Flag mode (any of `--risk-usdc`, `--fee-usdc` provided):
 *   only act on the dimensions specified. The two are orthogonal —
 *   omitting a flag leaves that allowance untouched, and approving bet
 *   risk never implies a fee approval. A wallet that may be first to a
 *   line — a `(contest, scorer, lineTicks)` tuple, which odds are NOT
 *   part of — must approve `--fee-usdc` explicitly, or its first match
 *   on that line reverts on the speculation creation fee.
 *
 * Interactive mode (no flags + TTY + not --json):
 *   prompts for each dimension with sensible defaults. Press enter to
 *   accept the default; type "skip" or empty to leave that dimension
 *   unchanged.
 *
 * Output:
 *   - human (default) — preview block + Y/n prompt + per-tx progress.
 *   - --json without --yes — emits SetupPreviewEnvelope
 *     ({ schemaVersion, plan }), no signing.
 *   - --yes --json — signs/sends and emits SetupResultEnvelope
 *     ({ schemaVersion, plan, results }).
 *
 * Approvals are sent sequentially. Already-sufficient allowances are
 * skipped so this is idempotent — re-running with the same flags is a
 * no-op.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexValidationError,
  type AgentApprovalPurpose,
  type AgentApprovalSpenderLabel,
  type AgentEffect,
  type ApprovalRequirement,
  type ApprovalsSnapshot,
  type Hex,
} from '@ospex/sdk';
import {
  buildAgentEnvelope,
  emitJsonFailureAndExit,
  formatTokenAmount,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_ALLOWANCES,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptValue, promptYesNo } from '../../lib/prompt.js';
import {
  buildSetupPlan,
  parseUsdcInput,
  type ApprovalSpenderKey,
  type PlanItem,
  type SetupInput,
  type SetupPlan,
} from '../../lib/approvalsPlan.js';
import {
  renderSetupPlan,
  setupPlanToJson,
  type JsonSetupResult,
} from '../../lib/approvalsRender.js';

const optionsSchema = z.object({
  riskUsdc: z.string().optional(),
  feeUsdc: z.string().optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const approvalsSetupCommand = addSignerOptions(
  new Command('setup')
    .description(
      'Set up USDC approvals for Ospex modules in one command. ' +
        'Without flags, runs interactively. With at least one flag, only acts on the dimensions specified.',
    )
    .option(
      '--risk-usdc <amount>',
      'USDC approval for PositionModule (your bet risk pool). Decimal USDC like "50" or "0.25", or "max".',
    )
    .option(
      '--fee-usdc <amount>',
      'USDC approval for TreasuryModule (protocol fees: contest creation + lazy spec creation). ' +
        'Independent of --risk-usdc; omit it to leave the fee allowance unchanged. Approve a few ' +
        'USDC here if you may be first to a line — the 0.25/side speculation creation fee is ' +
        'pulled on that line\'s first match.',
    )
    .option('--yes', 'skip the confirmation prompt')
    .option('--json', 'machine-readable output'),
)
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const isInteractiveTTY = process.stdin.isTTY === true;

    const flagsProvided =
      opts.riskUsdc !== undefined || opts.feeUsdc !== undefined;
    const wantInteractive = !flagsProvided && !wantJson;

    if (!flagsProvided && wantJson) {
      throw new OspexValidationError(
        'Pass at least one of --risk-usdc, --fee-usdc with --json. Interactive ' +
          'prompts and --json are mutually exclusive.',
      );
    }
    if (wantInteractive && !isInteractiveTTY) {
      throw new OspexValidationError(
        'Interactive setup requires a TTY. Re-run with at least one of --risk-usdc, --fee-usdc.',
      );
    }
    if (!skipPrompt && !wantJson && !isInteractiveTTY) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `approvals setup`. Re-run with --yes.',
      );
    }

    // Pre-parse flag amounts BEFORE any signer/chain interaction, so a
    // typo'd `--risk-usdc not-a-number` — or an explicit `0`, which this
    // monotonic command refuses — errors out without first prompting for
    // the keystore passphrase. The result is discarded (buildSetupPlan
    // re-parses internally); parseUsdcInput throws on both cases.
    //
    // These throws sit outside the try/catch on purpose, matching the
    // three pre-chain guards above: the failure envelope needs a chainId
    // and owner that only exist after the client is built. Under --json a
    // consumer still sees exit 1 with the reason on stderr — never a
    // green envelope.
    if (opts.riskUsdc !== undefined) parseUsdcInput(opts.riskUsdc, '--risk-usdc');
    if (opts.feeUsdc !== undefined) parseUsdcInput(opts.feeUsdc, '--fee-usdc');

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    const owner = ((await client.signer().getAddress()) as string).toLowerCase() as `0x${string}`;
    // Failure-envelope state: plan is computed inside the try; results
    // accumulate during the approval loop. On mid-flight failure
    // (e.g. tx N reverts), the catch preserves results 0..N-1 as
    // confirmed effects via setupResultsToEffects(plan, results).
    let plan: SetupPlan | null = null;
    const results: JsonSetupResult[] = [];

    try {
    // Read current allowances (after signer unlock so the prompt
    // fires here rather than mid-loop).
    const current = await client.approvals.read({ owner });

    const input: SetupInput = wantInteractive
      ? await runInteractivePrompts(current)
      : { riskUsdc: opts.riskUsdc, feeUsdc: opts.feeUsdc };

    plan = buildSetupPlan(input, current);

    // --json without --yes → preview-only envelope, no signing.
    if (wantJson && !skipPrompt) {
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'approvals.setup',
          stage: 'preview',
          network: networkForChainId(chainId),
          chainId,
          wallet: owner,
          walletRole: 'signer',
          signer: owner,
          requiresSignature: plan.willSendCount > 0,
          requiresTransaction: plan.willSendCount > 0,
          approvalRequirements: planItemsToApprovalRequirements(plan),
          payload: { plan: setupPlanToJson(plan) },
        }),
      );
      return;
    }
    if (!wantJson) {
      renderSetupPlan(plan, process.stderr);
    }

    // Idempotent re-run: no txs to send. Emit empty-results envelope
    // for JSON consumers; nothing further for human mode (the plan
    // renderer already printed "Nothing to do").
    if (plan.willSendCount === 0) {
      if (wantJson) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: 'approvals.setup',
            stage: 'execute',
            network: networkForChainId(chainId),
            chainId,
            wallet: owner,
            walletRole: 'signer',
            signer: owner,
            payload: { plan: setupPlanToJson(plan), results: [] },
          }),
        );
      }
      return;
    }

    if (!skipPrompt && !wantJson) {
      const ok = await promptYesNo('\nProceed?');
      if (!ok) {
        process.stderr.write('Cancelled.\n');
        process.exit(130);
      }
    }

    for (const item of plan.items) {
      if (item.action.kind !== 'send') continue;
      if (!wantJson) {
        process.stderr.write(`\nApproving ${moduleDisplayName(item.spenderModule)} ...\n`);
      }
      const result = await executeItem(client, item);
      results.push(result);
      if (!wantJson) {
        process.stderr.write(
          `  ✓ ${result.txHash}  (block ${result.blockNumber})\n`,
        );
      }
    }

    if (wantJson) {
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: results.every((r) => r.status === 'success'),
          action: 'approvals.setup',
          stage: 'execute',
          network: networkForChainId(chainId),
          chainId,
          wallet: owner,
          walletRole: 'signer',
          signer: owner,
          effects: setupResultsToEffects(plan, results),
          nextCommands: [VERIFY_ALLOWANCES.build({ address: owner })],
          payload: { plan: setupPlanToJson(plan), results },
        }),
      );
      return;
    }
    process.stderr.write(
      `\nDone. Run \`ospex approvals show\` to verify the new state.\n`,
    );
    } catch (err) {
      // The failure-envelope scope: mid-flight failure preserves any approve
      // txs already landed in `results[]` as effects so agents see
      // exactly what was committed before the throw.
      if (wantJson) {
        const effects = plan !== null ? setupResultsToEffects(plan, results) : [];
        await emitJsonFailureAndExit({
          action: 'approvals.setup',
          stage: 'execute',
          chainId,
          wallet: owner,
          walletRole: 'signer',
          signer: owner,
          requiresSignature: true,
          requiresTransaction: true,
          effects,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
      }
      throw err;
    }
  });

/**
 * Map every plan item that targets a real allowance change (send OR
 * skip-already-approved) into the v2 `ApprovalRequirement` shoulder
 * shape. `skip-not-requested` items are omitted — they don't represent
 * an intent.
 *
 * `purpose` resolves the most common consumer for each (spender, token)
 * pair. `setup` is a bundled pre-approval, so the v1 narrow purpose
 * doesn't quite fit; agents that need finer discrimination should
 * combine `spenderLabel` + `tokenSymbol` themselves.
 */
function planItemsToApprovalRequirements(plan: SetupPlan): ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  for (const item of plan.items) {
    if (item.action.kind === 'skip-not-requested') continue;
    const targetRaw = item.action.targetRaw;
    out.push({
      token: item.tokenAddress,
      tokenSymbol: item.token,
      spender: item.spender,
      spenderLabel: spenderLabelFromKey(item.spenderModule),
      purpose: approvalPurposeFor(item.spenderModule),
      requiredWei: targetRaw.toString(),
      requiredHuman: formatTokenAmount(item.token, targetRaw.toString()),
      currentWei: item.currentRaw.toString(),
      currentHuman: formatTokenAmount(item.token, item.currentRaw.toString()),
      needsApproval: item.action.kind === 'send',
    });
  }
  return out;
}

/**
 * Build the `effects[]` shoulder for the execute envelope — one entry
 * per tx that landed (success OR reverted). The `purpose` token
 * encodes which spender was approved so agents can correlate without
 * cross-referencing the payload.
 */
function setupResultsToEffects(
  plan: SetupPlan,
  results: JsonSetupResult[],
): AgentEffect[] {
  return results.map((r) => {
    const item = plan.items.find((i) => i.spenderModule === r.spenderModule);
    const tokenSymbol = item?.token ?? 'USDC';
    return {
      type: 'transaction',
      purpose: `approve-${tokenSymbol.toLowerCase()}`,
      ok: r.status === 'success',
      txHash: r.txHash as Hex,
      blockNumber: r.blockNumber,
      status: r.status === 'success' ? 'confirmed' : 'reverted',
    };
  });
}

function spenderLabelFromKey(key: ApprovalSpenderKey): AgentApprovalSpenderLabel {
  if (key === 'positionModule') return 'PositionModule';
  return 'TreasuryModule';
}

function approvalPurposeFor(spender: ApprovalSpenderKey): AgentApprovalPurpose {
  if (spender === 'positionModule') return 'commitment-risk';
  // TreasuryModule USDC covers both lazy-creation-fee (commitment match)
  // and contest-creation-usdc (contest create). Pick the more common
  // consumer; setup is a bundled pre-approval and the precise purpose
  // depends on which downstream op consumes it first. spenderLabel
  // + tokenSymbol are the authoritative discriminators.
  return 'lazy-creation-fee';
}

async function runInteractivePrompts(current: ApprovalsSnapshot): Promise<SetupInput> {
  process.stderr.write(`\nSetting up Ospex approvals for ${current.owner}\n`);
  process.stderr.write(`(Press enter to accept the default; type "skip" to leave a dimension unchanged.)\n\n`);
  const riskUsdc = await promptValue(
    'USDC for bets (matching/submitting bets — decimal USDC, "max", or "skip")',
    '50',
  );
  const feeUsdc = await promptValue(
    'USDC for fees (small budget for protocol fees on lazy spec creation + contest creation)',
    '1',
  );
  return { riskUsdc, feeUsdc };
}

async function executeItem(
  client: Awaited<ReturnType<typeof getClient>>,
  item: PlanItem,
): Promise<JsonSetupResult> {
  if (item.action.kind !== 'send') {
    throw new Error('executeItem called on a non-send plan item');
  }
  const target = item.action.targetIsMax ? 'max' : item.action.targetRaw;
  let receipt;
  if (item.spenderModule === 'positionModule') {
    receipt = await client.commitments.approve(target);
  } else {
    receipt = await client.commitments.approveCreationFee(target);
  }
  return {
    spenderModule: item.spenderModule,
    txHash: receipt.txHash,
    blockNumber: receipt.receipt.blockNumber.toString(),
    status: receipt.receipt.status as 'success' | 'reverted',
  };
}

function moduleDisplayName(spender: ApprovalSpenderKey): string {
  if (spender === 'positionModule') return 'PositionModule';
  return 'TreasuryModule';
}
