/**
 * Smoke tests for the `ospex odds *` command tree. Verifies the
 * command composes without throwing and exposes both the snapshot
 * (`show`) and streaming (`watch`) subcommands. Full action invocation
 * requires a configured client and live API.
 *
 * `watch` subscribes per market via the core-api odds SSE stream
 * (contest-id native — no upstream id needed) and only fails fast when
 * the contest has no upstream linkage. We don't run the action here
 * (that requires a live API), but the command tree composes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOddsCommand } from '../src/commands/odds/index.js';
import { formatFreshness } from '../src/commands/odds/show.js';

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

  it('show subcommand exposes --market and lists the three values', () => {
    const root = makeOddsCommand();
    const show = root.commands.find((c) => c.name() === 'show');
    expect(show).toBeDefined();
    if (show === undefined) return;
    const help = show.helpInformation();
    expect(help).toMatch(/--market/);
    expect(help).toMatch(/moneyline/);
    expect(help).toMatch(/spread/);
    expect(help).toMatch(/total/);
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

describe('odds show — formatFreshness (price-stability + poll-recency line)', () => {
  // Pin "now" so duration math is deterministic.
  const NOW_ISO = '2026-05-09T05:32:48.000Z';
  const NOW_MS = new Date(NOW_ISO).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders both halves: "price stable for X" and "writer polled Y ago"', () => {
    const out = formatFreshness({
      // Mirrors the real Pistons-Cavaliers contest 8 case from the bug
      // report: total at 212.5 hadn't moved for ~12h but the writer
      // re-fetched the row 5 minutes ago. The previous label
      // ("updated: 12h ago") read as staleness; the new format makes
      // the distinction explicit.
      changedAt: '2026-05-08T17:20:17.344+00:00', // ~12h before NOW
      pollCapturedAt: '2026-05-09T05:27:48.705+00:00', // ~5m before NOW
    });
    expect(out).toBe('price stable for 12h · writer polled 5m ago');
  });

  it('uses second-bucket for very recent moves (under 60s)', () => {
    const out = formatFreshness({
      changedAt: new Date(NOW_MS - 30_000).toISOString(),
      pollCapturedAt: new Date(NOW_MS - 30_000).toISOString(),
    });
    expect(out).toBe('price stable for 30s · writer polled 30s ago');
  });

  it('uses minute-bucket for [60s, 60m)', () => {
    const out = formatFreshness({
      changedAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
      pollCapturedAt: new Date(NOW_MS - 30_000).toISOString(),
    });
    expect(out).toBe('price stable for 5m · writer polled 30s ago');
  });

  it('uses hour-bucket for [1h, 24h)', () => {
    const out = formatFreshness({
      changedAt: new Date(NOW_MS - 3 * 3600_000).toISOString(),
      pollCapturedAt: new Date(NOW_MS - 30_000).toISOString(),
    });
    expect(out).toBe('price stable for 3h · writer polled 30s ago');
  });

  it('uses day-bucket for ≥24h', () => {
    const out = formatFreshness({
      changedAt: new Date(NOW_MS - 3 * 86400_000).toISOString(),
      pollCapturedAt: new Date(NOW_MS - 30_000).toISOString(),
    });
    expect(out).toBe('price stable for 3d · writer polled 30s ago');
  });

  it('falls back to the raw ISO when an input cannot be parsed', () => {
    const out = formatFreshness({
      changedAt: 'not-a-date',
      pollCapturedAt: '2026-05-09T05:27:48Z',
    });
    expect(out).toContain('not-a-date');
    expect(out).toContain('writer polled');
  });
});
