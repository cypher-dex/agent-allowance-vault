// Prints the web app's NEXT_PUBLIC_* lines for one deployment file. Used by `make env`.
import { existsSync, readFileSync } from "node:fs";

const [file, net] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error(`No ${file}. Deploy first.`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(file, "utf8"));
console.log(`NEXT_PUBLIC_VAULT_${net}=${d.vault}`);
console.log(`NEXT_PUBLIC_IDENTITY_${net}=${d.identity}`);
console.log(`NEXT_PUBLIC_REPUTATION_${net}=${d.reputation}`);
console.log(`NEXT_PUBLIC_DEPLOY_BLOCK_${net}=${d.deployBlock}`);
