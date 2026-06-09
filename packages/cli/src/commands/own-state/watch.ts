/**
 * `ospex own-state watch [--address <wallet>]` — opens the owner-auth
 * composite own-state SSE stream (own-state SSE plan §2.4, Phase 5) and
 * prints one line per event. Line-delimited JSON in `--json` mode (one
 * object per line, suitable for piping / artifact capture); a compact
 * text summary in human mode.
 *
 * Events surfaced (the `kind` discriminator per line):
 *   - `snapshot`       — a snapshot page (cold-start baseline; more pages
 *                        follow when `truncated:true`).
 *   - `ready`          — catch-up complete; "safe to trade" boundary.
 *   - `commitment`     — an owner-commitment lifecycle delta.
 *   - `fill`           — an append-only fill (maker- or taker-side).
 *   - `positionStatus` — a position lifecycle transition.
 *   - `status`         — transport status: connected / reconnecting /
 *                        degraded / resync.
 *   - `heartbeat`      — an SSE heartbeat frame; the freshness pulse on a
 *                        quiet wallet (every ~20s).
 *   - `error`          — a non-fatal transport error (the SDK keeps
 *                        reconnecting unless `reason:'fatal'`).
 *   - `summary`        — emitted once on exit; event counts + the
 *                        stream-observed live-commitment tally.
 *
 * Auth: the stream is owner-authenticated, so a signer is required. It
 * is resolved non-interactively via the standard Foundry signer flag
 * group (`--account` / `--password-file` / `--expected-address` / …);
 * `--address` is the wallet the stream is scoped to and defaults to the
 * resolved signer address. When `--address` is supplied AND differs from
 * the resolved signer, the command refuses up-front (the server would
 * reject the EIP-712 challenge anyway — failing fast is friendlier).
 *
 * Public-safety: this command's output is meant to be captured as soak /
 * artifact evidence in the PUBLIC artifacts repo. By default it REDACTS
 * the EIP-712 `signature` and the `signedPayload` struct from every owner
 * commitment (replacing them with a `signedPayloadPresent` boolean) —
 * those are the only fields that would let a third party act on-chain
 * against the maker's orders. Every economic / lifecycle / identity field
 * is preserved. Pass `--include-signed` to emit the full payload for
 * local-only debugging; never feed that output into a public artifact.
 *
 * Bounded run (for artifact capture):
 *   - `--until-ready`        — exit 0 after the first `ready` (or exit 1
 *                              if no ready within `--ready-timeout`).
 *   - `--duration <seconds>` — run for N seconds, then clean exit 0.
 *   - `--max-events <n>`     — exit 0 after N delta events (commitment /
 *                              fill / positionStatus).
 * With none of these, the command runs until SIGINT (Ctrl+C) / SIGTERM.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexValidationError,
  type Fill,
  type OwnerCommitment,
  type OwnerPosition,
  type OwnerStateSnapshot,
  type OwnerStateSubscribeStatus,
  type OwnStateEventMeta,
  type OwnStateFrameMeta,
  type PositionStatusEvent,
  type StoredCommitmentStatus,
  type Subscription,
} from '@ospex/sdk';
import type { OspexStreamError, OspexStreamErrorPhase, OspexStreamReason } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import { sanitizeUntargetedMessage } from '../../lib/redact.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

/* ------------------------------------------------------------------------- */
/* Redaction projection                                                      */
/* ------------------------------------------------------------------------- */

/**
 * An {@link OwnerCommitment} with the EIP-712 signing material removed —
 * `signature` and the full `signedPayload` struct are dropped (replaced by
 * `signedPayloadPresent`), the API-layer `redacted:false` marker is dropped
 * (it would misleadingly imply the OUTPUT is unredacted), and a
 * `signatureRedacted:true` marker is added. Every economic / lifecycle /
 * identity field survives so the line is still fully usable for soak
 * validation. This is the default shape emitted on every `commitment` line
 * and inside every `snapshot` page.
 */
export type RedactedOwnerCommitment = Omit<
  OwnerCommitment,
  'signature' | 'signedPayload' | 'redacted'
> & {
  signatureRedacted: true;
  signedPayloadPresent: boolean;
};

/**
 * Strip the signing material off an owner commitment. The ONLY fields that
 * let a third party forge a match / replay are `signature` and the embedded
 * `signedPayload.signature`; dropping the signature and the whole
 * `signedPayload` struct makes the remaining fields inert (the struct
 * fields — nonce, oddsTick, riskAmount, … — cannot be acted on without the
 * maker's signature). Pure + exported so the redaction contract is unit
 * tested with concrete leak assertions.
 */
export function redactOwnerCommitment(c: OwnerCommitment): RedactedOwnerCommitment {
  const {
    signature: _signature,
    signedPayload,
    redacted: _redacted,
    ...rest
  } = c;
  return {
    ...rest,
    signatureRedacted: true,
    signedPayloadPresent: signedPayload !== null,
  };
}

/** Project a commitment for output: redacted by default, raw when opted in. */
export function projectCommitment(
  c: OwnerCommitment,
  includeSigned: boolean,
): OwnerCommitment | RedactedOwnerCommitment {
  return includeSigned ? c : redactOwnerCommitment(c);
}

/* ------------------------------------------------------------------------- */
/* Live-set accounting (passive-expiry-correct)                              */
/* ------------------------------------------------------------------------- */

/**
 * The slice of an {@link OwnerCommitment} the watcher retains per hash so it
 * can RECOMPUTE liveness against the current wall clock — at summary time and
 * on each heartbeat — rather than trusting a cached boolean.
 *
 * We deliberately do NOT store the server's `isLive` flag. Commitment EXPIRY
 * is passive and time-based: it crosses with NO SSE delta. A row received
 * `isLive:true` with a future expiry would otherwise stay "live" in memory
 * forever — past its actual expiry — until a terminal SSE frame that never
 * arrives. (A fresh watcher recomputes from a current snapshot, which is why
 * the same wallet read fresh correctly shows zero.) The non-time fields
 * (`storedStatus` / `remainingRiskAmount` / `nonceInvalidated`) DO change via
 * `commitment` deltas, so the last-received value is current for those; only
 * the expiry comparison must be re-evaluated against `now`.
 */
export interface TrackedCommitment {
  storedStatus: StoredCommitmentStatus;
  /** wei6 decimal string. */
  remainingRiskAmount: string;
  /** ISO-8601, or null on a legacy row that never carried an expiry. */
  expiry: string | null;
  nonceInvalidated: boolean;
}

/** Extract the liveness-relevant slice of an owner commitment. */
export function trackCommitment(c: OwnerCommitment): TrackedCommitment {
  return {
    storedStatus: c.storedStatus,
    remainingRiskAmount: c.remainingRiskAmount,
    expiry: c.expiry,
    nonceInvalidated: c.nonceInvalidated,
  };
}

/**
 * Re-derive the canonical "still matchable on chain" predicate at time
 * `nowMs`, mirroring core-api's `OwnerCommitment.isLive` derivation but with
 * the expiry compared to the CURRENT clock — the whole point of the fix:
 *
 *   storedStatus ∈ {open, partially_filled}
 *   AND NOT nonceInvalidated
 *   AND remainingRiskAmount > 0
 *   AND (expiry is null OR expiry is strictly in the future)
 *
 * A null expiry is a legacy no-expiry row that never time-expires.
 * `Date.parse` (ms precision) is fine here — expiry is a coarse boundary,
 * not a cursor comparison. An UNPARSEABLE expiry is treated as non-expiring
 * (we never age a row out on a parse failure — that would be the opposite,
 * more-dangerous bug of dropping a still-live row).
 */
export function isLiveAt(c: TrackedCommitment, nowMs: number): boolean {
  if (c.storedStatus !== 'open' && c.storedStatus !== 'partially_filled') return false;
  if (c.nonceInvalidated) return false;
  let remaining: bigint;
  try {
    remaining = BigInt(c.remainingRiskAmount);
  } catch {
    return false; // unparseable remaining → not provably live
  }
  if (remaining <= 0n) return false;
  if (c.expiry !== null) {
    const expMs = Date.parse(c.expiry);
    if (!Number.isNaN(expMs) && expMs <= nowMs) return false;
  }
  return true;
}

/** Count tracked commitments that are live AS OF `nowMs`. */
export function countLiveAt(map: Map<string, TrackedCommitment>, nowMs: number): number {
  let n = 0;
  for (const c of map.values()) if (isLiveAt(c, nowMs)) n += 1;
  return n;
}

/* ------------------------------------------------------------------------- */
/* Line shapes                                                               */
/* ------------------------------------------------------------------------- */

export type ExitReason =
  | 'until-ready'
  | 'ready-timeout'
  | 'duration'
  | 'max-events'
  | 'signal'
  | 'fatal';

export interface WatchCounts {
  snapshot: number;
  ready: number;
  commitment: number;
  fill: number;
  positionStatus: number;
  status: number;
  heartbeat: number;
  error: number;
}

export type WatchLine =
  | {
      kind: 'snapshot';
      at: string;
      address: string;
      cursor: string;
      truncated: boolean;
      positionsTruncated: boolean;
      commitmentCount: number;
      positionCount: number;
      commitments?: Array<OwnerCommitment | RedactedOwnerCommitment>;
      positions?: OwnerPosition[];
    }
  | { kind: 'ready'; at: string; address: string; cursor: string }
  | {
      kind: 'commitment';
      at: string;
      address: string;
      cursor: string;
      commitment: OwnerCommitment | RedactedOwnerCommitment;
    }
  | { kind: 'fill'; at: string; address: string; cursor: string; fill: Fill }
  | {
      kind: 'positionStatus';
      at: string;
      address: string;
      cursor: string;
      event: PositionStatusEvent;
    }
  | { kind: 'status'; at: string; address: string; status: OwnerStateSubscribeStatus }
  | { kind: 'heartbeat'; at: string; address: string; liveCommitmentCount: number }
  | {
      kind: 'error';
      at: string;
      address: string;
      reason: OspexStreamReason;
      phase: OspexStreamErrorPhase | null;
      status: number | null;
      message: string;
    }
  | {
      kind: 'summary';
      at: string;
      address: string;
      exitReason: ExitReason;
      readyObserved: boolean;
      counts: WatchCounts;
      liveCommitmentCount: number;
      lastStatus: OwnerStateSubscribeStatus | null;
      lastCursor: string | null;
    };

/* ------------------------------------------------------------------------- */
/* Human formatting                                                          */
/* ------------------------------------------------------------------------- */

function shortHash(h: string): string {
  return h.length <= 12 ? h : `${h.slice(0, 8)}…${h.slice(-4)}`;
}

function shortCursor(c: string): string {
  if (c === '') return '(none)';
  return c.length <= 16 ? c : `${c.slice(0, 12)}…`;
}

/** Render one line as a compact human string (no trailing newline). */
export function formatWatchLine(line: WatchLine): string {
  switch (line.kind) {
    case 'snapshot':
      return (
        `[SNAP]  ${line.at} commitments=${line.commitmentCount} positions=${line.positionCount} ` +
        `truncated=${line.truncated} positionsTruncated=${line.positionsTruncated} cursor=${shortCursor(line.cursor)}`
      );
    case 'ready':
      return `[READY] ${line.at} cursor=${shortCursor(line.cursor)} — safe to trade`;
    case 'commitment': {
      const c = line.commitment;
      return (
        `[CMT]   ${line.at} ${shortHash(c.commitmentHash)} vis=${c.visibility} status=${c.status} ` +
        `filled=${c.filledRiskAmount} remaining=${c.remainingRiskAmount} live=${c.isLive}`
      );
    }
    case 'fill': {
      const f = line.fill;
      return (
        `[FILL]  ${line.at} ${shortHash(f.commitmentHash)} makerRisk=${f.makerRiskUSDC} takerRisk=${f.takerRiskUSDC} ` +
        `tx=${shortHash(f.txHash)}:${f.logIndex}`
      );
    }
    case 'positionStatus': {
      const e = line.event;
      const claimable = e.claimableAmount !== undefined ? ` claimable=${e.claimableAmount}` : '';
      return (
        `[POS]   ${line.at} spec=${e.speculationId} type=${e.positionType} status=${e.status}` +
        `${e.result !== undefined ? ` result=${e.result}` : ''}${claimable}`
      );
    }
    case 'status':
      return `[STATUS] ${line.at} ${line.status}`;
    case 'heartbeat':
      return `[hb]    ${line.at} liveCommitments=${line.liveCommitmentCount}`;
    case 'error':
      return (
        `[ERR]   ${line.at} ${line.reason}${line.phase !== null ? `/${line.phase}` : ''}` +
        `${line.status !== null ? ` status=${line.status}` : ''} ${line.message}`
      );
    case 'summary': {
      const c = line.counts;
      return (
        `\n[SUMMARY] ${line.at} exit=${line.exitReason} ready=${line.readyObserved} ` +
        `liveCommitments=${line.liveCommitmentCount} lastStatus=${line.lastStatus ?? 'none'}\n` +
        `          snapshots=${c.snapshot} commitments=${c.commitment} fills=${c.fill} ` +
        `positionStatus=${c.positionStatus} heartbeats=${c.heartbeat} errors=${c.error}`
      );
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Options                                                                   */
/* ------------------------------------------------------------------------- */

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const optionsSchema = z
  .object({
    json: z.boolean().optional(),
    address: z
      .string()
      .regex(HEX_ADDRESS_RE, '--address must be a 0x-prefixed 20-byte hex address')
      .optional(),
    includeSigned: z.boolean().optional(),
    countsOnly: z.boolean().optional(),
    untilReady: z.boolean().optional(),
    readyTimeout: z.coerce.number().int().positive().optional(),
    duration: z.coerce.number().int().positive().optional(),
    maxEvents: z.coerce.number().int().positive().optional(),
  })
  .passthrough();

const DEFAULT_READY_TIMEOUT_SEC = 120;

/* ------------------------------------------------------------------------- */
/* Command                                                                   */
/* ------------------------------------------------------------------------- */

export const ownStateWatchCommand = addSignerOptions(
  new Command('watch').description(
    'Stream a wallet\'s owner-authenticated own-state (commitments, fills, positions) over SSE.',
  ),
)
  .option(
    '--address <wallet>',
    'wallet to watch (0x…). Defaults to the resolved signer address; must equal it.',
  )
  .option('--json', 'output line-delimited JSON (one object per line)')
  .option(
    '--include-signed',
    'include EIP-712 signature + signedPayload in commitment output (UNSAFE for public artifacts; local debug only)',
  )
  .option('--counts-only', 'on snapshot lines, emit counts only — omit the commitment/position arrays')
  .option('--until-ready', 'exit 0 after the first `ready` event (with --ready-timeout as the failsafe)')
  .addOption(
    new Option(
      '--ready-timeout <seconds>',
      'with --until-ready: exit 1 if no `ready` arrives within this window',
    ).default(String(DEFAULT_READY_TIMEOUT_SEC)),
  )
  .option('--duration <seconds>', 'run for N seconds, then exit 0')
  .option('--max-events <n>', 'exit 0 after N delta events (commitment / fill / positionStatus)')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const json = opts.json === true;
    const includeSigned = opts.includeSigned === true;
    const countsOnly = opts.countsOnly === true;
    const untilReady = opts.untilReady === true;
    const readyTimeoutSec = opts.readyTimeout ?? DEFAULT_READY_TIMEOUT_SEC;
    const durationSec = opts.duration;
    const maxEvents = opts.maxEvents;

    // Owner-auth stream — resolve the signer up-front (one keystore unlock).
    const client = await getClient({ requiresSigner: true, signerIntent });
    const signerAddress = (await client.signer().getAddress()).toLowerCase();

    // `--address` is the watch scope; default to the signer, and refuse a
    // mismatch (the server rejects the EIP-712 challenge for a wallet the
    // signer doesn't own — fail fast client-side instead).
    let address = signerAddress;
    if (opts.address !== undefined) {
      const requested = opts.address.toLowerCase();
      if (requested !== signerAddress) {
        throw new OspexValidationError(
          `--address ${requested} does not match the resolved signer ${signerAddress}. ` +
            'The own-state stream is owner-authenticated — the signer must own the watched ' +
            'address. Re-run without --address (defaults to the signer) or point the signer ' +
            'flags at the keystore for that wallet.',
          { field: 'address' },
        );
      }
      address = requested;
    }

    const at = (): string => new Date().toISOString();

    const counts: WatchCounts = {
      snapshot: 0,
      ready: 0,
      commitment: 0,
      fill: 0,
      positionStatus: 0,
      status: 0,
      heartbeat: 0,
      error: 0,
    };
    const liveByHash = new Map<string, TrackedCommitment>();
    let readyObserved = false;
    let lastStatus: OwnerStateSubscribeStatus | null = null;
    let lastCursor: string | null = null;
    let deltaEvents = 0;

    let sub: Subscription | undefined;
    let exited = false;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    const emit = (line: WatchLine): void => {
      if (json) {
        process.stdout.write(JSON.stringify(line, jsonReplacer) + '\n');
        return;
      }
      const text = formatWatchLine(line);
      const toStderr =
        line.kind === 'status' ||
        line.kind === 'heartbeat' ||
        line.kind === 'error' ||
        line.kind === 'summary';
      (toStderr ? process.stderr : process.stdout).write(text + '\n');
    };

    const finish = (exitReason: ExitReason, code: number): void => {
      if (exited) return;
      exited = true;
      if (durationTimer !== undefined) clearTimeout(durationTimer);
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      emit({
        kind: 'summary',
        at: at(),
        address,
        exitReason,
        readyObserved,
        counts,
        liveCommitmentCount: countLiveAt(liveByHash, Date.now()),
        lastStatus,
        lastCursor,
      });
      // Set the exit code and let the process drain + exit NATURALLY: closing
      // the subscription aborts the SDK's SSE fetch + reconnect loop, so the
      // event loop empties and Node flushes buffered stdout on its own. Calling
      // process.exit() here instead would truncate buffered NDJSON when stdout
      // is a pipe / file — exactly the artifact-capture path. The unref'd
      // backstop force-exits only if something keeps the loop alive past the
      // window; being unref'd, it never delays an otherwise-clean exit.
      process.exitCode = code;
      void Promise.resolve(sub?.unsubscribe()).catch(() => undefined);
      setTimeout(() => process.exit(code), 2000).unref?.();
    };

    const recordCursor = (meta: OwnStateEventMeta): void => {
      if (meta.cursor !== '') lastCursor = meta.cursor;
    };
    const maybeMaxEvents = (): void => {
      deltaEvents += 1;
      if (maxEvents !== undefined && deltaEvents >= maxEvents) finish('max-events', 0);
    };

    sub = client.ownState.subscribe(
      { address: address as `0x${string}` },
      {
        onSnapshot: (snapshot: OwnerStateSnapshot, meta: OwnStateEventMeta) => {
          counts.snapshot += 1;
          for (const c of snapshot.commitments) {
            liveByHash.set(c.commitmentHash, trackCommitment(c));
          }
          recordCursor(meta);
          const line: Extract<WatchLine, { kind: 'snapshot' }> = {
            kind: 'snapshot',
            at: at(),
            address,
            cursor: meta.cursor,
            truncated: snapshot.truncated,
            positionsTruncated: snapshot.positionsTruncated,
            commitmentCount: snapshot.commitments.length,
            positionCount: snapshot.positions.length,
          };
          if (!countsOnly) {
            line.commitments = snapshot.commitments.map((c) =>
              projectCommitment(c, includeSigned),
            );
            line.positions = snapshot.positions;
          }
          emit(line);
        },
        onReady: (meta: OwnStateEventMeta) => {
          counts.ready += 1;
          readyObserved = true;
          recordCursor(meta);
          if (readyTimer !== undefined) {
            clearTimeout(readyTimer);
            readyTimer = undefined;
          }
          emit({ kind: 'ready', at: at(), address, cursor: meta.cursor });
          if (untilReady) finish('until-ready', 0);
        },
        onCommitment: (commitment: OwnerCommitment, meta: OwnStateEventMeta) => {
          counts.commitment += 1;
          liveByHash.set(commitment.commitmentHash, trackCommitment(commitment));
          recordCursor(meta);
          emit({
            kind: 'commitment',
            at: at(),
            address,
            cursor: meta.cursor,
            commitment: projectCommitment(commitment, includeSigned),
          });
          maybeMaxEvents();
        },
        onFill: (fill: Fill, meta: OwnStateEventMeta) => {
          counts.fill += 1;
          recordCursor(meta);
          emit({ kind: 'fill', at: at(), address, cursor: meta.cursor, fill });
          maybeMaxEvents();
        },
        onPositionStatus: (event: PositionStatusEvent, meta: OwnStateEventMeta) => {
          counts.positionStatus += 1;
          recordCursor(meta);
          emit({ kind: 'positionStatus', at: at(), address, cursor: meta.cursor, event });
          maybeMaxEvents();
        },
        onStatus: (status: OwnerStateSubscribeStatus) => {
          counts.status += 1;
          lastStatus = status;
          emit({ kind: 'status', at: at(), address, status });
        },
        onFrame: (frame: OwnStateFrameMeta) => {
          // Emit a freshness pulse only for true heartbeat comments; event
          // frames are already represented by their typed line.
          if (frame.kind !== 'heartbeat') return;
          counts.heartbeat += 1;
          // Recompute the live count against the heartbeat's wall clock so a
          // long-running watcher SHOWS the count aging to zero as rows passively
          // expire — without ever needing a fresh snapshot or a reconnect.
          emit({
            kind: 'heartbeat',
            at: new Date(frame.receivedAtMs).toISOString(),
            address,
            liveCommitmentCount: countLiveAt(liveByHash, frame.receivedAtMs),
          });
        },
        onError: (err: OspexStreamError) => {
          counts.error += 1;
          emit({
            kind: 'error',
            at: at(),
            address,
            reason: err.reason,
            phase: err.phase ?? null,
            status: err.status ?? null,
            message: sanitizeUntargetedMessage(err.message),
          });
          // A fatal stream error means the subscription is dead and will not
          // recover — for a bounded/artifact run that's a failure.
          if (err.reason === 'fatal') finish('fatal', 1);
        },
      },
    );

    if (!json) {
      const bound =
        untilReady
          ? `until ready (timeout ${readyTimeoutSec}s)`
          : durationSec !== undefined
            ? `for ${durationSec}s`
            : maxEvents !== undefined
              ? `until ${maxEvents} delta events`
              : 'until Ctrl+C';
      process.stderr.write(`Watching own-state for ${address} (${bound}).\n`);
    }

    if (durationSec !== undefined) {
      durationTimer = setTimeout(() => finish('duration', 0), durationSec * 1000);
    }
    if (untilReady) {
      readyTimer = setTimeout(() => finish('ready-timeout', 1), readyTimeoutSec * 1000);
    }

    const onSignal = (): void => finish('signal', 0);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/** BigInt-safe JSON replacer (defensive — own-state bodies are string/number). */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
