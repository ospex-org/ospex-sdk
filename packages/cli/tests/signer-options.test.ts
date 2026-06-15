/**
 * Tests for the shared signer-option group + intent parser used by
 * every CLI write command. Pure unit-level — no chain or API I/O.
 * Verifies:
 *   - `addSignerOptions` installs the six flags on a Command
 *   - `signerOptionsSchema` accepts valid combinations and rejects
 *     bad expected-address inputs
 *   - `parseSignerIntent` produces a clean SignerIntent and lower-
 *     cases the expected address
 *   - `hasExplicitKeystoreSource` / `hasNonInteractivePassphrase`
 *     return the right truthiness across the supported sources
 */

import { describe, expect, it } from 'vitest';
import { Command } from '@commander-js/extra-typings';
import {
  addSignerOptions,
  hasExplicitKeystoreSource,
  hasNonInteractivePassphrase,
  parseSignerIntent,
  signerOptionsSchema,
} from '../src/lib/signer-options.js';

describe('addSignerOptions — installs the shared flag group', () => {
  it('exposes --account / --keystore-path / --password-file / --password-stdin / --expected-address / --foundry-keystores-dir', () => {
    const cmd = addSignerOptions(new Command('test'));
    const help = cmd.helpInformation();
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--keystore-path/);
    expect(help).toMatch(/--password-file/);
    expect(help).toMatch(/--password-stdin/);
    expect(help).toMatch(/--expected-address/);
    expect(help).toMatch(/--foundry-keystores-dir/);
  });

  it('does NOT shadow flags the caller already declared', () => {
    const cmd = addSignerOptions(
      new Command('test').option('--my-other-flag <v>', 'kept'),
    );
    const help = cmd.helpInformation();
    expect(help).toMatch(/--my-other-flag/);
    expect(help).toMatch(/--account/);
  });
});

describe('signerOptionsSchema — validation', () => {
  it('accepts an empty input (no signer flags supplied)', () => {
    const parsed = signerOptionsSchema.parse({});
    expect(parsed.account).toBeUndefined();
    expect(parsed.keystorePath).toBeUndefined();
  });

  it('accepts a full Foundry-style configuration', () => {
    const parsed = signerOptionsSchema.parse({
      account: 'maker-a',
      passwordFile: '/etc/secrets/maker-a.pass',
      expectedAddress: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
      foundryKeystoresDir: '/home/agent/.foundry/keystores',
    });
    expect(parsed.account).toBe('maker-a');
    expect(parsed.passwordFile).toBe('/etc/secrets/maker-a.pass');
    expect(parsed.expectedAddress).toMatch(/^0xab12cd34/i);
  });

  it('rejects a malformed --expected-address', () => {
    expect(() =>
      signerOptionsSchema.parse({ expectedAddress: 'not-an-address' }),
    ).toThrow();
    expect(() =>
      signerOptionsSchema.parse({ expectedAddress: '0xabc' }),
    ).toThrow();
  });

  it('passes through extra keys (passthrough mode)', () => {
    // Commands pass the whole rawOpts to the schema; the schema only
    // describes the keys this layer cares about. Extra keys (other
    // option flags on the same command) must not cause a parse error.
    const parsed = signerOptionsSchema.parse({
      account: 'maker-a',
      json: true,
      riskUsdc: '5',
    });
    expect(parsed.account).toBe('maker-a');
  });

  // review warning #4: mutual-exclusion documented in help but
  // not enforced. Failing closed at parse time prevents the loader
  // from silently picking one of the two conflicting sources.

  it('rejects --account AND --keystore-path together', () => {
    expect(() =>
      signerOptionsSchema.parse({
        account: 'maker-a',
        keystorePath: '/path/to/keystore.json',
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects --password-file AND --password-stdin together', () => {
    expect(() =>
      signerOptionsSchema.parse({
        passwordFile: '/etc/pw',
        passwordStdin: true,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('accepts --account alone or --keystore-path alone', () => {
    expect(signerOptionsSchema.parse({ account: 'maker-a' }).account).toBe('maker-a');
    expect(
      signerOptionsSchema.parse({ keystorePath: '/path/to/keystore.json' })
        .keystorePath,
    ).toBe('/path/to/keystore.json');
  });

  it('accepts --password-file alone or --password-stdin alone', () => {
    expect(signerOptionsSchema.parse({ passwordFile: '/etc/pw' }).passwordFile).toBe(
      '/etc/pw',
    );
    expect(signerOptionsSchema.parse({ passwordStdin: true }).passwordStdin).toBe(
      true,
    );
  });
});

describe('parseSignerIntent', () => {
  it('returns an empty intent when no signer flags supplied', () => {
    expect(parseSignerIntent({})).toEqual({});
  });

  it('lower-cases --expected-address', () => {
    const intent = parseSignerIntent({
      expectedAddress: '0xAB12cd34Ab12CD34ab12Cd34aB12CD34aB12cd34',
    });
    expect(intent.expectedAddress).toBe(
      '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
    );
  });

  it('maps `passwordStdin: true` → `fromStdin: true` (SDK helper name)', () => {
    const intent = parseSignerIntent({ passwordStdin: true });
    expect(intent.fromStdin).toBe(true);
  });

  it('omits keys that were not set (no `undefined` leaks)', () => {
    const intent = parseSignerIntent({ account: 'maker-a' });
    expect(intent).toEqual({ account: 'maker-a' });
    expect('keystorePath' in intent).toBe(false);
    expect('passwordFile' in intent).toBe(false);
  });
});

describe('hasNonInteractivePassphrase', () => {
  it('true when --password-file is set', () => {
    expect(hasNonInteractivePassphrase({ passwordFile: '/x' }, {})).toBe(true);
  });

  it('true when --password-stdin is set', () => {
    expect(hasNonInteractivePassphrase({ fromStdin: true }, {})).toBe(true);
  });

  it('true when OSPEX_PASSWORD_FILE env is set', () => {
    expect(
      hasNonInteractivePassphrase({}, { OSPEX_PASSWORD_FILE: '/etc/pw' }),
    ).toBe(true);
  });

  it('false when only OSPEX_PASSWORD_FILE is set to empty string', () => {
    expect(hasNonInteractivePassphrase({}, { OSPEX_PASSWORD_FILE: '' })).toBe(
      false,
    );
  });

  it('false when nothing is set', () => {
    expect(hasNonInteractivePassphrase({}, {})).toBe(false);
  });
});

describe('hasExplicitKeystoreSource', () => {
  it('true when --account is set', () => {
    expect(hasExplicitKeystoreSource({ account: 'maker-a' }, {})).toBe(true);
  });

  it('true when --keystore-path is set', () => {
    expect(hasExplicitKeystoreSource({ keystorePath: '/x' }, {})).toBe(true);
  });

  it('true when OSPEX_KEYSTORE_PATH env is set', () => {
    expect(
      hasExplicitKeystoreSource({}, { OSPEX_KEYSTORE_PATH: '/x' }),
    ).toBe(true);
  });

  it('false when nothing is set', () => {
    expect(hasExplicitKeystoreSource({}, {})).toBe(false);
  });
});
