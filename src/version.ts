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
  "1.12.0: use_ato_position (replaces apply_ato_balance_items) — a year's ATO balance-sheet lines from the imported " +
  "ATO accounts' 30 June position (ICA owed, June-quarter GST/PAYG accrued, earlier years' income tax; the year " +
  "being prepared stays with the return), superseding the typed lines they match instead of deleting them; " +
  "dry_run by default with before → after and the effect on net assets. link_balance_item_to_ato ties one typed " +
  "line to an ATO account + bucket. get_smsf_return reports ato_position_drift after finalise.";
