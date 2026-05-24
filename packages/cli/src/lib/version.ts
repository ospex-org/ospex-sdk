/**
 * `CLI_VERSION` / `SDK_VERSION` — resolved once at module load, the single source for
 * every version string the CLI surfaces (agent envelopes, `--version`, doctor `meta`).
 *
 * Two resolution paths:
 *
 *  - **Bundle** (the shipped artifact): `scripts/bundle.mjs` replaces the
 *    `__OSPEX_*_VERSION__` identifiers with string literals via esbuild `--define`, so
 *    the `if` below is statically true and the runtime read is tree-shaken away. A
 *    bundled CLI therefore reads nothing from disk / `node_modules` for its versions —
 *    the whole reason it works under any (even broken) global package store.
 *
 *  - **Dev / tsc / test**: the identifiers are undefined (no define), so we fall back to
 *    reading the package.json files at runtime via `createRequire` — which sidesteps the
 *    `rootDir: "./src"` trip a static `import … with { type: 'json' }` would cause (the
 *    package.jsons live one level above `src`). Best-effort: `'unknown'` on any failure,
 *    never load-bearing.
 */

import { createRequire } from 'node:module';

// Injected at bundle time (esbuild --define). `undefined` in every other build.
declare const __OSPEX_CLI_VERSION__: string | undefined;
declare const __OSPEX_SDK_VERSION__: string | undefined;

interface PkgShape {
  version: string;
}

function resolveVersions(): { cli: string; sdk: string } {
  if (typeof __OSPEX_CLI_VERSION__ === 'string' && typeof __OSPEX_SDK_VERSION__ === 'string') {
    return { cli: __OSPEX_CLI_VERSION__, sdk: __OSPEX_SDK_VERSION__ };
  }
  const require = createRequire(import.meta.url);
  let cli = 'unknown';
  let sdk = 'unknown';
  try {
    cli = (require('../../package.json') as PkgShape).version;
  } catch {
    // best-effort — leave 'unknown'
  }
  try {
    sdk = (require('@ospex/sdk/package.json') as PkgShape).version;
  } catch {
    // SDK package.json unresolvable (e.g. exports map dropped) — leave 'unknown'
  }
  return { cli, sdk };
}

const versions = resolveVersions();

/** The `@ospex/cli` package version. */
export const CLI_VERSION: string = versions.cli;
/** The `@ospex/sdk` version this CLI was built against (bundled in, for the bundle). */
export const SDK_VERSION: string = versions.sdk;
