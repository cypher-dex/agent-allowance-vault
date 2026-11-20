import type { Address, Hex } from "viem";

/** Addresses written by `contracts/script/Deploy.s.sol` to `deployments/<chainId>.json`. */
export interface Deployment {
  chainId: number;
  deployBlock: number;
  token: Address;
  identity: Address;
  vault: Address;
  reputation: Address;
}

export interface SpendMessage {
  agent: Address;
  payee: Address;
  amount: bigint;
  ref: Hex;
  deadline: bigint;
}

/** EIP-712 domain of AllowanceVault. */
export function vaultDomain(chainId: number, vault: Address) {
  return { name: "AllowanceVault", version: "1", chainId, verifyingContract: vault } as const;
}

export const spendTypes = {
  Spend: [
    { name: "agent", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "ref", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Typed data an agent signs so anyone can submit `AllowanceVault.spendWithSig` for it. */
export function spendTypedData(chainId: number, vault: Address, message: SpendMessage) {
  return { domain: vaultDomain(chainId, vault), types: spendTypes, primaryType: "Spend" as const, message };
}

/**
 * One sentence per AllowanceVault / ReputationRegistry error, for UIs, logs and HTTP responses.
 * `args` are the decoded error arguments; amounts are formatted with `fmt`.
 */
export function explainVaultError(name: string, args: readonly unknown[] = [], fmt: (v: bigint) => string = String): string {
  const a = (i: number) => args[i] as bigint;
  switch (name) {
    case "NoGrant":
      return "This agent key has no allowance. The owner must grant it first.";
    case "GrantRevoked":
      return "The owner revoked this agent's allowance. Nothing was charged.";
    case "GrantExpired":
      return "This agent's allowance has expired. The owner can renew it.";
    case "PayeeNotAllowed":
      return "This seller is not on the agent's allowlist. The owner can add it.";
    case "OverPerTxCap":
      return `This payment (${fmt(a(0))}) is above the agent's per-payment limit of ${fmt(a(1))}.`;
    case "OverDailyCap":
      return `Daily limit reached: this payment needs ${fmt(a(0))} but only ${fmt(a(1))} is left today.`;
    case "InsufficientVaultBalance":
      return `The owner's vault balance (${fmt(a(1))}) is too low for ${fmt(a(0))}. The owner must deposit.`;
    case "RefAlreadyPaid":
      return "This quote is already paid. Nothing was charged twice.";
    case "SignatureExpired":
      return "The agent's payment signature expired before it was submitted. Nothing was charged.";
    case "BadSignature":
      return "The payment signature does not match the agent, seller, amount or quote.";
    case "ZeroAmount":
      return "The amount must be more than zero.";
    case "BadCaps":
      return "The per-payment limit must be above zero and not above the daily limit.";
    case "BadExpiry":
      return "The expiry must be in the future.";
    case "NotIdentityOwner":
      return "You don't own this agent identity.";
    case "AgentOwnedByOther":
      return "This agent key already belongs to another owner. Generate a new agent key.";
    case "NotGrantOwner":
      return "Only the owner who granted this agent can change it.";
    case "NoReceipt":
      return "There is no payment for this quote, so it cannot be rated.";
    case "AlreadyRated":
      return "This payment has already been rated.";
    default:
      return name;
  }
}
