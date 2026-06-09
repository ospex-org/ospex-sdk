/**
 * `ospex own-state <subcommand>` — owner-authenticated maker view.
 *
 * - `watch` — live composite SSE stream of the wallet's own commitments,
 *   fills, and position transitions (the agent-/operator-facing streaming
 *   primitive; own-state SSE plan Phase 5).
 *
 * The stream is owner-authenticated (EIP-712 challenge → bearer token),
 * so `watch` requires a signer that owns the watched address. Read /
 * one-shot owner-auth surfaces (`client.ownState.snapshot`,
 * `getCommitment`, `health`) are SDK-only today; a `snapshot` /
 * `health` subcommand can join this group if operator demand surfaces.
 */

import { Command } from '@commander-js/extra-typings';
import { ownStateWatchCommand } from './watch.js';

export function makeOwnStateCommand(): Command {
  const ownState = new Command('own-state').description(
    'Owner-authenticated maker view — `watch` streams your commitments, fills, and positions.',
  );
  ownState.addCommand(ownStateWatchCommand);
  return ownState;
}
