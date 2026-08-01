/**
 * `client.ownState.health()` — public indexer-lag probe consumer
 * (own-state SSE plan §2.6 + §3.3 / amendment A4).
 *
 * Reads `GET /v1/health/own-state` and decodes it into the public
 * {@link OwnStateHealth}. No signer / token: indexer lag is a GLOBAL,
 * wallet-independent signal. A market-maker polls this once per runner tick
 * (the reference implementation's `ownState.auditPollIntervalMs`, default 60s)
 * and folds it into a composite stream-health gate, holding quoting when the
 * indexer falls behind.
 *
 * Sizing a threshold: the indexer writes its cursor after every processed
 * block-range chunk, so in caught-up steady state this value sawtooths roughly
 * 0 → 15s. A threshold at or below that band can read as degraded on a healthy
 * indexer, depending on when the sample lands in the cycle.
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
