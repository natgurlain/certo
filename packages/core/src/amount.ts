/** Token amounts: 6-decimal USDC in base units, carried as decimal-integer strings / bigint. */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** "0.40" → "400000". Rejects more than 6 decimals and negatives. */
export function parseUsdc(s: string | number): string {
  const str = typeof s === 'number' ? s.toFixed(USDC_DECIMALS) : s.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(str);
  if (!m) throw new Error(`invalid amount: ${s}`);
  const frac = (m[2] ?? '');
  if (frac.length > USDC_DECIMALS) throw new Error(`more than ${USDC_DECIMALS} decimals: ${s}`);
  return (BigInt(m[1]!) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0')).toString();
}

/** "400000" → "0.400000" (always 6 decimals, as in the demo transcript). */
export function formatUsdc(units: string | bigint): string {
  const n = BigInt(units);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / SCALE}.${(a % SCALE).toString().padStart(USDC_DECIMALS, '0')}`;
}

export const FEE_BPS = [50, 100, 150, 250, 500] as const;

/** `fee = max(1, ceil(amount × fee_bps / 10000))`. */
export function feeFor(amount: string | bigint, feeBps: number): string {
  const a = BigInt(amount);
  const f = (a * BigInt(feeBps) + 9999n) / 10000n;
  return (f < 1n ? 1n : f).toString();
}

/** `stake_for(price) = max(stake_min, price × stake_bps / 10000) × 2^mult_log2`. */
export function stakeFor(price: string | bigint, opts: { stakeMin?: string | bigint; stakeBps?: number; multLog2?: number } = {}): string {
  const p = BigInt(price);
  const min = BigInt(opts.stakeMin ?? 20_000n);
  const pct = (p * BigInt(opts.stakeBps ?? 500)) / 10000n;
  const base = pct > min ? pct : min;
  return (base << BigInt(opts.multLog2 ?? 0)).toString();
}

/** refund = price × offer_bps / 10000. */
export function refundFor(price: string | bigint, offerBps: number): string {
  return ((BigInt(price) * BigInt(offerBps)) / 10000n).toString();
}

/**
 * An amount typed by a person or an agent. A JSON number, a string with a
 * decimal point, or a string ending in "USDC" is USDC ("0.4", "1 USDC", 0.4);
 * a bare integer string is base units ("400000" = 0.40 USDC). Returns base units.
 */
export function parseAmountInput(v: string | number): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid amount: ${v}`);
    return parseUsdc(v);
  }
  const s = v.trim();
  const usdc = /^(.*?)\s*usdc$/i.exec(s);
  if (usdc) return parseUsdc(usdc[1]!);
  if (/^\d+$/.test(s)) return BigInt(s).toString();
  if (/^\d*\.\d*$/.test(s) && s !== '.') return parseUsdc(s.startsWith('.') ? `0${s}` : s);
  throw new Error(`invalid amount "${v}": use USDC like "0.40" or "1 USDC", or base units like "400000"`);
}

/** Default buyer price cap when `CERTO_MAX_PRICE` is not set: 1.00 USDC. */
export const DEFAULT_MAX_PRICE = '1000000';
