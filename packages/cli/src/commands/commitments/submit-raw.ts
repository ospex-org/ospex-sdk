import { exitAfterStdoutFlush } from '../../lib/agentEnvelope.js';
/**
 * `ospex commitments submit-raw <contestId> <scorer> <lineTicks> <position> <oddsTick> <riskAmount>`
 *
 * Protocol-level escape hatch — direct positional surface mirroring the
 * on-chain OspexCommitment struct (no speculationId — the contract
 * derives that from contestId+scorer+lineTicks). Most users should
 * reach for the high-level `ospex commitments submit`, which accepts
 * domain-language inputs and renders an explicit win/lose/push preview
 * before signing.
 *
 * Unlike `submit`/`match`, submit-raw has NO preview-only mode — it
 * ALWAYS signs + posts immediately. `--json` is therefore output format
 * only (it does NOT imply a dry run), and non-interactive runs require
 * `--yes` (refused up front so the reactive approval prompt can't hang).
 *
 * `--expiry` is REQUIRED. The raw-tuple surface reads no contest, so it has
 * no match time to derive a safe expiry from; the removed `now + 24h`
 * default was a wall-clock guess that left a commitment matchable well into
 * live play. Use `ospex commitments submit`, which reads the contest and
 * defaults expiry to its match time, if you want a default.
 *
 * Two of the three `--expiry` failure modes are caught in the command's
 * pre-parse, BEFORE `getClient`: a MISSING flag and an UNPARSEABLE value.
 * Neither costs a keystore passphrase prompt or a signer unlock. The third —
 * a value that parses but is out of bounds (already past, or beyond the
 * 366-day cap) — is refused by the SDK's `validateExpiry` inside `submitRaw`,
 * i.e. AFTER `getClient`, because that bound is not exported from
 * `@ospex/sdk` and duplicating the constant here would just create a second
 * number to drift. Nothing is signed or POSTed in any of the three cases.
 *
 * On `OspexAllowanceError` we offer to approve PositionModule and retry
 * once: interactive runs prompt (defaulting to the EXACT required amount,
 * "max" for unlimited); `--yes` auto-approves the required amount, or
 * unlimited with `--approve-max`. All approval diagnostics go to stderr so
 * the `--json` payload on stdout stays parseable. Prints the EIP-712
 * commitment hash on success.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexAllowanceError,
  OspexValidationError,
  usdcDecimalToAmountWei6,
  wei6ToDecimalUSDC,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';
import type { Hex } from '@ospex/sdk';

const positionSchema = z.enum(['upper', 'lower', '0', '1']);

const optionsSchema = z.object({
  expiry: z.string().optional(),
  nonce: z.string().regex(/^[0-9]+$/).optional(),
  yes: z.boolean().optional(),
  approveMax: z.boolean().optional(),
  json: z.boolean().optional(),
});

function parsePosition(raw: string): 0 | 1 {
  const parsed = positionSchema.parse(raw);
  if (parsed === 'upper' || parsed === '0') return 0;
  return 1;
}

/**
 * Relative-duration grammar accepted by `--expiry`: a positive integer
 * followed by one of `s` / `m` / `h` / `d` / `w` — all five units, which is
 * why the user-facing strings below lead with `"45s"` rather than the
 * four-example list this grammar is usually advertised with. Mirrors the
 * grammar the high-level `ospex commitments submit` accepts (implemented
 * SDK-side in `prepareSubmit`), so the two `--expiry` flags take the same
 * inputs.
 *
 * Deliberately duplicated rather than imported: the SDK's parser is
 * module-private and the CLI must not import SDK internals. If either side
 * gains a unit, the other has to follow — a shared exported parser is the
 * durable fix.
 */
const DURATION_RE = /^([0-9]+)([smhdw])$/;
const DURATION_UNIT_SEC: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3600n,
  d: 86400n,
  w: 604800n,
};

/**
 * Parse `--expiry` to unix-seconds. Accepts a duration ("45s", "30m", "4h",
 * "1d", "1w"), unix-seconds ("1715299200"), or ISO-8601 / RFC3339.
 *
 * A duration is resolved against the CALLER's clock at parse time, so a
 * re-issued `submit-raw` with the same duration signs a DIFFERENT expiry —
 * hence a different commitment hash, which the server's hash-keyed
 * idempotency cannot dedup. To make a retry idempotent, pass the absolute
 * unix-seconds value you originally signed. See `docs/AGENT_CONTRACT.md` §7.
 */
function parseExpiry(raw: string): bigint {
  const duration = DURATION_RE.exec(raw);
  if (duration !== null) {
    const magnitude = BigInt(duration[1]!);
    if (magnitude === 0n) {
      throw new OspexValidationError(
        `Invalid --expiry duration "${raw}": magnitude must be > 0 (e.g. "45s", "30m", "4h", "1d", "1w").`,
        { field: 'expiry' },
      );
    }
    // Non-null: DURATION_RE only matches the five keys of DURATION_UNIT_SEC.
    return BigInt(Math.floor(Date.now() / 1000)) + magnitude * DURATION_UNIT_SEC[duration[2]!]!;
  }
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new OspexValidationError(
      `Invalid --expiry "${raw}". Accepted forms: a duration ("45s", "30m", "4h", "1d", "1w"), ` +
        `unix-seconds ("1715299200"), or ISO-8601 / RFC3339 ("2026-05-09T20:00:00Z").`,
      { field: 'expiry' },
    );
  }
  return BigInt(Math.floor(ms / 1000));
}

export const commitmentsSubmitRawCommand = addSignerOptions(
  new Command('submit-raw')
    .description(
      'Protocol-level escape hatch — sign + post an EIP-712 OspexCommitment using ' +
        'the literal canonical tuple. Prefer `ospex commitments submit` for the ' +
        'domain-language flow with preview block.',
    )
    .argument('<contestId>', 'contest id (uint256)')
    .argument('<scorer>', 'scorer module address')
    .argument('<lineTicks>', 'line ticks (int32, 10× scale)')
    .argument('<position>', 'upper | lower (or 0 | 1)')
    .argument('<oddsTick>', 'odds tick (uint16, 100× scale; 191 = 1.91)')
    .argument('<riskAmount>', 'risk amount (USDC, 6 decimals; multiple of 100)')
    .option(
      '--expiry <duration-iso-or-unix>',
      'REQUIRED. duration ("45s", "30m", "4h", "1d", "1w"), ISO-8601 ("2026-05-09T20:00:00Z"), or ' +
        'unix-seconds. There is NO default: submit-raw reads no contest, so it has no match ' +
        'time to derive a safe expiry from. Use `ospex commitments submit` for a match-time default.',
    )
    .option('--nonce <bigint>', 'override nonce strategy with an explicit value')
    .option(
      '--yes',
      'run unattended: on a USDC allowance shortfall, auto-approve the exact required amount ' +
        'without prompting. Required for non-interactive runs (submit-raw always signs + posts).',
    )
    .option(
      '--approve-max',
      'with --yes, approve unlimited USDC on a shortfall instead of the exact required amount. ' +
        'Ignored in interactive mode — type "max" at the amount prompt to grant unlimited interactively.',
    )
    .addOption(
      new Option(
        '--json',
        'machine-readable JSON output. NOTE: unlike `commitments submit`/`match`, submit-raw has ' +
          'NO preview-only mode — it ALWAYS signs + posts. --json is output format only, does NOT ' +
          'imply a dry run, and does NOT exempt the non-interactive --yes requirement.',
      ).hideHelp(false),
    ),
)
  .action(async (contestIdArg, scorerArg, lineTicksArg, positionArg, oddsTickArg, riskAmountArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const skipPrompt = opts.yes === true;
    const approveMax = opts.approveMax === true;
    const isInteractive = process.stdin.isTTY === true;

    // submit-raw signs + posts immediately (it has NO preview-only mode) and
    // may need an interactive USDC approval if allowance is short. Refuse
    // non-interactive runs without --yes up front — BEFORE getClient unlocks
    // the keystore — so the reactive allowance prompt can never hang on a
    // stdin nobody can answer. Unlike `submit`/`match`, --json does NOT exempt
    // this guard: there is no preview-only path here, so --json still executes.
    if (!skipPrompt && !isInteractive) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `commitments submit-raw`. ' +
          'It signs + posts immediately (no preview-only mode) and may need to approve USDC; ' +
          'pass --yes to run unattended (add --approve-max to approve unlimited instead of the ' +
          'exact required amount).',
      );
    }

    // --expiry is required and has no default. Refuse HERE — in the pre-parse,
    // before getClient — so a forgotten flag never costs a keystore passphrase
    // prompt or a signer unlock. The SDK's `submitRaw` throws the same typed
    // error and is the real boundary; this is the ergonomic half.
    if (opts.expiry === undefined) {
      throw new OspexValidationError(
        '--expiry is required for `commitments submit-raw`; there is no default. ' +
          'The raw-tuple surface reads no contest, so it has no match time to derive a safe ' +
          'expiry from, and a wall-clock default would leave the commitment matchable after ' +
          'the game starts. Pass a duration ("45s", "30m", "4h", "1d", "1w"), an ISO-8601 ' +
          'timestamp, or unix-seconds — or use `ospex commitments submit`, which reads the contest and ' +
          'defaults expiry to its match time.',
        { field: 'expiry' },
      );
    }

    const args = {
      contestId: BigInt(contestIdArg),
      scorer: scorerArg as Hex,
      lineTicks: Number(lineTicksArg),
      positionType: parsePosition(positionArg),
      oddsTick: Number(oddsTickArg),
      riskAmount: BigInt(riskAmountArg),
      expiry: parseExpiry(opts.expiry),
      ...(opts.nonce !== undefined ? { nonce: BigInt(opts.nonce) } : {}),
    };

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    const trySubmit = async () => client.commitments.submitRaw(args);

    let result;
    try {
      result = await trySubmit();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleAllowance(client, err, { skipPrompt, approveMax });
      if (!handled) throw err;
      result = await trySubmit();
    }

    if (opts.json === true) {
      formatOutput({ hash: result.hash, commitment: result.commitment }, { json: true });
      return;
    }
    formatOutput(
      {
        hash: result.hash,
        status: result.commitment.status,
        riskAmount: result.commitment.riskAmount,
        nonce: result.commitment.nonce,
        expiry: result.commitment.expiry,
      },
      { json: false },
    );
  });

async function handleAllowance(
  client: Awaited<ReturnType<typeof getClient>>,
  err: OspexAllowanceError,
  opts: { skipPrompt: boolean; approveMax: boolean },
): Promise<boolean> {
  // All diagnostics + prompts go to STDERR — stdout is reserved for the
  // --json payload so `submit-raw … --json | jq .` stays parseable.
  const requiredHuman = wei6ToDecimalUSDC(err.required);
  const currentHuman = wei6ToDecimalUSDC(err.current);
  process.stderr.write(
    `\nUSDC approval needed (commitment risk).\n` +
      `  Required: ${requiredHuman} USDC\n` +
      `  Approved: ${currentHuman} USDC\n` +
      `  Spender:  ${err.spender} (PositionModule)\n` +
      `  Token:    ${err.token} (USDC)\n`,
  );

  let approveAmount: bigint | 'max';
  if (opts.skipPrompt) {
    // Non-interactive (--yes): approve the EXACT required amount by default;
    // --approve-max opts into unlimited. Never default to unlimited.
    approveAmount = opts.approveMax ? 'max' : err.required;
  } else {
    const allow = await promptYesNo('Allow PositionModule to spend USDC from your wallet?', true);
    if (!allow) {
      process.stderr.write('Approval declined; submit-raw cancelled.\n');
      return false;
    }
    // Amount is entered in human USDC units (e.g. "5" = 5 USDC), defaulting
    // to the required amount on a bare Enter — NOT unlimited. "max" grants
    // unlimited explicitly.
    const choice = await promptValue('Amount in USDC (number, or "max" for unlimited)', requiredHuman);
    if (choice.toLowerCase() === 'max') {
      approveAmount = 'max';
    } else {
      let parsed: bigint;
      try {
        parsed = usdcDecimalToAmountWei6(choice);
      } catch {
        process.stderr.write(`Could not parse "${choice}" as a USDC amount.\n`);
        process.exit(1);
      }
      if (parsed < err.required) {
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
  process.stderr.write(`Approving USDC → ${err.spender} (${display})...\n`);
  const tx = await client.commitments.approve(approveAmount);
  process.stderr.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  return true;
}
