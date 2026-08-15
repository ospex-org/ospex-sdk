/**
 * CHANGELOG link-definition consistency.
 *
 * The root CHANGELOG.md ends in a reference-link block that had silently
 * drifted: after v0.5.4 the release-link definitions stopped being added,
 * and `[Unreleased]` kept comparing from v0.5.4 — caught by review as a
 * release-metadata blocker on the v0.13.0 roll. This suite makes the
 * invariant executable so the drift can't restart:
 *
 *   - every `## [x.y.z]` heading has exactly one `[x.y.z]:` definition,
 *     in the house form `releases/tag/vx.y.z`;
 *   - every definition corresponds to a heading (no orphans);
 *   - `[Unreleased]` compares from the NEWEST released heading to HEAD,
 *     so rolling a release without repointing it goes red;
 *   - headings are unique and newest-first (Keep a Changelog order).
 *
 * Scope: internal consistency of the FILE only. The check is shape-exact
 * but offline — it does not assert that GitHub serves the URLs (that
 * would need the network, which this suite never touches).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_URL = 'https://github.com/ospex-org/ospex-sdk';

const text = readFileSync(fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)), 'utf8');
const lines = text.split(/\r?\n/);

/** `## [Unreleased]` / `## [0.13.0] — 2026-08-15` → 'Unreleased' / '0.13.0', in file order. */
const headings = lines
  .map((l) => /^## \[([^\]]+)\]/.exec(l)?.[1])
  .filter((v): v is string => v !== undefined);

/** `[0.13.0]: https://…` → name → url. */
const definitions = new Map<string, string>();
for (const l of lines) {
  const m = /^\[([^\]]+)\]:\s+(\S+)\s*$/.exec(l);
  if (m) definitions.set(m[1]!, m[2]!);
}

const versionHeadings = headings.filter((h) => h !== 'Unreleased');
const newest = versionHeadings[0]!;

describe('CHANGELOG.md link definitions', () => {
  it('has an Unreleased heading, at the top, and at least one release', () => {
    expect(headings[0]).toBe('Unreleased');
    expect(versionHeadings.length).toBeGreaterThan(0);
  });

  it('version headings are unique and newest-first', () => {
    expect(new Set(versionHeadings).size).toBe(versionHeadings.length);
    const key = (v: string): number[] => v.split('.').map(Number);
    for (let i = 1; i < versionHeadings.length; i++) {
      const [a, b] = [key(versionHeadings[i - 1]!), key(versionHeadings[i]!)];
      const newerFirst =
        a[0]! > b[0]! ||
        (a[0] === b[0] && a[1]! > b[1]!) ||
        (a[0] === b[0] && a[1] === b[1] && a[2]! > b[2]!);
      expect(newerFirst, `${versionHeadings[i - 1]} must sort newer than ${versionHeadings[i]}`).toBe(
        true,
      );
    }
  });

  it('[Unreleased] compares from the newest released heading to HEAD', () => {
    // Derived from the headings, so rolling a new release section without
    // repointing this definition goes red — the exact defect that shipped
    // with the 0.6.0–0.13.0 roll gap.
    expect(definitions.get('Unreleased')).toBe(`${REPO_URL}/compare/v${newest}...HEAD`);
  });

  it('every version heading has its release-link definition in the house form', () => {
    for (const v of versionHeadings) {
      expect(definitions.get(v), `missing link definition for [${v}]`).toBe(
        `${REPO_URL}/releases/tag/v${v}`,
      );
    }
  });

  it('every definition corresponds to a heading (no orphans)', () => {
    const known = new Set(headings);
    for (const name of definitions.keys()) {
      expect(known.has(name), `orphan link definition [${name}]`).toBe(true);
    }
  });
});
