/**
 * Smoke tests for the `ospex commitments list` command surface. Verifies
 * the option set, including the new taker-view flags (`--raw`, `--side`,
 * `--sort`). Full action invocation requires a live core-API and is not
 * exercised here — the `computeTakerView` math is covered by SDK unit
 * tests in `packages/sdk/tests/commitments-takerView.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { commitmentsListCommand } from '../src/commands/commitments/list.js';

describe('ospex commitments list — surface', () => {
  it('keeps the existing protocol-level filter options', () => {
    const help = commitmentsListCommand.helpInformation();
    expect(help).toMatch(/--maker/);
    expect(help).toMatch(/--scorer/);
    expect(help).toMatch(/--contest-id/);
    expect(help).toMatch(/--speculation/);
    expect(help).toMatch(/--status/);
    expect(help).toMatch(/--include-invalidated/);
    expect(help).toMatch(/--include-expired/);
    expect(help).toMatch(/--limit/);
    expect(help).toMatch(/--offset/);
    expect(help).toMatch(/--full-hash/);
    expect(help).toMatch(/--json/);
  });

  it('exposes --raw for the orderbook-style protocol view', () => {
    const help = commitmentsListCommand.helpInformation();
    expect(help).toMatch(/--raw/);
  });

  it('exposes --side for taker-view filtering', () => {
    const help = commitmentsListCommand.helpInformation();
    expect(help).toMatch(/--side/);
  });

  it('exposes --sort with size|odds|newest', () => {
    const help = commitmentsListCommand.helpInformation();
    expect(help).toMatch(/--sort/);
    expect(help).toMatch(/size/);
    expect(help).toMatch(/odds/);
    expect(help).toMatch(/newest/);
  });

  it('exposes --with-fillability for the advisory maker-funding column', () => {
    const help = commitmentsListCommand.helpInformation();
    expect(help).toMatch(/--with-fillability/);
  });

  it('description documents the default taker-centric mode', () => {
    const desc = commitmentsListCommand.description();
    expect(desc).toMatch(/taker/i);
  });
});
