/**
 * Tests for the `isMainModule` entry-point guard.
 *
 * Hermes PR-72 blocker regression: the naive
 * `process.argv[1] === fileURLToPath(import.meta.url)` comparison
 * failed when the CLI was invoked via the npm/yarn `.bin` symlink
 * (argv[1] = node_modules/.bin/ospex; import.meta.url =
 * node_modules/@ospex/cli/dist/index.js), causing the installed
 * binary to be a no-op. The fix resolves both sides via
 * realpathSync so symlinks collapse before comparison.
 */

import { promises as fs, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainModule } from '../src/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-ismain-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('isMainModule', () => {
  it('returns true when argv[1] points at the same file as import.meta.url', async () => {
    const target = path.join(tmpDir, 'entry.js');
    await fs.writeFile(target, '// entry\n');
    const metaUrl = pathToFileURL(target).toString();
    expect(isMainModule(target, metaUrl)).toBe(true);
  });

  it('returns false when argv[1] points at a different file', async () => {
    const target = path.join(tmpDir, 'entry.js');
    const other = path.join(tmpDir, 'other.js');
    await fs.writeFile(target, '// entry\n');
    await fs.writeFile(other, '// other\n');
    const metaUrl = pathToFileURL(target).toString();
    expect(isMainModule(other, metaUrl)).toBe(false);
  });

  it('returns false when argv[1] is undefined', () => {
    const metaUrl = pathToFileURL(path.join(tmpDir, 'entry.js')).toString();
    expect(isMainModule(undefined, metaUrl)).toBe(false);
  });

  it('returns false when argv[1] points at a path that does not exist', async () => {
    const target = path.join(tmpDir, 'entry.js');
    await fs.writeFile(target, '// entry\n');
    const metaUrl = pathToFileURL(target).toString();
    expect(isMainModule(path.join(tmpDir, 'does-not-exist'), metaUrl)).toBe(false);
  });

  // Hermes PR-72 blocker regression — the .bin symlink case.
  // Mirrors how npm/yarn create a bin symlink that points back
  // into the installed package directory.
  //
  // Skipped on Windows by default: symlinkSync requires admin or
  // Developer Mode, neither guaranteed in CI. The realpathSync
  // logic that fixes the bug runs the same code path regardless
  // of platform — Linux + macOS CI exercises it; Windows tests
  // get coverage from the same-file + different-file cases above.
  const itSkipWindows = process.platform === 'win32' ? it.skip : it;
  itSkipWindows(
    'returns true when argv[1] is a SYMLINK to the file at import.meta.url (the .bin scenario)',
    async () => {
      const target = path.join(tmpDir, 'dist-index.js');
      const symlink = path.join(tmpDir, 'bin-ospex');
      await fs.writeFile(target, '// real entry\n');
      symlinkSync(target, symlink, 'file');
      const metaUrl = pathToFileURL(target).toString();
      // argv[1] is the symlink; import.meta.url is the real file.
      // Before the fix, this returned false; after the fix
      // (realpathSync on both sides), it returns true.
      expect(isMainModule(symlink, metaUrl)).toBe(true);
    },
  );
});
