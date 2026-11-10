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
  "1.17.0: the audit, for the auditor's assistant. get_audit_program returns the year's audit program — the same one " +
  "the Audit step shows — stage by stage (engagement, the fund, planning, Part A financial, Part B compliance, " +
  "conclude), each line with its figure, what proves it, the source document an auditor expects when none is on file, " +
  "and the auditor's sign-off; get_audit_line opens one with its working, tests and documents. select_audit_sample " +
  "draws a reproducible sample weighted to rows not read from the bank; list_changes_since_finalised shows whether " +
  "the figures moved. An auditor's token (read-only elsewhere) can raise_audit_query, reply_audit_query, " +
  "close_audit_query, request_audit_document and, on the auditor's explicit yes, sign_off_audit_line (audit:write). " +
  "The trustee's assistant answers with list_audit_queries / answer_audit_query. Queries are now threads the auditor " +
  "closes (status open, resolved = answered, closed).";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = [
  "get_audit_program", "get_audit_line", "select_audit_sample", "list_changes_since_finalised", "sign_off_audit_line",
  "list_audit_queries", "raise_audit_query", "answer_audit_query", "reply_audit_query", "close_audit_query",
  "request_audit_document"
];
