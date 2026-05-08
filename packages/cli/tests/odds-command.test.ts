/**
 * Smoke tests for the `ospex odds *` command tree. Verifies the
 * command composes without throwing and exposes both the snapshot
 * (`show`) and streaming (`watch`) subcommands. Full action invocation
 * requires a configured client and live API.
 *
 * Particularly important: `watch` no longer pre-flight rejects on
 * `contest.speculations.length === 0` — speculations are lazy and the
 * Realtime channel filter only needs `jsonoddsId`. We don't run the
 * action here (that requires Supabase Realtime + Polygon RPC), but the
 * code path was reviewed and the `speculations.length` gate has been
 * removed in favor of the existing `jsonoddsId` check.
 */
import { describe, expect, it } from 'vitest';
import { makeOddsCommand } from '../src/commands/odds/index.js';

describe('ospex odds', () => {
  it('registers both `show` and `watch` subcommands', () => {
    const root = makeOddsCommand();
    const names = root.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['show', 'watch']);
  });

  it('show subcommand has --json flag', () => {
    const root = makeOddsCommand();
    const show = root.commands.find((c) => c.name() === 'show');
    expect(show).toBeDefined();
    if (show === undefined) return;
    expect(show.helpInformation()).toMatch(/--json/);
  });

  it('show subcommand takes a positional <contestId>', () => {
    const root = makeOddsCommand();
    const show = root.commands.find((c) => c.name() === 'show');
    expect(show).toBeDefined();
    if (show === undefined) return;
    expect(show.helpInformation()).toMatch(/<contestId>/);
  });

  it('watch subcommand still has --include-refreshes (back-compat)', () => {
    const root = makeOddsCommand();
    const watch = root.commands.find((c) => c.name() === 'watch');
    expect(watch).toBeDefined();
    if (watch === undefined) return;
    const help = watch.helpInformation();
    expect(help).toMatch(/--include-refreshes/);
    expect(help).toMatch(/--json/);
  });

  it('command-tree description distinguishes user vs streaming use', () => {
    const root = makeOddsCommand();
    const description = root.description();
    expect(description).toMatch(/snapshot/);
    expect(description).toMatch(/stream/i);
  });
});
