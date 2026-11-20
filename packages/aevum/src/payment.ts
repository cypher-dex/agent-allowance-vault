import type { Address, Hex } from "viem";

/**
 * A minimal HTTP 402 payment flow that settles on Aevum through AllowanceVault.
 * It follows the shape of x402 (402 + payment requirements, a payment header on retry, a payment
 * response header) but uses the vault as the settlement contract, because QDay's x402 facilitator
 * has no published endpoint on Aevum yet. Swap the "vault-sig" scheme for x402's "exact" scheme
 * when it ships.
 *
 *   1. Client calls the paid endpoint with `X-Agent: <agent address>`.
 *   2. Server answers 402 with a `Quote` (price, payee, ref, deadline) in the JSON body.
 *   3. Client signs the vault `Spend` for exactly that quote and retries with `X-Payment`.
 *   4. Server checks the quote, submits `spendWithSig`, waits for the receipt, serves the result
 *      and returns `X-Payment-Response` with the tx hash.
 * Retrying step 3 with the same quote is safe: the vault pays a (payee, ref) once and the server
 * returns the stored result.
 */
export const HEADER_AGENT = "x-agent";
export const HEADER_PAYMENT = "x-payment";
export const HEADER_PAYMENT_RESPONSE = "x-payment-response";

export interface Quote {
  scheme: "vault-sig";
  quoteId: string;
  chainId: number;
  vault: Address;
  token: Address;
  payee: Address;
  /** Base units (tUSD8 has 6 decimals), as a decimal string. */
  amount: string;
  ref: Hex;
  /** Unix seconds. The signed Spend must use exactly this deadline. */
  deadline: number;
  resource: string;
  /** Why this price: base price and any reputation discount. */
  pricing: { base: string; discountBps: number; reputation: { count: number; average: number } };
  /** True if the agent's grant commits to an ML-DSA-65 key, so a PQ signature is required. */
  pqRequired: boolean;
}

export interface PaymentPayload {
  scheme: "vault-sig";
  quoteId: string;
  agent: Address;
  /** ECDSA signature over the EIP-712 Spend digest. */
  signature: Hex;
  /** Present when the agent has a post-quantum key: ML-DSA-65 over the same digest. */
  pq?: { publicKey: Hex; signature: Hex };
}

export interface PaymentResponse {
  txHash: Hex;
  ref: Hex;
  amount: string;
  payee: Address;
  agent: Address;
  blockNumber: string;
}

/** base64(JSON), safe for HTTP headers. Works in Node and in the browser. */
export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    const bin = atob(value);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}
