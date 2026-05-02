/**
 * Typed error classes. All errors thrown by the SDK extend OspexError
 * and carry a discriminable `code` field — consumers can `switch`
 * on `err.code` without instanceof.
 */

export type OspexErrorCode =
  | 'API_ERROR'
  | 'CONFIG_ERROR'
  | 'VALIDATION_ERROR'
  | 'SIGNING_ERROR';

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
  /** The endpoint path that failed (e.g. `/v1/markets`). */
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
