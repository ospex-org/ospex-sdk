/**
 * Argv-roundtrip test for every registered nextCommand template.
 *
 * Each template's `argv` must parse cleanly through the real CLI
 * commander program. If someone renames a flag (e.g. `--maker` →
 * `--maker-address`) in some command, the template still says
 * `--maker` → broken argv → agent's auto-run fails. This test
 * catches the regression at build time.
 *
 * Implementation:
 *   - Import every command file that registers templates via the
 *     central `nextCommandTemplates.ts` module — this triggers the
 *     `registerNextCommand` calls at module load and populates the
 *     registry.
 *   - For each registered template, render with stub params, then
 *     `parseAsync` the argv through a fresh program with all
 *     action handlers stubbed to no-op (so the parse doesn't
 *     trigger real getClient / network calls).
 *   - Assert no throw from commander.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '@commander-js/extra-typings';
import { makeProgram } from '../src/index.js';
import {
  _resetNextCommandRegistryForTests,
  getRegisteredNextCommandIds,
  getRegisteredNextCommandTemplate,
} from '../src/lib/nextCommands.js';
// Importing the templates module triggers `registerNextCommand`
// calls so the registry is populated by the time the test runs.
import * as _templates from '../src/lib/nextCommandTemplates.js';

// Reference the import to keep TypeScript from tree-shaking it.
void _templates;

// Per-template stub params. Each template's render function expects
// a specific shape; this map provides a synthetic-but-valid input
// so the resulting argv can be parsed.
const STUB_PARAMS: Record<string, unknown> = {
  'verify-commitment': { hash: '0x' + 'ab'.repeat(32) },
  'verify-allowances': { address: '0x' + 'cd'.repeat(20) },
  'verify-position-status': { address: '0x' + 'cd'.repeat(20) },
  'verify-contest': { contestId: '42' },
  'verify-commitments-empty': {
    maker: '0x' + 'cd'.repeat(20),
    contestId: '42',
  },
  'complete-cancel-all': {
    contestId: '42',
    scorer: '0x' + 'ef'.repeat(20),
    lineTicks: -35,
    newMinNonce: '17000000005',
  },
  'complete-claim-all': { address: '0x' + 'cd'.repeat(20) },
  'complete-contests-wait-verified': { contestId: '42' },
  'remediate-approve-position': { requiredUsdc: '25.000000' },
  'remediate-approve-treasury': { requiredUsdc: '1.000000' },
  'remediate-cancel-onchain': { hash: '0x' + 'ab'.repeat(32) },
};

/**
 * Recursively replace every command's action with a no-op so
 * parseAsync doesn't trigger real getClient / RPC calls. Commander's
 * .action() replaces the existing handler.
 */
function stubAllActions(cmd: Command): void {
  const subs = cmd.commands as Command[];
  for (const sub of subs) {
    sub.action(() => {});
    stubAllActions(sub);
  }
  // The root program itself can have an action too if someone added
  // a default. Stub it defensively.
  cmd.action(() => {});
}

function makeTestProgram(): Command {
  const program = makeProgram() as unknown as Command;
  // Suppress help/error output to keep test output clean.
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  // Make parse errors throw (commander's exitOverride) instead of
  // process.exit-ing.
  program.exitOverride();
  stubAllActions(program);
  return program;
}

describe('nextCommands argv-roundtrip through commander', () => {
  // The registry is module-level singleton state. Other tests reset
  // it via `_resetNextCommandRegistryForTests`. We do NOT reset here
  // — we WANT the production templates populated. But if another
  // test order strips them, re-import via dynamic import.
  beforeEach(() => {
    // No-op: registry is populated by the static import at the top.
  });
  afterEach(() => {
    // Don't tear down — leaves the registry intact for subsequent
    // tests in this file.
  });

  it('every PR-7 template has a stub-params entry (no orphans)', () => {
    const ids = getRegisteredNextCommandIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(STUB_PARAMS[id], `no STUB_PARAMS entry for ${id}`).toBeDefined();
    }
  });

  // One test per registered template. Generated dynamically so a
  // template addition surfaces a failure here if STUB_PARAMS isn't
  // updated.
  for (const id of getRegisteredNextCommandIds()) {
    it(`template "${id}" argv parses through commander`, async () => {
      const template = getRegisteredNextCommandTemplate(id);
      expect(template).toBeDefined();
      const params = STUB_PARAMS[id];
      expect(params, `no STUB_PARAMS for ${id}`).toBeDefined();
      const built = template!.build(params);
      // argv omits the leading `ospex` per PR-1 contract. Commander
      // parseAsync expects ['node', 'ospex', ...args].
      const program = makeTestProgram();
      await expect(
        program.parseAsync(['node', 'ospex', ...built.argv]),
      ).resolves.not.toThrow();
    });
  }
});

describe('nextCommands template metadata', () => {
  // Reset between tests in THIS describe block since we're not
  // exercising the production registry.
  beforeEach(() => {
    // Don't reset — the templates file is already imported and
    // the production registry has all the entries.
  });

  it('safeToAutoRun: true only on verify intent', () => {
    for (const id of getRegisteredNextCommandIds()) {
      const t = getRegisteredNextCommandTemplate(id)!;
      if (t.safeToAutoRun) {
        expect(t.suggestedFor, `${id} safeToAutoRun but suggestedFor=${t.suggestedFor}`).toBe(
          'verify',
        );
      }
    }
  });

  it('every verify template ends its argv with --json (read-side stable contract)', () => {
    for (const id of getRegisteredNextCommandIds()) {
      const t = getRegisteredNextCommandTemplate(id)!;
      if (t.suggestedFor === 'verify') {
        const built = t.build(STUB_PARAMS[id]);
        expect(built.argv[built.argv.length - 1], `${id}: argv must end with --json`).toBe(
          '--json',
        );
      }
    }
  });

  it('every template id is kebab-case (stable across SDK versions)', () => {
    const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const id of getRegisteredNextCommandIds()) {
      expect(id, `${id} not kebab-case`).toMatch(kebab);
    }
  });
});
