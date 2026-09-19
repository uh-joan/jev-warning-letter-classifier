import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { analyzeRedactions } from "./redaction.js";

let assertions = 0;
function ok(cond: unknown, msg: string): asserts cond {
  assert.ok(cond, msg);
  assertions++;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures");

// --- Fixture: Bausch & Lomb — product name is redacted throughout. -------
{
  const text = readFileSync(path.join(fixturesDir, "bausch-lomb-2026.txt"), "utf8");
  const report = analyzeRedactions(text);

  ok(report.total === 2, `bausch-lomb: expected 2 markers, got ${report.total}`);
  ok(report.product_name_redacted === true, "bausch-lomb: product_name_redacted should be true");
  ok(report.product_redaction_score > 0.5, "bausch-lomb: product_redaction_score should be > 0.5");
  ok((report.by_role["product_name"] ?? 0) === 2, "bausch-lomb: both spans should be product_name");
  ok(report.evidence.length === 2, "bausch-lomb: evidence should include both product_name contexts");
}

// --- Fixture: H2 BEV — (b)(4)s are lot codes, product names are in clear. -
{
  const text = readFileSync(path.join(fixturesDir, "h2-bev-2026.txt"), "utf8");
  const report = analyzeRedactions(text);

  ok(report.total === 2, `h2-bev: expected 2 markers, got ${report.total}`);
  ok(report.product_name_redacted === false, "h2-bev: product_name_redacted should be false");
  ok(report.product_redaction_score === 0, "h2-bev: product_redaction_score should be 0");
  ok((report.by_role["lot_or_batch"] ?? 0) === 2, "h2-bev: both spans should be lot_or_batch");
  ok((report.by_role["product_name"] ?? 0) === 0, "h2-bev: no span should be product_name");
}

// --- Inline: one representative string per role. --------------------------
{
  const report = analyzeRedactions("Your firm manufactures drug products, including (b)(4).");
  ok(report.total === 1, "product_name inline: expected 1 marker");
  ok(report.spans[0]?.role === "product_name", "product_name inline: role should be product_name");
  ok(report.product_name_redacted === true, "product_name inline: product_name_redacted should be true");
}

{
  const report = analyzeRedactions("your raw material test records for (b)(4) API were incomplete.");
  ok(report.total === 1, "api inline: expected 1 marker");
  ok(report.spans[0]?.role === "api_or_ingredient", "api inline: role should be api_or_ingredient");
}

{
  const report = analyzeRedactions("Lot (b)(4) failed release testing due to out-of-specification results.");
  ok(report.total === 1, "lot inline: expected 1 marker");
  ok(report.spans[0]?.role === "lot_or_batch", "lot inline: role should be lot_or_batch");
}

{
  const report = analyzeRedactions("The tanks were held at (b)(4)°C for (b)(4) minutes before release.");
  ok(report.total === 2, "quantity inline: expected 2 markers");
  ok(
    report.spans.every((s) => s.role === "quantity_or_parameter"),
    "quantity inline: both roles should be quantity_or_parameter",
  );
}

{
  const report = analyzeRedactions("Your (b)(4) supplier did not provide a Certificate of Analysis.");
  ok(report.total === 1, "supplier inline: expected 1 marker");
  ok(report.spans[0]?.role === "supplier_or_party", "supplier inline: role should be supplier_or_party");
}

{
  const report = analyzeRedactions("The inspection occurred on (b)(4), which delayed corrective actions.");
  ok(report.total === 1, "date inline: expected 1 marker");
  ok(report.spans[0]?.role === "date_or_time", "date inline: role should be date_or_time");
}

{
  const report = analyzeRedactions("We discussed (b)(4) during the meeting.");
  ok(report.total === 1, "unknown inline: expected 1 marker");
  ok(report.spans[0]?.role === "unknown", "unknown inline: role should be unknown when no signal is present");
}

// --- Whitespace and quote-style tolerance. --------------------------------
{
  const report = analyzeRedactions("Your (b) (4) product line was affected by the recall.");
  ok(report.total === 1, "whitespace variant: expected 1 marker for '(b) (4)'");
  ok(report.spans[0]?.marker === "(b)(4)", "whitespace variant: marker should normalize to '(b)(4)'");
  ok(report.spans[0]?.role === "product_name", "whitespace variant: role should be product_name");
}

{
  const report = analyzeRedactions("Your firm manufactures drug products, including “(b)(4)”.");
  ok(report.total === 1, "curly quotes: expected 1 marker");
  ok(report.spans[0]?.role === "product_name", "curly quotes: role should be product_name");
}

// --- Extension markers: (b)(6), (b)(7)(C). --------------------------------
{
  const report = analyzeRedactions("The complainant's information, including (b)(6), was redacted from the record.");
  ok(report.total === 1, "(b)(6): expected 1 marker");
  ok(report.spans[0]?.marker === "(b)(6)", "(b)(6): marker should be '(b)(6)'");
}

{
  const report = analyzeRedactions("The investigator's notes named (b)(7)(C) as the responsible party.");
  ok(report.total === 1, "(b)(7)(C): expected 1 marker");
  ok(report.spans[0]?.marker === "(b)(7)(C)", "(b)(7)(C): marker should be '(b)(7)(C)'");
}

// --- Composite real-world snippet: must yield product_name + api + lot + --
// --- quantity roles together (this is the case the extraction pipeline ---
// --- needs to disambiguate: some (b)(4)s are the product, some aren't). --
{
  const text =
    'Your firm manufactures over-the-counter (OTC) drug products, including (b)(4). For example, ' +
    "your raw material test records for (b)(4) API lot (b)(4) show that you only performed " +
    "organoleptic testing. You manufactured (b)(4) finished drug batches using this lot. " +
    "accelerated stability data provided for (b)(4) consisted of three batches tested for (b)(4) " +
    "at (b)(4)°C";
  const report = analyzeRedactions(text);

  ok(report.total === 7, `composite: expected 7 markers, got ${report.total}`);
  ok(report.product_name_redacted === true, "composite: product_name_redacted should be true");
  ok((report.by_role["product_name"] ?? 0) >= 1, "composite: should include a product_name span");
  ok((report.by_role["api_or_ingredient"] ?? 0) >= 1, "composite: should include an api_or_ingredient span");
  ok((report.by_role["lot_or_batch"] ?? 0) >= 1, "composite: should include a lot_or_batch span");
  ok((report.by_role["quantity_or_parameter"] ?? 0) >= 1, "composite: should include a quantity_or_parameter span");
}

console.log(`ok ${assertions} assertions`);
