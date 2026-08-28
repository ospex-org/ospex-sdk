/**
 * Source-level guard: no command may write an envelope and then exit on its own.
 *
 * This exists because prose could not hold the line. Two rounds of review on
 * the same PR both landed on the same defect, and both times the claim in the
 * repo was wider than what had been checked:
 *
 *   round 1 — nineteen read commands emitted then exited, truncating any
 *             envelope past the OS pipe buffer;
 *   round 2 — the fix migrated the `emitJsonFailure(...)` + `process.exit(1)`
 *             SHAPE, and the CHANGELOG then said all 35 envelope-emitting
 *             commands were flush-safe. `doctor` writes with
 *             `writeAgentEnvelope` and exits on a code computed from its
 *             report, so the migration was structurally blind to it, and
 *             `doctor --json` still truncated at 65,534 bytes.
 *
 * The lesson is `verification-discipline.md` §3d-enumerated: a claim that
 * quantifies over a set has to be checked against the set, not against the
 * members a pattern happened to match. So the set is enumerated here, from the
 * source, every run.
 *
 * The runtime half lives in `stdout-flush-and-wallet-shape.test.ts`, which
 * drives one command per emit shape through a real pipe. That proves the
 * mechanism; this proves nobody re-opened the hole somewhere it isn't driven.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CMDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/commands');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Strip comments before matching anything.
 *
 * Not hygiene — load-bearing. Every rule below is explained in a comment that
 * names the very identifiers it forbids, and this file's own header names them
 * too. A matcher run over raw source would find the prose and pass while the
 * code was broken (`verification-discipline.md` §3c: a substring test can match
 * its own explanation).
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const FILES = tsFiles(CMDS).map((f) => ({
  rel: path.relative(CMDS, f).replace(/\\/g, '/'),
  src: code(readFileSync(f, 'utf8')),
}));

/** Anything that puts a v2 envelope on stdout. */
const WRITES_ENVELOPE = /\b(writeAgentEnvelope|emitJsonFailure|emitJsonSuccess)\s*\(/;

describe('envelope emission and process exit are never separated', () => {
  it('finds the command tree (harness check)', () => {
    // A glob that silently matched nothing would make every rule below vacuous.
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES.some((f) => f.rel === 'doctor.ts')).toBe(true);
  });

  it('no envelope write is followed by a bare process.exit', () => {
    // The window is generous on purpose: `doctor`'s write and its exit were
    // five lines and an else-branch apart, and a tight window would have missed
    // exactly the instance that got through review.
    const WINDOW = 900;
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(new RegExp(WRITES_ENVELOPE, 'g'))) {
        const after = src.slice(m.index ?? 0, (m.index ?? 0) + WINDOW);
        if (/\bprocess\.exit\s*\(/.test(after)) {
          offenders.push(`${rel}: ${m[1]} … process.exit within ${WINDOW} chars`);
        }
      }
    }
    expect(
      offenders,
      'An envelope written to stdout is discarded by process.exit() when stdout ' +
        'is a pipe and the payload exceeds the OS pipe buffer. Use ' +
        'emitJsonFailureAndExit / emitJsonSuccess / exitAfterStdoutFlush.',
    ).toStrictEqual([]);
  });

  it('the guard is load-bearing (negative control)', () => {
    // Without this, the rule above passes on a matcher that never matches
    // anything — a regex typo, a changed helper name, a stripped-away window.
    const planted = code(`
      writeAgentEnvelope(buildAgentEnvelope({ ok: true }));
      process.exit(1);
    `);
    const m = planted.match(WRITES_ENVELOPE);
    expect(m, 'the envelope matcher must still recognise a real write').not.toBeNull();
    expect(/\bprocess\.exit\s*\(/.test(planted.slice(m?.index ?? 0, (m?.index ?? 0) + 900))).toBe(true);
  });

  it('a comment mentioning both must NOT trip the rule (negative control)', () => {
    // The other direction: several files explain WHY they no longer pair the
    // two, naming both. If comment-stripping regressed, those explanations
    // would be reported as offences and the suite would go red on prose.
    const prose = code(`
      // Never call writeAgentEnvelope( and then process.exit( — it truncates.
      const x = 1;
    `);
    expect(WRITES_ENVELOPE.test(prose)).toBe(false);
    expect(/\bprocess\.exit\s*\(/.test(prose)).toBe(false);
  });

  it('every surviving bare process.exit writes nothing to stdout first', () => {
    // Six remain, all in amount-parsing catch blocks that write to stderr and
    // exit. They are exempt from the rule above by NOT writing stdout — but
    // "it does not write stdout" is itself a claim, so it is checked rather
    // than trusted, and the count is pinned so a new one cannot join quietly.
    const bare: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(/\bprocess\.exit\s*\(/g)) {
        const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
        const wroteStdout = WRITES_ENVELOPE.test(before) || /process\.stdout\.write\s*\(/.test(before);
        bare.push(`${rel}${wroteStdout ? ' [WROTE STDOUT]' : ''}`);
      }
    }
    expect(bare.filter((b) => b.includes('[WROTE STDOUT]'))).toStrictEqual([]);
    expect(bare.length, 'a new bare process.exit appeared; route it through exitAfterStdoutFlush').toBe(6);
  });
});
