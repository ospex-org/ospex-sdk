import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { ChainId, Hex } from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { loadSigner } from '../../lib/client.js';
import {
  getKeystorePath,
  isFileNotFound,
  resolveCliConfig,
} from '../../lib/config.js';
import { getKeystoreAddressIfPresent } from '../../lib/keystore.js';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  exitAfterStdoutFlush,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { promptHidden } from '../../lib/prompt.js';
import {
  addSignerOptions,
  hasExplicitKeystoreSource,
  parseSignerIntent,
} from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const walletAddressCommand = addSignerOptions(
  new Command('address')
    .description(
      'Print the keystore address. Foundry-produced keystores omit the field; ' +
        'in that case the passphrase is requested to derive it (or supply ' +
        '--password-file for a non-interactive unlock).',
    )
    .option('--json', 'output as JSON'),
)
  .action(async (rawOpts) => {
    const parsed = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const wantJson = parsed.json === true;

    let address: string;
    if (hasExplicitKeystoreSource(signerIntent)) {
      // New flags path: when an explicit keystore source is supplied
      // (--account / --keystore-path / OSPEX_KEYSTORE_PATH), route
      // through `loadSigner` so the agent-friendly --password-file /
      // --password-stdin / OSPEX_PASSWORD_FILE flow works here too.
      const signer = await loadSigner(signerIntent);
      address = await signer.getAddress();
    } else {
      // Legacy path: read the configured keystore directly so users with
      // an ethers-format keystore (top-level `address` field present) get
      // the address without paying for a scrypt decrypt.
      const file = await getKeystorePath();
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (err) {
        if (isFileNotFound(err)) {
          console.error(
            `No keystore at ${file}. Run \`ospex init\` and supply a Foundry ` +
              'keystore path when prompted, set OSPEX_KEYSTORE_PATH for a ' +
              'per-shell override, or pass --account/--keystore-path inline. ' +
              'See docs/QUICKSTART.md.',
          );
          await exitAfterStdoutFlush(1);
        }
        throw err;
      }
      const cached = getKeystoreAddressIfPresent(raw);
      if (cached !== null) {
        address = cached;
      } else {
        const passphrase = await promptHidden('Keystore passphrase: ');
        const signer = await KeystoreSigner.unlock(raw, passphrase);
        address = await signer.getAddress();
      }
    }

    if (wantJson) {
      // No client constructed on this path — pull chainId from the
      // resolved CLI config so the envelope can declare network /
      // chainId without an unnecessary OspexClient round-trip.
      const cfg = await resolveCliConfig();
      const chainId = (cfg.chainId ?? 137) as ChainId;
      const lowercased = address.toLowerCase() as Hex;
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'wallet.address',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          wallet: lowercased,
          walletRole: 'subject',
          signer: lowercased,
          payload: { address },
        }),
      );
      return;
    }
    formatOutput({ address }, { json: false });
  });
