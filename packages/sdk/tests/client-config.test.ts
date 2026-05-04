/**
 * Configuration-validation tests on OspexClient. Reads work without
 * a signer or rpcUrl; chain-write methods throw OspexConfigError
 * when the required dependencies are missing. Catches regressions
 * where a write path silently no-ops or hits an undefined client.
 */

import { describe, expect, it } from 'vitest';
import { OspexClient, OspexConfigError } from '../src/index.js';

describe('OspexClient — write-path config guards', () => {
  it('hasSigner / hasChain reflect constructor args', () => {
    const bare = new OspexClient();
    expect(bare.hasSigner()).toBe(false);
    expect(bare.hasChain()).toBe(false);
    expect(bare.chainId()).toBe(137);
  });

  it('chainId switches when configured', () => {
    const client = new OspexClient({ chainId: 80002 });
    expect(client.chainId()).toBe(80002);
  });

  it('signer() throws OspexConfigError when not configured', () => {
    const client = new OspexClient();
    expect(() => client.signer()).toThrow(OspexConfigError);
  });

  it('commitments.approve throws OspexConfigError on missing signer', async () => {
    const client = new OspexClient({ rpcUrl: 'https://example.test/rpc' });
    await expect(client.commitments.approve('max')).rejects.toBeInstanceOf(OspexConfigError);
  });

  it('commitments.approve throws OspexConfigError on missing rpcUrl', async () => {
    const fakeSigner = {
      getAddress: async () => '0x1111111111111111111111111111111111111111' as const,
      signTypedData: async () => '0x' as const,
      signTransaction: async () => '0x' as const,
    };
    const client = new OspexClient({ signer: fakeSigner });
    await expect(client.commitments.approve('max')).rejects.toBeInstanceOf(OspexConfigError);
  });

  it('reads still work without rpcUrl or signer', async () => {
    // We only need to confirm the read namespaces exist and the
    // lazy-config namespaces don't require chain init at construction
    // time. We don't open a real connection.
    const client = new OspexClient();
    expect(typeof client.contests.list).toBe('function');
    expect(typeof client.contests.get).toBe('function');
    expect(typeof client.commitments.list).toBe('function');
    expect(typeof client.commitments.get).toBe('function');
    expect(typeof client.positions.byAddress).toBe('function');
    expect(typeof client.health).toBe('object');
  });
});
