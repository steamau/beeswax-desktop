# Beeswax Shares MCP server — changelog

## 1.17.0 — 2026-11-10
- **The audit, for the auditor's assistant.** `get_audit_program` returns the year's audit program — the same one the
  Audit step shows — in the order an SMSF audit runs: engagement, the fund, planning, Part A financial, Part B
  compliance, conclude. Each line has a key, state (`ready`, `attention`, `blocking`, `na`, `info`, or `manual` where
  Alpha holds no test and the line carries the auditor's procedure), figure, `proven_by`, `evidence_gap` (the source
  document an auditor expects when none is on file) and the auditor's `signoff`. `get_audit_line` opens one line: facts,
  working tables, the checks behind it, source documents (read with `download_document`) and its queries.
- **Testing tools.** `select_audit_sample` draws a reproducible sample (seeded; by value or random) from rows a person
  or the trustee's assistant entered, since rows read from the bank already carry its record.
  `list_changes_since_finalised` shows ledger changes after the return was finalised.
- **An auditor's write lane.** An auditor's token stays read-only on the ledger. With the new `audit:write` scope it can
  `raise_audit_query` (on a program line with `line_key`), `reply_audit_query`, `close_audit_query`,
  `request_audit_document` (starts the 14 days, s 35C(2)) and `sign_off_audit_line` — the last only with
  `confirmed_by_user: true` after the auditor's explicit yes, recorded as signed via their assistant.
- **Both sides on one thread.** The trustee's assistant reads `list_audit_queries` and answers with
  `answer_audit_query`. A query's status is now `open` (waiting on the trustee), `resolved` (answered) or `closed`
  (the auditor accepted the answer); only the auditor closes one.
- Server instructions gain an AUDITING section: when `whoami` shows role `auditor`, test figures against documents,
  raise what doesn't agree, change nothing.

## 1.16.0 — 2026-11-10
- **The Compliance step asks only for what the law requires.** Each year: `financial_statements` (SIS Act s 35B —
  the statement of financial position and the operating statement as one item with one signing block, the trustees'
  declaration wording; figures from the return's own builder), `trustee_minutes` (s 103) and `investment_strategy`
  (reg 4.09, a standing record: flagged only with none on file or no review for the year; finalised minutes with the
  review resolution are the review). Permanent records (trust deed, ATO trustee declarations, consents to act) are
  kept once for the fund.
- **financial_statements** has no finalise: it freezes when the return is finalised (`finalise_smsf_return`) and
  unfreezes when the return is unfinalised. Trustees' signatures are recorded on the web; the signing rule follows the
  trustee structure (3+ directors: at least half; 1 or 2: all).
- **generate_compliance_document / mark_compliance_document_prepared**: retired types — `operating_statement`,
  `statement_of_financial_position`, `trustees_declaration`, `detailed_operating_statement`, `investment_summary`,
  `tax_reconciliation`, `member_statements` — return 410 with `retired: true`, a message saying where the information
  now lives and `now_lives_in` (pages with URLs). Auditor-requested types (`trustee_representation_letter`,
  `notes_to_financial_statements`, `related_party_confirmation`, `trustee_residency_declaration`, `property_valuation`)
  work as before. A year kept on the earlier list keeps every type. The result adds `tier` and `signatures`.
- **list_year_end_pack / get_year_end_pack_pdf** are slim by default: financial statements, minutes and the return.
  `include_audit_items: true` adds the notes and the representation letter. Every document key still builds on its own.
- **update_trustee_minutes**: `strategy_reviewed` (default true).
- **New: list_auditor_requests, record_auditor_request, answer_auditor_request** — documents the auditor asks for in
  writing, due 14 days after the request (s 35C(2)), answered with a generated letter or an uploaded file.

## 1.15.1 — 2026-11-10
- **No financial advice.** The server instructions now tell the assistant that Beeswax doesn't hold an Australian
  financial services licence and Alpha gives factual information only: report the fund's figures and how they are
  calculated; don't recommend buying, selling or holding an investment, suggest investments or an asset allocation,
  say which strategy or scenario is better, or say whether a member's balance is enough to retire on. Results from
  the calculators (fund longevity, scenarios, "if sold today") are stated with their assumptions, never as a
  forecast. No tools changed.

## 1.15.0 — 2026-11-10
- **Compliance documents agree with the year-end pack and the return.** `operating_statement` and
  `statement_of_financial_position` are now built by the pack's builder (the same blocks as
  `get_year_end_pack_document`): their `content` carries `documents` (blocks), no longer a `statement` hash.
- **generate_compliance_document**: `warnings` now carries consistency failures (net assets ≠ members' funds, total
  assets ≠ item 15 U, benefits accrued not agreeing across the statements). `finalize: true` on a financial document is
  refused (422 + `blockers`) while the year has blocking checks or the document fails those checks; a draft generates
  at any time. The result adds `out_of_date` / `out_of_date_reason`: a finalised document whose figures have since
  moved reads "Out of date" on its `compliance_document:<type>` check, and generating it again regenerates it.
- **update_smsf_return_field**: returns the changed `field`, `affected_fields` (every other figure it moved) and the
  return's status and completion — not the whole return. `compact: false` returns the whole return as before.

## 1.14.0 — 2026-11-09
- **Supporting documents.** `upload_document` takes `category` ("statement" | "supporting"; inferred from `kind`),
  `document_date`, `financial_years`, `permanent`, `holding_id`, `balance_item_id`, `check_key`,
  `compliance_document_type`, `counterparty` and `note`, and accepts images, docx/xlsx, txt and eml. A supporting
  document is stored as evidence only (status `stored`): no extraction, no `next_step`, and extract / lines /
  reconcile refuse it.
- **update_document** (new): retitle, recategorise or relink a document. A statement with extracted lines can't
  become supporting. Never changes the ledger.
- **list_documents**: filters `category`, `kind`, `holding_id`, `financial_year`, `check_key`,
  `compliance_document_type`.

## 1.13.0 — 2026-11-09
- **resolve_return_check**: accept a check in state `attention` (note required), answer a `needs_decision` check
  with one of its `decision_options` values, or `clear` an earlier answer — the same service as the web buttons.
  `confirmed_by_user` must be true: quote the check, value and note to the trustee and get a yes first. Recorded as
  "<user> via assistant" on the check (web and year-end accounts) and in the audit log. Refused for blocking checks,
  finalised returns and closed or lodged years.
- **reclassify_balance_item_to_holding** (`dry_run` defaults to true; `remove` undoes): a prior-year asset balance item
  that became part of a holding from 1 July shows as a transfer in on the movement schedule, not a purchase or an
  unrealised gain. The item's own (lodged) year isn't changed.
- **settle_prior_year_creditor** (also `settles_fund_balance_item_id` on update_cash_transaction): the settled part
  of an expense payment isn't an expense again — on the operating statement or the return's deductions.
- **set_expense_gst_treatment** (`dry_run` defaults to true): expense GST against BAS credits claimed per period, and a
  bulk gst_treatment fix over a year's expense rows. New check `expenses_gst_treatment` (Books). A GST-registered
  fund's expense rows now default to gst_inclusive when categorised (not bank fees, ASIC fees, interest, insurance).
- **update_transaction / record_income**: a receipt linked to a receivable for more than is outstanding is split;
  the excess is income (`excess_income_transaction` in the result).
- The operating statement expenses the general interest charge on the ATO accounts for the year (net of remissions).

## 1.12.0 — 2026-11-09
- **use_ato_position** replaces apply_ato_balance_items (`dry_run` defaults to true): the year's ATO
  balance-sheet lines from the 30 June position — buckets `owed` (ICA; earlier income years' income tax) and
  `accrued_<component>` (June-quarter GST, PAYG instalment …). The year being prepared never comes from the
  income tax account; the return's label S carries it. Typed lines that stand for the same account + bucket
  are **superseded** (kept, `counted: false`, out of the totals), not discarded; `keep` leaves named ones
  counting. The preview gives before → after per line, unmatched ATO-looking typed lines and
  `net_assets_effect`. Derived lines can't be edited by hand.
- **link_balance_item_to_ato**: tie one typed line to an ATO account + bucket so it is matched by link.
- **get_smsf_return**: `ato_position_drift` — how the 30 June ATO position has moved since finalise.
- **list_balance_items**: rows carry `counted`, `superseded_by_id` and, for derived lines, `ato_position_url`.

## 1.11.0 — 2026-11-09
- **apply_ato_balance_items** (`dry_run` defaults to true): writes a year's ATO balance-sheet lines from the
  imported ATO accounts' 30 June position — the activity statement's integrated client account (`ica`), the
  quarter's GST and PAYG instalment accrued, the income tax and super accounts — as balance items linked by
  `ato_account_id` + `ato_bucket`, so applying again follows later imports. `replace` discards the typed lines
  they stand in for in the same step.
- **match_ato_payment**: `confirm` takes `cash_transaction_ids` for one ATO payment paid by several bank rows
  (they must add up to it); `find` proposes such splits when no single row fits.
- **import_ato_statement**: a statement line that can't be stored is a 422 naming the row; any other server
  failure names the exception and request id instead of a bare "Internal Server Error".

## 1.10.0 — 2026-11-08
- **generate_compliance_document**: generate one of the year's compliance documents (operating statement,
  statement of financial position, trustee minutes, declarations …) the way the Compliance step's Generate
  button does. `answers` fill the document's own fields (the result lists them and any still missing);
  `finalize: true` freezes it so its check reads Done; `not_applicable: true` marks it N/A. Uploaded types,
  locked years and already-finalised documents are refused.

## 1.9.0 — 2026-11-07
- **undo_ato_import** (destructive; `dry_run` defaults to true): takes a statement import back out of an
  ATO account — removes only the lines it created and restores the opening balance it replaced. Refused
  while a line is matched to a bank row, a year it touches is closed or lodged, or a later import covers
  the same lines.
- **list_ato_imports**: an ATO account's imports, each with `can_undo` and `undo_blockers`.
- **create_ato_account**: add the fund's income tax (551), activity statement (001) or superannuation (552)
  account; one of each per fund.
- **import_ato_statement** refuses a statement whose lines read as another account type (an activity
  statement into the income tax account, or the reverse), naming the account it looks like.
- `server_info` reports `release_notes`.

## 1.8.1 — 2026-11-06
- import_ato_statement takes the portal's Download CSV as well as the JSON.

## 1.8.0
- ATO account tools: list_ato_accounts, import_ato_statement, list_ato_transactions, get_ato_position,
  update_ato_transaction, match_ato_payment.
