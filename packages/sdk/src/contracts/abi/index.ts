/**
 * ABI re-exports. Module artifacts are full Foundry outputs, refreshed
 * from the contracts repo on every redeploy. The ERC-20 ABI is
 * hand-written for viem-friendly `as const` typing and is reused for
 * LINK token interactions (balanceOf / allowance / approve).
 */

import contestModuleArtifact from './ContestModule.json' with { type: 'json' };
import matchingModuleArtifact from './MatchingModule.json' with { type: 'json' };
import oracleModuleArtifact from './OracleModule.json' with { type: 'json' };
import positionModuleArtifact from './PositionModule.json' with { type: 'json' };
import speculationModuleArtifact from './SpeculationModule.json' with { type: 'json' };

export const contestModuleAbi = contestModuleArtifact.abi;
export const matchingModuleAbi = matchingModuleArtifact.abi;
export const oracleModuleAbi = oracleModuleArtifact.abi;
export const positionModuleAbi = positionModuleArtifact.abi;
export const speculationModuleAbi = speculationModuleArtifact.abi;
export { erc20Abi } from './erc20.js';
