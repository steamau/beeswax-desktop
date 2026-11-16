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
  "1.18.0: compliance documents are written in Alpha. mark_compliance_document_prepared now takes only an uploaded " +
  "file (document_id required, no url) and refuses every generated document — write those with " +
  "generate_compliance_document, never in an artifact or file pointed at. generate_compliance_document lists " +
  "property_valuation as required in any year the fund held property at 30 June. list_ato_accounts carries the ATO " +
  "feed's status where the server has it.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = [
  "get_audit_program", "get_audit_line", "select_audit_sample", "list_changes_since_finalised", "sign_off_audit_line",
  "list_audit_queries", "raise_audit_query", "answer_audit_query", "reply_audit_query", "close_audit_query",
  "request_audit_document"
];
