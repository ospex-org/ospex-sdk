/**
 * Smoke tests for the `ospex speculations *` command tree.
 */
import { describe, expect, it } from 'vitest';
import { makeSpeculationsCommand } from '../src/commands/speculations/index.js';

describe('makeSpeculationsCommand', () => {
  it('registers list / show as subcommands', () => {
    const root = makeSpeculationsCommand();
    const names = root.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['list', 'show']);
  });

  it('list documents the expected filter flags', () => {
    const root = makeSpeculationsCommand();
    const list = root.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    if (list === undefined) return;
    const help = list.helpInformation();
    expect(help).toMatch(/--contest <contestId>/);
    expect(help).toMatch(/--sport <sport>/);
    expect(help).toMatch(/--status <status>/);
  });

  it('show takes the speculationId positional', () => {
    const root = makeSpeculationsCommand();
    const show = root.commands.find((c) => c.name() === 'show');
    expect(show).toBeDefined();
    if (show === undefined) return;
    expect(show.helpInformation()).toMatch(/<speculationId>/);
  });
});
