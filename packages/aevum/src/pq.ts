import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex, concat, hexToBytes, keccak256, toBytes, type Hex } from "viem";

/**
 * Post-quantum agent keys (ML-DSA-65, FIPS 204).
 *
 * QDay plans hybrid ECDSA + ML-DSA-65 agent keys (Q4 2026) and an ML-DSA verify precompile in
 * Phase 2. Neither is on Aevum yet, so this app:
 *   - commits `keccak256(publicKey)` in the agent's vault grant (`pqKeyHash`), and
 *   - has the agent sign the same EIP-712 Spend digest with both keys; the seller verifies the
 *     ML-DSA signature off chain against the committed hash before it settles.
 * When the precompile ships, the same check moves into `spendWithSig`.
 */

/** Derives the agent's ML-DSA-65 key from its ECDSA key, so one secret backs both (like QDay's one-mnemonic plan). */
export function pqKeyFromAgentKey(agentPrivateKey: Hex) {
  const seed = hexToBytes(keccak256(concat([toBytes("aevum-allowance-vault:ml-dsa-65:v1"), hexToBytes(agentPrivateKey)])));
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey: bytesToHex(publicKey), secretKey, pqKeyHash: keccak256(publicKey) };
}

export function pqSign(digest: Hex, secretKey: Uint8Array): Hex {
  return bytesToHex(ml_dsa65.sign(hexToBytes(digest), secretKey));
}

/** Checks the ML-DSA-65 signature and that the public key matches the hash committed on chain. */
export function pqVerify(digest: Hex, signature: Hex, publicKey: Hex, committedHash: Hex): boolean {
  if (keccak256(publicKey).toLowerCase() !== committedHash.toLowerCase()) return false;
  try {
    return ml_dsa65.verify(hexToBytes(signature), hexToBytes(digest), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
