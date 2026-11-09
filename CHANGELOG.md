# Beeswax Shares MCP server — changelog

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
