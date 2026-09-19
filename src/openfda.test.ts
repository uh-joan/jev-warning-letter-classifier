/**
 * Plain tsx script (no test runner) exercising the openFDA-backed lookup.
 * Run: npx tsx src/openfda.test.ts
 */

import assert from "node:assert";
import { lookupDrug, productsForLabeler } from "./openfda.js";

let count = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  count++;
}

async function main(): Promise<void> {
  // Lumify — brand-name match, ingredient + route filled from the NDC record.
  const lumify = await lookupDrug("Lumify");
  ok(lumify !== undefined, "lookupDrug(Lumify) should find a record");
  ok(
    lumify!.active_ingredient.toLowerCase().includes("brimonidine"),
    "Lumify active_ingredient should mention brimonidine",
  );
  ok(lumify!.route.toLowerCase().includes("ophthalmic"), "Lumify route should be ophthalmic");

  // Prolensa — brand-name match, different active ingredient.
  const prolensa = await lookupDrug("Prolensa");
  ok(prolensa !== undefined, "lookupDrug(Prolensa) should find a record");
  ok(
    prolensa!.active_ingredient.toLowerCase().includes("bromfenac"),
    "Prolensa active_ingredient should mention bromfenac",
  );

  // Not a real drug — must resolve to undefined, never throw.
  const missing = await lookupDrug("zzzznotadrug");
  ok(missing === undefined, "lookupDrug(zzzznotadrug) should be undefined");

  // Facility cross-reference seed: a real labeler should yield known B&L brands.
  const products = await productsForLabeler("Bausch & Lomb Inc.");
  ok(products.length > 0, "productsForLabeler(Bausch & Lomb Inc.) should be non-empty");
  const brands = products.map((p) => p.name.toLowerCase());
  ok(
    brands.some((b) => b.includes("lotemax") || b.includes("besivance") || b.includes("alrex") || b.includes("lumify")),
    "productsForLabeler should include a well-known Bausch & Lomb brand",
  );

  // Second run, offline — must be served entirely from cache (no network calls).
  const lumifyCached = await lookupDrug("Lumify", { offline: true });
  ok(lumifyCached !== undefined, "offline lookupDrug(Lumify) should be served from cache");
  ok(
    lumifyCached!.active_ingredient.toLowerCase().includes("brimonidine"),
    "offline Lumify active_ingredient should still mention brimonidine",
  );

  const productsCached = await productsForLabeler("Bausch & Lomb Inc.", { offline: true });
  ok(productsCached.length === products.length, "offline productsForLabeler should match cached count");

  console.log(`ok ${count} assertions`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
