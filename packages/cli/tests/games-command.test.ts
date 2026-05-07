/**
 * Smoke tests for the `ospex games *` command tree. Verifies the
 * command composes without throwing and exposes the expected
 * subcommands. Full action invocation requires a configured client
 * and live API; that path is exercised in `docs/MANUAL_INTEGRATION_TESTING.md`.
 */
import { describe, expect, it } from 'vitest';
import { gamesCommand } from '../src/commands/games/index.js';

describe('ospex games', () => {
  it('exposes a `list` subcommand', () => {
    const list = gamesCommand.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
  });

  it('list registers --creatable-only and keeps --all for back-compat', () => {
    const list = gamesCommand.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    if (list === undefined) return;

    const help = list.helpInformation();
    // Default-flip: explicit strict-filter flag is the new spelling.
    expect(help).toMatch(/--creatable-only/);
    // Back-compat: scripts that already pass --all should still parse.
    expect(help).toMatch(/--all/);
  });

  it('list still accepts the existing schedule-window flags', () => {
    const list = gamesCommand.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    if (list === undefined) return;
    const help = list.helpInformation();
    expect(help).toMatch(/--sport/);
    expect(help).toMatch(/--hours/);
    expect(help).toMatch(/--json/);
  });
});
