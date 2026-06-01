/**
 * `client.ownState.health()` — public indexer-lag probe consumer
 * (own-state SSE plan §2.6 + §3.3 / amendment A4).
 *
 * Reads `GET /v1/health/own-state` and decodes it into the public
 * {@link OwnStateHealth}. No signer / token: indexer lag is a GLOBAL,
 * wallet-independent signal. A market-maker polls this (~10 s) and folds
 * `indexerLagSeconds < INDEXER_LAG_MAX` into its composite stream-health gate,
 * holding quoting when the indexer falls behind.
 */

import { OwnStateApi } from '../api/ownState.js';
import type { ApiClient } from '../api/client.js';
import { parseWire } from '../wireSchema.js';
import { OwnStateHealthSchema } from './schemas.js';
import type { OwnStateHealth } from '../types/ownState.js';

export async function loadOwnStateHealth(api: ApiClient): Promise<OwnStateHealth> {
  const wire = await new OwnStateApi(api).health();
  return parseWire(OwnStateHealthSchema, wire);
}
