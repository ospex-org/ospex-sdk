import { describe, expect, it } from 'vitest';
import {
  OspexAllowanceError,
  OspexAPIError,
  OspexChainError,
  OspexConfigError,
  OspexError,
  OspexSigningError,
  OspexValidationError,
} from '../src/errors.js';

describe('errors', () => {
  it('all subclasses extend OspexError and Error', () => {
    const cases = [
      new OspexAPIError('api'),
      new OspexConfigError('config'),
      new OspexValidationError('validation'),
      new OspexSigningError('signing'),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OspexError);
    }
  });

  it('codes are stable and discriminable', () => {
    expect(new OspexAPIError('').code).toBe('API_ERROR');
    expect(new OspexConfigError('').code).toBe('CONFIG_ERROR');
    expect(new OspexValidationError('').code).toBe('VALIDATION_ERROR');
    expect(new OspexSigningError('').code).toBe('SIGNING_ERROR');
  });

  it('OspexAPIError carries status, apiCode, and path', () => {
    const err = new OspexAPIError('not found', {
      status: 404,
      apiCode: 'NOT_FOUND',
      path: '/v1/markets/x',
    });
    expect(err.status).toBe(404);
    expect(err.apiCode).toBe('NOT_FOUND');
    expect(err.path).toBe('/v1/markets/x');
  });

  it('cause is propagated when supplied', () => {
    const cause = new Error('boom');
    const err = new OspexSigningError('wrapped', { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it('OspexValidationError exposes the field name', () => {
    const err = new OspexValidationError('bad', { field: 'address' });
    expect(err.field).toBe('address');
  });

  it('OspexAllowanceError carries the structured shortfall info', () => {
    const err = new OspexAllowanceError('short', {
      required: 1_000_000n,
      current: 0n,
      spender: '0xPositionModule',
      token: '0xUSDC',
    });
    expect(err.code).toBe('ALLOWANCE_INSUFFICIENT');
    expect(err.required).toBe(1_000_000n);
    expect(err.current).toBe(0n);
    expect(err.spender).toBe('0xPositionModule');
    expect(err.token).toBe('0xUSDC');
  });

  it('OspexChainError carries optional revertReason and txHash', () => {
    const cause = new Error('reverted: NonceTooLow()');
    const err = new OspexChainError('match failed', {
      revertReason: 'NonceTooLow',
      txHash: '0xdeadbeef',
      cause,
    });
    expect(err.code).toBe('CHAIN_ERROR');
    expect(err.revertReason).toBe('NonceTooLow');
    expect(err.txHash).toBe('0xdeadbeef');
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});
