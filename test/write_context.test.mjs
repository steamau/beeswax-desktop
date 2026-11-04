import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Every write tool takes reasoning + external_ref and sends them as
// X-Reasoning / Idempotency-Key; reads send neither.
test("write tools send Idempotency-Key and X-Reasoning; reads don't", async () => {
  const seen = [];
  const http = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "t", BEESWAX_URL: `http://127.0.0.1:${http.address().port}` },
    stderr: "ignore"
  });
  const client = new Client({ name: "write-context-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const t of tools.filter((t) => t.annotations.readOnlyHint === false)) {
      assert.ok(t.inputSchema.properties.reasoning, `${t.name} lacks reasoning`);
      assert.ok(t.inputSchema.properties.external_ref, `${t.name} lacks external_ref`);
    }

    await client.callTool({
      name: "record_balance_item",
      arguments: { fund_id: 2, financial_year: "2024-25", side: "asset", label: "Dividends receivable",
                   amount: 7215.32, external_ref: "fy24-div-recv", reasoning: "Audited FY24 accounts — note 6" }
    });
    await client.callTool({ name: "update_fund_details", arguments: { fund_id: 2, abn: "12345678901" } });
    await client.callTool({ name: "list_balance_items", arguments: { fund_id: 2, financial_year: "2024-25" } });

    const [withRef, withoutRef, read] = seen;
    assert.equal(withRef.headers["idempotency-key"], "record_balance_item:fy24-div-recv");
    assert.equal(decodeURIComponent(withRef.headers["x-reasoning"]), "Audited FY24 accounts — note 6");
    assert.match(withoutRef.headers["idempotency-key"], /^update_fund_details:[0-9a-f-]{36}$/);
    assert.equal(withoutRef.headers["x-reasoning"], undefined);
    assert.equal(read.method, "GET");
    assert.equal(read.headers["idempotency-key"], undefined);
  } finally {
    await client.close();
    http.close();
  }
});
