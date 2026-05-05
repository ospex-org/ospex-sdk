/**
 * `ospex init` — interactive setup that writes `~/.ospex/config.json`.
 *
 * The most important prompt is the RPC URL: every chain operation needs
 * one, public Polygon RPCs are flaky (`polygon-rpc.com` returns 401
 * since 2026-03 per ospex-foundry-matched-pairs/docs/DEPLOYMENT.md), and
 * the SDK deliberately has no public-RPC default. We require an explicit
 * value and recommend Alchemy / Infura / QuickNode in the prompt.
 *
 * The keystore path prompt persists the bring-your-own-Foundry-keystore
 * pointer so users don't have to `export OSPEX_KEYSTORE_PATH=…` in every
 * shell. Optional — leaving it blank means the runtime falls back to env
 * var or the legacy `~/.ospex/keystore.json` location.
 *
 * The command is non-destructive: existing values are shown as defaults
 * (so re-running `init` is idempotent for unchanged fields).
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { loadConfigFile, saveConfigFile, type CliConfigFile } from '../lib/config.js';
import { promptValue, promptYesNo } from '../lib/prompt.js';

const ALLOWED_CHAIN_IDS = [137, 80002] as const;
const chainIdSchema = z.enum(['137', '80002']);

const optionsSchema = z.object({
  apiUrl: z.string().url().optional(),
  rpcUrl: z.string().url().optional(),
  chainId: chainIdSchema.optional(),
  keystorePath: z.string().optional(),
  yes: z.boolean().optional(),
});

export const initCommand = new Command('init')
  .description('Interactive setup for ~/.ospex/config.json (apiUrl, rpcUrl, chainId, keystorePath).')
  .option('--api-url <url>', 'core-api URL (defaults to production)')
  .option('--rpc-url <url>', 'Polygon RPC URL (Alchemy / Infura / QuickNode recommended)')
  .option('--chain-id <id>', '137 (mainnet) or 80002 (amoy)')
  .option('--keystore-path <path>', 'Foundry-managed keystore path (e.g. ~/.foundry/keystores/<name>)')
  .option('-y, --yes', 'accept all defaults non-interactively (still requires --rpc-url)')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const existing = await loadConfigFile();

    const next: CliConfigFile = { ...existing };

    // Chain id first — defaults flow off it.
    let chainIdStr: string;
    if (opts.chainId !== undefined) {
      chainIdStr = opts.chainId;
    } else if (opts.yes === true) {
      chainIdStr = String(existing.chainId ?? 137);
    } else {
      chainIdStr = await promptValue(
        'Network — 137 (Polygon mainnet) or 80002 (Polygon Amoy)',
        String(existing.chainId ?? 137),
      );
    }
    if (chainIdStr !== '137' && chainIdStr !== '80002') {
      throw new Error(`chainId must be 137 or 80002 (got "${chainIdStr}").`);
    }
    next.chainId = Number(chainIdStr) as (typeof ALLOWED_CHAIN_IDS)[number];

    // API URL — fine to default to prod.
    if (opts.apiUrl !== undefined) {
      next.apiUrl = opts.apiUrl;
    } else if (opts.yes !== true) {
      const v = await promptValue(
        'core-api URL',
        existing.apiUrl ?? 'https://api.ospex.org',
      );
      next.apiUrl = v;
    } else if (existing.apiUrl !== undefined) {
      next.apiUrl = existing.apiUrl;
    }

    // RPC URL — the one we won't default. Public RPCs are flaky and the
    // mainnet public RPC returns 401 since 2026-03; document this here
    // so users see it inline.
    if (opts.rpcUrl !== undefined) {
      next.rpcUrl = opts.rpcUrl;
    } else if (opts.yes === true) {
      if (existing.rpcUrl === undefined) {
        throw new Error(
          'No rpcUrl in existing config and `--yes` set. Pass `--rpc-url <url>` or run init interactively.',
        );
      }
      next.rpcUrl = existing.rpcUrl;
    } else {
      process.stderr.write(
        '\nRPC URL — required for any chain operation (submit / match / approve).\n' +
          'Recommended: Alchemy / Infura / QuickNode. Public RPCs are rate-limited and prone\n' +
          "to drops, and Polygon's public mainnet RPC has been returning 401 since 2026-03.\n" +
          'Examples:\n' +
          '  https://polygon-mainnet.g.alchemy.com/v2/<your-key>\n' +
          '  https://polygon-amoy.g.alchemy.com/v2/<your-key>\n\n',
      );
      next.rpcUrl = existing.rpcUrl !== undefined
        ? await promptValue('RPC URL', existing.rpcUrl)
        : await promptValue('RPC URL');
    }

    // Keystore path — optional. Persists the bring-your-own-Foundry-
    // keystore pointer so users don't have to export OSPEX_KEYSTORE_PATH
    // in every shell. Empty input clears the field (delete, not assign-
    // undefined, because exactOptionalPropertyTypes forbids the latter).
    if (opts.keystorePath !== undefined) {
      if (opts.keystorePath === '') delete next.keystorePath;
      else next.keystorePath = opts.keystorePath;
    } else if (opts.yes !== true) {
      process.stderr.write(
        '\nKeystore path — optional. Point at a Foundry-managed keystore file\n' +
          '(e.g. ~/.foundry/keystores/<name>). Saving it here means future shells\n' +
          "won't need OSPEX_KEYSTORE_PATH set. Hit enter to leave unset (the env var\n" +
          'or the legacy ~/.ospex/keystore.json fallback still apply at runtime).\n\n',
      );
      const raw = existing.keystorePath !== undefined
        ? await promptValue('Keystore path', existing.keystorePath)
        : await promptValue('Keystore path', '');
      if (raw === '') delete next.keystorePath;
      else next.keystorePath = raw;
    } else if (existing.keystorePath !== undefined) {
      next.keystorePath = existing.keystorePath;
    }

    // Confirm before write.
    if (opts.yes !== true) {
      process.stderr.write(
        `\nWriting:\n` +
          `  apiUrl:       ${next.apiUrl ?? '(SDK default)'}\n` +
          `  rpcUrl:       ${next.rpcUrl}\n` +
          `  chainId:      ${next.chainId}\n` +
          `  keystorePath: ${next.keystorePath ?? '(unset; falls back to env or ~/.ospex/keystore.json)'}\n\n`,
      );
      const ok = await promptYesNo('Save?', true);
      if (!ok) {
        process.stderr.write('Aborted; no changes written.\n');
        return;
      }
    }

    await saveConfigFile(next);
    process.stderr.write('Wrote ~/.ospex/config.json\n');
  });
