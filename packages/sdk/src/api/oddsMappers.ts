/**
 * Shared mappers: per-market odds wire bodies (`api/types.ts`) → public SDK
 * shapes (`types/odds.ts`). The REST snapshot (`api/odds.ts`) and the odds SSE
 * stream (`realtime/oddsStream.ts`) carry the identical per-market body on the
 * wire, so they map through the same functions — one definition means the two
 * paths can't drift on field names or null handling.
 */

import type { MarketType, MoneylineOdds, OddsForMarket, SpreadOdds, TotalOdds } from '../types/odds.js';
import type { MoneylineOddsBody, SpreadOddsBody, TotalOddsBody } from './types.js';

export function mapMoneyline(body: MoneylineOddsBody): MoneylineOdds {
  return {
    market: 'moneyline',
    awayOddsAmerican: body.awayOddsAmerican,
    homeOddsAmerican: body.homeOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}

export function mapSpread(body: SpreadOddsBody): SpreadOdds {
  return {
    market: 'spread',
    awayLine: body.awayLine,
    homeLine: body.homeLine,
    awayOddsAmerican: body.awayOddsAmerican,
    homeOddsAmerican: body.homeOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}

export function mapTotal(body: TotalOddsBody): TotalOdds {
  return {
    market: 'total',
    line: body.line,
    overOddsAmerican: body.overOddsAmerican,
    underOddsAmerican: body.underOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}

/**
 * Decode an odds stream event body (`{ contestId, market, odds }`) into the
 * public shape for the subscribed `market`, or `null` when the event carries
 * no odds (`snapshot` before the writer has populated the market). The shape
 * is keyed off the subscribed market — not the body's `market` field — so the
 * mapper output is always self-consistent. Shared by the SSE transport via the
 * per-market subscription's `decode`.
 */
export function decodeOddsEvent<M extends MarketType>(
  market: M,
  body: unknown,
): OddsForMarket<M> | null {
  const odds = (body as { odds?: unknown } | null)?.odds;
  if (odds === null || odds === undefined) return null;
  switch (market) {
    case 'moneyline':
      return mapMoneyline(odds as MoneylineOddsBody) as OddsForMarket<M>;
    case 'spread':
      return mapSpread(odds as SpreadOddsBody) as OddsForMarket<M>;
    case 'total':
      return mapTotal(odds as TotalOddsBody) as OddsForMarket<M>;
    default:
      return null;
  }
}
