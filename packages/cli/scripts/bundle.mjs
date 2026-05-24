/**
 * Bundle the `ospex` CLI into ONE self-contained ESM file with every dependency
 * inlined (incl. `@ospex/sdk` + its transitive `viem` / `ethers`). A global install
 * of the bundle therefore has zero runtime deps to resolve, so bare `ospex` works
 * regardless of the host's (possibly broken) global package store — the whole point
 * of bundling. Orthogonal to npm: the output is still an off-registry tarball.
 *
 * Run: `node scripts/bundle.mjs [outfile]` (default `dist/index.js`, the `bin` target).
 *
 * The entry (`src/index.ts`) already carries the `#!/usr/bin/env node` shebang, which
 * esbuild preserves at the very top of the bundle (needed for Unix `bin` execution;
 * harmless on Windows, where npm's generated `.cmd` / `.ps1` shims call `node` directly
 * and ignore it). So the banner adds ONLY the require shim — NOT a second shebang.
 *
 * Banner — a `createRequire` shim: CJS deps that call `require()` (e.g. `commander` →
 * `require('node:events')`) would otherwise hit esbuild's "Dynamic require … is not
 * supported" guard in an ESM bundle; esbuild's `__require` helper delegates to a real
 * `require` when one is in scope, which this provides.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = process.argv[2] ? resolve(process.argv[2]) : join(cliRoot, 'dist', 'index.js');

// Read both versions at build time and inline them via `define`, so the bundled CLI
// never reads package.json / resolves `@ospex/sdk` at runtime for its version strings
// (see lib/version.ts — the runtime fallback there is tree-shaken out of the bundle).
const readVersion = (pkgPath) => JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const cliVersion = readVersion(join(cliRoot, 'package.json'));
const sdkVersion = readVersion(join(cliRoot, '..', 'sdk', 'package.json'));

const banner = [
  "import { createRequire as __ospexCreateRequire } from 'node:module';",
  'const require = __ospexCreateRequire(import.meta.url);',
].join('\n');

await build({
  entryPoints: [join(cliRoot, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  banner: { js: banner },
  define: {
    __OSPEX_CLI_VERSION__: JSON.stringify(cliVersion),
    __OSPEX_SDK_VERSION__: JSON.stringify(sdkVersion),
  },
  logLevel: 'info',
});

console.log(`\nbundled ospex CLI v${cliVersion} (sdk ${sdkVersion}) → ${outfile}`);
