import { readFileSync } from "node:fs";
import type { Deployment } from "@aevum-kit/aevum";

/** Reads deployments/<chainId>.json, written by contracts/script/Deploy.s.sol. */
export function loadDeployment(chainId: number): Deployment {
  const url = new URL(`../../deployments/${chainId}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, "utf8")) as Deployment;
  } catch {
    console.error(`No deployment for chain ${chainId}. Deploy first (make deploy-fork / deploy-aevum / deploy-local).`);
    process.exit(1);
  }
}
