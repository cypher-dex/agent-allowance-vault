import type { Address, Hex } from "viem";

export function short(value: Address | Hex | string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function timeLeft(unixSeconds: number, nowMs = Date.now()): string {
  const s = unixSeconds - Math.floor(nowMs / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86400) return `${Math.floor(s / 3600)} h left`;
  return `${Math.floor(s / 86400)} d left`;
}
