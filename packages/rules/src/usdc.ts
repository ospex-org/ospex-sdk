import { formatUnits, parseUnits } from 'viem';
import { USDC_DECIMALS } from './protocol.js';

/**
 * A USDC amount typed by a person, to base units. Exact: digits with at most
 * six decimals, more than zero, and no more than the caller's cap: a top-up
 * amount or a bet size, for example.
 */
export function parseUsdc(text: string, capUnits: bigint): bigint {
  const t = text.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(t)) {
    throw new Error(`"${text}" is not a USDC amount (digits, at most six decimals)`);
  }
  const units = parseUnits(t, USDC_DECIMALS);
  if (units <= 0n) throw new Error('the amount must be more than zero');
  if (typeof capUnits !== 'bigint' || capUnits <= 0n) throw new Error('the cap must be a positive bigint of USDC base units');
  if (units > capUnits) throw new Error(`the amount is above the cap of ${formatUnits(capUnits, USDC_DECIMALS)} USDC`);
  return units;
}
