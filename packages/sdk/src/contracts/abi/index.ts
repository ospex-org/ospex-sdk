/**
 * ABI re-exports. The MatchingModule artifact is the full Foundry output
 * (refresh by copying from `ospex-foundry-matched-pairs/out/`). The
 * ERC-20 ABI is hand-written for viem-friendly `as const` typing.
 */

import matchingModuleArtifact from './MatchingModule.json' with { type: 'json' };

export const matchingModuleAbi = matchingModuleArtifact.abi;
export { erc20Abi } from './erc20.js';
