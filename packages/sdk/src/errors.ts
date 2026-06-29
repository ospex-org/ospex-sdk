/**
 * Typed error classes. All errors thrown by the SDK extend OspexError
 * and carry a discriminable `code` field — consumers can `switch`
 * on `err.code` without instanceof.
 */

import type { TransactionReceipt } from 'viem';

export type OspexErrorCode =
  | 'API_ERROR'
  | 'CONFIG_ERROR'
  | 'VALIDATION_ERROR'
  | 'SIGNING_ERROR'
  | 'ALLOWANCE_INSUFFICIENT'
  | 'CHAIN_ERROR'
  | 'STREAM_ERROR'
  | 'SIGNER_RESOLUTION_ERROR'
  | 'OWN_STATE_ERROR';

export class OspexError extends Error {
  readonly code: OspexErrorCode;

  constructor(code: OspexErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    this.name = 'OspexError';
    if (options?.cause !== undefined) {
      // ES2022 Error.cause; widely available on Node 20+.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * The API responded with a non-2xx status, or a network failure prevented
 * the request from completing. `status` is undefined for transport-level
 * failures (timeout, DNS, etc.).
 */
export class OspexAPIError extends OspexError {
  readonly status: number | undefined;
  /** The `code` field from the API's error envelope, when present. */
  readonly apiCode: string | undefined;
  /** The endpoint path that failed (e.g. `/v1/contests`). */
  readonly path: string | undefined;
  /**
   * The locally-computed EIP-712 commitment hash, attached ONLY when a
   * `/v1/commitments` POST (submit / submit-raw) failed AFTER the hash was
   * computed. A POST that fails after the server inserted the row (a lost
   * response — fetch reject, gateway timeout / Heroku H12, a 5xx emitted after
   * the insert) leaves a LIVE, matchable commitment the caller can identify
   * only by this hash. Surfacing it lets the caller probe whether the
   * commitment landed (`commitments show <hash>` / own-state) before retrying,
   * instead of blindly re-submitting (a fresh submit signs a NEW nonce → NEW
   * hash → the server's hash-keyed `Idempotency-Key` dedup can't catch it →
   * doubled exposure). See `docs/AGENT_CONTRACT.md` §7 retry carve-out.
   * Undefined for every other API error.
   */
  readonly commitmentHash: string | undefined;

  constructor(
    message: string,
    init?: {
      status?: number;
      apiCode?: string;
      path?: string;
      commitmentHash?: string;
      cause?: unknown;
    },
  ) {
    super('API_ERROR', message, init?.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'OspexAPIError';
    this.status = init?.status;
    this.apiCode = init?.apiCode;
    this.path = init?.path;
    this.commitmentHash = init?.commitmentHash;
  }
}

/**
 * Required configuration is missing or invalid (e.g. requesting a
 * write operation without a signer, or a chain read without an
 * `rpcUrl`).
 */
export class OspexConfigError extends OspexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG_ERROR', message, options);
    this.name = 'OspexConfigError';
  }
}

/** A user-supplied argument failed validation. */
export class OspexValidationError extends OspexError {
  /** Optional dotted path indicating which field was invalid. */
  readonly field: string | undefined;

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super('VALIDATION_ERROR', message, options);
    this.name = 'OspexValidationError';
    this.field = options?.field;
  }
}

/**
 * A signing operation failed (keystore decrypt, EIP-712 sign, etc.).
 * The original cause is attached for debugging — never log the
 * decrypted-key path itself.
 */
export class OspexSigningError extends OspexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SIGNING_ERROR', message, options);
    this.name = 'OspexSigningError';
  }
}

/**
 * The wallet's ERC-20 allowance for a given spender is below what the
 * pending action requires. Carries the structured detail so the caller
 * can decide what to do (e.g. CLI prompts for an `approve` tx; an agent
 * may queue one automatically). The SDK never auto-approves.
 *
 * For Ospex commitments, `spender` is always `PositionModule` (NOT
 * MatchingModule — the most common new-integrator confusion).
 */
export class OspexAllowanceError extends OspexError {
  readonly required: bigint;
  readonly current: bigint;
  readonly spender: string;
  readonly token: string;

  constructor(
    message: string,
    init: {
      required: bigint;
      current: bigint;
      spender: string;
      token: string;
      cause?: unknown;
    },
  ) {
    super(
      'ALLOWANCE_INSUFFICIENT',
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'OspexAllowanceError';
    this.required = init.required;
    this.current = init.current;
    this.spender = init.spender;
    this.token = init.token;
  }
}

/**
 * Discriminator for known MatchingModule (and other Ospex contract)
 * reverts. Set on `OspexChainError.reason` when the SDK could decode
 * the revert against a known custom-error selector. Consumers can
 * `switch (err.reason)` for typed handling without parsing strings.
 */
export type OspexChainErrorReason =
  | 'NotCommitmentMaker'
  | 'NonceMustIncrease';

/**
 * On-chain interaction failed — either an RPC transport error, a
 * contract revert, or a transaction that reverted on inclusion.
 *
 * `reason` is set when the SDK could decode a known custom error
 * (e.g. `MatchingModule__NotCommitmentMaker`). `revertReason` is
 * a free-form string for legacy / unknown reverts. `txHash` is set
 * whenever a tx was broadcast (so the caller can inspect on Polygonscan) —
 * which includes both a reverted tx AND a confirmed tx that failed a
 * post-send step; use `receipt.status` (below) to tell them apart.
 */
export class OspexChainError extends OspexError {
  readonly reason: OspexChainErrorReason | undefined;
  readonly revertReason: string | undefined;
  readonly txHash: string | undefined;
  /**
   * The transaction receipt, attached when the error occurred after the tx
   * was mined and a receipt was available. **Branch on `receipt.status`, not
   * on presence** — presence alone does NOT mean the tx reverted:
   *
   *   - `receipt.status === 'reverted'` — the authoritative revert signal:
   *     the broadcast tx reverted on-chain (attached by `broadcastSignedTx`).
   *     Carries `gasUsed` / `effectiveGasPrice` so consumers can account the
   *     POL the reverted tx spent.
   *   - `receipt.status === 'success'` — the tx CONFIRMED on-chain, but a
   *     post-send step failed (e.g. `claim()` throwing "tx confirmed but no
   *     POSITION_CLAIMED event" — the claim landed; its payout event just
   *     couldn't be parsed). The on-chain effect happened; the operation
   *     didn't complete. Do NOT treat this as a revert.
   *   - `receipt === undefined` — the failure happened before/without a mined
   *     receipt (pre-send revert, RPC/signing error). On-chain status is
   *     UNKNOWN — do NOT assume reverted.
   *
   * Idempotent recovery (`ensurePositionClaimed`) keys specifically off
   * `receipt?.status === 'reverted'`: a confirmed-but-unparseable claim
   * (`status: 'success'`) stays a loud failure, never a benign recovery.
   */
  readonly receipt: TransactionReceipt | undefined;

  constructor(
    message: string,
    init?: {
      reason?: OspexChainErrorReason;
      revertReason?: string;
      txHash?: string;
      receipt?: TransactionReceipt;
      cause?: unknown;
    },
  ) {
    super(
      'CHAIN_ERROR',
      message,
      init?.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'OspexChainError';
    this.reason = init?.reason;
    this.revertReason = init?.revertReason;
    this.txHash = init?.txHash;
    this.receipt = init?.receipt;
  }
}

/**
 * Discriminator for failures on an Ospex SSE stream (`client.<resource>.subscribe`).
 *
 *   connection_failed — a connect/transport attempt failed (network error, 5xx,
 *                       a dropped stream). The transport retries with backoff; this
 *                       is surfaced for observability, not a terminal state.
 *   capacity_exceeded — the server's concurrent-connection cap was hit (HTTP 429).
 *                       Retried with backoff.
 *   fatal             — unrecoverable: the server rejected the request in a way a
 *                       retry can't fix (e.g. 404 unknown resource, a 400 that isn't
 *                       a stale cursor). The subscription stops.
 */
export type OspexStreamReason = 'connection_failed' | 'capacity_exceeded' | 'fatal';

/**
 * Optional phase discriminator on {@link OspexStreamError}. Set on
 * own-state-subscribe errors so consumers building composite health gates
 * (per own-state SSE plan §2.6) can latch on a specific failure phase
 * without parsing messages. Other resource streams (`odds`, etc.) may leave
 * `phase` undefined.
 *
 *   token-mint     — minting a fresh stream-auth bearer failed
 *                    (challenge/sign/exchange path)
 *   token-refresh  — re-mint during an active subscription (same path,
 *                    different latch — the health gate may treat
 *                    refresh-in-flight failures differently from
 *                    initial-connect failures)
 *   connect        — opening the SSE connection failed (HTTP non-2xx
 *                    or transport error)
 *   snapshot-page  — REST snapshot paging during the truncated cold-start
 *                    handoff failed (auth / transport / decode)
 *   decode         — a wire-level frame couldn't be parsed
 *   dispatch       — a consumer handler threw during event delivery
 */
export type OspexStreamErrorPhase =
  | 'token-mint'
  | 'token-refresh'
  | 'connect'
  | 'snapshot-page'
  | 'decode'
  | 'dispatch';

/**
 * A failure on an Ospex SSE stream. Delivered to a subscription's `onError`
 * handler. `reason` discriminates retry-vs-stop; `status` carries the HTTP
 * status when the failure was an HTTP response (otherwise undefined for
 * transport-level failures); `phase` (optional) discriminates the
 * subscriber-side phase the failure occurred in — populated by the
 * own-state subscribe path for composite-health-gate consumers.
 */
export class OspexStreamError extends OspexError {
  readonly reason: OspexStreamReason;
  readonly status: number | undefined;
  readonly phase: OspexStreamErrorPhase | undefined;

  constructor(
    message: string,
    init: {
      reason: OspexStreamReason;
      status?: number;
      phase?: OspexStreamErrorPhase;
      cause?: unknown;
    },
  ) {
    super('STREAM_ERROR', message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'OspexStreamError';
    this.reason = init.reason;
    this.status = init.status;
    this.phase = init.phase;
  }
}

/**
 * Discriminator for failures on the owner-auth own-state surface
 * (`client.ownState.*`).
 *
 *   scan_limit_exceeded — `getCommitment` walked its defensive page bound
 *                         (`MAX_SNAPSHOT_PAGES`) and the server was still
 *                         returning `truncated:true`. The result is
 *                         UNKNOWN, not "not in scope" — callers MUST NOT
 *                         treat this as a found/not-found verdict. Drive
 *                         the recovery via `snapshot()` manually, or wait
 *                         for the dedicated by-hash endpoint.
 */
export type OspexOwnStateReason = 'scan_limit_exceeded';

/**
 * A failure specific to the owner-auth own-state surface. Distinct from
 * `OspexAPIError` (which covers transport / HTTP) and from `OspexStreamError`
 * (which covers the SSE composite stream landing in PR3c) — this is the
 * SDK signaling a bounded local helper couldn't reach a definitive verdict.
 * The carried `pagesScanned` lets observability code report on the scan
 * scope reached before the bound kicked in.
 */
export class OspexOwnStateError extends OspexError {
  readonly reason: OspexOwnStateReason;
  readonly pagesScanned: number;

  constructor(
    message: string,
    init: { reason: OspexOwnStateReason; pagesScanned: number; cause?: unknown },
  ) {
    super('OWN_STATE_ERROR', message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'OspexOwnStateError';
    this.reason = init.reason;
    this.pagesScanned = init.pagesScanned;
  }
}

/**
 * Discriminator for failures in the non-interactive Foundry-keystore
 * signer-resolution pipeline (path resolution, file reads, decryption,
 * address pinning checks). Stable string codes — agents can `switch`
 * on `err.reason` without parsing messages.
 *
 *   keystore_not_found              — resolved path didn't exist
 *   password_file_not_found         — --password-file path didn't exist
 *   decryption_failed               — passphrase didn't decrypt the keystore
 *   address_mismatch                — keystore unlocked to a different
 *                                     address than --expected-address /
 *                                     the config-pinned expectedAddress
 *   non_interactive_password_required
 *                                   — no passphrase source available and
 *                                     the caller refused to fall back to
 *                                     an interactive prompt
 *   password_file_permissions_loose — password file is group/other-readable;
 *                                     emitted only under strict-mode checks
 *                                     (e.g. `ospex auth check --strict`)
 *   account_and_path_conflict       — both --account and --keystore-path
 *                                     supplied for one resolve call
 *   password_source_conflict        — multiple passphrase sources supplied
 *                                     (e.g. --password-file AND
 *                                     --password-stdin AND literal)
 */
export type OspexSignerResolutionReason =
  | 'keystore_not_found'
  | 'password_file_not_found'
  | 'decryption_failed'
  | 'address_mismatch'
  | 'non_interactive_password_required'
  | 'password_file_permissions_loose'
  | 'account_and_path_conflict'
  | 'password_source_conflict';

/**
 * Failure in the non-interactive Foundry-keystore signer-resolution
 * pipeline. Thrown by `KeystoreSigner.fromFoundryAccount` and
 * `KeystoreSigner.fromKeystoreFile`, and by the resolver/reader helpers
 * in `signers/foundry.ts`.
 *
 * Carries context fields so callers can render actionable errors
 * without re-deriving state:
 *   - `path`            — the file path involved (keystore or password)
 *   - `expectedAddress` — the asserted address (for address_mismatch)
 *   - `actualAddress`   — the actually-unlocked address (for address_mismatch)
 *   - `mode`            — POSIX mode (for password_file_permissions_loose)
 */
export class OspexSignerResolutionError extends OspexError {
  readonly reason: OspexSignerResolutionReason;
  readonly path: string | undefined;
  readonly expectedAddress: string | undefined;
  readonly actualAddress: string | undefined;
  readonly mode: number | undefined;

  constructor(
    message: string,
    init: {
      reason: OspexSignerResolutionReason;
      path?: string;
      expectedAddress?: string;
      actualAddress?: string;
      mode?: number;
      cause?: unknown;
    },
  ) {
    super(
      'SIGNER_RESOLUTION_ERROR',
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'OspexSignerResolutionError';
    this.reason = init.reason;
    this.path = init.path;
    this.expectedAddress = init.expectedAddress;
    this.actualAddress = init.actualAddress;
    this.mode = init.mode;
  }
}
