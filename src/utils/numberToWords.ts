const ones = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'
];

const tens = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'
];

function convertThreeDigit(num: number): string {
  let result = '';
  const hundred = Math.floor(num / 100);
  const remainder = num % 100;

  if (hundred > 0) {
    result += `${ones[hundred]} HUNDRED `;
  }

  if (remainder > 0) {
    if (remainder < 20) {
      result += ones[remainder];
    } else {
      const ten = Math.floor(remainder / 10);
      const one = remainder % 10;
      result += tens[ten] + (one > 0 ? ` ${ones[one]}` : '');
    }
  }

  return result.trim();
}

export function numberToWordsUSD(amount: number): string {
  if (isNaN(amount) || amount === 0) return 'US DOLLARS ZERO ONLY';

  const totalCents = Math.round(Math.abs(amount) * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  let words = '';

  const billions = Math.floor(dollars / 1_000_000_000);
  const millions = Math.floor((dollars % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((dollars % 1_000_000) / 1_000);
  const remainingDollars = dollars % 1000;

  if (billions > 0) {
    words += `${convertThreeDigit(billions)} BILLION `;
  }
  if (millions > 0) {
    words += `${convertThreeDigit(millions)} MILLION `;
  }
  if (thousands > 0) {
    words += `${convertThreeDigit(thousands)} THOUSAND `;
  }
  if (remainingDollars > 0) {
    words += `${convertThreeDigit(remainingDollars)} `;
  }

  words = words.trim();
  if (!words) words = 'ZERO';

  let finalPhrase = `US DOLLARS ${words}`;

  if (cents > 0) {
    const centsText = convertThreeDigit(cents);
    finalPhrase += ` AND ${centsText} CENTS`;
  }

  return `${finalPhrase} ONLY`;
}
