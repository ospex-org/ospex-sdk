/**
 * Verify that every CLI write command exposes the shared signer
 * option group (spec §17, PR 2). One table-driven test per command,
 * checking that --account / --keystore-path / --password-file /
 * --password-stdin / --expected-address all appear in the rendered
 * help. Catches regressions where someone adds a new write command
 * and forgets to wrap it in `addSignerOptions(...)`.
 */

import { describe, expect, it } from 'vitest';
import { approvalsSetupCommand } from '../src/commands/approvals/setup.js';
import { commitmentsApproveCommand } from '../src/commands/commitments/approve.js';
import { commitmentsApproveRawCommand } from '../src/commands/commitments/approve-raw.js';
import { commitmentsCancelCommand } from '../src/commands/commitments/cancel.js';
import { commitmentsCancelAllCommand } from '../src/commands/commitments/cancel-all.js';
import { commitmentsCancelOnchainCommand } from '../src/commands/commitments/cancel-onchain.js';
import { commitmentsSubmitCommand } from '../src/commands/commitments/submit.js';
import { commitmentsSubmitRawCommand } from '../src/commands/commitments/submit-raw.js';
import { contestCreateCommand } from '../src/commands/contests/create.js';
import { contestScoreCommand } from '../src/commands/contests/score.js';
import { positionsClaimCommand } from '../src/commands/positions/claim.js';
import { positionsClaimAllCommand } from '../src/commands/positions/claim-all.js';
import { positionsSettleCommand } from '../src/commands/positions/settle.js';
import { walletAddressCommand } from '../src/commands/wallet/address.js';

const WRITE_COMMANDS = [
  ['approvals setup', approvalsSetupCommand],
  ['commitments approve', commitmentsApproveCommand],
  ['commitments approve-raw', commitmentsApproveRawCommand],
  ['commitments cancel', commitmentsCancelCommand],
  ['commitments cancel-all', commitmentsCancelAllCommand],
  ['commitments cancel-onchain', commitmentsCancelOnchainCommand],
  ['commitments submit', commitmentsSubmitCommand],
  ['commitments submit-raw', commitmentsSubmitRawCommand],
  ['contests create', contestCreateCommand],
  ['contests score', contestScoreCommand],
  ['positions claim', positionsClaimCommand],
  ['positions claim-all', positionsClaimAllCommand],
  ['positions settle', positionsSettleCommand],
  ['wallet address', walletAddressCommand],
] as const;

describe('Every write command exposes the signer option group', () => {
  for (const [name, cmd] of WRITE_COMMANDS) {
    it(`${name} — has --account / --keystore-path / --password-file / --password-stdin / --expected-address`, () => {
      const help = cmd.helpInformation();
      expect(help).toMatch(/--account/);
      expect(help).toMatch(/--keystore-path/);
      expect(help).toMatch(/--password-file/);
      expect(help).toMatch(/--password-stdin/);
      expect(help).toMatch(/--expected-address/);
    });
  }
});
