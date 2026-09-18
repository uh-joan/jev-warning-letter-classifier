/**
 * Minimal drug knowledge base.
 *
 * Two jobs:
 *  1) Enrichment — once Jev *selects* a drug span, we copy its ingredient/indication
 *     from here rather than asking a language model to generate them.
 *  2) Candidate seeding (optional) — a caller can pull a facility's known products
 *     from here (or, in production, from Cortellis / Drugs@FDA / DailyMed) and pass
 *     them in as candidates when the letter itself redacts the product name (b)(4).
 *
 * This is deliberately tiny and swappable. In production, replace lookup() with a
 * call into your canonical drug entity source.
 */

export interface DrugRecord {
  name: string;
  aliases?: string[];
  active_ingredient: string;
  indication: string;
  route: string;
  dosage_form: string;
  /** Facility hints (FEI or free text) — used only for optional candidate seeding. */
  facilities?: string[];
}

export const DRUG_KB: DrugRecord[] = [
  {
    name: "Lumify",
    active_ingredient: "brimonidine tartrate 0.025%",
    indication: "temporary relief of redness of the eye due to minor eye irritations",
    route: "ophthalmic",
    dosage_form: "ophthalmic solution",
    facilities: ["1000113778", "Tampa"],
  },
  {
    name: "Prolensa",
    active_ingredient: "bromfenac 0.07%",
    indication:
      "treatment of postoperative inflammation and reduction of ocular pain following cataract surgery",
    route: "ophthalmic",
    dosage_form: "ophthalmic solution",
    facilities: ["1000113778", "Tampa"],
  },
  {
    name: "Vyzulta",
    active_ingredient: "latanoprostene bunod 0.024%",
    indication:
      "reduction of intraocular pressure in patients with open-angle glaucoma or ocular hypertension",
    route: "ophthalmic",
    dosage_form: "ophthalmic solution",
    facilities: ["1000113778", "Tampa"],
  },
  {
    name: "Lotemax",
    aliases: ["Lotemax SM"],
    active_ingredient: "loteprednol etabonate",
    indication:
      "treatment of corticosteroid-responsive inflammation of the eye and postoperative ocular inflammation",
    route: "ophthalmic",
    dosage_form: "ophthalmic gel/suspension",
    facilities: ["1000113778", "Tampa"],
  },
  {
    name: "Tetracaine",
    active_ingredient: "tetracaine hydrochloride",
    indication: "topical ophthalmic anesthesia",
    route: "ophthalmic",
    dosage_form: "ophthalmic solution",
    facilities: ["1000113778", "Tampa"],
  },
];

const norm = (s: string) => s.trim().toLowerCase();

/** Look up a KB record by brand name or alias. */
export function lookup(name: string): DrugRecord | undefined {
  const n = norm(name);
  return DRUG_KB.find(
    (d) => norm(d.name) === n || (d.aliases ?? []).some((a) => norm(a) === n),
  );
}

/** Products documented at a facility (FEI or location substring) — for candidate seeding. */
export function productsForFacility(hint: string): DrugRecord[] {
  const h = norm(hint);
  return DRUG_KB.filter((d) =>
    (d.facilities ?? []).some((f) => h.includes(norm(f)) || norm(f).includes(h)),
  );
}
