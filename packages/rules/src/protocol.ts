import { erc20Abi, getAbiItem, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';

export const POLYGON_CHAIN_ID = 137;
export const USDC_DECIMALS = 6;

// Addresses of record: the contracts repo's docs/DEPLOYMENT.md (current round).
export const USDC: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const MATCHING_MODULE: Address = '0x46Af20B6307Aa0Ec13de10EF58a02c5F1b5C9559';
/** The spender the smart account approves. That allowance is the spend cap. */
export const POSITION_MODULE: Address = '0x3C71fdB8ABF41487a512440e5ce6490158C26e56';
/**
 * Pulls the speculation-creation fee (first fill of a new market only). The
 * account's allowance to it stays 0, so the worker can only trade into markets
 * that already exist. Nothing in this package builds an approval to it.
 */
export const TREASURY_MODULE: Address = '0x07f357e67cc9B48D029b1E4C9B7F45569a2eB85C';

/** The public relay. `GET /v1/commitments/:hash` returns a quote's struct and signature. */
export const OSPEX_API_URL = 'https://api.ospex.org';

export const matchingModuleAbi = parseAbi([
  'struct OspexCommitment { address maker; uint256 contestId; address scorer; int32 lineTicks; uint8 positionType; uint16 oddsTick; uint256 riskAmount; uint256 nonce; uint256 expiry; }',
  'function matchCommitment(OspexCommitment commitment, bytes signature, uint256 takerDesiredRisk)',
  'event CommitmentMatched(bytes32 indexed commitmentHash, address indexed maker, address indexed taker, uint256 contestId, uint256 speculationId, address scorer, int32 lineTicks, uint8 makerPositionType, uint16 oddsTick, uint256 makerRisk, uint256 takerRisk, uint256 commitmentRiskAmount, uint256 nonce, uint256 expiry)',
]);

/**
 * The only method the worker's delegation permits. Derived from the ABI above
 * so the two cannot drift; tests pin it to the value the contracts repo's
 * build artifact reports.
 */
export const MATCH_COMMITMENT_SELECTOR: Hex = toFunctionSelector(
  getAbiItem({ abi: matchingModuleAbi, name: 'matchCommitment' }),
);

/** ERC-20 approve(address,uint256): the only method the top-up rule permits. */
export const APPROVE_SELECTOR: Hex = toFunctionSelector(getAbiItem({ abi: erc20Abi, name: 'approve' }));

/** EIP-712 domain and type of a maker's commitment, as MatchingModule hashes it. */
export const COMMITMENT_DOMAIN = {
  name: 'Ospex',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: MATCHING_MODULE,
} as const;

export const COMMITMENT_TYPES = {
  OspexCommitment: [
    { name: 'maker', type: 'address' },
    { name: 'contestId', type: 'uint256' },
    { name: 'scorer', type: 'address' },
    { name: 'lineTicks', type: 'int32' },
    { name: 'positionType', type: 'uint8' },
    { name: 'oddsTick', type: 'uint16' },
    { name: 'riskAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

/**
 * Errors a redemption can revert with, for reading a failed simulation. Written
 * from the contracts' sources; `Error(string)` (the enforcers' and USDC's
 * require messages) is decoded by viem without an entry here.
 */
export const revertErrorsAbi = parseAbi([
  // MatchingModule
  'error MatchingModule__InvalidSignature()',
  'error MatchingModule__OddsOutOfRange(uint16 oddsTick)',
  'error MatchingModule__CommitmentExpired()',
  'error MatchingModule__NonceTooLow()',
  'error MatchingModule__CommitmentCancelled()',
  'error MatchingModule__InvalidLotSize()',
  'error MatchingModule__InvalidMakerAddress()',
  'error MatchingModule__InvalidTakerDesiredRisk()',
  'error MatchingModule__InvalidFillMakerRisk()',
  'error MatchingModule__CommitmentFullyFilled()',
  'error MatchingModule__ContestAlreadyScored()',
  'error MatchingModule__ContestPastCooldown()',
  'error MatchingModule__LineTicksOutOfRange(int32 lineTicks)',
  // DelegationManager / DeleGator
  'error CannotUseADisabledDelegation()',
  'error InvalidAuthority()',
  'error InvalidDelegate()',
  'error InvalidDelegator()',
  'error InvalidEOASignature()',
  'error InvalidERC1271Signature()',
  'error EmptySignature()',
  'error BatchDataLengthMismatch()',
  'error EnforcedPause()',
  'error NotDelegationManager()',
  'error UnsupportedCallType(bytes1 callType)',
  'error UnsupportedExecType(bytes1 execType)',
  // OpenZeppelin SafeERC20
  'error SafeERC20FailedOperation(address token)',
]);
