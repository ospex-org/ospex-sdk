import type { Delegation, SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { isAddress, isAddressEqual, isHex, type Address, type Hex } from 'viem';
import {
  BET_EXPIRY_SECONDS,
  TOP_UP_EXPIRY_SECONDS,
  buildBetDelegation,
  buildTopUpDelegation,
  ruleWindow,
} from './delegation.js';
import { POLYGON_CHAIN_ID } from './protocol.js';
import { recoverDelegationSigner } from './verifyDelegation.js';

// A signed rule is one delegation plus the login signer that owns the account.
// It travels as text (serializeRule / parseRule), as plain JSON. `format` and
// `kind` are strings and `chainId` is a JSON number; the owner, and every
// address, byte string and number inside the delegation (caveats included),
// are hex strings.

export type RuleKind = 'top-up' | 'bet';

export interface SignedRule {
  format: 'ospex-rule/1';
  kind: RuleKind;
  chainId: number;
  /** The login signer (the embedded wallet's EOA) that owns the smart account. */
  owner: Address;
  /** The signed delegation. `delegator` is the smart account. */
  delegation: Delegation;
}

/** What signTopUpRule and signBetRule need from a Kit smart account. */
export interface RuleSigningAccount {
  address: Address;
  environment: SmartAccountsEnvironment;
  signDelegation(params: { delegation: Omit<Delegation, 'signature'>; chainId?: number }): Promise<Hex>;
}

interface SignArgs {
  account: RuleSigningAccount;
  owner: Address;
  worker: Address;
  nowSeconds: number;
}

async function finish(kind: RuleKind, args: SignArgs, delegation: Omit<Delegation, 'signature'>): Promise<SignedRule> {
  const signature = await args.account.signDelegation({ delegation, chainId: POLYGON_CHAIN_ID });
  // Refuse to hand over a rule the owner did not sign: the account would
  // reject it at redemption, after the worker has paid for the attempt.
  const recovered = await recoverDelegationSigner({
    delegation,
    signature,
    chainId: POLYGON_CHAIN_ID,
    delegationManager: args.account.environment.DelegationManager,
  });
  if (!isAddressEqual(recovered, args.owner)) {
    throw new Error(`the signature recovers to ${recovered}, not the login signer ${args.owner}`);
  }
  return {
    format: 'ospex-rule/1',
    kind,
    chainId: POLYGON_CHAIN_ID,
    owner: args.owner,
    delegation: { ...delegation, signature },
  };
}

/** Builds and signs the one-shot top-up rule (approve PositionModule for `amountUnits`, at most `capUnits`, once, within the hour). */
export function signTopUpRule(args: SignArgs & { amountUnits: bigint; capUnits: bigint }): Promise<SignedRule> {
  const delegation = buildTopUpDelegation({
    environment: args.account.environment,
    from: args.account.address,
    to: args.worker,
    amountUnits: args.amountUnits,
    capUnits: args.capUnits,
    ...ruleWindow(args.nowSeconds, TOP_UP_EXPIRY_SECONDS),
  });
  return finish('top-up', args, delegation);
}

/** Builds and signs the bet permission (matchCommitment only, value 0, for BET_EXPIRY_SECONDS). */
export function signBetRule(args: SignArgs): Promise<SignedRule> {
  const delegation = buildBetDelegation({
    environment: args.account.environment,
    from: args.account.address,
    to: args.worker,
    ...ruleWindow(args.nowSeconds, BET_EXPIRY_SECONDS),
  });
  return finish('bet', args, delegation);
}

export function serializeRule(rule: SignedRule): string {
  return JSON.stringify(rule, null, 2);
}

const isHexField = (v: unknown): v is Hex => typeof v === 'string' && isHex(v, { strict: true });
const isAddressField = (v: unknown): v is Address => typeof v === 'string' && isAddress(v, { strict: false });

/**
 * Parses a rule's text and checks its SHAPE only: types and formats. Whether a
 * worker may redeem the rule is decided by `verifyRule`.
 */
export function parseRule(text: string): SignedRule {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('rule: not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('rule: not a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.format !== 'ospex-rule/1') throw new Error('rule: unknown format');
  if (r.kind !== 'top-up' && r.kind !== 'bet') throw new Error('rule: kind must be top-up or bet');
  if (typeof r.chainId !== 'number') throw new Error('rule: chainId must be a number');
  if (!isAddressField(r.owner)) throw new Error('rule: owner must be an address');

  const d = r.delegation as Record<string, unknown> | null | undefined;
  if (typeof d !== 'object' || d === null) throw new Error('rule: delegation missing');
  if (!isAddressField(d.delegate) || !isAddressField(d.delegator)) {
    throw new Error('rule: delegate and delegator must be addresses');
  }
  if (!isHexField(d.authority) || !isHexField(d.salt) || !isHexField(d.signature)) {
    throw new Error('rule: authority, salt and signature must be hex');
  }
  if (!Array.isArray(d.caveats)) throw new Error('rule: caveats must be an array');
  const caveats = d.caveats.map((c: unknown, i: number) => {
    const cv = c as Record<string, unknown> | null;
    if (typeof cv !== 'object' || cv === null || !isAddressField(cv.enforcer) || !isHexField(cv.terms) || !isHexField(cv.args)) {
      throw new Error(`rule: caveat ${i} must have an enforcer address and hex terms and args`);
    }
    return { enforcer: cv.enforcer, terms: cv.terms, args: cv.args };
  });

  return {
    format: 'ospex-rule/1',
    kind: r.kind,
    chainId: r.chainId,
    owner: r.owner,
    delegation: {
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      caveats,
      salt: d.salt,
      signature: d.signature,
    },
  };
}
