import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Workstream E: return sign-off tools and the year-end pack PDFs. Boots the built
// server against a stub API so the PDF delivery (binary fetch → file on disk) is
// exercised end to end.

const FAKE_PDF = Buffer.from("%PDF-1.3\n% stub\n%%EOF\n", "latin1");

async function withServer(fn) {
  const requests = [];
  const http = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url.includes("/export_pdf") || req.url.includes("/year_end_pack/pdf")) {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="tax-reconciliation-2025-26-fund-1.pdf"'
      });
      res.end(FAKE_PDF);
    } else if (req.url.includes("/finalise")) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Can't finalise yet: Lock the year-end review (step 1) first." }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    }
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const exportDir = await mkdtemp(join(tmpdir(), "bwx-export-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      BEESWAX_API_TOKEN: "test-token",
      BEESWAX_URL: `http://127.0.0.1:${http.address().port}`,
      BEESWAX_EXPORT_DIR: exportDir
    }
  });
  const client = new Client({ name: "year-end-pack-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn({ client, requests, exportDir });
  } finally {
    await client.close();
    http.close();
    await rm(exportDir, { recursive: true, force: true });
  }
}

test("year-end pack tools are registered with the right annotations", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const expect = {
      confirm_smsf_return_section: { readOnlyHint: false, destructiveHint: false },
      reopen_smsf_return_section: { readOnlyHint: false, destructiveHint: false },
      finalise_smsf_return: { readOnlyHint: false, destructiveHint: true },
      export_smsf_return_pdf: { readOnlyHint: true },
      list_year_end_pack: { readOnlyHint: true },
      get_year_end_pack_pdf: { readOnlyHint: true }
    };
    for (const [name, annotations] of Object.entries(expect)) {
      assert.ok(byName.has(name), `missing ${name}`);
      for (const [hint, value] of Object.entries(annotations)) {
        assert.equal(byName.get(name).annotations[hint], value, `${name}.${hint}`);
      }
    }
  });
});

test("sign-off tools post to the return endpoints and surface a 422", async () => {
  await withServer(async ({ client, requests }) => {
    await client.callTool({ name: "confirm_smsf_return_section", arguments: { fund_id: 1, smsf_return_id: 9, section_key: "income" } });
    await client.callTool({ name: "reopen_smsf_return_section", arguments: { fund_id: 1, smsf_return_id: 9, section_key: "income" } });
    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url}`),
      ["POST /api/v1/funds/1/smsf_returns/9/confirm_section", "POST /api/v1/funds/1/smsf_returns/9/unconfirm_section"]
    );
    // Without confirm: true the tool refuses before calling the API.
    const unconfirmed = await client.callTool({ name: "finalise_smsf_return", arguments: { fund_id: 1, smsf_return_id: 9 } });
    assert.equal(unconfirmed.isError, true);
    assert.equal(requests.filter((r) => r.url.includes("/finalise")).length, 0);

    const result = await client.callTool({
      name: "finalise_smsf_return",
      arguments: { fund_id: 1, smsf_return_id: 9, confirm: true }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Lock the year-end review/);
  });
});

test("PDF tools save the file and return its path and size", async () => {
  await withServer(async ({ client, requests, exportDir }) => {
    const result = await client.callTool({
      name: "get_year_end_pack_pdf",
      arguments: { fund_id: 1, financial_year: "2025-26", document: "tax_reconciliation" }
    });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const info = JSON.parse(result.content[0].text);
    assert.equal(info.path, join(exportDir, "tax-reconciliation-2025-26-fund-1.pdf"));
    assert.equal(info.size_bytes, FAKE_PDF.length);
    assert.deepEqual(await readFile(info.path), FAKE_PDF);
    assert.equal(requests.at(-1).url, "/api/v1/funds/1/financial_years/2025-26/year_end_pack/pdf?document=tax_reconciliation");
    assert.equal(requests.at(-1).auth, "Bearer test-token");

    const ret = await client.callTool({ name: "export_smsf_return_pdf", arguments: { fund_id: 1, smsf_return_id: 9 } });
    assert.ok(!ret.isError, ret.content?.[0]?.text);
    assert.equal(requests.at(-1).url, "/api/v1/funds/1/smsf_returns/9/export_pdf");
  });
});
