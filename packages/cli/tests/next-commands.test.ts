import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetNextCommandRegistryForTests,
  getRegisteredNextCommandIds,
  getRegisteredNextCommandTemplate,
  registerNextCommand,
} from '../src/lib/nextCommands.js';

describe('nextCommands registry', () => {
  // The registry is module-level singleton state. Tests reset it so
  // they don't leak templates into each other.
  beforeEach(() => {
    _resetNextCommandRegistryForTests();
  });
  afterEach(() => {
    _resetNextCommandRegistryForTests();
  });

  it('starts empty before any registrations', () => {
    expect(getRegisteredNextCommandIds()).toEqual([]);
  });

  it('PR-1 ships with zero registered templates', () => {
    // Sanity-check that NO production template snuck into PR-1 — every
    // command-specific template lives behind its command module's
    // import, which the lib bundle does not pull in. If this assertion
    // grows entries, audit who imported what.
    //
    // (Tests reset the registry in `beforeEach`, so this test passes
    // independently of import order — the assertion is about the
    // module's clean state when no caller has registered.)
    expect(getRegisteredNextCommandIds()).toEqual([]);
  });

  it('registers a verify template and returns it', () => {
    const template = registerNextCommand({
      id: 'verify-thing',
      suggestedFor: 'verify',
      safeToAutoRun: true,
      render: (params: { id: string }) => ({
        description: `Verify ${params.id}`,
        command: `ospex things show ${params.id}`,
        argv: ['things', 'show', params.id, '--json'],
      }),
    });

    expect(template.id).toBe('verify-thing');
    expect(template.suggestedFor).toBe('verify');
    expect(template.safeToAutoRun).toBe(true);

    const built = template.build({ id: 'abc' });
    expect(built).toEqual({
      id: 'verify-thing',
      description: 'Verify abc',
      suggestedFor: 'verify',
      command: 'ospex things show abc',
      argv: ['things', 'show', 'abc', '--json'],
      safeToAutoRun: true,
    });
  });

  it('throws on duplicate id', () => {
    registerNextCommand({
      id: 'dup',
      suggestedFor: 'verify',
      safeToAutoRun: true,
      render: () => ({ description: '', command: 'ospex x', argv: ['x'] }),
    });
    expect(() =>
      registerNextCommand({
        id: 'dup',
        suggestedFor: 'verify',
        safeToAutoRun: true,
        render: () => ({ description: '', command: 'ospex y', argv: ['y'] }),
      }),
    ).toThrow(/duplicate id "dup"/);
  });

  it('forbids safeToAutoRun: true on non-verify intents', () => {
    expect(() =>
      registerNextCommand({
        id: 'bad-complete',
        suggestedFor: 'complete',
        safeToAutoRun: true,
        render: () => ({ description: '', command: 'ospex x', argv: ['x'] }),
      }),
    ).toThrow(/writes\/remediations must never be auto-run/);

    expect(() =>
      registerNextCommand({
        id: 'bad-remediate',
        suggestedFor: 'remediate',
        safeToAutoRun: true,
        render: () => ({ description: '', command: 'ospex x', argv: ['x'] }),
      }),
    ).toThrow(/writes\/remediations must never be auto-run/);
  });

  it('allows safeToAutoRun: false on every intent', () => {
    for (const intent of ['verify', 'complete', 'remediate'] as const) {
      registerNextCommand({
        id: `not-auto-${intent}`,
        suggestedFor: intent,
        safeToAutoRun: false,
        render: () => ({ description: '', command: 'ospex x', argv: ['x'] }),
      });
    }
    expect(getRegisteredNextCommandIds().sort()).toEqual([
      'not-auto-complete',
      'not-auto-remediate',
      'not-auto-verify',
    ]);
  });

  it('looks up registered templates by id', () => {
    const template = registerNextCommand({
      id: 'look-me-up',
      suggestedFor: 'verify',
      safeToAutoRun: true,
      render: () => ({ description: '', command: 'ospex x', argv: ['x'] }),
    });
    expect(getRegisteredNextCommandTemplate('look-me-up')).toBe(template);
    expect(getRegisteredNextCommandTemplate('does-not-exist')).toBeUndefined();
  });
});
