import { ROOT_AUTHORITY, type Delegation, type SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { decodeFunctionData, erc20Abi, isAddressEqual, type Address, type Hex } from 'viem';
import { buildBetDelegation, buildTopUpDelegation } from './delegation.js';
import { POLYGON_CHAIN_ID, POSITION_MODULE } from './protocol.js';
import type { RuleKind, SignedRule } from './rules.js';
import { recoverDelegationSigner } from './verifyDelegation.js';

export class RuleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleRefused';
  }
}

export interface VerifiedRule {
  kind: RuleKind;
  owner: Address;
  /** The smart account (the delegator). */
  account: Address;
  /** The signed delegation, as it will be redeemed. */
  delegation: Delegation;
  notBefore: number;
  notAfter: number;
  /** Top-up rules only: the allowance the rule sets, in USDC base units. */
  amountUnits?: bigint;
}

export interface VerifyRuleContext {
  kind: RuleKind;
  /** The unlocked worker key's address. */
  worker: Address;
  environment: SmartAccountsEnvironment;
  nowSeconds: number;
  /** The counterfactual smart-account address an owner gets (Hybrid, salt 0x). */
  accountFor(owner: Address): Promise<Address>;
  /** The allowance cap, in USDC base units. A top-up rule above it is refused. */
  capUnits: bigint;
}

function onlyCaveat(delegation: Delegation, enforcer: Hex | undefined, name: string) {
  const matches = delegation.caveats.filter((c) => enforcer !== undefined && isAddressEqual(c.enforcer, enforcer));
  if (matches.length !== 1) throw new RuleRefused(`expected exactly one ${name} caveat, found ${matches.length}`);
  return matches[0] as (typeof matches)[number];
}

function readWindow(delegation: Delegation, environment: SmartAccountsEnvironment) {
  const { terms } = onlyCaveat(delegation, environment.caveatEnforcers.TimestampEnforcer, 'timestamp');
  // TimestampEnforcer terms: (uint128 after, uint128 before), packed.
  if (terms.length !== 2 + 64) throw new RuleRefused('timestamp caveat terms are not 32 bytes');
  const after = BigInt(`0x${terms.slice(2, 34)}`);
  const before = BigInt(`0x${terms.slice(34)}`);
  if (after > BigInt(Number.MAX_SAFE_INTEGER) || before > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RuleRefused('timestamp caveat is out of range');
  }
  return { notBefore: Number(after), notAfter: Number(before) };
}

function readTopUpAmount(delegation: Delegation, environment: SmartAccountsEnvironment): bigint {
  const { terms } = onlyCaveat(delegation, environment.caveatEnforcers.ExactCalldataEnforcer, 'exact-calldata');
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: terms });
  } catch {
    throw new RuleRefused('the top-up rule does not pin an ERC-20 call');
  }
  if (decoded.functionName !== 'approve') throw new RuleRefused(`the top-up rule pins ${decoded.functionName}, not approve`);
  const [spender, amount] = decoded.args;
  if (!isAddressEqual(spender, POSITION_MODULE)) {
    throw new RuleRefused(`the top-up rule approves ${spender}, not PositionModule`);
  }
  return amount;
}

const sameCaveats = (a: Delegation['caveats'], b: Delegation['caveats']) =>
  a.length === b.length &&
  a.every(
    (c, i) =>
      isAddressEqual(c.enforcer, b[i]!.enforcer) &&
      c.terms.toLowerCase() === b[i]!.terms.toLowerCase() &&
      c.args.toLowerCase() === b[i]!.args.toLowerCase(),
  );

/**
 * Decides whether this worker may redeem a rule, before anything is sent:
 * right kind and chain, delegated to this worker, from the account the owner's
 * login derives, signed by that owner, inside its window, and with caveats
 * identical to what the page's builder makes for the same parameters. The last
 * check is what stops a rule that grants more than the builder would (another
 * target, a larger top-up, a missing expiry) even when the owner signed it.
 */
export async function verifyRule(rule: SignedRule, ctx: VerifyRuleContext): Promise<VerifiedRule> {
  const { environment } = ctx;
  if (rule.kind !== ctx.kind) throw new RuleRefused(`this is a ${rule.kind} rule; this command needs a ${ctx.kind} rule`);
  if (rule.chainId !== POLYGON_CHAIN_ID) throw new RuleRefused(`the rule is for chain ${rule.chainId}, not ${POLYGON_CHAIN_ID}`);

  const d = rule.delegation;
  if (!isAddressEqual(d.delegate, ctx.worker)) {
    throw new RuleRefused(`the rule delegates to ${d.delegate}, not this worker ${ctx.worker}`);
  }
  if (d.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase()) throw new RuleRefused('the rule is not a root delegation');

  const account = await ctx.accountFor(rule.owner);
  if (!isAddressEqual(d.delegator, account)) {
    throw new RuleRefused(`the rule's account ${d.delegator} is not the account ${account} that owner ${rule.owner} derives`);
  }

  let recovered: Address;
  try {
    recovered = await recoverDelegationSigner({
      delegation: d,
      signature: d.signature,
      chainId: POLYGON_CHAIN_ID,
      delegationManager: environment.DelegationManager,
    });
  } catch {
    throw new RuleRefused('the rule signature is malformed');
  }
  if (!isAddressEqual(recovered, rule.owner)) {
    throw new RuleRefused(`the rule was signed by ${recovered}, not the owner ${rule.owner}`);
  }

  const { notBefore, notAfter } = readWindow(d, environment);
  let amountUnits: bigint | undefined;
  let rebuilt: Omit<Delegation, 'signature'>;
  try {
    if (ctx.kind === 'top-up') {
      amountUnits = readTopUpAmount(d, environment);
      rebuilt = buildTopUpDelegation({
        environment, from: d.delegator, to: d.delegate, notBefore, notAfter, amountUnits, capUnits: ctx.capUnits,
      });
    } else {
      rebuilt = buildBetDelegation({ environment, from: d.delegator, to: d.delegate, notBefore, notAfter });
    }
  } catch (err) {
    if (err instanceof RuleRefused) throw err;
    throw new RuleRefused(`the page's builder would not make this rule: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!sameCaveats(d.caveats, rebuilt.caveats)) {
    throw new RuleRefused("the rule's caveats differ from what the page's builder makes for the same parameters");
  }

  if (ctx.nowSeconds <= notBefore) {
    throw new RuleRefused(`the rule is not valid until ${new Date(notBefore * 1000).toISOString()}`);
  }
  if (ctx.nowSeconds >= notAfter) {
    throw new RuleRefused(`the rule expired at ${new Date(notAfter * 1000).toISOString()}; sign a new one on the page`);
  }

  return {
    kind: ctx.kind,
    owner: rule.owner,
    account,
    delegation: d,
    notBefore,
    notAfter,
    ...(amountUnits !== undefined ? { amountUnits } : {}),
  };
}
