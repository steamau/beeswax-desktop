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
  "1.19.0: get_strategy_mix returns the fund's mix by investment-strategy asset class against the ranges in the " +
  "strategy in force, today or at 30 June, with a status per class (facts against the trustees' own ranges only). " +
  "The year end is four steps, one person each: 1 Review (was Books), 2 Tax return, 3 Audit (now opening on the SIS " +
  "compliance tests and required documents), 4 Sign & lodge; the instructions and tool text follow.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = ["get_strategy_mix"];
