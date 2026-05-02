/**
 * Filesystem helpers for sensitive on-disk artifacts (keystore, unlocked
 * session, config). Two operations callers should reach for instead of
 * `fs.writeFile` / `fs.mkdir`:
 *
 *   - `secureWriteFile(path, data)` — atomic, mode-correct write. Creates
 *     a temp file with mode 0600 (POSIX), writes, fsyncs, atomically
 *     renames to the destination, then chmods defensively. Use this for
 *     anything that touches secret material.
 *
 *   - `secureMkdirP(dir)` — `mkdir -p` plus a defensive 0700 chmod.
 *
 * Why this exists at all: `fs.writeFile(path, data, { mode })` only
 * applies `mode` when *creating* the file. Overwriting a path that
 * already exists with mode 0644 leaves it 0644. The reviewer caught
 * this; the helpers below close the gap.
 *
 * Cross-platform notes:
 *   - On Windows, file mode bits are largely a no-op (NTFS uses ACLs).
 *     The chmod calls here cost nothing on Windows but provide defense
 *     in depth on POSIX. Same-user processes can read these files on
 *     either platform regardless — see README for the threat model.
 *   - `fs.rename` is atomic on POSIX; on Windows it replaces the
 *     destination unless it's locked. Acceptable for our use.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';

/**
 * Write `data` to `filePath` atomically with mode 0600 on POSIX. Replaces
 * any existing file at the destination. The intermediate temp file is
 * cleaned up on error; on success it's renamed into place.
 */
export async function secureWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // Random suffix avoids collisions if two CLI invocations race on the
  // same destination. We bound it to one host (no NFS hilarity expected).
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  let handle: fs.FileHandle | undefined;
  try {
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY — refuses to follow a planted
    // symlink at the temp path, and refuses to clobber an existing file.
    handle = await fs.open(tmpPath, 'wx', FILE_MODE);
    await handle.writeFile(data);
    // fsync ensures the bytes are durable before we rename — losing the
    // session file on a power cut is harmless, but losing the keystore
    // would be unrecoverable for the user.
    await handle.sync();
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  await handle.close();

  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  // Belt-and-suspenders: even though POSIX rename preserves the source
  // file's mode (so the destination is 0600 already), assert it post-hoc
  // in case a future Node change weakens that. No-op on Windows.
  if (POSIX) {
    await fs.chmod(filePath, FILE_MODE);
  }
}

/**
 * Ensure `dir` exists with mode 0700 on POSIX. `fs.mkdir`'s `mode`
 * option only applies on creation, so on an already-existing 0755 dir
 * it would otherwise stay 0755 — the explicit chmod fixes that.
 */
export async function secureMkdirP(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (POSIX) {
    await fs.chmod(dir, DIR_MODE);
  }
}

/** Exported for tests so they can assert the constants we're targeting. */
export const _internals = {
  FILE_MODE,
  DIR_MODE,
  POSIX,
  /** Resolves a tmpdir under os.tmpdir() — used by tests. */
  resolveTmpRoot: (): string => path.join(os.tmpdir(), 'ospex-cli-secure-fs'),
};
