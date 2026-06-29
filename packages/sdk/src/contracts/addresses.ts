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

// ⚠ STALE — these are the PRE-R5 (R4-era) Amoy addresses. Amoy was redeployed
// for the CRE migration, but the canonical R5 Amoy instance is currently
// AMBIGUOUS: the DeployAmoyCre broadcast artifact shows OspexCore
// 0xe35059…/CreOracleReceiver 0xec3d98…, while the migration notes cite a
// different instance (OspexCore 0x4794De…/receiver 0x7529845C…) — multiple
// Amoy redeploys disagree. Left un-refreshed deliberately rather than baking in
// a guess; do NOT rely on chain 80002 for R5 integration testing until the live
// Amoy instance is confirmed and these are updated. Mainnet (137) is R5-correct.
const POLYGON_AMOY: OspexAddresses = {
  matchingModule: '0x36bc5693ee30cd65f8dce51bd48bc03815091a26',
  positionModule: '0xb7e1c99bb4490be17c9bf4003c0ada6b3b3c6480',
  usdc: '0xB1D1c0A8Cc8BB165b34735972E798f64A785eaF8',
  linkToken: '0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904',
  ospexCore: '0xd47456f17b8f1d232799ae8670330b76a924422e',
  speculationModule: '0x8a757a818b765a8fcb483042af2f514aeb647580',
  contestModule: '0xb6dbd31fc14841777cf3c5e06b31685630d08b69',
  leaderboardModule: '0x274fc351aa6960a5742bd997b75490a9ac324e23',
  rulesModule: '0x2bcd9098add5e3aecea27d2e4d72f9fb18738634',
  treasuryModule: '0x85478f81d395eaf8819119491b1257e6dbf1f662',
  secondaryMarketModule: '0x988707212e45d26e8635356ec6650150fc9466ae',
  oracleModule: '0x0508d9147d1f4c34866550a6f5877bb3aa57a33e',
  scorers: {
    moneyline: '0x2e6fd04bf32e2ffd46aad9549d86ab619938167b',
    spread: '0x0de8b42fe14bf008ef26a510e45f663f083ebd77',
    total: '0xac2ec406c3f1ade03f5e25233b7379faa0fae85b',
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
