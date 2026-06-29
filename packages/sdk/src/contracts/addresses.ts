/**
 * On-chain contract addresses per network. Sourced from the canonical
 * deployment artifacts in the contracts repo and refreshed on every
 * redeploy. Mainnet is the production target; Amoy is for integration
 * testing.
 *
 * Active SDK consumers:
 *   - MatchingModule  — commitments.match
 *   - PositionModule  — commitments.{submit,match} allowance, positions.claim
 *   - SpeculationModule — positions.settleSpeculation
 *   - OspexCore       — read-only event-log address filter for receipt parsing
 *   - USDC            — allowance + transfer
 *
 * The other modules (LeaderboardModule, SecondaryMarketModule, etc.)
 * are stored here for future surface area.
 */

import type { ChainId } from '../types/protocol.js';
import { OspexConfigError } from '../errors.js';

export interface OspexAddresses {
  matchingModule: `0x${string}`;
  positionModule: `0x${string}`;
  usdc: `0x${string}`;
  linkToken: `0x${string}`;
  ospexCore: `0x${string}`;
  speculationModule: `0x${string}`;
  contestModule: `0x${string}`;
  leaderboardModule: `0x${string}`;
  rulesModule: `0x${string}`;
  treasuryModule: `0x${string}`;
  secondaryMarketModule: `0x${string}`;
  oracleModule: `0x${string}`;
  scorers: {
    moneyline: `0x${string}`;
    spread: `0x${string}`;
    total: `0x${string}`;
  };
}

// Polygon mainnet — Round 5 (CRE oracle migration), live since 2026-06-28
// (first tx block 89322650). Cross-checked against the contracts repo
// docs/DEPLOYMENT.md and the DeployPolygonCre broadcast artifact.
const POLYGON_MAINNET: OspexAddresses = {
  matchingModule: '0x46Af20B6307Aa0Ec13de10EF58a02c5F1b5C9559',
  positionModule: '0x3C71fdB8ABF41487a512440e5ce6490158C26e56',
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // native USDC — unchanged from R4
  // DEAD: R4 Functions LINK token. R5/CRE has no caller LINK payment; this
  // field is removed with the rest of the Functions surface in the CRE migration.
  linkToken: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
  ospexCore: '0x40047BAFcdEd16C938058b7b67186299a2893561',
  speculationModule: '0xEA21b58E91eDcA41d0c42A8655234F8A64fa31bc',
  contestModule: '0x0f838AF735E95625905c6acFB887a2E9f4DB9216',
  leaderboardModule: '0x02228F4bAB35d9631296C47C2103789474aD72ee',
  rulesModule: '0x5a5662C8246Ed3dC2422Cc8f773564fA41b34723',
  treasuryModule: '0x07f357e67cc9B48D029b1E4C9B7F45569a2eB85C',
  secondaryMarketModule: '0xf779d82E9a11234767921A73913dAd429F140aFB',
  // DEAD: R5 has no OracleModule (replaced by CreOracleReceiver at
  // 0x06e3470012039797119Ae30e1236169304F9220C in the CRE_ORACLE_RECEIVER
  // slot). This R4 address is retained only so the still-present Functions
  // contest-create/score code compiles; both are removed in the CRE migration.
  oracleModule: '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb',
  scorers: {
    moneyline: '0x59555106D4B5f1A797f3552f60ac418Eb6B6f6BD',
    spread: '0x8f293da716164d5A32dc087A85e5164D929ae9D4',
    total: '0xB4B1E2A2a75C34e9E4C5D3BB8A432aff973DaDa0',
  },
};

// ⚠ Amoy (80002) is NOT actively supported — we do not vouch that it works.
// Amoy was redeployed several times during R5 testing (some runs were throwaway,
// and the most-recent full-protocol deploy was a mainnet rehearsal that isn't
// guaranteed to have a live CRE oracle behind it). Mainnet (137) is the ONLY
// supported target; user-facing docs + the CLI should not steer anyone here
// (Amoy is de-advertised in the Functions→CRE migration). These are the
// most-recent Amoy addresses on record (DeployAmoyCre broadcast, 2026-06-27
// 18:47 UTC) — kept current per "if we must reference one, use the latest", but
// treat them as best-effort. `oracleModule`/`linkToken` are dead R4 fields (see
// mainnet) removed with the rest of the Functions surface.
const POLYGON_AMOY: OspexAddresses = {
  matchingModule: '0xE35333e11F65811EaFEB757b14668fEd0094C1Ef',
  positionModule: '0xef9036B6Fd822ca5140b3909f8d36f6E2d12Ae2F',
  usdc: '0xB1D1c0A8Cc8BB165b34735972E798f64A785eaF8', // mock USDC — unchanged
  linkToken: '0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904', // DEAD (R4; no CRE LINK) — removed in the CRE migration
  ospexCore: '0xE35059DeD09ceC91c6B479169c442712E3C968F4',
  speculationModule: '0x4F98e520E566Fc9c36276D8c832Fe89489ece727',
  contestModule: '0x665027D9D8AEdE296254312e2c1F95a9cd256ccf',
  leaderboardModule: '0x9A4EE9e998290Cc9F99632dBA62E4C70Fc20cA61',
  rulesModule: '0x0093e70cF18745ac80017ac2658b85A586ff2E1F',
  treasuryModule: '0xc18Fb80Da257543626D92cb6CA65151B5abC017A',
  secondaryMarketModule: '0xe42651cf0b508401804DAED5307FC466e046a24d',
  // DEAD: R5 has no OracleModule (CreOracleReceiver is 0xec3d98… on Amoy);
  // retained only so the Functions code compiles; removed in the CRE migration.
  oracleModule: '0x0508d9147d1f4c34866550a6f5877bb3aa57a33e',
  scorers: {
    moneyline: '0x6a273F3E42c1ba212035829b32a73D1E1ef0480e',
    spread: '0xAE0273AF7085bF34AB345209c893bA087Ef23529',
    total: '0x6B9F7886f6400d9e65194a6762FEDA61D1582Ff8',
  },
};

const ADDRESSES_BY_CHAIN: Record<ChainId, OspexAddresses> = {
  137: POLYGON_MAINNET,
  80002: POLYGON_AMOY,
};

export function getAddresses(chainId: ChainId): OspexAddresses {
  const out = ADDRESSES_BY_CHAIN[chainId];
  if (!out) {
    throw new OspexConfigError(
      `No Ospex deployment configured for chain id ${chainId}. Supported: 137 (mainnet), 80002 (amoy).`,
    );
  }
  return out;
}
