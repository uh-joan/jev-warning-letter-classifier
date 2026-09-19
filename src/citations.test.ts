/**
 * Plain tsx-runnable check (no test framework). Run with:
 *   npx tsx src/citations.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractCitations, summarizeViolations, type Citation } from "./citations.js";

let n = 0;
function check(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  n++;
}

function find(cites: Citation[], pred: (c: Citation) => boolean): Citation | undefined {
  return cites.find(pred);
}

// ---------------------------------------------------------------------------
// Fixture: Bausch & Lomb (sterile pharma CGMP letter)
// ---------------------------------------------------------------------------
{
  const text = readFileSync(new URL("../fixtures/bausch-lomb-2026.txt", import.meta.url), "utf8");
  const cites = extractCitations(text);

  const c211_42 = find(cites, (c) => c.section === "211.42(c)(10)");
  check(c211_42, "finds 21 CFR 211.42(c)(10)");
  check(c211_42?.category === "CGMP_finished_pharma", "211.42 -> CGMP_finished_pharma");
  check(c211_42?.part === 211, "211.42 -> part 211");
  check(c211_42?.kind === "cfr", "211.42 -> kind cfr");

  const c211_113 = find(cites, (c) => c.section === "211.113(b)");
  check(c211_113, "finds 21 CFR 211.113(b)");
  check(c211_113?.category === "CGMP_finished_pharma", "211.113(b) -> CGMP_finished_pharma");
  check(
    /microbiological/i.test(c211_113?.description ?? ""),
    "211.113(b) description mentions microbiological contamination",
  );

  const c501 = find(cites, (c) => c.fdca_section === "501(a)(2)(B)");
  check(c501, "finds FDCA 501(a)(2)(B)");
  check(c501?.kind === "fdca", "501(a)(2)(B) -> kind fdca");
  check(c501?.category === "adulteration", "501(a)(2)(B) -> adulteration");

  // Non-citations must not leak in: "ISO 5", the FEI number, dates.
  check(
    !cites.some((c) => c.raw.includes("ISO") || c.part === 5),
    "ISO 5 is not captured as a citation",
  );
  check(
    !cites.some((c) => c.raw.includes("1000113778")),
    "the FEI number is not captured as a citation",
  );

  const summary = summarizeViolations(cites);
  check(summary.categories.includes("CGMP_finished_pharma"), "summary includes CGMP_finished_pharma");
  check(summary.categories.includes("adulteration"), "summary includes adulteration");
  check(
    summary.cgmp_sections.includes("211.42(c)(10)") && summary.cgmp_sections.includes("211.113(b)"),
    "summary.cgmp_sections lists both CGMP sections",
  );
  check(
    (summary.by_category["CGMP_finished_pharma"]?.length ?? 0) >= 2,
    "by_category groups both CGMP citations",
  );

  console.log(`bausch-lomb: ${cites.length} citations, categories=${summary.categories.join(",")}`);
}

// ---------------------------------------------------------------------------
// Fixture: H2 BEV (acidified food + unapproved new drug letter)
// ---------------------------------------------------------------------------
{
  const text = readFileSync(new URL("../fixtures/h2-bev-2026.txt", import.meta.url), "utf8");
  const cites = extractCitations(text);

  const part108 = find(cites, (c) => c.kind === "cfr" && c.part === 108 && !c.section);
  check(part108, "finds bare 21 CFR Part 108");
  check(part108?.category === "acidified_lacf_food", "Part 108 -> acidified_lacf_food");
  check((part108?.count ?? 0) >= 2, "Part 108 dedup count reflects repeats (spelled-out + short form)");

  const part114 = find(cites, (c) => c.kind === "cfr" && c.part === 114 && !c.section);
  check(part114, "finds bare 21 CFR Part 114");
  check(part114?.category === "acidified_lacf_food", "Part 114 -> acidified_lacf_food");

  const s108_25_1 = find(cites, (c) => c.section === "108.25(c)(1)");
  const s108_25_2 = find(cites, (c) => c.section === "108.25(c)(2)");
  check(s108_25_1 && s108_25_2, "captures both 108.25(c)(1) and 108.25(c)(2) as distinct citations");
  check(s108_25_1!.index !== s108_25_2!.index, "the two 108.25 citations have distinct offsets");

  const s114_80a = find(cites, (c) => c.section === "114.80(a)");
  const s114_80a2 = find(cites, (c) => c.section === "114.80(a)(2)");
  check(s114_80a && s114_80a2, "114.80(a) and 114.80(a)(2) captured as distinct citations");

  const usc342 = find(cites, (c) => c.usc === "21 U.S.C. 342(a)(4)");
  check(usc342, "finds bracketed [21 U.S.C. § 342(a)(4)]");
  check(usc342?.category === "adulteration", "USC 342(a)(4) -> adulteration (food)");
  check(usc342?.fdca_section === "402(a)(4)", "USC 342(a)(4) cross-references FDCA 402(a)(4)");

  const drugDefFdca = cites.filter((c) => c.kind === "fdca" && c.fdca_section === "201(g)(1)(B)");
  check(drugDefFdca.length === 1, "section 201(g)(1)(B) of the Act de-duplicates repeated mentions");
  check(drugDefFdca[0]?.count === 2, "201(g)(1)(B) dedup count is 2 (mentioned twice in the letter)");
  check(drugDefFdca[0]?.category === "drug_definition", "201(g)(1)(B) -> drug_definition");

  const drugDefUsc = cites.filter((c) => c.kind === "usc" && c.fdca_section === "201(g)(1)(B)");
  check(drugDefUsc.length === 1 && drugDefUsc[0]?.count === 2, "bracketed USC 321(g)(1)(B) also de-duplicates to one citation, count 2");

  const newDrug201p = find(cites, (c) => c.fdca_section === "201(p)");
  check(newDrug201p, "finds FDCA 201(p) via the bracketed USC form");
  check(newDrug201p?.category === "unapproved_new_drug", "201(p) -> unapproved_new_drug");

  check(
    !cites.some((c) => c.raw.includes("2541")),
    "Form FDA 2541 is not captured as a citation",
  );
  check(
    !cites.some((c) => c.raw.includes("730567")),
    "MARCS-CMS / CMS docket number is not captured as a citation",
  );

  const summary = summarizeViolations(cites);
  check(summary.categories.includes("acidified_lacf_food"), "summary includes acidified_lacf_food");
  check(summary.categories.includes("unapproved_new_drug"), "summary includes unapproved_new_drug");

  console.log(`h2-bev: ${cites.length} citations, categories=${summary.categories.join(",")}`);
}

// ---------------------------------------------------------------------------
// Inline pattern coverage
// ---------------------------------------------------------------------------

{
  const cites = extractCitations("Violations of 21 CFR 211.42(c)(10) were noted during the inspection.");
  check(cites.length === 1 && cites[0]?.section === "211.42(c)(10)", "inline: dotted CFR section");
  check(cites[0]?.category === "CGMP_finished_pharma", "inline: 211.42 -> CGMP_finished_pharma");
}

{
  const cites = extractCitations("This covers 21 CFR parts 210 and 211 in full.");
  check(cites.length === 2, "inline: 'parts 210 and 211' yields two citations");
  check(
    cites.some((c) => c.part === 210) && cites.some((c) => c.part === 211),
    "inline: parts 210 and 211 both captured",
  );
}

{
  const cites = extractCitations("See 21 CFR Part 114 for details.");
  check(cites.length === 1 && cites[0]?.part === 114 && !cites[0]?.section, "inline: bare 'CFR Part 114'");
}

{
  const cites = extractCitations("Title 21, Code of Federal Regulations, Part 108 governs this area.");
  check(cites.length === 1 && cites[0]?.part === 108, "inline: spelled-out Title 21 CFR Part 108");
}

{
  const cites = extractCitations("in violation of 21 CFR 211.84(d)(1) and 211.84(d)(2) of the regulations.");
  check(cites.length === 2, "inline: '211.84(d)(1) and 211.84(d)(2)' both captured");
  check(
    cites.some((c) => c.section === "211.84(d)(1)") && cites.some((c) => c.section === "211.84(d)(2)"),
    "inline: both 211.84 subsections present with distinct sections",
  );
  check(cites[0]!.index < cites[1]!.index, "inline: 211.84(d)(1) precedes 211.84(d)(2) by index");
}

{
  const cites = extractCitations(
    "adulterated within the meaning of section 501(a)(2)(B) of the Federal Food, Drug, and Cosmetic Act.",
  );
  check(cites.length === 1 && cites[0]?.fdca_section === "501(a)(2)(B)", "inline: FDCA 'of the Federal Food...Act' form");
  check(cites[0]?.usc === "21 U.S.C. 351(a)(2)(B)", "inline: FDCA 501 cross-references USC 351");
}

{
  const cites = extractCitations("in violation of sections 301(d) and 505(a) of the Act.");
  check(cites.length === 2, "inline: 'sections 301(d) and 505(a) of the Act' yields two citations");
  check(
    cites.every((c) => c.category === "unapproved_new_drug"),
    "inline: 301(d) and 505(a) both -> unapproved_new_drug",
  );
}

{
  const cites = extractCitations("your product is adulterated [21 U.S.C. § 342(a)(4)] under the statute.");
  check(cites.length === 1 && cites[0]?.usc === "21 U.S.C. 342(a)(4)", "inline: bracketed USC single-section form");
  check(cites[0]?.category === "adulteration", "inline: USC 342(a)(4) -> adulteration");
}

{
  const cites = extractCitations("this is prohibited under 21 U.S.C. 351(a)(2)(B) specifically.");
  check(cites.length === 1 && cites[0]?.usc === "21 U.S.C. 351(a)(2)(B)", "inline: plain USC form, no section symbol");
}

{
  const cites = extractCitations("prohibited acts under 21 U.S.C. §§ 331(d), 355(a) of the code.");
  check(cites.length === 2, "inline: '§§ 331(d), 355(a)' double-section-symbol list yields two citations");
  check(
    cites.some((c) => c.usc === "21 U.S.C. 331(d)") && cites.some((c) => c.usc === "21 U.S.C. 355(a)"),
    "inline: both 331(d) and 355(a) captured",
  );
  check(
    cites.every((c) => c.category === "unapproved_new_drug"),
    "inline: 331(d)/355(a) both map to unapproved_new_drug via FDCA equivalence",
  );
}

// Guards against non-citation numbers.
{
  check(extractCitations("Form FDA 2541 (Food Canning Establishment Registration)").length === 0, "guard: Form FDA 2541");
  check(extractCitations("recovered from your ISO 5 areas").length === 0, "guard: ISO 5");
  check(extractCitations("inspected the facility from March 12 to March 20, 2026.").length === 0, "guard: dates");
  check(extractCitations('lot codes "LOT: (b)(4)" and "LOT: (b)(4),"').length === 0, "guard: redacted lot numbers");
  check(extractCitations("MARCS-CMS 730567 — JULY 31, 2026").length === 0, "guard: MARCS-CMS docket number");
}

console.log(`ok ${n} assertions`);
