/**
 * Structure tests for `ospex commitments fillability`. Mirrors the
 * `match-command` convention: assert the flag/argument surface and the
 * advisory framing via `helpInformation()`. The verdict LOGIC is covered by
 * the SDK's `commitments-checkFillability` unit suite; full action invocation
 * (a live chain read) lives in the manual integration playbook.
 *
 * Help text is whitespace-normalized before phrase matching — Commander wraps
 * the description at terminal width, so multi-word phrases would otherwise be
 * split across newlines + indentation.
 */

import { describe, expect, it } from 'vitest';
import { commitmentsFillabilityCommand } from '../src/commands/commitments/fillability.js';

const help = commitmentsFillabilityCommand.helpInformation();
const helpFlat = help.replace(/\s+/g, ' ');
const helpLower = helpFlat.toLowerCase();

describe('commitments fillability — command structure', () => {
  it('takes a hash-or-prefix positional', () => {
    expect(help).toMatch(/<hash-or-prefix>/);
  });

  it('exposes --risk-usdc / --taker / --json', () => {
    expect(help).toMatch(/--risk-usdc/);
    expect(help).toMatch(/--taker/);
    expect(help).toMatch(/--json/);
  });

  it('exposes the shared non-interactive signer option group (for taker resolution)', () => {
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--keystore-path/);
    expect(help).toMatch(/--password-file/);
    expect(help).toMatch(/--password-stdin/);
    expect(help).toMatch(/--expected-address/);
  });

  it('frames the check as advisory and read-only (no tx / no guarantee)', () => {
    expect(helpLower).toMatch(/advisory/);
    // Must read as a non-mutating check, not a fill.
    expect(helpLower).toMatch(/without sending a tx/);
  });

  it('--taker help describes the prospective filler', () => {
    expect(helpLower).toMatch(/prospective taker address/);
  });

  it('--risk-usdc help describes the taker fill risk + full-remaining default', () => {
    expect(helpLower).toMatch(/fill risk/);
    expect(helpLower).toMatch(/remaining capacity/);
  });
});
