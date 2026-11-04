import { z } from "zod";

// ── Shared schema fragments ──────────────────────────────────────────────────

export const fundId = z.number().int().positive().describe("Fund ID (discover via whoami or list_funds)");
export const isoDate = (what: string) => z.string().describe(`${what} as an ISO date, e.g. "2026-05-30"`);
export const pageParam = z.number().int().positive().optional().describe("Page number (default 1)");
export const perPageParam = z
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe("Results per page (default 25, max 100)");

// MCP tool annotations (hints for the client harness — e.g. to require
// confirmation before non-read-only calls).
export const READS = { readOnlyHint: true } as const;
// Additive/derived writes: create rows or recompute derived state; reversible.
export const WRITES = { readOnlyHint: false, destructiveHint: false } as const;
// Overwrites or discards existing data.
export const WRITES_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

export const financialYearKeyEarly = z
  .string()
  .describe('Financial year — the label "2023-24" or its numeric id (from list_financial_years)');
export const bankAccountId = z
  .number()
  .int()
  .positive()
  .describe("Bank account ID (find via list_bank_accounts)");
export const financialYearKey = z
  .string()
  .describe('Financial year — the label "2023-24" or its numeric id (from list_financial_years)');

export const balanceItemId = z
  .number()
  .int()
  .positive()
  .describe("Balance item ID (from list_balance_items)");
