/**
 * CHANGELOG link-definition consistency.
 *
 * The root CHANGELOG.md ends in a reference-link block that had silently
 * drifted: after v0.5.4 the release-link definitions stopped being added,
 * and `[Unreleased]` kept comparing from v0.5.4 — caught by review as a
 * release-metadata blocker on the v0.13.0 roll. This suite makes the
 * invariant executable so the drift can't restart.
 *
 * Structure: `auditChangelog()` is a pure function returning a list of
 * violations, asserted `[]` against the REAL file. The rules themselves
 * are then each proven live against fixtures that violate exactly one of
 * them — including DUPLICATE definitions and a duplicate `[Unreleased]`
 * heading, which a first draft of this suite missed because it collapsed
 * definitions into a Map before checking anything (a reviewer reproduced
 * a silently-shadowed wrong definition passing 5/5; the counting now
 * happens on the raw parsed entries, before any map).
 *
 * Scope: internal consistency of the FILE only. The check is shape-exact
 * but offline — it does not assert that GitHub serves the URLs (that
 * would need the network, which this suite never touches).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_URL = 'https://github.com/ospex-org/ospex-sdk';

const realText = readFileSync(
  fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)),
  'utf8',
);

interface ParsedChangelog {
  /** `## [x]` heading names, in file order, DUPLICATES PRESERVED. */
  headings: string[];
  /** `[x]: url` definitions, in file order, DUPLICATES PRESERVED. */
  defs: Array<{ name: string; url: string }>;
}

function parseChangelog(text: string): ParsedChangelog {
  const headings: string[] = [];
  const defs: Array<{ name: string; url: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^## \[([^\]]+)\]/.exec(line);
    if (h) headings.push(h[1]!);
    const d = /^\[([^\]]+)\]:\s+(\S+)\s*$/.exec(line);
    if (d) defs.push({ name: d[1]!, url: d[2]! });
  }
  return { headings, defs };
}

/** Pure audit — every violated rule contributes a human-readable line. */
function auditChangelog(text: string): string[] {
  const { headings, defs } = parseChangelog(text);
  const violations: string[] = [];

  const unreleasedCount = headings.filter((h) => h === 'Unreleased').length;
  if (unreleasedCount !== 1) {
    violations.push(`expected exactly one [Unreleased] heading, found ${unreleasedCount}`);
  }
  if (headings[0] !== 'Unreleased') violations.push('[Unreleased] must be the first heading');

  const versions = headings.filter((h) => h !== 'Unreleased');
  if (versions.length === 0) violations.push('no release headings found');

  const seen = new Set<string>();
  for (const v of versions) {
    if (seen.has(v)) violations.push(`duplicate heading [${v}]`);
    seen.add(v);
  }

  const key = (v: string): number[] => v.split('.').map(Number);
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [key(versions[i - 1]!), key(versions[i]!)];
    const newerFirst =
      a[0]! > b[0]! ||
      (a[0] === b[0] && (a[1]! > b[1]! || (a[1] === b[1] && a[2]! > b[2]!)));
    if (!newerFirst) {
      violations.push(
        `headings out of order: [${versions[i - 1]}] must sort newer than [${versions[i]}]`,
      );
    }
  }

  // Exactly one definition per name — counted on the RAW entries, before
  // any map collapse, so a shadowed duplicate cannot hide.
  const counts = new Map<string, number>();
  for (const d of defs) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) violations.push(`[${name}] has ${n} link definitions; expected exactly one`);
  }

  // Every definition — duplicates included — must carry the exact expected
  // URL, and must correspond to a heading.
  const headingSet = new Set(headings);
  const newest = versions[0];
  for (const d of defs) {
    if (!headingSet.has(d.name)) {
      violations.push(`orphan link definition [${d.name}]`);
      continue;
    }
    const want =
      d.name === 'Unreleased'
        ? `${REPO_URL}/compare/v${newest}...HEAD`
        : `${REPO_URL}/releases/tag/v${d.name}`;
    if (d.url !== want) violations.push(`[${d.name}] link is ${d.url}; expected ${want}`);
  }

  for (const h of headingSet) {
    if (!counts.has(h)) violations.push(`missing link definition for [${h}]`);
  }

  return violations;
}

// ── the guard: the real file must audit clean ───────────────────────────

describe('CHANGELOG.md link definitions', () => {
  it('the real CHANGELOG.md has zero violations', () => {
    expect(auditChangelog(realText)).toEqual([]);
  });
});

// ── the rules, each proven live against a violating input ───────────────

const SYNTH = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '—',
  '',
  '## [0.2.0] — 2026-01-02',
  '',
  '### Added',
  '- b',
  '',
  '## [0.1.0] — 2026-01-01',
  '',
  '### Added',
  '- a',
  '',
  `[Unreleased]: ${REPO_URL}/compare/v0.2.0...HEAD`,
  `[0.2.0]: ${REPO_URL}/releases/tag/v0.2.0`,
  `[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0`,
  '',
].join('\n');

describe('auditChangelog — every rule fires on a violating input', () => {
  it('control: the clean synthetic fixture audits clean', () => {
    expect(auditChangelog(SYNTH)).toEqual([]);
  });

  it("REGRESSION (reviewer's exact probe): a shadowed wrong duplicate definition is refused", () => {
    // A first draft collapsed definitions into a Map, so a wrong first
    // definition silently shadowed by a correct second one passed 5/5.
    const mutated = realText.replace(
      `[0.13.0]: ${REPO_URL}/releases/tag/v0.13.0`,
      `[0.13.0]: https://example.invalid/wrong-first-definition\n[0.13.0]: ${REPO_URL}/releases/tag/v0.13.0`,
    );
    expect(mutated).not.toBe(realText); // the probe applied
    const violations = auditChangelog(mutated);
    expect(violations.some((v) => v.includes('[0.13.0] has 2 link definitions'))).toBe(true);
    // The wrong URL is ALSO flagged individually — duplicates are not
    // exempt from the per-definition URL check.
    expect(violations.some((v) => v.includes('example.invalid'))).toBe(true);
  });

  it('two IDENTICAL correct definitions are still refused (the count rule is load-bearing on its own)', () => {
    // Discriminating input: both URLs are correct, so only the
    // exactly-one rule can produce the violation.
    const mutated = SYNTH.replace(
      `[0.2.0]: ${REPO_URL}/releases/tag/v0.2.0`,
      `[0.2.0]: ${REPO_URL}/releases/tag/v0.2.0\n[0.2.0]: ${REPO_URL}/releases/tag/v0.2.0`,
    );
    const violations = auditChangelog(mutated);
    expect(violations).toEqual(['[0.2.0] has 2 link definitions; expected exactly one']);
  });

  it('a duplicate [Unreleased] heading is refused', () => {
    const mutated = realText.replace('## [Unreleased]', '## [Unreleased]\n\n## [Unreleased]');
    expect(
      auditChangelog(mutated).some((v) =>
        v.includes('expected exactly one [Unreleased] heading, found 2'),
      ),
    ).toBe(true);
  });

  it('a missing definition is refused', () => {
    const mutated = SYNTH.replace(`[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0\n`, '');
    expect(auditChangelog(mutated)).toEqual(['missing link definition for [0.1.0]']);
  });

  it('an orphan definition is refused', () => {
    const mutated = SYNTH + `[0.0.9]: ${REPO_URL}/releases/tag/v0.0.9\n`;
    expect(auditChangelog(mutated)).toEqual(['orphan link definition [0.0.9]']);
  });

  it('a stale [Unreleased] target is refused (must compare from the NEWEST heading)', () => {
    // The founding defect: [Unreleased] pinned at an old release while
    // new sections roll in above it.
    const mutated = SYNTH.replace(
      `[Unreleased]: ${REPO_URL}/compare/v0.2.0...HEAD`,
      `[Unreleased]: ${REPO_URL}/compare/v0.1.0...HEAD`,
    );
    expect(auditChangelog(mutated)).toEqual([
      `[Unreleased] link is ${REPO_URL}/compare/v0.1.0...HEAD; expected ${REPO_URL}/compare/v0.2.0...HEAD`,
    ]);
  });

  it('a wrong-form version link is refused', () => {
    const mutated = SYNTH.replace(
      `[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0`,
      `[0.1.0]: ${REPO_URL}/compare/v0.0.1...v0.1.0`,
    );
    expect(auditChangelog(mutated)).toEqual([
      `[0.1.0] link is ${REPO_URL}/compare/v0.0.1...v0.1.0; expected ${REPO_URL}/releases/tag/v0.1.0`,
    ]);
  });

  it('out-of-order headings are refused', () => {
    const mutated = SYNTH.replace('## [0.2.0] — 2026-01-02', '## [0.0.5] — 2026-01-02').replace(
      `[0.2.0]: ${REPO_URL}/releases/tag/v0.2.0`,
      `[0.0.5]: ${REPO_URL}/releases/tag/v0.0.5`,
    );
    const violations = auditChangelog(mutated);
    expect(
      violations.some((v) => v.includes('headings out of order: [0.0.5] must sort newer than [0.1.0]')),
    ).toBe(true);
  });

  it('a duplicate version heading is refused', () => {
    const mutated = SYNTH.replace(
      '## [0.1.0] — 2026-01-01',
      '## [0.1.0] — 2026-01-01\n\n### Fixed\n- x\n\n## [0.1.0] — 2026-01-01',
    );
    expect(auditChangelog(mutated).some((v) => v.includes('duplicate heading [0.1.0]'))).toBe(true);
  });
});
