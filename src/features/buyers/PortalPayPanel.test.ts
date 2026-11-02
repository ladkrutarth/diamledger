import { describe, expect, it } from 'vitest';
import { inrFor, readUsd } from './PortalPayPanel';

describe('readUsd', () => {
  it('accepts an amount up to the balance', () => {
    expect(readUsd('400', 1000)).toBe(400);
    expect(readUsd(' 1000.00 ', 1000)).toBe(1000);
    expect(readUsd('99.999', 1000)).toBe(100);
  });

  it('refuses blanks, zero, negatives, text and more than the balance', () => {
    for (const text of ['', '0', '-5', 'abc', '1000.01']) expect(readUsd(text, 1000)).toBeNull();
  });
});

describe('inrFor', () => {
  it('converts at the rate and rounds to paise like the server', () => {
    expect(inrFor(400, 85)).toBe(34000);
    expect(inrFor(123.45, 83.4567)).toBe(10302.73);
  });
});
