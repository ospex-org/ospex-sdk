/**
 * `ospex commitments match <hash-or-prefix> [flags]` — high-level
 * domain-language match. Mirrors `commitments submit`'s preview /
 * confirm / approve / sign flow:
 *
 *   0. Early non-TTY guard. Refuses runs without `--yes` on
 *      non-interactive stdin BEFORE any signer-unlock work, so the
 *      user gets an actionable "--yes is required" message instead of
 *      a cryptic "hidden input requires a TTY" failure from the
 *      keystore passphrase prompt. `--json` alone is allowed past the
 *      guard so an agent's preview-only path stays consumable from a
 *      script (see step 3).
 *   1. Resolve input via `client.commitments.resolveByPrefix` so the
 *      truncated `0x…` from `commitments list` is actionable. Echoes
 *      the full resolved hash to stderr if the input was a prefix.
 *   2. Call `client.commitments.prepareMatch({ commitment, ... })` —
 *      no signing yet. Returns a structured `MatchPreview`. Note:
 *      preparing the preview reads the taker address from the signer
 *      (for `selfMatch` and the allowance preflight), so the keystore
 *      passphrase prompt may fire even on the `--json`-alone path
 *      when no session is cached. This mirrors `commitments submit`.
 *   3. `--json` alone (no `--yes`) → emit `MatchPreviewEnvelope`,
 *      exit. Agent flow: inspect tuple before deciding whether to
 *      execute.
 *   4. Render the preview to stderr; prompt to confirm unless `--yes`.
 *      Decline → exit 130 (Ctrl-C convention).
 *   5. Run any required approvals (commitment-risk on PositionModule;
 *      lazy-creation-fee on TreasuryModule when the commitment matches
 *      a not-yet-created speculation). `--approve-max` non-interactive
 *      shorthand for unlimited; otherwise prompt.
 *   6. Call `client.commitments.matchFromPreview(preview)` — always
 *      re-fetches and re-checks state immediately before sending.
 *
 * `--risk-usdc` is the TAKER's desired risk / max outlay (USDC
 * decimal). The matching engine computes the maker fill from this
 * value and the maker's odds — at +260, e.g., a taker risking 1.6
 * USDC fully fills a maker risking 1 USDC. The preview always shows
 * both `takerRisk` AND `fillMakerRisk` so the user can verify both
 * sides of the fill.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexAPIError,
  OspexValidationError,
  usdcDecimalToWei6,
  wei6ToDecimalUSDC,
  type ApprovalPurpose,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptValue, promptYesNo } from '../../lib/prompt.js';
import { renderMatchPreview } from '../../lib/matchPreviewRender.js';

const optionsSchema = z.object({
  riskUsdc: z.string().min(1, '--risk-usdc cannot be empty').optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
  approveMax: z.boolean().optional(),
});

export const commitmentsMatchCommand = new Command('match')
  .description(
    'Match an existing commitment as the taker. Renders a preview block before signing; ' +
      'pass --yes to skip the prompt. Accepts a full 0x-prefixed 32-byte hash OR a unique ' +
      '0x-prefixed hex prefix (≥ 8 hex chars after 0x).',
  )
  .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
  .option(
    '--risk-usdc <decimal>',
    'taker desired risk / taker max outlay in decimal USDC (e.g. "1" or "0.5"). ' +
      "The matching engine computes the maker fill from this and the maker's odds — " +
      "at +260, a taker risking 1.6 USDC fully fills a maker risking 1 USDC. The preview " +
      'shows both takerRisk AND fillMakerRisk so the relationship is visible. Default: ' +
      'fully fill the maker remaining capacity.',
  )
  .option('--yes', 'skip the confirmation prompt')
  .option(
    '--approve-max',
    'with --yes (non-interactive), approve unlimited USDC instead of the exact required amount. ' +
      'Ignored in interactive mode — to grant unlimited interactively, type "max" at the amount prompt.',
  )
  .addOption(
    new Option(
      '--json',
      'machine-readable output. ALONE = preview only, no signing (MatchPreviewEnvelope). ' +
        'WITH --yes = signs/sends and emits MatchJsonResult.',
    ).hideHelp(false),
  )
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const approveMax = opts.approveMax === true;
    const isInteractive = process.stdin.isTTY === true;

    // ── 0. Early non-TTY guard. ────────────────────────────────────
    // Refuses runs that would hang on a confirmation prompt (no
    // `--yes`) before we trigger any signer unlock. The keystore
    // passphrase prompt that loadSigner runs is hidden-stdin and
    // fails outright on non-TTY runs with a less-actionable error
    // than the message below; better to fail here with an actionable
    // hint. `--json` alone (preview-only for agents) is allowed past
    // this guard — it may still hit the hidden-input error if no
    // session is cached, but that is a separate, documented condition
    // unrelated to the no-confirmation case Hermes flagged.
    if (!skipPrompt && !wantJson && !isInteractive) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `commitments match`. Re-run with --yes.',
      );
    }

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    // ── 1. Resolve input via the SDK's prefix resolver. ─────────────
    // Match scope is open + partially_filled (live commitments).
    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: ['open', 'partially_filled'],
    });
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      // Prefix → full echo to stderr (never stdout — preserves --json).
      process.stderr.write(
        `Resolved ${hashArg} → ${commitment.commitmentHash}\n`,
      );
    }

    // ── 2. Prepare match preview. No signing. ──────────────────────
    const prepArgs: Parameters<typeof client.commitments.prepareMatch>[0] = {
      commitment,
    };
    if (opts.riskUsdc !== undefined) {
      prepArgs.takerDesiredRiskWei6 = usdcDecimalToWei6(opts.riskUsdc);
    }
    const preview = await client.commitments.prepareMatch(prepArgs);

    // ── 3. --json alone (no --yes) is preview-only. ────────────────
    if (wantJson && !skipPrompt) {
      formatOutput({ schemaVersion: 1, preview }, { json: true });
      return;
    }

    // ── 4. Render preview + confirm (unless --yes). ────────────────
    renderMatchPreview(preview);
    if (!skipPrompt) {
      const ok = await promptYesNo('Match?', true);
      if (!ok) {
        process.stderr.write('Match cancelled.\n');
        process.exit(130);
      }
    }

    // ── 5. Run approvals if needed. ────────────────────────────────
    // commitment-risk → PositionModule (always present); lazy-creation-fee
    // → TreasuryModule (present iff speculation.mode === 'lazy').
    for (const row of preview.approvals) {
      if (!row.needsApproval || row.token !== 'USDC') continue;
      const requiredWei6 = BigInt(row.required);
      const currentWei6 = BigInt(row.current);
      let approveAmount: bigint | 'max';

      if (skipPrompt) {
        approveAmount = approveMax ? 'max' : requiredWei6;
      } else {
        const requiredHuman = wei6ToDecimalUSDC(requiredWei6);
        const currentHuman = wei6ToDecimalUSDC(currentWei6);
        const copy = approvalCopy(row.purpose);
        process.stderr.write(
          `\nUSDC approval needed (${copy.headerLabel}).\n` +
            `${'  '}Required: ${requiredHuman} USDC\n` +
            `${'  '}Approved: ${currentHuman} USDC\n` +
            `\n${copy.description}\n` +
            `${'  '}Spender: ${row.spender} (${copy.moduleName})\n`,
        );
        const allow = await promptYesNo(
          `Allow ${copy.moduleName} to spend USDC from your wallet?`,
          true,
        );
        if (!allow) {
          process.stderr.write('Approval declined; match cancelled.\n');
          process.exit(130);
        }
        const choice = await promptValue(
          'Amount in USDC (number, or "max" for unlimited)',
          requiredHuman,
        );
        if (choice.toLowerCase() === 'max') {
          approveAmount = 'max';
        } else {
          let parsed: bigint;
          try {
            parsed = usdcDecimalToWei6(choice);
          } catch {
            process.stderr.write(`Could not parse "${choice}" as a USDC amount.\n`);
            process.exit(1);
          }
          if (parsed < requiredWei6) {
            process.stderr.write(
              `Amount ${choice} USDC is less than the required ${requiredHuman} USDC.\n`,
            );
            process.exit(1);
          }
          approveAmount = parsed;
        }
      }

      const display =
        approveAmount === 'max'
          ? 'unlimited'
          : `${wei6ToDecimalUSDC(approveAmount)} USDC (${approveAmount} wei6)`;
      process.stderr.write(`Approving USDC → ${row.spender} (${display})...\n`);
      const approveResult =
        row.purpose === 'lazy-creation-fee'
          ? await client.commitments.approveCreationFee(approveAmount)
          : await client.commitments.approve(approveAmount);
      process.stderr.write(
        `approve tx: ${approveResult.txHash} (status ${approveResult.receipt.status})\n`,
      );
    }

    // ── 6. Sign + send. matchFromPreview always re-fetches first. ──
    let result;
    try {
      result = await client.commitments.matchFromPreview(preview);
    } catch (err) {
      if (err instanceof OspexAPIError && err.apiCode === 'NONCE_TOO_LOW') {
        process.stderr.write(
          'Maker activity changed between preview and submit. Re-run the command to refresh.\n',
        );
      }
      throw err;
    }

    if (wantJson) {
      formatOutput(
        {
          schemaVersion: 1,
          preview,
          result: {
            txHash: result.txHash,
            status: result.receipt.status,
            blockNumber: result.receipt.blockNumber.toString(),
            takerRiskWei6: result.takerRisk.toString(),
            fillMakerRiskWei6: result.fillMakerRisk.toString(),
          },
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        status: result.receipt.status,
        takerRisk: wei6ToDecimalUSDC(result.takerRisk),
        fillMakerRisk: wei6ToDecimalUSDC(result.fillMakerRisk),
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
  });

interface ApprovalCopy {
  headerLabel: string;
  moduleName: string;
  description: string;
}

function approvalCopy(purpose: ApprovalPurpose): ApprovalCopy {
  if (purpose === 'lazy-creation-fee') {
    return {
      headerLabel: 'lazy speculation creation fee',
      moduleName: 'TreasuryModule',
      description:
        'The TreasuryModule contract pulls this USDC from your wallet ONLY if this match\n' +
        'is the first one on this speculation tuple — i.e. the match that triggers lazy\n' +
        'creation. If a prior match already created the speculation by the time this\n' +
        'tx lands, no fee is charged.',
    };
  }
  // 'commitment-risk' — the canonical PositionModule allowance for the
  // taker's risk amount.
  return {
    headerLabel: 'taker risk',
    moduleName: 'PositionModule',
    description:
      'The PositionModule contract pulls the taker risk in USDC from your wallet\n' +
      "as part of the match. This is a standard ERC-20 `approve` — your tokens stay\n" +
      'in your wallet until the match transaction lands.',
  };
}
