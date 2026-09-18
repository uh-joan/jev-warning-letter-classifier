# FDA Warning Letter → structured entities (Jev classifier)

Classifies an FDA Warning Letter into a structured `WarningLetter` object using
**TypeSafe's Jev (System One)** via the **Vercel AI Gateway** (`typesafe-ai/jev`).

The design follows the one rule that makes Jev work well: **Jev does not generate
text.** It makes *bounded decisions* — "which of these candidates is the drug?",
"is this sterile?", "how severe?". Every string span in the output is produced by
deterministic extraction; Jev only *selects*, and code *copies the span through*.

```
FDA Warning Letter (text)
        │
        ▼
  extract.ts  ── deterministic ──►  company · facility · FEI · date · office
        │                            organisms · DRUG candidates · indication candidates
        ▼
  classify.ts ──►  JEV (one evaluate() call)
        │            • document_type      (choice)
        │            • drug_candidate      (choice  ← candidates, + "unknown")
        │            • indication_candidate(choice  ← candidates, + "unknown")
        │            • is_sterile / cgmp / aseptic / env-mon / contamination … (boolean)
        │            • severity            (score)
        ▼
  assemble.ts ── copies selected spans, enriches drug from KB ──►  WarningLetter
```

## Why this shape (the `(b)(4)` problem)

The public Bausch & Lomb letter redacts the product name everywhere as `(b)(4)`.
A text-generating model would happily *hallucinate* "Prolensa". Jev can't — it can
only pick from candidates you supply, and it will pick **`unknown`** when nothing in
the document supports a choice.

So there are two paths:

- **Name is in the letter** → `extract.ts` finds it, Jev confirms it's the subject,
  `drug.redaction_note` is `null`.
- **Name is redacted** → run with `--seed-facility` (or pass `extraDrugCandidates`).
  Candidates come from a facility cross-reference (here a tiny local KB; in
  production, Cortellis / Drugs@FDA / DailyMed). Jev picks the best-supported one or
  `unknown`, and `drug.redaction_note` records that it was a cross-reference lead,
  **not stated verbatim in the letter**. Probabilities are preserved in `_jev` so a
  reviewer can see how confident the pick was.

## Run

```bash
cp .env.example .env         # add your Vercel AI Gateway key (AI_GATEWAY_API_KEY)
npm install

# deterministic extraction only — no API key needed:
npm run demo -- --extract-only --seed-facility

# full classification through Jev:
npm run demo                 # bundled Bausch & Lomb fixture
npx tsx src/run.ts path/to/letter.txt --seed-facility
```

## Library use

```ts
import { classifyWarningLetter } from "./src/index.js";

const result = await classifyWarningLetter(letterText, {
  seedFromFacility: true,
  // or hand in candidates from your own cross-reference step:
  extraDrugCandidates: [
    { id: "drug_x", text: "Prolensa (bromfenac) — Drugs@FDA match for this FEI",
      payload: { name: "Prolensa" } },
  ],
});
// result.drug.name / .active_ingredient / .indication / .confidence / .redaction_note
```

Then pass `result.drug.name` downstream into Cortellis for canonical normalization —
warning-letter language and Cortellis drug entities aren't one-to-one, so keep the
extraction (this repo) and the normalization (Cortellis) as separate stages.

## Files

| File | Role |
|------|------|
| `src/types.ts`   | Output schema (`WarningLetter`, `DrugEntity`, candidates) |
| `src/extract.ts` | Deterministic candidate extraction (spans) |
| `src/drug-kb.ts` | Tiny drug KB for enrichment + facility candidate seeding |
| `src/classify.ts`| The single Jev `evaluate()` call (choice/score/boolean) |
| `src/assemble.ts`| Copies Jev's selections into the final object |
| `src/index.ts`   | `classifyWarningLetter(text, opts)` |
| `src/run.ts`     | CLI |

## Jev API notes (AI SDK `experimental_evaluate`)

- Model: `typesafe-ai/jev`; SDK: `ai` ≥ 7.0.105; `import { experimental_evaluate as evaluate } from "ai"`.
- Question types: `choice` (`.criteria` map → answer `.choice` + `.probabilities`),
  `score` (`.criteria` array → `.score`), `boolean` (→ `.probability`, i.e. P(true), *not* confidence).
- Confidence: `result.providerMetadata.typesafe.confidence`.
- `state` may be a string, object, or array (an array is one state, not a batch).
- Choice supports up to 255 options.
