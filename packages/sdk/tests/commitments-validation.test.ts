/**
 * Validators for commitment inputs. Mirror the contract + core-api
 * bounds; failing fast here saves an EIP-712 sign + a roundtrip.
 */

import { describe, expect, it } from 'vitest';
import { OspexValidationError } from '../src/errors.js';
import {
  nowUnixSec,
  validateExpiry,
  validateLineTicks,
  validateOdds,
  validatePositionType,
  validateRiskAmount,
} from '../src/commitments/validation.js';

describe('commitments/validation', () => {
  describe('validateOdds', () => {
    it('accepts the contract bounds and rejects outside', () => {
      expect(() => validateOdds(101)).not.toThrow();
      expect(() => validateOdds(10100)).not.toThrow();
      expect(() => validateOdds(100)).toThrow(OspexValidationError);
      expect(() => validateOdds(10101)).toThrow(OspexValidationError);
      expect(() => validateOdds(1.5)).toThrow(OspexValidationError);
    });
  });

  describe('validatePositionType', () => {
    it('accepts 0 and 1 only', () => {
      expect(() => validatePositionType(0)).not.toThrow();
      expect(() => validatePositionType(1)).not.toThrow();
      expect(() => validatePositionType(2)).toThrow(OspexValidationError);
      expect(() => validatePositionType(-1)).toThrow(OspexValidationError);
    });
  });

  describe('validateRiskAmount', () => {
    it('requires lot-size alignment (multiple of 100)', () => {
      expect(() => validateRiskAmount(100n)).not.toThrow();
      expect(() => validateRiskAmount(10_000n)).not.toThrow();
      expect(() => validateRiskAmount(99n)).toThrow(OspexValidationError);
      expect(() => validateRiskAmount(101n)).toThrow(OspexValidationError);
      expect(() => validateRiskAmount(0n)).toThrow(OspexValidationError);
      expect(() => validateRiskAmount(-100n)).toThrow(OspexValidationError);
    });
  });

  describe('validateExpiry', () => {
    it('requires future + within 1 year', () => {
      const now = nowUnixSec();
      expect(() => validateExpiry(now + 60n, now)).not.toThrow();
      expect(() => validateExpiry(now - 1n, now)).toThrow(OspexValidationError);
      expect(() => validateExpiry(now, now)).toThrow(OspexValidationError);
      const tooFar = now + 366n * 24n * 60n * 60n + 1n;
      expect(() => validateExpiry(tooFar, now)).toThrow(OspexValidationError);
    });
  });

  describe('validateLineTicks', () => {
    it('accepts int32 range', () => {
      expect(() => validateLineTicks(0)).not.toThrow();
      expect(() => validateLineTicks(-2_147_483_648)).not.toThrow();
      expect(() => validateLineTicks(2_147_483_647)).not.toThrow();
      expect(() => validateLineTicks(2_147_483_648)).toThrow(OspexValidationError);
      expect(() => validateLineTicks(1.5)).toThrow(OspexValidationError);
    });
  });
});
