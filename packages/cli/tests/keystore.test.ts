import { describe, expect, it } from 'vitest';
import { getKeystoreAddressIfPresent } from '../src/lib/keystore.js';

describe('getKeystoreAddressIfPresent', () => {
  it('returns the address when present and 0x-prefixed (ethers / legacy ospex import)', () => {
    const raw = JSON.stringify({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      crypto: {},
      version: 3,
    });
    expect(getKeystoreAddressIfPresent(raw)).toBe(
      '0x1234567890abcdef1234567890abcdef12345678',
    );
  });

  it('prefixes 0x when the address is stored without it', () => {
    const raw = JSON.stringify({
      address: '1234567890abcdef1234567890abcdef12345678',
      crypto: {},
      version: 3,
    });
    expect(getKeystoreAddressIfPresent(raw)).toBe(
      '0x1234567890abcdef1234567890abcdef12345678',
    );
  });

  it('returns null when address field is absent (Foundry-style)', () => {
    const raw = JSON.stringify({
      crypto: {},
      id: '00000000-0000-0000-0000-000000000000',
      version: 3,
    });
    expect(getKeystoreAddressIfPresent(raw)).toBeNull();
  });

  it('returns null when address is empty', () => {
    const raw = JSON.stringify({ address: '', crypto: {}, version: 3 });
    expect(getKeystoreAddressIfPresent(raw)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(getKeystoreAddressIfPresent('not-json')).toBeNull();
  });

  it('returns null when address is not a string', () => {
    const raw = JSON.stringify({ address: 1234, crypto: {}, version: 3 });
    expect(getKeystoreAddressIfPresent(raw)).toBeNull();
  });

  it('returns null when JSON parses to a non-object value', () => {
    expect(getKeystoreAddressIfPresent('null')).toBeNull();
    expect(getKeystoreAddressIfPresent('"a string"')).toBeNull();
  });
});
