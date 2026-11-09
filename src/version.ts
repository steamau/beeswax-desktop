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
  "1.13.0: resolve_return_check — accept (attention, with a note), answer (a decision option) or clear a check once " +
  "the trustee confirms (confirmed_by_user), recorded \"via assistant\"; blocking checks still need fixing. " +
  "reclassify_balance_item_to_holding — a prior-year asset line that became part of a holding from 1 July is a " +
  "transfer in, not a gain. settle_prior_year_creditor — an expense payment that settles last year's creditor isn't " +
  "expensed again. set_expense_gst_treatment — expense GST vs BAS credits per period, with a previewed bulk fix " +
  "(check expenses_gst_treatment). update_transaction splits a receipt above its receivable into income. GIC from the " +
  "ATO accounts is an operating expense.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS = [
  "resolve_return_check",
  "reclassify_balance_item_to_holding",
  "settle_prior_year_creditor",
  "set_expense_gst_treatment"
];
