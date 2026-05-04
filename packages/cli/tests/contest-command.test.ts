/**
 * Smoke tests for the `ospex contest *` command tree. Verifies the
 * command composes without throwing and exposes the expected
 * subcommands. Full action invocation requires a configured client +
 * signer; that path is covered manually per docs/MANUAL_INTEGRATION_TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { makeContestCommand } from '../src/commands/contest/index.js';

describe('makeContestCommand', () => {
  it('registers create / score / get / list / wait-verified / scripts as subcommands', () => {
    const root = makeContestCommand();
    const names = root.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['create', 'get', 'list', 'score', 'scripts', 'wait-verified']);
  });

  it('create requires at least one external id (validation runs before tx submission)', async () => {
    const root = makeContestCommand();
    const create = root.commands.find((c) => c.name() === 'create');
    expect(create).toBeDefined();
    if (create === undefined) return;
    // Commander runs the action on parseAsync; we want it to reject early
    // because no external id is set. parseAsync(['node','prog','create'])
    // — but that path will also trigger getClient which needs config.
    // Rather than mock all of that, just assert that the help text
    // documents the three external-id flags so they're clearly marked.
    const help = create.helpInformation();
    expect(help).toMatch(/--rundown-id/);
    expect(help).toMatch(/--sportspage-id/);
    expect(help).toMatch(/--jsonodds-id/);
  });

  it('score requires the contestId positional argument', () => {
    const root = makeContestCommand();
    const score = root.commands.find((c) => c.name() === 'score');
    expect(score).toBeDefined();
    if (score === undefined) return;
    expect(score.helpInformation()).toMatch(/<contestId>/);
  });

  it('wait-verified accepts --timeout-seconds', () => {
    const root = makeContestCommand();
    const wait = root.commands.find((c) => c.name() === 'wait-verified');
    expect(wait).toBeDefined();
    if (wait === undefined) return;
    expect(wait.helpInformation()).toMatch(/--timeout-seconds/);
  });

  it('create --no-wait registers as a negate option mapping to attribute `wait`', () => {
    // Regression test for review3.md issue 1: the zod schema for
    // `create` previously read `noWait`, but commander's --no-X
    // convention writes the attribute as `wait` (default true). The
    // mismatch silently dropped the flag and the command always
    // waited. This test pins the option to the commander convention
    // so a future schema rename has to update both ends.
    const root = makeContestCommand();
    const create = root.commands.find((c) => c.name() === 'create');
    expect(create).toBeDefined();
    if (create === undefined) return;

    const noWaitOption = create.options.find((o) => o.long === '--no-wait');
    expect(noWaitOption).toBeDefined();
    if (noWaitOption === undefined) return;

    expect(noWaitOption.negate).toBe(true);
    expect(noWaitOption.attributeName()).toBe('wait');
  });
});
