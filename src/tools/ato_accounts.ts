import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, pageParam, perPageParam, READS, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

const atoAccountId = z
  .number()
  .int()
  .positive()
  .describe("ATO account ID (find via list_ato_accounts)");

// The fund's accounts with the Tax Office — income tax (551), activity statement
// (001, the Integrated Client Account), superannuation (552) — mirrored line by
// line from the ATO's own statements. Descriptions are the ATO's text from a file
// the user supplied, so results that carry them are fenced as untrusted data.
export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "list_ato_accounts",
    {
      title: "List ATO accounts",
      annotations: READS,
      description:
        "List the fund's ATO accounts (income tax 551, activity statement 001, superannuation 552) with their " +
        "balance (positive = owed to the ATO, negative = the ATO owes the fund), how far the imported statement " +
        "reaches, and whether Alpha's running balance agrees with the ATO's. Use to find an ato_account_id.",
      inputSchema: { fund_id: fundId }
    },
    async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/ato_accounts`))
  );

  server.registerTool(
    "import_ato_statement",
    {
      title: "Import ATO statement",
      annotations: WRITES,
      description:
        "Import an ATO account statement from the ATO Online services portal's Transactions page: the CSV its " +
        "Download button saves, or the JSON the page returns (TransactionStatements: response.transactionDetail[]). " +
        "Pass file_path to the saved .csv or .json file, or the text itself as statement_json. Prefer the JSON when " +
        "the user has it: it links GIC remissions to their charges, so the 30 June position is exact (a position " +
        "built from the CSV says when it isn't). Idempotent — lines already imported are matched, and a JSON import " +
        "upgrades lines first imported from the CSV, so re-importing an overlapping range adds nothing. Afterwards Alpha checks its running balance against " +
        "the ATO's on every line (reconciled: false names the first line that differs) and proposes bank rows " +
        "for ATO payments and refunds (confirm them with match_ato_payment). A statement for a different ATO " +
        "account is refused, by its header or, when the CSV has no title lines, by what its lines say (activity " +
        "statement lines can't go into the income tax account, or income tax lines into the activity statement " +
        "account); the error names the account it looks like. Imported into the wrong account? Use undo_ato_import.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        file_path: z.string().optional().describe("Absolute path to the saved Download .csv or TransactionStatements .json file"),
        statement_json: z.string().optional().describe("The statement's text — the JSON or the Download CSV (instead of file_path)")
      }
    },
    async ({ fund_id, ato_account_id, file_path, statement_json }) => {
      let statement = statement_json;
      let filename: string | undefined;
      if (file_path) {
        try {
          statement = await readFile(file_path, "utf8");
          filename = file_path.split(/[\\/]/).pop();
        } catch (err) {
          throw new Error(`Could not read file at ${file_path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!statement) {
        throw new Error("Pass file_path or statement_json.");
      }
      return toResult(
        await api("POST", `/funds/${fund_id}/ato_accounts/${ato_account_id}/import`, {
          body: { statement, filename }
        })
      );
    }
  );

  server.registerTool(
    "list_ato_transactions",
    {
      title: "List ATO transactions",
      annotations: READS,
      description:
        "List an ATO account's statement lines, newest first, each with the ATO's running balance and Alpha's " +
        "beside it. By default only the lines that carry the balance (parents and single lines); pass " +
        "include_children to add the per-period breakdown (GST, PAYG instalment, GIC lines). Amounts: positive " +
        "= DR (owed to the ATO), negative = CR. Filter by category (activity_statement_raised, " +
        "income_tax_assessed, payment, refund, general_interest_charge, penalty, remission, " +
        "interest_on_overpayment, transfer_between_ato_accounts, other), match_status or processed-date range.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        category: z.string().optional().describe("Filter by category"),
        match_status: z
          .enum(["unmatched", "proposed", "matched", "ignored"])
          .optional()
          .describe("Bank match status (payments and refunds)"),
        from: isoDate("Earliest processed date (inclusive)").optional(),
        to: isoDate("Latest processed date (inclusive)").optional(),
        include_children: z.boolean().optional().describe("Also list the breakdown lines under each parent"),
        page: pageParam,
        per_page: perPageParam
      }
    },
    async ({ fund_id, ato_account_id, ...query }) =>
      toResult(await api("GET", `/funds/${fund_id}/ato_accounts/${ato_account_id}/ato_transactions`, { query }), {
        untrusted: true
      })
  );

  server.registerTool(
    "get_ato_position",
    {
      title: "Get ATO position",
      annotations: READS,
      description:
        "Where an ATO account stood on a date (default the last 30 June), using every line the ATO has processed " +
        "to today: `owed` for periods ended (for the activity statement, the Integrated Client Account balance), " +
        "broken down into general interest charge, penalties and each income year's periods; and `accrued` — " +
        "activity statement amounts for periods ended by the date but not yet due (GST / PAYG instalment payable " +
        "for the June quarter). GIC remitted after the date nets to nil. Positive = owed to the ATO. These are the " +
        "figures for the year's balance items.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        as_at: isoDate("Position date (default the last 30 June)").optional()
      }
    },
    async ({ fund_id, ato_account_id, as_at }) =>
      toResult(await api("GET", `/funds/${fund_id}/ato_accounts/${ato_account_id}/position`, { query: { as_at } }))
  );

  server.registerTool(
    "update_ato_transaction",
    {
      title: "Update ATO transaction",
      annotations: WRITES,
      description:
        "Correct how an ATO statement line is treated: its category (a person's category survives re-import), a " +
        "note, or reverses_id — the line a remission or amendment reverses (same account). The amount, dates and " +
        "description are the ATO's and can't be changed; re-import the statement instead.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        ato_transaction_id: z.number().int().positive().describe("Alpha's id for the line (from list_ato_transactions)"),
        category: z
          .enum([
            "activity_statement_raised",
            "income_tax_assessed",
            "payment",
            "refund",
            "general_interest_charge",
            "penalty",
            "remission",
            "interest_on_overpayment",
            "transfer_between_ato_accounts",
            "other"
          ])
          .optional(),
        note: z.string().optional(),
        reverses_id: z.number().int().positive().optional().describe("Alpha's id of the line this one reverses")
      }
    },
    async ({ fund_id, ato_account_id, ato_transaction_id, ...ato_transaction }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/ato_accounts/${ato_account_id}/ato_transactions/${ato_transaction_id}`, {
          body: { ato_transaction }
        })
      )
  );

  server.registerTool(
    "match_ato_payment",
    {
      title: "Match ATO payment",
      annotations: WRITES,
      description:
        "Settle which bank row paid an ATO payment (or received an ATO refund). match_action: \"find\" proposes " +
        "bank rows for every unmatched ATO payment and refund in the fund (same amount, within 5 days, PRN " +
        "preferred; when no single row fits, several rows of one day or one unique combination that add up to it, " +
        "e.g. seven BPAYs paid as one ATO payment); \"confirm\" accepts the proposed row(s), or the " +
        "cash_transaction_id you give (the amount must be equal), or cash_transaction_ids for several rows that " +
        "together add up exactly to the ATO line, marking both sides matched; \"ignore\" rejects the proposal; " +
        "\"unmatch\" undoes a match or an ignore. Confirm only what the user has agreed or what you have checked " +
        "against the bank statement.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        match_action: z.enum(["find", "confirm", "ignore", "unmatch"]),
        ato_transaction_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Alpha's id for the ATO payment or refund line (required except for find)"),
        cash_transaction_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("For confirm: the bank row, when it isn't the proposed one"),
        cash_transaction_ids: z
          .array(z.number().int().positive())
          .min(2)
          .optional()
          .describe("For confirm: several bank rows that together paid this ATO line (their amounts must add up to it)")
      }
    },
    async ({ fund_id, ato_account_id, match_action, ato_transaction_id, cash_transaction_id, cash_transaction_ids }) => {
      const base = `/funds/${fund_id}/ato_accounts/${ato_account_id}`;
      if (match_action === "find") return toResult(await api("POST", `${base}/match_payments`));
      if (!ato_transaction_id) {
        throw new Error(`ato_transaction_id is required for ${match_action}`);
      }
      return toResult(
        await api("POST", `${base}/ato_transactions/${ato_transaction_id}/match`, {
          body: { match_action, cash_transaction_id, cash_transaction_ids }
        })
      );
    }
  );

  server.registerTool(
    "create_ato_account",
    {
      title: "Create ATO account",
      annotations: WRITES,
      description:
        "Add one of the fund's accounts with the Tax Office: income_tax (551), activity_statement (001, the " +
        "Integrated Client Account — a fund registered for GST or paying PAYG instalments has one) or " +
        "superannuation (552). A fund has at most one of each; asking for a type it already has is refused. " +
        "Alpha also adds the activity statement account by itself when the fund is GST-registered or pays PAYG " +
        "instalments, so check list_ato_accounts first. Import its statement afterwards with import_ato_statement.",
      inputSchema: {
        fund_id: fundId,
        account_type: z.enum(["income_tax", "activity_statement", "superannuation"]).describe("Which ATO account"),
        display_name: z.string().max(100).optional().describe("Defaults to e.g. \"Activity statement (001)\"")
      }
    },
    async ({ fund_id, account_type, display_name }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/ato_accounts`, { body: { ato_account: { account_type, display_name } } })
      )
  );

  server.registerTool(
    "list_ato_imports",
    {
      title: "List ATO imports",
      annotations: READS,
      description:
        "List the statement imports into an ATO account, newest first: file, dates covered, lines created / " +
        "updated / unchanged, whether the balance agreed with the ATO's afterwards, and whether each can be " +
        "undone (can_undo, undo_blockers). Use to find the import_id for undo_ato_import.",
      inputSchema: { fund_id: fundId, ato_account_id: atoAccountId }
    },
    async ({ fund_id, ato_account_id }) =>
      toResult(await api("GET", `/funds/${fund_id}/ato_accounts/${ato_account_id}/imports`), { untrusted: true })
  );

  server.registerTool(
    "undo_ato_import",
    {
      title: "Undo ATO import",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "DESTRUCTIVE: take an ATO statement import back out of its account — deletes every line that import " +
        "created and puts back the opening balance and date it replaced. Lines it only updated or found " +
        "unchanged, and lines typed in by hand, stay. dry_run defaults to true: it returns the preview (lines " +
        "removed, their processed-date range, the balance and opening balance before and after, blockers) and " +
        "writes nothing. Show the user the preview and get their go-ahead before calling again with dry_run: " +
        "false. Refused (blockers) when a line it created is matched to a bank row (unmatch it first with " +
        "match_ato_payment), when a financial year it touches is closed or lodged, or when a later import " +
        "covers the same lines (undo that one first). Audit-logged with your reasoning and the removed lines.",
      inputSchema: {
        fund_id: fundId,
        ato_account_id: atoAccountId,
        import_id: z.number().int().positive().describe("The import to undo (from list_ato_imports)"),
        dry_run: z.boolean().default(true).describe("true (default): preview only, nothing written")
      }
    },
    async ({ fund_id, ato_account_id, import_id, dry_run }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/ato_accounts/${ato_account_id}/imports/${import_id}/undo`, {
          body: { dry_run: dry_run !== false }
        }),
        { untrusted: true } // blockers quote the ATO's line descriptions
      )
  );
}
