import { describe, expect, it } from 'vitest';
import { numberToWordsUSD } from './numberToWords';

describe('numberToWordsUSD', () => {
  it.each([
    [0, 'US DOLLARS ZERO ONLY'],
    [Number.NaN, 'US DOLLARS ZERO ONLY'],
    [1, 'US DOLLARS ONE ONLY'],
    [15, 'US DOLLARS FIFTEEN ONLY'],
    [40, 'US DOLLARS FORTY ONLY'],
    [99, 'US DOLLARS NINETY NINE ONLY'],
    [100, 'US DOLLARS ONE HUNDRED ONLY'],
    [1050, 'US DOLLARS ONE THOUSAND FIFTY ONLY'],
    [12_000, 'US DOLLARS TWELVE THOUSAND ONLY'],
    [1_000_001, 'US DOLLARS ONE MILLION ONE ONLY'],
    [2_500_000_000, 'US DOLLARS TWO BILLION FIVE HUNDRED MILLION ONLY'],
    [148_312.75, 'US DOLLARS ONE HUNDRED FORTY EIGHT THOUSAND THREE HUNDRED TWELVE AND SEVENTY FIVE CENTS ONLY'],
  ])('writes %s as %s', (amount, words) => {
    expect(numberToWordsUSD(amount)).toBe(words);
  });

  it('writes amounts below a dollar as cents', () => {
    expect(numberToWordsUSD(0.5)).toBe('US DOLLARS ZERO AND FIFTY CENTS ONLY');
  });

  it('rounds to the nearest cent without producing a hundred cents', () => {
    expect(numberToWordsUSD(1.999)).toBe('US DOLLARS TWO ONLY');
    expect(numberToWordsUSD(0.1 + 0.2)).toBe('US DOLLARS ZERO AND THIRTY CENTS ONLY');
    expect(numberToWordsUSD(1050.294)).toBe('US DOLLARS ONE THOUSAND FIFTY AND TWENTY NINE CENTS ONLY');
  });
});
