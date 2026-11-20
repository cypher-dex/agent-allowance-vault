import type { Address, Hex } from "viem";
import { tusd8Domain } from "./contracts";

/** EIP-712 types for an EIP-3009 `ReceiveWithAuthorization` (used by `AllowanceVault.depositWithAuthorization`). */
export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface ReceiveAuthorization {
  from: Address;
  /** Must be the contract that calls receiveWithAuthorization (the vault). */
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** Any unused 32 bytes. */
  nonce: Hex;
}

/**
 * Typed data for `signTypedData` (viem / wagmi). Pass the result straight to the wallet.
 *
 *   const sig = await walletClient.signTypedData({ account, ...receiveTypedData(...) })
 */
export function receiveTypedData(chainId: number, token: Address, message: ReceiveAuthorization) {
  return {
    domain: tusd8Domain(chainId, token),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization" as const,
    message,
  };
}

/** A signature window that is valid at once (validAfter = 0, so clock drift can't reject it) and lasts `seconds`. */
export function authorizationWindow(seconds = 600, nowMs = Date.now()) {
  const now = BigInt(Math.floor(nowMs / 1000));
  return { validAfter: 0n, validBefore: now + BigInt(seconds) };
}
