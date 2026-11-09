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
  "1.15.0: compliance documents agree with the year-end pack and the return — operating_statement and " +
  "statement_of_financial_position are built by the pack's builder (content carries documents blocks, not a " +
  "statement hash). generate_compliance_document reports consistency failures in warnings, refuses finalize " +
  "(422 + blockers) while the year has blocking checks or the document fails them, and adds out_of_date / " +
  "out_of_date_reason (generating again regenerates). update_smsf_return_field returns the changed field, " +
  "affected_fields and completion; compact: false returns the whole return.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = [];
