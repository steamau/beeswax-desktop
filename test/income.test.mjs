import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Workstream C: record_income carries the full tax-statement split, GST and the
// accrual fields; update_transaction edits a ledger row; update_cash_transaction
// takes a GST treatment.
test("income tools expose tax-statement, GST and accrual fields", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "income-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const income = byName.get("record_income");
    assert.equal(income.annotations.destructiveHint, false);
    for (const field of [
      "franking_credits", "franked_distribution_amount", "non_primary_production_amount", "trust_franking_credit",
      "foreign_income_amount", "foreign_tax_paid", "capital_gain_discounted_gross", "capital_gain_indexed",
      "capital_gain_other", "cgt_concession_amount", "tax_deferred_amount", "amit_cost_base_increase",
      "gst_treatment", "gst_amount", "entitlement_date", "settles_fund_balance_item_id"
    ]) {
      assert.ok(income.inputSchema.properties[field], `record_income missing ${field}`);
    }

    const update = byName.get("update_transaction");
    assert.ok(update, "update_transaction is registered");
    assert.equal(update.annotations.readOnlyHint, false);
    assert.equal(update.annotations.destructiveHint, true);
    assert.deepEqual([...update.inputSchema.required].sort(), ["fund_id", "holding_id", "transaction_id"]);
    for (const field of ["capital_gain_discounted_gross", "gst_treatment", "entitlement_date", "capital_gain_loss"]) {
      assert.ok(update.inputSchema.properties[field], `update_transaction missing ${field}`);
    }

    const cash = byName.get("update_cash_transaction");
    assert.ok(cash.inputSchema.properties.gst_treatment);
    assert.ok(cash.inputSchema.properties.gst_amount);
  } finally {
    await client.close();
  }
});
