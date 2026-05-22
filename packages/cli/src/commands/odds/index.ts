/**
 * `ospex odds <subcommand>` — read upstream reference odds.
 *
 * - `show`  — one-shot snapshot for a contest (user-facing default).
 * - `watch` — live SSE stream subscription (agent-facing primitive).
 *
 * Distinct purposes: `show` answers "what are the odds right now so I
 * can decide what commitment price to write?", `watch` answers
 * "subscribe me to future upstream odds changes so an agent can react."
 * They are NOT interchangeable — `--json` semantics differ
 * (single envelope vs line-delimited stream), and `watch` runs until
 * SIGINT while `show` exits after one round-trip.
 */

import { Command } from '@commander-js/extra-typings';
import { oddsShowCommand } from './show.js';
import { oddsWatchCommand } from './watch.js';

export function makeOddsCommand(): Command {
  const odds = new Command('odds').description(
    'Read upstream reference odds — `show` for a one-shot snapshot, `watch` for a live stream.',
  );
  odds.addCommand(oddsShowCommand);
  odds.addCommand(oddsWatchCommand);
  return odds;
}
