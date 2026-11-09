import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Round-trips the document tools against a stub API: upload_document sends the
// supporting fields, update_document PATCHes only what was passed (null clears),
// list_documents forwards its filters.
test("supporting document tools round-trip to the API", async () => {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ document: { id: 29, category: "supporting", status: "stored" }, next_step: null }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address();
  const dir = await mkdtemp(join(tmpdir(), "docs-test-"));
  const file = join(dir, "report.pdf");
  await writeFile(file, "%PDF-1.4 report");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: `http://127.0.0.1:${port}` }
  });
  const client = new Client({ name: "documents-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const upload = byName.get("upload_document");
    assert.deepEqual(upload.inputSchema.properties.category.enum, ["statement", "supporting"]);
    for (const f of ["document_date", "financial_years", "holding_id", "balance_item_id", "check_key",
                     "compliance_document_type", "counterparty", "note", "permanent"]) {
      assert.ok(f in upload.inputSchema.properties, `upload_document missing ${f}`);
    }
    const update = byName.get("update_document");
    assert.ok(update, "update_document missing");
    assert.equal(update.annotations.readOnlyHint, false);
    assert.deepEqual(update.inputSchema.required.sort(), ["document_id", "fund_id"]);
    for (const f of ["category", "kind", "holding_id", "financial_year", "check_key"]) {
      assert.ok(f in byName.get("list_documents").inputSchema.properties, `list_documents missing ${f}`);
    }

    await client.callTool({ name: "upload_document", arguments: {
      fund_id: 2, file_path: file, category: "supporting", kind: "correspondence",
      financial_years: ["2024-25", "2025-26"], holding_id: 23, counterparty: "Slightly Orangey Colour Pty Ltd"
    } });
    await client.callTool({ name: "update_document", arguments: {
      fund_id: 2, document_id: 29, category: "supporting", kind: "correspondence",
      financial_years: ["2024-25", "2025-26"], holding_id: 23,
      compliance_document_type: "notes_to_financial_statements", check_key: null
    } });
    await client.callTool({ name: "list_documents", arguments: { fund_id: 2, category: "supporting", financial_year: "2025-26", holding_id: 23 } });

    const [up, patch, list] = requests;
    assert.equal(up.method, "POST");
    assert.match(up.url, /\/funds\/2\/documents$/);
    assert.equal(up.body.document.category, "supporting");
    assert.deepEqual(up.body.document.financial_years, ["2024-25", "2025-26"]);
    assert.equal(up.body.document.counterparty, "Slightly Orangey Colour Pty Ltd");
    assert.equal(up.body.document.content_type, "application/pdf");

    assert.equal(patch.method, "PATCH");
    assert.match(patch.url, /\/funds\/2\/documents\/29$/);
    assert.deepEqual(patch.body.document, {
      category: "supporting", kind: "correspondence", financial_years: ["2024-25", "2025-26"], holding_id: 23,
      compliance_document_type: "notes_to_financial_statements", check_key: ""
    });

    assert.equal(list.method, "GET");
    const q = new URL(list.url, "http://x").searchParams;
    assert.equal(q.get("category"), "supporting");
    assert.equal(q.get("financial_year"), "2025-26");
    assert.equal(q.get("holding_id"), "23");
  } finally {
    await client.close();
    stub.close();
  }
});
