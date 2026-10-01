import {
  CaveatType,
  ScopeType,
  createDelegation,
  type SmartAccountsEnvironment,
} from '@metamask/smart-accounts-kit';
import { encodeFunctionData, erc20Abi, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import {
  APPROVE_SELECTOR,
  MATCHING_MODULE,
  MATCH_COMMITMENT_SELECTOR,
  POSITION_MODULE,
  USDC,
} from './protocol.js';

// The Kit reports each createDelegation / toMetaMaskSmartAccount call (function
// and caveat names, chain id, an anonymous id) to MetaMask's analytics endpoint
// unless it sees Do Not Track. In Kit 2.0.0 it checks once, at its first
// reported call, and keeps that answer for the life of the process or page.
// This package does not need the analytics, so importing it sets Do Not Track,
// best-effort: process.env.DO_NOT_TRACK for the whole Node process, and
// window.doNotTrack in a browser, unless that property is read-only. It has no
// effect if a Kit call was reported before this module loaded.
if (typeof process !== 'undefined' && process.env) process.env.DO_NOT_TRACK = '1';
if (typeof window !== 'undefined') {
  try {
    (window as unknown as { doNotTrack: string }).doNotTrack = '1';
  } catch {
    // Read-only here: left as the browser set it.
  }
}

/** The framework's "anyone may redeem" sentinel. */
export const ANY_DELEGATE: Address = '0x0000000000000000000000000000000000000a11';

/**
 * A placeholder delegate for tests: the 0x…dEaD burn address. A test fixture
 * only; never sign a real rule to it.
 */
export const TEST_DELEGATE: Address = '0x000000000000000000000000000000000000dEaD';

/** The longest bet permission the builder makes, and so the longest the verifier accepts: 90 days. */
export const MAX_DELEGATION_SECONDS = 90 * 24 * 60 * 60;

/** How long the bet permission lasts once signed: 30 days. */
export const BET_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long the top-up rule lasts: an hour. The rule is already bound to one
 * exact call, once.
 */
export const TOP_UP_EXPIRY_SECONDS = 60 * 60;

/**
 * Both rules start a minute in the past. TimestampEnforcer needs the block
 * time strictly after the lower bound, so a rule redeemed in the same second
 * it was signed, or read by a chain whose clock trails the signer's, would
 * otherwise revert.
 */
export const CLOCK_SKEW_SECONDS = 60;

/** The longest window the top-up builder accepts: the expiry plus the back-dating. */
export const MAX_TOP_UP_WINDOW_SECONDS = TOP_UP_EXPIRY_SECONDS + CLOCK_SKEW_SECONDS;

/** The window a rule signed now should carry. */
export function ruleWindow(nowSeconds: number, expirySeconds: number) {
  return { notBefore: nowSeconds - CLOCK_SKEW_SECONDS, notAfter: nowSeconds + expirySeconds };
}

interface RuleParties {
  environment: SmartAccountsEnvironment;
  /** The smart account granting the permission. */
  from: Address;
  /**
   * The worker: the delegate the rule names. It can redeem the rule, as can an
   * address it delegates the rule to, directly or through further delegations
   * (any address, through an open delegation). Every such delegation keeps all
   * of this rule's restrictions.
   */
  to: Address;
  /** Unix seconds. Both bounds are required; the enforcer reads 0 as "no limit". */
  notBefore: number;
  notAfter: number;
}

export type BetDelegationArgs = RuleParties;

export interface TopUpDelegationArgs extends RuleParties {
  /** The allowance to set, in USDC base units (6 decimals). At most `capUnits`. */
  amountUnits: bigint;
  /**
   * The allowance cap, in USDC base units. The caller passes it and there is no
   * default: a missing cap is refused, never read as "no cap".
   */
  capUnits: bigint;
}

function checkParties(fn: string, args: RuleParties, maxWindowSeconds: number) {
  const { from, to, notBefore, notAfter } = args;
  if (!isAddress(from) || !isAddress(to)) {
    throw new Error(`${fn}: from and to must be addresses`);
  }
  if (isAddressEqual(to, ANY_DELEGATE)) {
    throw new Error(`${fn}: refusing an open delegation (any redeemer)`);
  }
  if (isAddressEqual(to, from)) {
    throw new Error(`${fn}: the delegate must not be the granting account`);
  }
  if (!Number.isInteger(notBefore) || !Number.isInteger(notAfter) || notBefore <= 0 || notAfter <= 0) {
    throw new Error(`${fn}: notBefore and notAfter must be positive unix seconds`);
  }
  if (notAfter <= notBefore) {
    throw new Error(`${fn}: notAfter must be after notBefore`);
  }
  if (notAfter - notBefore > maxWindowSeconds) {
    throw new Error(`${fn}: window exceeds ${maxWindowSeconds} seconds`);
  }
}

/**
 * The permission the account signs once: the delegate may call
 * MatchingModule.matchCommitment and nothing else, until it expires.
 *
 * The function-call scope contributes the allowed-targets, allowed-methods and
 * value-lte (zero) caveats; the timestamp caveat adds the expiry. This
 * function only BUILDS the delegation. Nothing here signs or sends.
 */
export function buildBetDelegation(args: BetDelegationArgs) {
  checkParties('buildBetDelegation', args, MAX_DELEGATION_SECONDS);
  const { environment, from, to, notBefore, notAfter } = args;
  return createDelegation({
    environment,
    from,
    to,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [MATCHING_MODULE],
      selectors: [MATCH_COMMITMENT_SELECTOR],
    },
    caveats: [{ type: CaveatType.Timestamp, afterThreshold: notBefore, beforeThreshold: notAfter }],
  });
}

/**
 * The calldata the top-up rule pins: approve(PositionModule, amount). The
 * spender is fixed here and is not a parameter, so no top-up this package builds
 * can approve TreasuryModule or anyone else.
 */
export function topUpCalldata(amountUnits: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [POSITION_MODULE, amountUnits] });
}

/**
 * The one-shot top-up rule: the delegate may call USDC.approve(PositionModule,
 * amount) with exactly that calldata, once, within the hour. The account then
 * holds that allowance, which bounds its stakes; a new market's creation fee is
 * drawn through TreasuryModule instead (see TREASURY_MODULE).
 *
 * Function-call scope (USDC, approve, value 0, exact calldata), plus
 * limited-calls 1 and the timestamp window. Builds only; nothing signs here.
 */
export function buildTopUpDelegation(args: TopUpDelegationArgs) {
  checkParties('buildTopUpDelegation', args, MAX_TOP_UP_WINDOW_SECONDS);
  const { environment, from, to, notBefore, notAfter, amountUnits, capUnits } = args;
  if (typeof amountUnits !== 'bigint' || amountUnits <= 0n) {
    throw new Error('buildTopUpDelegation: amount must be a positive bigint of USDC base units');
  }
  if (typeof capUnits !== 'bigint' || capUnits <= 0n) {
    throw new Error('buildTopUpDelegation: the cap must be a positive bigint of USDC base units');
  }
  if (amountUnits > capUnits) {
    throw new Error(`buildTopUpDelegation: amount exceeds the cap of ${capUnits} units`);
  }
  return createDelegation({
    environment,
    from,
    to,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [USDC],
      selectors: [APPROVE_SELECTOR],
      exactCalldata: { calldata: topUpCalldata(amountUnits) },
    },
    caveats: [
      { type: CaveatType.LimitedCalls, limit: 1 },
      { type: CaveatType.Timestamp, afterThreshold: notBefore, beforeThreshold: notAfter },
    ],
  });
}
