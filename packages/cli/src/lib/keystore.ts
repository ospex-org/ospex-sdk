/**
 * Helpers for inspecting v3 JSON keystores without decrypting.
 *
 * Different keystore-producing tools differ in whether they include a
 * top-level `address` field:
 *   - ethers' `encryptKeystoreJson` (used by `KeystoreSigner.encrypt`,
 *     i.e. the legacy `ospex wallet import` path) writes the address.
 *   - Foundry's `cast wallet new` / `cast wallet import` does NOT — only
 *     `crypto`, `id`, and `version` are persisted.
 *
 * Callers that need the address cheaply should call this and, on null,
 * fall back to `KeystoreSigner.unlock(raw, passphrase).getAddress()`.
 */
export function getKeystoreAddressIfPresent(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.address !== 'string' || obj.address.length === 0) return null;
  return obj.address.startsWith('0x') ? obj.address : `0x${obj.address}`;
}
