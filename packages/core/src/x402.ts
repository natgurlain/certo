import { PAYMENT_SCHEME } from './brand.js';
import type { Receipt } from './types.js';

export const HDR_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
export const HDR_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HDR_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    seller: string; quoteId: string; termsId: string; windowMs: number; feeBps: number;
    /** Where a stock x402 client can learn the scheme (repository URL; may be empty). */
    docs?: string;
  };
}

export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description?: string };
  accepts: PaymentRequirement[];
}

export interface PaymentSignature {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: { callId: string; buyer: string; txHash: string };
}

export interface PaymentResponse {
  success: boolean;
  network: string;
  transaction: string;
  payer: string;
  receipt: Receipt;
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
}

export function findOurRequirement(pr: PaymentRequired): PaymentRequirement | undefined {
  return pr.accepts.find((a) => a.scheme === PAYMENT_SCHEME);
}
