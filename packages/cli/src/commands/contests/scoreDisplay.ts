/**
 * Shared human-output helpers for the scoring commands (`score --wait`,
 * `wait-scored`, `score-status`). The authoritative scoring signal is an
 * on-chain read that carries no team names, so the human score line
 * enriches team names best-effort from the core-api projection — which
 * can lag the on-chain score by minutes, hence non-fatal (fall back to
 * abstract 'Away'/'Home' labels). The Team Identity Rule requires the
 * actual team name paired with its away/home role, never a bare abstract
 * score. JSON payloads keep the raw on-chain numbers, unenriched.
 */
import type { AgentWarning, OspexClient } from '@ospex/sdk';

export interface ScoredTeams {
  awayTeam: string;
  homeTeam: string;
}

export async function resolveTeamsBestEffort(
  client: OspexClient,
  contestId: bigint,
): Promise<ScoredTeams> {
  try {
    const c = await client.contests.get(contestId);
    return {
      awayTeam: c.awayTeam || 'Away',
      homeTeam: c.homeTeam || 'Home',
    };
  } catch {
    // core-api lag / read failure — the score still renders with roles.
    return { awayTeam: 'Away', homeTeam: 'Home' };
  }
}

export function renderScoredLine(
  teams: ScoredTeams,
  awayScore: number | null,
  homeScore: number | null,
): string {
  const a = awayScore ?? 0;
  const h = homeScore ?? 0;
  const outcome = a === h ? 'Tie game.' : `${a > h ? teams.awayTeam : teams.homeTeam} won.`;
  return `Scored. ${teams.awayTeam} (away) ${a} — ${teams.homeTeam} (home) ${h}. ${outcome}`;
}

export function contestVoidedWarning(contestId: bigint): AgentWarning {
  return {
    code: 'contest-voided',
    message:
      `Contest ${contestId} is voided; it will not be scored. ` +
      'Positions void-refund their principal after the void cooldown.',
    severity: 'info',
  };
}
