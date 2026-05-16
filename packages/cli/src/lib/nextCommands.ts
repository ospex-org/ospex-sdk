/**
 * `nextCommands` registry — typed template library for the
 * agent-facing JSON envelope's `nextCommands[]` field.
 *
 * Each command that wants to suggest a follow-up registers a template
 * at its module's top level. The template carries the static metadata
 * (`id`, `suggestedFor`, `safeToAutoRun`) and a `build(params)`
 * function that produces a concrete `AgentNextCommand` at call time.
 *
 *   const VERIFY_COMMITMENT = registerNextCommand({
 *     id: 'verify-commitment',
 *     suggestedFor: 'verify',
 *     safeToAutoRun: true,
 *     build: (params: { hash: string }) => ({
 *       description: 'Verify the submitted commitment',
 *       command: `ospex commitments show ${params.hash}`,
 *       argv:    ['commitments', 'show', params.hash, '--json'],
 *     }),
 *   });
 *
 *   // call site
 *   nextCommands.push(VERIFY_COMMITMENT.build({ hash: '0xabc...' }));
 *
 * The registry is a module-level Map populated as command modules
 * load. It exists primarily so tests can enumerate every registered
 * template and assert its argv parses cleanly through commander —
 * the guardrail that prevents `nextCommands` suggestions from drifting
 * out of sync with the actual CLI flag surface as it evolves.
 *
 * PR-1 ships the infrastructure with an empty registry. Per-command
 * templates land alongside each command's envelope migration in
 * subsequent PRs.
 *
 * Constraints enforced at register time:
 *   - `id` must be unique across the whole registry.
 *   - `safeToAutoRun: true` is allowed only when `suggestedFor === 'verify'`.
 *     Writes (`'complete'`, `'remediate'`) must NEVER be marked safe —
 *     spec §2.6.
 */

import type { AgentNextCommand, AgentNextCommandIntent } from '@ospex/sdk';

/**
 * The mutable parts a per-call template produces. The static metadata
 * (`id`, `suggestedFor`, `safeToAutoRun`) is held on the template
 * itself and stitched in at `build()` time.
 */
export interface NextCommandRendered {
  description: string;
  /** Copy-pasteable form (single shell line). MUST start with the literal `ospex `. */
  command: string;
  /** Argv-array form, omitting the leading `ospex` binary name. Always ends with `--json`. */
  argv: string[];
}

export interface AgentNextCommandTemplate<TParams> {
  readonly id: string;
  readonly suggestedFor: AgentNextCommandIntent;
  readonly safeToAutoRun: boolean;
  /**
   * Per-call render — produces the variable parts of the
   * `AgentNextCommand`. The template's static metadata is added by
   * `build()`.
   */
  readonly render: (params: TParams) => NextCommandRendered;
  /** Convenience: render + assemble the full `AgentNextCommand`. */
  build(params: TParams): AgentNextCommand;
}

/**
 * Module-level singleton. Type-erased so heterogeneous templates can
 * coexist; per-call sites preserve `TParams` typing because they hold
 * the typed template object returned by `registerNextCommand`.
 */
const _registry: Map<string, AgentNextCommandTemplate<unknown>> = new Map();

export interface RegisterNextCommandArgs<TParams> {
  id: string;
  suggestedFor: AgentNextCommandIntent;
  safeToAutoRun: boolean;
  render: (params: TParams) => NextCommandRendered;
}

export function registerNextCommand<TParams>(
  args: RegisterNextCommandArgs<TParams>,
): AgentNextCommandTemplate<TParams> {
  if (_registry.has(args.id)) {
    throw new Error(
      `registerNextCommand: duplicate id "${args.id}". ` +
        `Every nextCommand template needs a unique stable id.`,
    );
  }
  if (args.safeToAutoRun && args.suggestedFor !== 'verify') {
    throw new Error(
      `registerNextCommand: id "${args.id}" sets safeToAutoRun: true with ` +
        `suggestedFor: '${args.suggestedFor}'. Spec §2.6: writes/remediations ` +
        `must never be auto-run; only 'verify' suggestions may be safe.`,
    );
  }
  const template: AgentNextCommandTemplate<TParams> = {
    id: args.id,
    suggestedFor: args.suggestedFor,
    safeToAutoRun: args.safeToAutoRun,
    render: args.render,
    build(params: TParams): AgentNextCommand {
      const rendered = args.render(params);
      return {
        id: args.id,
        description: rendered.description,
        suggestedFor: args.suggestedFor,
        command: rendered.command,
        argv: rendered.argv,
        safeToAutoRun: args.safeToAutoRun,
      };
    },
  };
  _registry.set(args.id, template as AgentNextCommandTemplate<unknown>);
  return template;
}

/* ------------------------------------------------------------------------- */
/* Test surface                                                              */
/* ------------------------------------------------------------------------- */

/** Returns every registered template id. Used by argv-roundtrip tests. */
export function getRegisteredNextCommandIds(): string[] {
  return Array.from(_registry.keys()).sort();
}

/** Lookup a registered template by id. Returns undefined when unknown. */
export function getRegisteredNextCommandTemplate(
  id: string,
): AgentNextCommandTemplate<unknown> | undefined {
  return _registry.get(id);
}

/**
 * Drop every registered template. Tests use this to start with a
 * known-empty registry; production code never calls it.
 */
export function _resetNextCommandRegistryForTests(): void {
  _registry.clear();
}
