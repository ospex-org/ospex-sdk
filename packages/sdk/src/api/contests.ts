/**
 * Typed wrapper around `/v1/contests/scripts/approved`. The wider
 * contests namespace (create/get/list/waitForVerified/score) lives at
 * `src/contests/`; this file is purely the API-layer adapter so reads
 * stay parallel to other api/* files (markets, positions, etc.).
 */
import type { ApiClient } from './client.js';
import type { ApprovedScripts, ScriptApproval } from '../types/contest.js';
import type { ApprovedScriptsBody, ScriptApprovalEntryBody } from './types.js';
import type { Hex } from '../types/signer.js';

export class ContestsApi {
  constructor(private readonly client: ApiClient) {}

  async scripts(): Promise<ApprovedScripts> {
    const body = await this.client.request<ApprovedScriptsBody>(
      '/v1/contests/scripts/approved',
    );
    return toApprovedScripts(body);
  }
}

function toApprovedScripts(body: ApprovedScriptsBody): ApprovedScripts {
  return {
    network: body.network,
    approvedSigner: body.approvedSigner as Hex,
    verify: toEntry(body.verify),
    marketUpdate: toEntry(body.marketUpdate),
    score: toEntry(body.score),
  };
}

function toEntry(body: ScriptApprovalEntryBody): ScriptApproval {
  return {
    scriptHash: body.scriptHash as Hex,
    purpose: body.purpose,
    leagueId: body.leagueId,
    version: body.version,
    validUntil: body.validUntil,
    signature: body.signature as Hex,
    sourceUrl: body.sourceUrl,
  };
}
