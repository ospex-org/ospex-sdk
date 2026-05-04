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
  | 'SUBSCRIPTION_ERROR';

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
 * write operation without a signer, or trying to open a Realtime
 * channel before Supabase config is available).
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
