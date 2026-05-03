/**
 * `client.contests.scripts()` — fetches and caches the three EIP-712
 * ScriptApproval structs for the deployment's network from
 * core-api `GET /v1/contests/scripts/approved`.
 *
 * Cached per-instance for 5 minutes — re-signed approvals (notably the
 * verify approval, which expires 2026-10-26) propagate to running
 * SDK consumers via core-api redeploy without an SDK release.
 *
 * 503 SCRIPT_APPROVALS_NOT_CONFIGURED bubbles up as
 * OspexScriptApprovalError(reason='not_configured').
 */
import { OspexAPIError, OspexScriptApprovalError } from '../errors.js';
import type { ApprovedScripts } from '../types/contest.js';
import type { ContestsContext } from './context.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  data: ApprovedScripts;
}

export class ScriptsCache {
  private entry: CacheEntry | undefined;

  /** Drop the cached value (test seam + script-rotation forced refresh). */
  invalidate(): void {
    this.entry = undefined;
  }

  async get(ctx: ContestsContext): Promise<ApprovedScripts> {
    const now = Date.now();
    if (this.entry !== undefined && now - this.entry.fetchedAt < CACHE_TTL_MS) {
      return this.entry.data;
    }
    let data: ApprovedScripts;
    try {
      data = await ctx.contestsApi.scripts();
    } catch (err) {
      if (
        err instanceof OspexAPIError &&
        err.status === 503 &&
        err.apiCode === 'SCRIPT_APPROVALS_NOT_CONFIGURED'
      ) {
        throw new OspexScriptApprovalError(
          'No approved scripts are configured for the connected network. Cannot create or score contests until approvals are committed and core-api is redeployed.',
          { reason: 'not_configured', cause: err },
        );
      }
      throw err;
    }
    this.entry = { fetchedAt: now, data };
    return data;
  }
}
