/**
 * Smoke tests for the `ospex contests *` command tree. Verifies the
 * command composes without throwing and exposes the expected
 * subcommands. Full action invocation requires a configured client +
 * signer; that path is covered manually per docs/MANUAL_INTEGRATION_TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { makeContestsCommand } from '../src/commands/contests/index.js';

describe('makeContestsCommand', () => {
  it('registers create / score / show / list / wait-verified / scripts as subcommands', () => {
    const root = makeContestsCommand();
    const names = root.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['create', 'list', 'score', 'scripts', 'show', 'wait-verified']);
  });

  it('command name is plural (contests, not contest)', () => {
    const root = makeContestsCommand();
    expect(root.name()).toBe('contests');
  });

  it('create takes a required --game-id (resolved to external IDs server-side)', async () => {
    const root = makeContestsCommand();
    const create = root.commands.find((c) => c.name() === 'create');
    expect(create).toBeDefined();
    if (create === undefined) return;
    const help = create.helpInformation();
    expect(help).toMatch(/--game-id/);
    // External-id flags are gone — they're internal to the SDK now.
    expect(help).not.toMatch(/--rundown-id/);
    expect(help).not.toMatch(/--sportspage-id/);
    expect(help).not.toMatch(/--jsonodds-id/);
  });

  it('score requires the contestId positional argument', () => {
    const root = makeContestsCommand();
    const score = root.commands.find((c) => c.name() === 'score');
    expect(score).toBeDefined();
    if (score === undefined) return;
    expect(score.helpInformation()).toMatch(/<contestId>/);
  });

  it('wait-verified accepts --timeout-seconds', () => {
    const root = makeContestsCommand();
    const wait = root.commands.find((c) => c.name() === 'wait-verified');
    expect(wait).toBeDefined();
    if (wait === undefined) return;
    expect(wait.helpInformation()).toMatch(/--timeout-seconds/);
  });

  it('create --no-wait registers as a negate option mapping to attribute `wait`', () => {
    // Regression: the zod schema for `create` previously read
    // `noWait`, but commander's --no-X convention writes the
    // attribute as `wait` (default true). The mismatch silently
    // dropped the flag and the command always waited. This test
    // pins the option to the commander convention so a future
    // schema rename has to update both ends.
    const root = makeContestsCommand();
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
