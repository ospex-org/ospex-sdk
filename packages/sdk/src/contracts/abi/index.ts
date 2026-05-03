/**
 * ABI re-exports. The MatchingModule, PositionModule, and SpeculationModule
 * artifacts are full Foundry outputs (refresh by copying from
 * `ospex-foundry-matched-pairs/out/<Module>.sol/<Module>.json`). The ERC-20
 * ABI is hand-written for viem-friendly `as const` typing.
 */

import matchingModuleArtifact from './MatchingModule.json' with { type: 'json' };
import positionModuleArtifact from './PositionModule.json' with { type: 'json' };
import speculationModuleArtifact from './SpeculationModule.json' with { type: 'json' };

export const matchingModuleAbi = matchingModuleArtifact.abi;
export const positionModuleAbi = positionModuleArtifact.abi;
export const speculationModuleAbi = speculationModuleArtifact.abi;
export { erc20Abi } from './erc20.js';
