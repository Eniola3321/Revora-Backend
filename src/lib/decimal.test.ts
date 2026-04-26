import { Decimal } from './decimal';
import { AppError, ErrorCode } from './errors';

describe('Decimal Utility', () => {
  describe('Constructor and toString()', () => {
    it('should correctly parse and represent integer strings', () => {
      const dec = new Decimal('123');
      expect(dec.toString()).toBe('123');
    });

    it('should correctly parse and represent decimal strings', () => {
      const dec = new Decimal('123.456');
      expect(dec.toString()).toBe('123.456');
    });

    it('should handle leading zeros in fractional part', () => {
      const dec = new Decimal('0.001');
      expect(dec.toString()).toBe('0.001');
    });

    it('should handle trailing zeros in fractional part (constructor normalizes)', () => {
      const dec = new Decimal('1.200');
      expect(dec.toString()).toBe('1.200'); // Internal representation keeps original scale
    });

    it('should handle zero', () => {
      const dec = new Decimal('0');
      expect(dec.toString()).toBe('0');
      const dec2 = new Decimal('0.00');
      expect(dec2.toString()).toBe('0.00');
    });

    it('should reject invalid decimal string format', () => {
      expect(() => new Decimal('123.45.6')).toThrow(AppError);
      expect(() => new Decimal('-123.45')).toThrow(AppError);
      expect(() => new Decimal('.45')).toThrow(AppError);
      expect(() => new Decimal('abc')).toThrow(AppError);
    });

    it('should reject decimal strings with more than 18 decimal places', () => {
      expect(() => new Decimal('1.1234567890123456789')).toThrow(AppError);
      const dec = new Decimal('1.123456789012345678');
      expect(dec.toString()).toBe('1.123456789012345678');
    });
  });

  describe('toSorobanI128()', () => {
    it('should convert to Soroban i128 with same scale', () => {
      const dec = new Decimal('123.456');
      expect(dec.toSorobanI128(3)).toBe(123456n);
    });

    it('should convert to Soroban i128 by increasing scale', () => {
      const dec = new Decimal('123');
      expect(dec.toSorobanI128(7)).toBe(1230000000n);
    });

    it('should convert to Soroban i128 by decreasing scale (rounding half up)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2)).toBe(12346n); // 123.45678 -> 123.46
      const dec2 = new Decimal('123.454');
      expect(dec2.toSorobanI128(2)).toBe(12345n); // 123.454 -> 123.45
      const dec3 = new Decimal('123.455');
      expect(dec3.toSorobanI128(2)).toBe(12346n); // 123.455 -> 123.46
    });

    it('should convert to Soroban i128 by decreasing scale (floor)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2, 'floor')).toBe(12345n); // 123.45678 -> 123.45
    });

    it('should convert to Soroban i128 by decreasing scale (ceil)', () => {
      const dec = new Decimal('123.451');
      expect(dec.toSorobanI128(2, 'ceil')).toBe(12346n); // 123.451 -> 123.46
    });

    it('should convert to Soroban i128 by decreasing scale (truncate)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2, 'truncate')).toBe(12345n); // 123.45678 -> 123.45
    });

    it('should reject values exceeding i128 max limit', () => {
      const largeValue = new Decimal('1701411834604692317316873037158841057270'); // I128_MAX * 10
      expect(() => largeValue.toSorobanI128(0)).toThrow(AppError);
      expect(() => largeValue.toSorobanI128(1)).toThrow(AppError);
    });

    it('should reject values exceeding i128 min limit (conceptually, as input is positive)', () => {
      // Since our Decimal only handles positive numbers, this test case is more theoretical
      // or would apply if we introduced negative numbers. For now, it's about the scaled positive limit.
      const veryLargePositive = new Decimal('170141183460469231731687303715884105727'); // Just below I128_MAX
      expect(veryLargePositive.toSorobanI128(0)).toBe(170141183460469231731687303715884105727n);
      const overflowPositive = new Decimal('170141183460469231731687303715884105728'); // I128_MAX + 1
      expect(() => overflowPositive.toSorobanI128(0)).toThrow(AppError);
    });

    it('should throw for invalid target scale', () => {
      const dec = new Decimal('1.0');
      expect(() => dec.toSorobanI128(-1)).toThrow(AppError);
      expect(() => dec.toSorobanI128(19)).toThrow(AppError);
    });
  });

  describe('fromScaledBigInt()', () => {
    it('should convert scaled BigInt to Decimal', () => {
      const dec = Decimal.fromScaledBigInt(123456n, 3);
      expect(dec.toString()).toBe('123.456');
    });

    it('should handle zero scaled BigInt', () => {
      const dec = Decimal.fromScaledBigInt(0n, 5);
      expect(dec.toString()).toBe('0.00000');
    });

    it('should handle scaled BigInt with more scale than value digits', () => {
      const dec = Decimal.fromScaledBigInt(1n, 3); // 0.001
      expect(dec.toString()).toBe('0.001');
    });

    it('should throw for invalid scale', () => {
      expect(() => Decimal.fromScaledBigInt(100n, -1)).toThrow(AppError);
      expect(() => Decimal.fromScaledBigInt(100n, 19)).toThrow(AppError);
    });
  });

  describe('Arithmetic Operations', () => {
    it('should correctly add two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.35');
      expect(dec1.add(dec2).toString()).toBe('12.85');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.0005');
      expect(dec3.add(dec4).toString()).toBe('0.0015');
    });

    it('should correctly subtract two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.35');
      expect(dec1.subtract(dec2).toString()).toBe('8.15');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.0005');
      expect(dec3.subtract(dec4).toString()).toBe('0.0005');
    });

    it('should correctly multiply two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.0');
      expect(dec1.multiply(dec2).toString()).toBe('21.00');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.002');
      expect(dec3.multiply(dec4).toString()).toBe('0.000002');

      const dec5 = new Decimal('123456789012345678.123456789012345678'); // 18 decimals
      const dec6 = new Decimal('1.000000000000000001'); // 18 decimals
      // Product scale would be 36, but we truncate to 18.
      expect(dec5.multiply(dec6).toString()).toBe('123456789012345678.246913578024691356');
    });

    it('should correctly divide two Decimal numbers', () => {
      const dec1 = new Decimal('10.0');
      const dec2 = new Decimal('2.0');
      expect(dec1.divide(dec2).toString()).toBe('5.000000000000000000');

      const dec3 = new Decimal('1.0');
      const dec4 = new Decimal('3.0');
      expect(dec3.divide(dec4).toString()).toBe('0.333333333333333333'); // Truncated to 18 decimals

      expect(() => dec1.divide(new Decimal('0'))).toThrow(AppError);
    });
  });

  describe('Comparison and State Checks', () => {
    it('should correctly compare two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('10.50');
      const dec3 = new Decimal('12.0');
      const dec4 = new Decimal('8.0');

      expect(dec1.compareTo(dec2)).toBe(0);
      expect(dec1.compareTo(dec3)).toBe(-1);
      expect(dec3.compareTo(dec1)).toBe(1);
      expect(dec1.compareTo(dec4)).toBe(1);
    });

    it('should correctly identify zero, positive, and negative', () => {
      const zero = new Decimal('0.00');
      const positive = new Decimal('1.23');
      // Our Decimal class currently only handles positive inputs, so negative checks are theoretical
      // For now, isNegative will always be false.
      // const negative = new Decimal('-1.23'); // Would fail constructor regex

      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);

      expect(positive.isZero()).toBe(false);
      expect(positive.isPositive()).toBe(true);
      expect(positive.isNegative()).toBe(false);
    });
  });
});