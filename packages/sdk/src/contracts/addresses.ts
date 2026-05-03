/**
 * On-chain contract addresses per network. Sourced from the canonical
 * deployment artifacts in `ospex-foundry-matched-pairs`:
 *
 *   - Polygon mainnet: docs/deployment/POLYGON_MAINNET_R4.md
 *   - Polygon Amoy:    broadcast/DeployAmoy.s.sol/80002/run-latest.json
 *
 * Refresh on contract redeploy. Mainnet is the production target; Amoy
 * is for integration testing.
 *
 * Active SDK consumers as of M3:
 *   - MatchingModule — commitments.match (M2)
 *   - PositionModule — commitments.{submit,match} allowance, positions.claim (M3)
 *   - SpeculationModule — positions.settleSpeculation (M3)
 *   - OspexCore — read-only event-log address filter for receipt parsing (M3)
 *   - USDC — allowance + transfer
 *
 * The other modules (LeaderboardModule, SecondaryMarketModule, etc.)
 * are stored here for future milestones.
 */

import type { ChainId } from '../types/protocol.js';
import { OspexConfigError } from '../errors.js';

export interface OspexAddresses {
  matchingModule: `0x${string}`;
  positionModule: `0x${string}`;
  usdc: `0x${string}`;
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

const POLYGON_MAINNET: OspexAddresses = {
  matchingModule: '0x1B93579B044f0eE3c4C8a9F479A323DeF7770712',
  positionModule: '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c',
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  ospexCore: '0xECD12Af197FBF4C9F706B5Eb11a19c40Cfd643db',
  speculationModule: '0xd757387893E779AC35451CeA639a408A537b9a1B',
  contestModule: '0x1Eb0048650380369C6F4239dE070114463626102',
  leaderboardModule: '0x63f76D5796296FFB94132C6f70d3ff9c3c5a0DEF',
  rulesModule: '0x05aF3d55F44CfaFA59c3B152A1547b5219d90f93',
  treasuryModule: '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e',
  secondaryMarketModule: '0xaD2B4437296B46a1b107Bb2dB7AC4082182b6059',
  oracleModule: '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb',
  scorers: {
    moneyline: '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b',
    spread: '0x99c5fF5131F269cA178e2Ea78f2a2A222a3a7d5e',
    total: '0xC141679f09413EDe38E3Cd36a3e4aDE423827972',
  },
};

const POLYGON_AMOY: OspexAddresses = {
  matchingModule: '0x36bc5693ee30cd65f8dce51bd48bc03815091a26',
  positionModule: '0xb7e1c99bb4490be17c9bf4003c0ada6b3b3c6480',
  usdc: '0xB1D1c0A8Cc8BB165b34735972E798f64A785eaF8',
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
