import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureMkdirP, secureWriteFile } from '../src/lib/secure-fs.js';

const POSIX = process.platform !== 'win32';
const itPosix = POSIX ? it : it.skip;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-secure-fs-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('secureWriteFile', () => {
  it('creates the file with the requested content', async () => {
    const file = path.join(tmpDir, 'a.txt');
    await secureWriteFile(file, 'hello\n');
    const got = await fs.readFile(file, 'utf8');
    expect(got).toBe('hello\n');
  });

  it('overwrites existing content atomically', async () => {
    const file = path.join(tmpDir, 'a.txt');
    await fs.writeFile(file, 'old contents');
    await secureWriteFile(file, 'new contents');
    expect(await fs.readFile(file, 'utf8')).toBe('new contents');
  });

  itPosix('creates a fresh file with mode 0600', async () => {
    const file = path.join(tmpDir, 'fresh.json');
    await secureWriteFile(file, '{}');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  itPosix('tightens an existing 0644 file back to 0600 on overwrite', async () => {
    // Reproduce the exact bug fs.writeFile(path, data, { mode: 0o600 })
    // ships with: mode is creation-only, so an existing 0644 file stays
    // 0644. secureWriteFile must close that gap.
    const file = path.join(tmpDir, 'preexisting.json');
    await fs.writeFile(file, 'pre-existing content');
    await fs.chmod(file, 0o644);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
    await secureWriteFile(file, 'new content');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf8')).toBe('new content');
  });

  it('does not leave temp files behind on success', async () => {
    const file = path.join(tmpDir, 'a.txt');
    await secureWriteFile(file, 'data');
    const entries = await fs.readdir(tmpDir);
    // Only the destination file — no `.a.txt.<pid>.<ts>...tmp` leftovers.
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});

describe('secureMkdirP', () => {
  it('creates a missing directory', async () => {
    const dir = path.join(tmpDir, 'newdir');
    await secureMkdirP(dir);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent on an already-existing directory', async () => {
    const dir = path.join(tmpDir, 'existing');
    await fs.mkdir(dir);
    await expect(secureMkdirP(dir)).resolves.toBeUndefined();
  });

  itPosix('creates the directory with mode 0700', async () => {
    const dir = path.join(tmpDir, 'private');
    await secureMkdirP(dir);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  itPosix('tightens an existing 0755 directory to 0700', async () => {
    const dir = path.join(tmpDir, 'loose');
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755); // ensure umask didn't widen us
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
    await secureMkdirP(dir);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });
});
