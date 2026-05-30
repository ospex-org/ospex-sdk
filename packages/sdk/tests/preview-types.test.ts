/**
 * Type-level guard tests for the LEGACY (pre-v2, `@deprecated`) SubmitJsonResult
 * contract — frozen for back-compat. The CURRENT CLI `--json` emits a v2
 * `AgentEnvelope` (see `docs/AGENT_CONTRACT.md`); these assertions just keep the
 * retained legacy shape from drifting.
 *
 * The legacy `result` payload is pinned to the **v0.5.0 SubmitResult subset**
 * — `hash` + `commitment` — NOT the live in-memory {@link SubmitResult}. The
 * SDK's `submitRaw` / `submitPrepared` may grow new return fields over time
 * (v0.5.1 added `signedPayload`) that the legacy CLI `--json` runtime path
 * does NOT emit; pinning prevents typed legacy consumers from seeing fields
 * the CLI never writes. New fields land on the in-memory `SubmitResult` and
 * the v2 `AgentEnvelope`, not here.
 *
 * These tests use compile-time type assertions to guarantee any
 * future drift is caught before merge — if `SubmitJsonResult.result`
 * widens (extra fields) or narrows (missing fields), or diverges
 * structurally from the v0.5.0 pick, this file fails to compile.
 */

import { describe, expect, it } from 'vitest';
import type { SubmitJsonResult, SubmitPreviewEnvelope } from '../src/types/preview.js';
import type { SubmitResult } from '../src/commitments/submitRaw.js';
// Root-importability checks: consumers must be able to bring in these
// types from the package barrel without reaching into internal subpaths.
// If any of them is dropped from the root export list, this import fails
// at compile time. `SubmitResult` was added to the root barrel alongside
// the v0.5.1 `signedPayload` field so consumers can declare typed return
// variables (e.g. for adapters that wrap the SDK's submit surface).
import type {
  ExpirySource as RootExpirySource,
  PreviewExpiry as RootPreviewExpiry,
  SubmitResult as RootSubmitResult,
} from '../src/index.js';
import type {
  ExpirySource as InternalExpirySource,
  PreviewExpiry as InternalPreviewExpiry,
} from '../src/types/preview.js';
import type { PublicVisibleCommitment } from '../src/types/commitment.js';
import type { Hex } from '../src/types/signer.js';

// Compile-time identity: SubmitJsonResult['result'] is the LOCKED v0.5.0
// subset of SubmitResult, NOT the live SubmitResult. If the legacy interface
// reverts to `result: SubmitResult` (silent re-widening), or grows a third
// field beyond `hash | commitment`, this assertion fails.
type AssertEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;
type _LegacyResultIsV050Subset = AssertEqual<
  SubmitJsonResult['result'],
  Pick<SubmitResult, 'hash' | 'commitment'>
>;
const _legacyResultIsV050Subset: _LegacyResultIsV050Subset = true;
void _legacyResultIsV050Subset;

// Behavioural lock: a legacy consumer constructing a SubmitJsonResult.result
// from just `hash` + `commitment` must compile. If a future change adds
// `signedPayload` (or any other field) as REQUIRED on the legacy shape,
// this literal fails to compile with "Property 'X' is missing in type ...".
// This is the dual of the AssertEqual above — same invariant, surfaced as a
// concrete construction site so the failure message names the unwanted field.
const _legacyConsumerCanConstructWithoutSignedPayload: SubmitJsonResult['result'] = {
  hash: ('0x' + '0'.repeat(64)) as Hex,
  commitment: {} as PublicVisibleCommitment,
};
void _legacyConsumerCanConstructWithoutSignedPayload;

// Root-export identity for SubmitResult — the type at the root barrel must
// be the same type as the one in commitments/submitRaw. If someone re-types
// the root export by accident (e.g. an `interface SubmitResult { … }`
// declaration shadowing the re-export), this fails to compile.
type _RootSubmitResultMatches = AssertEqual<RootSubmitResult, SubmitResult>;
const _rootSubmitResultMatches: _RootSubmitResultMatches = true;
void _rootSubmitResultMatches;

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

  it('result type is locked to the v0.5.0 SubmitResult subset (hash + commitment) and rejects new required fields', () => {
    // Two compile-time assertions back this:
    //   - `_legacyResultIsV050Subset` (AssertEqual with `Pick<SubmitResult, 'hash' | 'commitment'>`)
    //   - `_legacyConsumerCanConstructWithoutSignedPayload` (literal construction)
    // Both fail at build time if the legacy schema silently re-aliases to
    // the full SubmitResult or adds a required field — this case surfaces
    // the assertion in `yarn test` output.
    expect(true).toBe(true);
  });

  it('ExpirySource / PreviewExpiry / SubmitResult are importable from the package root', () => {
    // Compile-time checks above (`_RootExpirySourceMatches` /
    // `_RootPreviewExpiryMatches` / `_RootSubmitResultMatches`); this case
    // surfaces them in the runtime test output.
    expect(true).toBe(true);
  });
});
