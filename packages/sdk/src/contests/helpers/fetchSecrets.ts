/**
 * Fetches a fresh encrypted Chainlink Functions secrets URL from
 * ospex-api-server (`POST /api/get-encrypted-secrets`). The server
 * stores a pre-encrypted blob in env vars and returns it verbatim —
 * there's no per-request encryption.
 *
 * Default URL `https://secrets.ospex.org` (protocol-stable alias for
 * the Heroku app `ospex-api`). Override via ContestsContext.apiServerUrl
 * when running locally / in tests.
 */
import { OspexAPIError } from '../../errors.js';
import { OSPEX_API_SERVER_URL } from '../../contracts/constants.js';
import type { Hex } from '../../types/signer.js';
import type { ContestsContext } from '../context.js';

interface SecretsBody {
  encryptedSecretsUrls?: string;
}

export async function fetchEncryptedSecrets(ctx: ContestsContext): Promise<Hex> {
  const baseUrl = (ctx.apiServerUrl ?? OSPEX_API_SERVER_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/api/get-encrypted-secrets`;
  const fetchImpl = ctx.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
  } catch (err) {
    throw new OspexAPIError(`Failed to reach ospex-api-server at ${url}.`, {
      path: '/api/get-encrypted-secrets',
      cause: err,
    });
  }

  if (!response.ok) {
    throw new OspexAPIError(
      `ospex-api-server returned HTTP ${response.status} ${response.statusText}.`,
      { status: response.status, path: '/api/get-encrypted-secrets' },
    );
  }

  let body: SecretsBody;
  try {
    body = (await response.json()) as SecretsBody;
  } catch (err) {
    throw new OspexAPIError('ospex-api-server returned an invalid JSON body.', {
      path: '/api/get-encrypted-secrets',
      cause: err,
    });
  }

  const value = body.encryptedSecretsUrls;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new OspexAPIError(
      'ospex-api-server returned a missing or malformed encryptedSecretsUrls field.',
      { path: '/api/get-encrypted-secrets' },
    );
  }
  return value as Hex;
}
