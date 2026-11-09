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
  "1.14.0: supporting documents — upload_document takes category (statement | supporting), document_date, " +
  "financial_years, permanent and links (holding, balance item, check, compliance document type, counterparty, " +
  "note), and accepts images, docx/xlsx, txt and eml; a supporting document is stored as evidence only. " +
  "update_document retitles, recategorises or relinks a document (never the ledger). list_documents filters by " +
  "category, kind, holding, financial year, check and compliance document type.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS = [
  "update_document"
];
