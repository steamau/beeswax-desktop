import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// manifest.json's tools array must list exactly the registered tools (npm run manifest).
test("manifest.json lists every registered tool and the right version", () => {
  const out = execFileSync(process.execPath, ["scripts/manifest.mjs", "--check"], { encoding: "utf8" });
  assert.match(out, /manifest OK/);
});
