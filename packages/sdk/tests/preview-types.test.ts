/**
 * Type-level guard tests for the SubmitJsonResult contract.
 *
 * Hermes' PR #21 review flagged that we lock `schemaVersion: 1` on
 * `SubmitJsonResult`, but the original PR's `result` field shape
 * `{ hash: string; status: string }` did NOT match the SDK's actual
 * `SubmitResult` (`{ hash: Hex; commitment: Commitment }`). That
 * would have shipped a public schema disagreeing with what
 * `commitments.submit` returns.
 *
 * These tests use compile-time type assertions to guarantee any
 * future drift is caught before merge — if `SubmitResult` grows a
 * field, the tests still pass; if `SubmitJsonResult.result` diverges
 * structurally from `SubmitResult`, this file fails to compile.
 */

import { describe, expect, it } from 'vitest';
import type { SubmitJsonResult, SubmitPreviewEnvelope } from '../src/types/preview.js';
import type { SubmitResult } from '../src/commitments/submitRaw.js';
// Root-importability check (Hermes PR #31 review): consumers must be
// able to bring in the new expiry types from the package barrel
// without reaching into internal subpaths. If either type is dropped
// from the root export list, this import fails at compile time.
import type {
  ExpirySource as RootExpirySource,
  PreviewExpiry as RootPreviewExpiry,
} from '../src/index.js';
import type {
  ExpirySource as InternalExpirySource,
  PreviewExpiry as InternalPreviewExpiry,
} from '../src/types/preview.js';

// Compile-time identity: SubmitJsonResult['result'] === SubmitResult.
type AssertEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;
type _ResultMatches = AssertEqual<SubmitJsonResult['result'], SubmitResult>;
const _resultMatches: _ResultMatches = true;
void _resultMatches;

// schemaVersion is the literal 1, not number — agents pin on this.
type _SchemaVersionLiteral = AssertEqual<SubmitJsonResult['schemaVersion'], 1>;
const _schemaVersionLiteral: _SchemaVersionLiteral = true;
void _schemaVersionLiteral;

type _EnvelopeSchemaVersionLiteral = AssertEqual<SubmitPreviewEnvelope['schemaVersion'], 1>;
const _envelopeSchemaVersionLiteral: _EnvelopeSchemaVersionLiteral = true;
void _envelopeSchemaVersionLiteral;

// Root export identity for the new expiry types — the type at the
// root barrel must be the same type as the one in the internal
// preview module. If someone re-types the root export by accident
// (e.g. `export type ExpirySource = string`), this fails to compile.
type _RootExpirySourceMatches = AssertEqual<RootExpirySource, InternalExpirySource>;
const _rootExpirySourceMatches: _RootExpirySourceMatches = true;
void _rootExpirySourceMatches;

type _RootPreviewExpiryMatches = AssertEqual<RootPreviewExpiry, InternalPreviewExpiry>;
const _rootPreviewExpiryMatches: _RootPreviewExpiryMatches = true;
void _rootPreviewExpiryMatches;

describe('SubmitJsonResult schema contract', () => {
  it('locks schemaVersion to literal 1', () => {
    // Runtime sanity check that mirrors the compile-time assertions.
    const v: SubmitJsonResult['schemaVersion'] = 1;
    expect(v).toBe(1);
  });

  it("result type structurally matches SubmitResult — see _ResultMatches type assertion above", () => {
    // The work is done at compile time; this case exists so the test
    // runner reports the assertion in `yarn test` output.
    expect(true).toBe(true);
  });

  it('ExpirySource and PreviewExpiry are importable from the package root', () => {
    // Compile-time check above (`_RootExpirySourceMatches` /
    // `_RootPreviewExpiryMatches`); this case surfaces it in the
    // runtime test output.
    expect(true).toBe(true);
  });
});
