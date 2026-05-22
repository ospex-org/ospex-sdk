/**
 * Typed error classes. All errors thrown by the SDK extend OspexError
 * and carry a discriminable `code` field — consumers can `switch`
 * on `err.code` without instanceof.
 */

export type OspexErrorCode =
  | 'API_ERROR'
  | 'CONFIG_ERROR'
  | 'VALIDATION_ERROR'
  | 'SIGNING_ERROR'
  | 'ALLOWANCE_INSUFFICIENT'
  | 'CHAIN_ERROR'
  | 'SCRIPT_APPROVAL_INVALID'
  | 'SUBSCRIPTION_ERROR'
  | 'STREAM_ERROR'
  | 'SIGNER_RESOLUTION_ERROR';

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

  constructor(
    message: string,
    init?: { status?: number; apiCode?: string; path?: string; cause?: unknown },
  ) {
    super('API_ERROR', message, init?.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'OspexAPIError';
    this.status = init?.status;
    this.apiCode = init?.apiCode;
    this.path = init?.path;
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
 * on receipt-level reverts so the caller can inspect on Polygonscan.
 */
export class OspexChainError extends OspexError {
  readonly reason: OspexChainErrorReason | undefined;
  readonly revertReason: string | undefined;
  readonly txHash: string | undefined;

  constructor(
    message: string,
    init?: {
      reason?: OspexChainErrorReason;
      revertReason?: string;
      txHash?: string;
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
  }
}

/**
 * A Chainlink Functions ScriptApproval is unusable for the requested
 * operation: hash mismatch (provided source ≠ approved hash), expired
 * (`validUntil` passed), or unconfigured (no approvals committed for the
 * deployment's network).
 *
 * `reason` discriminates the case so the caller can give a precise
 * remediation message.
 */
export type OspexScriptApprovalReason = 'hash_mismatch' | 'expired' | 'not_configured';

export class OspexScriptApprovalError extends OspexError {
  readonly reason: OspexScriptApprovalReason;
  /** The expected scriptHash from the approval (when known). */
  readonly expectedHash: string | undefined;
  /** The actual hash computed from the submitted source (when known). */
  readonly actualHash: string | undefined;

  constructor(
    message: string,
    init: {
      reason: OspexScriptApprovalReason;
      expectedHash?: string;
      actualHash?: string;
      cause?: unknown;
    },
  ) {
    super(
      'SCRIPT_APPROVAL_INVALID',
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'OspexScriptApprovalError';
    this.reason = init.reason;
    this.expectedHash = init.expectedHash;
    this.actualHash = init.actualHash;
  }
}

/**
 * The Chainlink Functions subscription configuration is unusable —
 * insufficient LINK funding in the caller's wallet, OracleModule isn't
 * a registered consumer of the chosen subscription, or no subscriptionId
 * was supplied on a network without a shared default.
 */
export type OspexSubscriptionReason =
  | 'link_balance_insufficient'
  | 'consumer_not_registered'
  | 'subscription_id_missing';

export class OspexSubscriptionError extends OspexError {
  readonly reason: OspexSubscriptionReason;
  readonly subscriptionId: bigint | undefined;

  constructor(
    message: string,
    init: { reason: OspexSubscriptionReason; subscriptionId?: bigint; cause?: unknown },
  ) {
    super(
      'SUBSCRIPTION_ERROR',
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'OspexSubscriptionError';
    this.reason = init.reason;
    this.subscriptionId = init.subscriptionId;
  }
}

/**
 * Discriminator for failures on an Ospex SSE stream (`client.<resource>.subscribe`).
 * Distinct from `OspexSubscriptionError`, which is about Chainlink Functions LINK
 * subscriptions — these two "subscription" concepts are unrelated.
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
 * A failure on an Ospex SSE stream. Delivered to a subscription's `onError`
 * handler. `reason` discriminates retry-vs-stop; `status` carries the HTTP
 * status when the failure was an HTTP response (otherwise undefined for
 * transport-level failures).
 */
export class OspexStreamError extends OspexError {
  readonly reason: OspexStreamReason;
  readonly status: number | undefined;

  constructor(message: string, init: { reason: OspexStreamReason; status?: number; cause?: unknown }) {
    super('STREAM_ERROR', message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'OspexStreamError';
    this.reason = init.reason;
    this.status = init.status;
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
