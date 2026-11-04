import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Member-statement tools exist with the right annotations and inputs.
test("member statement tools are registered with annotations", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "member-statements-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const list = byName.get("list_member_statements");
    assert.ok(list, "list_member_statements registered");
    assert.equal(list.annotations.readOnlyHint, true);

    const update = byName.get("update_member_statement");
    assert.ok(update, "update_member_statement registered");
    assert.equal(update.annotations.readOnlyHint, false);
    assert.equal(update.annotations.destructiveHint, true);
    const props = update.inputSchema.properties;
    for (const key of [
      "fund_member_id", "opening_balance", "employer_contributions", "other_contributions",
      "allocated_earnings", "inward_rollovers", "outward_rollovers", "lump_sum_payment", "income_stream_payment",
      "accumulation_phase_balance", "retirement_phase_balance", "tax_free_component", "taxable_component",
      "preserved_amount", "restricted_non_preserved_amount", "unrestricted_non_preserved_amount", "closing_balance"
    ]) {
      assert.ok(props[key], `update_member_statement accepts ${key}`);
    }
    assert.deepEqual([...update.inputSchema.required].sort(), ["financial_year", "fund_id", "fund_member_id"]);

    const allocate = byName.get("allocate_earnings");
    assert.ok(allocate, "allocate_earnings registered");
    assert.equal(allocate.annotations.readOnlyHint, false);
    assert.equal(allocate.annotations.destructiveHint, true);
    assert.deepEqual(allocate.inputSchema.properties.method.enum, ["opening_balance", "average_daily_balance"]);
  } finally {
    await client.close();
  }
});
