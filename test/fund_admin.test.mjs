import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Workstream D: fund details, bank-account corrections and depreciation tools
// are registered with the right read/write annotations. No API calls are made.
test("fund admin tools are registered with the right annotations", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "fund-admin-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const expected = {
      update_fund_details: { readOnlyHint: false, destructiveHint: true },
      update_bank_account: { readOnlyHint: false, destructiveHint: true },
      list_depreciation_schedules: { readOnlyHint: true },
      create_depreciation_schedule: { readOnlyHint: false, destructiveHint: false },
      update_depreciation_schedule: { readOnlyHint: false, destructiveHint: true },
      delete_depreciation_schedule: { readOnlyHint: false, destructiveHint: true },
      calculate_depreciation: { readOnlyHint: false, destructiveHint: false }
    };
    for (const [name, annotations] of Object.entries(expected)) {
      const tool = byName.get(name);
      assert.ok(tool, `missing tool ${name}`);
      for (const [key, value] of Object.entries(annotations)) {
        assert.equal(tool.annotations[key], value, `${name}.${key}`);
      }
    }

    // The TFN is never accepted through the connector.
    const props = byName.get("update_fund_details").inputSchema.properties;
    assert.equal(props.tfn, undefined);
    assert.ok(props.abn && props.auditor && props.tax_agent);
    assert.ok(byName.get("update_bank_account").inputSchema.properties.opening_balance_date);
  } finally {
    await client.close();
  }
});
