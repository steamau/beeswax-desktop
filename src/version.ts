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
  "1.16.0: the Compliance step asks only for what the law requires each year — financial_statements (statement of " +
  "financial position + operating statement, one signing block, figures from the return, frozen when the return " +
  "is finalised and unfrozen when it is unfinalised), trustee_minutes and investment_strategy (a standing record; " +
  "finalised minutes with strategy_reviewed are the year's review). Retired types (operating_statement, " +
  "statement_of_financial_position, trustees_declaration, detailed_operating_statement, investment_summary, " +
  "tax_reconciliation, member_statements) return 410 with where the information lives; auditor-requested types " +
  "still generate; years kept on the earlier list are unchanged. list_year_end_pack / get_year_end_pack_pdf are " +
  "slim by default (financial statements, minutes, return); include_audit_items adds notes and the representation " +
  "letter. New: list_auditor_requests, record_auditor_request, answer_auditor_request (14-day due date, s 35C(2)).";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = ["list_auditor_requests", "record_auditor_request", "answer_auditor_request"];
