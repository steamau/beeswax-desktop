import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The one place the server's version comes from: package.json, which ships in the
// .mcpb next to dist/. `npm run release` bumps it (and manifest.json) together.
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
};

export const SERVER_NAME = "beeswax-shares";
export const SERVER_VERSION: string = pkg.version;

// What changed in this release; server_info reports it. Keep in step with CHANGELOG.md.
export const RELEASE_NOTES =
  "1.11.0: apply_ato_balance_items — take a year's ATO balance-sheet lines (activity statement ICA, GST and PAYG " +
  "instalment accrued, income tax) from the imported ATO accounts, linked by ato_account_id + ato_bucket, " +
  "replacing typed lines in one step. match_ato_payment confirms one ATO payment against several bank rows " +
  "(cash_transaction_ids), and find proposes such splits.";
