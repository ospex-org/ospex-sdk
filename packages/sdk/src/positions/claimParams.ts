/**
 * Thin re-export of the read endpoint, mirroring the file-per-method
 * pattern used by the commitments namespace. The actual implementation
 * lives in `api/positions.ts:PositionsApi.claimParams` — keeping it
 * there means the existing M1 endpoint plumbing (validation, URL
 * encoding) is reused.
 */

import type { PositionsContext } from './context.js';
import type { ClaimParams } from '../types/position.js';

export function claimParams(ctx: PositionsContext, address: string): Promise<ClaimParams> {
  return ctx.positionsApi.claimParams(address);
}
