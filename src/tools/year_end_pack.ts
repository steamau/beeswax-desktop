import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api } from "../api.js";
import { API_TOKEN, BASE_URL, toResult } from "../api.js";
import { sanitizeText } from "../untrusted.js";
import { financialYearKey, fundId, READS, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

// Workstream E — signing off the return (confirm / reopen sections, finalise)
// and the year-end pack PDFs. Declaring and lodging stay in the web app.

const smsfReturnId = z.number().int().positive().describe("SMSF return ID (from get_smsf_return / create_smsf_return)");
const sectionKey = z
  .string()
  .describe(
    'Return section key, e.g. "fund_information", "income", "deductions", "tax_calc", "assets_liabilities", ' +
      'or "members" for the member information statement (the keys get_smsf_return lists)'
  );

/** Where exported PDFs are written: BEESWAX_EXPORT_DIR, else ~/Downloads/beeswax-shares. */
export function exportDir(): string {
  const configured = process.env.BEESWAX_EXPORT_DIR;
  return configured && configured.trim() ? resolve(configured.trim()) : join(homedir(), "Downloads", "beeswax-shares");
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 530]);

/**
 * GET a binary (PDF) endpoint of the API. api() parses JSON only, so PDFs come
 * through here: same bearer auth, a few retries on gateway errors, and the
 * JSON error body surfaced on failure.
 */
export async function apiBinary(
  path: string,
  query: Record<string, string | number | undefined> = {}
): Promise<{ bytes: Buffer; filename?: string; contentType: string }> {
  if (!API_TOKEN) {
    throw new Error("BEESWAX_API_TOKEN is not set. Create a token in the Beeswax Shares app (Account → API Access).");
  }
  const url = new URL(`${BASE_URL}/api/v1${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: "application/pdf, application/json" } });
    } catch (err) {
      if (attempt <= 3) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      throw new Error(`Could not reach the Beeswax Shares API at ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt <= 3) {
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 300 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 300) || res.statusText;
      try {
        const json = JSON.parse(text) as { error?: unknown };
        if (json && json.error !== undefined) message = String(json.error);
      } catch {
        /* not JSON */
      }
      throw new Error(sanitizeText(`Beeswax API error (HTTP ${res.status}): ${message}`));
    }
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      filename: match?.[1],
      contentType: res.headers.get("Content-Type") ?? ""
    };
  }
}

/** Write a downloaded PDF into the export folder and describe it for the model. */
async function savePdf(download: { bytes: Buffer; filename?: string; contentType: string }, fallbackName: string) {
  if (!download.bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    throw new Error(`Expected a PDF from the API but got ${download.contentType || "an unknown type"}.`);
  }
  const dir = exportDir();
  await mkdir(dir, { recursive: true });
  const safeName = (download.filename ?? fallbackName).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || fallbackName;
  const path = join(dir, safeName.endsWith(".pdf") ? safeName : `${safeName}.pdf`);
  await writeFile(path, download.bytes);
  const result = {
    path,
    size_bytes: download.bytes.length,
    size: `${(download.bytes.length / 1024).toFixed(1)} KB`,
    note: "PDF saved on this computer. Give the user the path; don't try to read the file back."
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "confirm_smsf_return_section",
    {
      title: "Confirm an SMSF return section",
      annotations: WRITES,
      description:
        "Confirm one section of an SMSF annual return: its computed figures are snapshotted as reviewed. Refused " +
        "(with the reasons) while the section has blocking gaps, or the return is already " +
        "finalised — fix those first (list_smsf_return_gaps). Returns the completion %, the sections still " +
        "unconfirmed and what still blocks finalising. Only confirm a section after the user has reviewed it.",
      inputSchema: { fund_id: fundId, smsf_return_id: smsfReturnId, section_key: sectionKey }
    },
    async ({ fund_id, smsf_return_id, section_key }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/smsf_returns/${smsf_return_id}/confirm_section`, { body: { section_key } })
      )
  );

  server.registerTool(
    "reopen_smsf_return_section",
    {
      title: "Reopen a confirmed SMSF return section",
      annotations: WRITES,
      description:
        "Undo a section confirmation so its figures can be edited again (drops that section's confirmation " +
        "snapshot; the figures themselves are unchanged). Not possible once the return is finalised — reopening a " +
        "finalised return is done in the web app.",
      inputSchema: { fund_id: fundId, smsf_return_id: smsfReturnId, section_key: sectionKey }
    },
    async ({ fund_id, smsf_return_id, section_key }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/smsf_returns/${smsf_return_id}/unconfirm_section`, { body: { section_key } })
      )
  );

  server.registerTool(
    "finalise_smsf_return",
    {
      title: "Finalise an SMSF annual return",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Finalise the tax return: freezes every figure into a snapshot so later ledger changes no longer move it, " +
        "and locks the financial year. Requires every section confirmed, no blocking gaps and no blocking checks " +
        "(see get_return_checks); otherwise fails with the list of blockers. Ask the user before calling. Declarations and " +
        "lodgement are then done by people in the web app; unfinalising is web-only too. Never lodges. " +
        "confirm must be true — only pass it after the user has said to finalise this return.",
      inputSchema: {
        fund_id: fundId,
        smsf_return_id: smsfReturnId,
        confirm: z
          .literal(true)
          .describe("Must be true: the user has explicitly asked to finalise this return")
      }
    },
    async ({ fund_id, smsf_return_id, confirm }) =>
      toResult(await api("POST", `/funds/${fund_id}/smsf_returns/${smsf_return_id}/finalise`, { body: { confirm } }))
  );

  server.registerTool(
    "export_smsf_return_pdf",
    {
      title: "Export the SMSF return as a PDF",
      annotations: READS,
      description:
        "Render the SMSF annual return (every completed label in NAT 71226 order, plus member information) as a " +
        "PDF and save it on this computer (BEESWAX_EXPORT_DIR, default ~/Downloads/beeswax-shares). Returns the " +
        "file path and size — share the path with the user.",
      inputSchema: { fund_id: fundId, smsf_return_id: smsfReturnId }
    },
    async ({ fund_id, smsf_return_id }) =>
      savePdf(
        await apiBinary(`/funds/${fund_id}/smsf_returns/${smsf_return_id}/export_pdf`),
        `smsf-return-${smsf_return_id}.pdf`
      )
  );

  server.registerTool(
    "list_year_end_pack",
    {
      title: "List the year-end pack",
      annotations: READS,
      description:
        "List the documents in a financial year's year-end pack. By default only what the law requires plus the " +
        "return: financial_statements (the statement of financial position and the operating statement, with the " +
        "trustees' declaration as their one signing block), trustee_minutes and smsf_return. include_audit_items: " +
        "true adds what the auditor asks for in writing (notes_to_financial_statements, " +
        "trustee_representation_letter). Also headline totals (benefits accrued, income tax expense, net assets, " +
        "taxable income, whether the tax reconciliation ties to the return), evidence_index (the year's supporting " +
        "documents, permanent ones included, each with a file_path) and net_assets_reconciliation: members' " +
        "opening balances + benefits accrued + rollovers in − benefits paid against net assets at 30 June, with " +
        "the difference (null without member statements). All figures come from the same services as the return. " +
        "Amounts in AUD.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        include_audit_items: z.boolean().optional().describe("Also list the auditor-requested items (notes, representation letter)")
      }
    },
    async ({ fund_id, financial_year, include_audit_items }) =>
      toResult(
        await api("GET", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/year_end_pack`, {
          query: { include_audit: include_audit_items ? "true" : undefined }
        })
      )
  );

  server.registerTool(
    "get_year_end_pack_document",
    {
      title: "Get a year-end pack document as JSON",
      annotations: READS,
      description:
        "Return one year-end pack document as structured JSON (headings, tables, lines and figures) — the same " +
        "content get_year_end_pack_pdf renders — for checking figures or building your own working papers. " +
        "Document keys come from list_year_end_pack; member_statement also needs member_id. Every key still " +
        "builds, including those no longer listed (detailed_operating_statement, investment_summary, " +
        "tax_reconciliation, member_statement, the separate statements and trustees_declaration): their figures " +
        "are the same ones Alpha shows on screen. Amounts in AUD.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        document: z
          .enum([
            "financial_statements",
            "statement_of_financial_position",
            "operating_statement",
            "detailed_operating_statement",
            "notes_to_financial_statements",
            "trustees_declaration",
            "investment_summary",
            "tax_reconciliation",
            "member_statement",
            "trustee_minutes",
            "trustee_representation_letter",
            "smsf_return"
          ])
          .describe("Which document"),
        member_id: z.number().int().positive().optional().describe("Member ID, for document member_statement")
      }
    },
    async ({ fund_id, financial_year, document, member_id }) =>
      toResult(
        await api(
          "GET",
          `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/year_end_pack/documents/${document}`,
          { query: { member_id } }
        )
      )
  );

  server.registerTool(
    "get_year_end_pack_pdf",
    {
      title: "Get the year-end pack as a PDF",
      annotations: READS,
      description:
        "Render the year-end pack (cover, contents and its documents) — or one document — as a PDF and save it " +
        "on this computer (BEESWAX_EXPORT_DIR, default ~/Downloads/beeswax-shares). The whole pack is the slim " +
        "one by default: financial statements, trustee minutes and the return; include_audit_items: true adds " +
        "the notes and the representation letter. Returns the file path and size. Document keys come from " +
        "list_year_end_pack; member_statement also needs member_id.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        document: z
          .enum([
            "financial_statements",
            "statement_of_financial_position",
            "operating_statement",
            "detailed_operating_statement",
            "notes_to_financial_statements",
            "trustees_declaration",
            "investment_summary",
            "tax_reconciliation",
            "member_statement",
            "trustee_minutes",
            "trustee_representation_letter",
            "smsf_return"
          ])
          .optional()
          .describe("One document only; omit for the whole pack"),
        member_id: z.number().int().positive().optional().describe("Member ID, for document member_statement"),
        include_audit_items: z.boolean().optional().describe("Whole pack: add the auditor-requested items")
      }
    },
    async ({ fund_id, financial_year, document, member_id, include_audit_items }) =>
      savePdf(
        await apiBinary(`/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/year_end_pack/pdf`, {
          document,
          member_id,
          include_audit: include_audit_items ? "true" : undefined
        }),
        `${document ?? "year-end-pack"}-${financial_year}.pdf`
      )
  );

  const settingsPath = (fund_id: number, financial_year: string, key: string) =>
    `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/year_end_pack/settings/${key}`;
  const STANDARD_RESOLUTIONS = [
    "directors_overseas",
    "cmc_australia",
    "no_non_resident_contributions",
    "events_after_year_end",
    "late_lodgments"
  ] as const;

  server.registerTool(
    "get_year_end_pack_settings",
    {
      title: "Get the trustee minutes / signatory settings",
      annotations: READS,
      description:
        "Read what is recorded for one of the year-end pack's signed documents: trustee_minutes (meeting date, " +
        "place, chair, attendance with absence reasons, optional standard resolutions, custom resolutions — " +
        "resolved shows who is present and absent, every resolution as it will print, and the signatories), " +
        "trustees_declaration and trustee_representation_letter (signatories and signing date; with none set they " +
        "default to the directors present at the minutes' meeting), or notes_to_financial_statements " +
        "(events after the reporting date).",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        document: z.enum([
          "trustee_minutes",
          "trustees_declaration",
          "trustee_representation_letter",
          "notes_to_financial_statements"
        ])
      }
    },
    async ({ fund_id, financial_year, document }) =>
      toResult(await api("GET", settingsPath(fund_id, financial_year, document)))
  );

  server.registerTool(
    "update_trustee_minutes",
    {
      title: "Record the year-end trustee meeting",
      annotations: WRITES,
      description:
        "Set the year-end trustee minutes: meeting date, place, chair, who was present and who was absent (with " +
        "a reason), optional standard resolutions and custom resolutions. Only what you pass changes. Only " +
        "directors present sign the minutes, and they are the default signatories of the trustees' declaration " +
        "and representation letter. The contributions resolution is written from the year's actual " +
        "contributions (none → \"no contributions were received\"). Standard resolutions: directors_overseas " +
        "(names the absent directors), cmc_australia (central management and control in Australia, by those " +
        "present), no_non_resident_contributions, events_after_year_end (uses the notes' subsequent events), " +
        "late_lodgments (with late_lodgments_detail). strategy_reviewed (default true) keeps the resolution that " +
        "the investment strategy was reviewed; once the minutes are finalised that is the year's strategy review " +
        "on the Compliance step. Refused for a locked year or finalised minutes.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        meeting_date: z.string().optional().describe("ISO date, e.g. 2026-11-10"),
        location: z.string().optional().describe("Where the meeting was held"),
        chair: z.string().optional().describe("Chair's name (defaults to the first director present)"),
        present: z.array(z.string()).optional().describe("Names of directors/trustees present"),
        absent: z
          .array(z.object({ name: z.string(), reason: z.string().optional() }))
          .optional()
          .describe("Directors/trustees absent, with the reason (e.g. \"resident overseas since 2023\")"),
        standard_resolutions: z
          .array(z.enum(STANDARD_RESOLUTIONS))
          .optional()
          .describe("Standard resolutions to include (replaces the current selection)"),
        late_lodgments_detail: z.string().optional().describe("What was lodged late, for the late_lodgments resolution"),
        strategy_reviewed: z.boolean().optional().describe("The trustees reviewed the investment strategy at this meeting (default true)"),
        custom_resolutions: z.array(z.string()).optional().describe("Extra resolutions, each starting \"That …\" (replaces the current list)")
      }
    },
    async ({ fund_id, financial_year, present, absent, standard_resolutions, custom_resolutions, strategy_reviewed, ...rest }) => {
      const answers: Record<string, unknown> = { ...rest };
      if (strategy_reviewed !== undefined) answers.res_strategy_reviewed = strategy_reviewed ? "yes" : "no";
      if (present || absent) {
        answers.attendance = [
          ...(present ?? []).map((name) => ({ name, present: "yes", absence_reason: "" })),
          ...(absent ?? []).map((a) => ({ name: a.name, present: "no", absence_reason: a.reason ?? "" }))
        ];
      }
      if (standard_resolutions) {
        for (const key of STANDARD_RESOLUTIONS) answers[`res_${key}`] = standard_resolutions.includes(key) ? "yes" : "";
      }
      if (custom_resolutions) answers.custom_resolutions = custom_resolutions.join("\n");
      return toResult(await api("PATCH", settingsPath(fund_id, financial_year, "trustee_minutes"), { body: { answers } }));
    }
  );

  server.registerTool(
    "update_pack_signatories",
    {
      title: "Set who signs the declaration or representation letter",
      annotations: WRITES,
      description:
        "Set the signatories (and optionally the signing date) of the trustee representation letter (also the " +
        "auditor's name), or of a separate trustees' declaration in a year kept on the earlier list — elsewhere the " +
        "declaration is the financial statements' signing block, where the trustees' signatures are recorded on the web. An empty signatories list returns to " +
        "the default: the directors present at the year-end trustee meeting. Refused for a locked year or a " +
        "finalised document.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        document: z.enum(["trustees_declaration", "trustee_representation_letter"]),
        signatories: z
          .array(z.object({ name: z.string(), role: z.string().optional() }))
          .optional()
          .describe("Who signs; role defaults to Director/Trustee"),
        signed_on: z.string().optional().describe("ISO date signed"),
        auditor_name: z.string().optional().describe("Representation letter only: auditor addressed")
      }
    },
    async ({ fund_id, financial_year, document, signatories, ...rest }) => {
      const answers: Record<string, unknown> = { ...rest };
      if (signatories) answers.signatories = signatories.map((s) => ({ name: s.name, role: s.role ?? "" }));
      return toResult(await api("PATCH", settingsPath(fund_id, financial_year, document), { body: { answers } }));
    }
  );
}
