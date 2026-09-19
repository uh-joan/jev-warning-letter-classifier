# FDA Warning Letter Classifier

Turn a messy FDA Warning Letter into clean, structured data — the company, the
facility, the drug, the violations, how serious it is — with a model that is
**physically incapable of making things up.**

```
  A 10-page FDA Warning Letter (plain text)
                  │
                  ▼
        ┌───────────────────┐
        │   this classifier  │
        └───────────────────┘
                  │
                  ▼
  {
    "company": "Bausch & Lomb Inc.",
    "facility": { "location": "Tampa, FL", "fei": "1000113778" },
    "warning_letter_date": "2026-09-04",
    "drug": { "name": null, "redaction_note": "product name redacted (b)(4)" },
    "is_sterile_product": true,
    "violation_categories": ["CGMP", "sterility", "aseptic_processing", ...],
    "contamination": { "present": true, "organisms": ["Serratia marcescens", ...] },
    "recall_concern": true
  }
```

This was built as a **learning project**: how to use TypeSafe's **Jev** model —
a new kind of AI that makes *decisions* instead of writing *text* — to solve a
real problem in the pharmaceutical / regulatory world, where being wrong has
consequences and "the AI hallucinated it" is not an acceptable answer.

---

## The problem, and why it's interesting

Every week the FDA publishes **Warning Letters** — public notices telling a drug
maker what they did wrong. They're long, inconsistent, and full of legal
boilerplate. People who track drug safety read thousands of them by hand.

The obvious idea: "just ask ChatGPT to pull out the drug name and the
violations." It works… until it doesn't. Here's the trap that makes pharma
different:

> FDA often **redacts the product name** as `(b)(4)` — a legal blackout for
> trade secrets. A text-writing AI, asked "what's the drug?", will happily
> *invent* a plausible-sounding answer. In a regulatory database, a confidently
> wrong drug name is worse than no answer at all.

So the whole project is built around one rule:

**The AI is never allowed to write an answer. It can only *choose* one.**

---

## Meet Jev: a model that decides, not writes

[Jev](https://docs.typesafe.ai) (by TypeSafe) is a **"System One" model** — think
of it as programmable common sense. You don't prompt it for a paragraph. You
hand it some context and ask **typed questions**, and it hands back **typed
answers with probabilities**:

- **"Which of these is the drug?"** → it picks one option (or `unknown`)
- **"Is this a sterile product?"** → 0.99 (yes)
- **"How severe is this?"** → 2.8 out of 3

Because it can only pick from options *you* supply, it **cannot hallucinate a
drug name.** If the letter redacts the product and nothing supports a choice, it
picks `unknown` — and it does, reliably. That single property is why this
approach fits pharma.

This is what "classifier" means here: not a black box that guesses, but a set of
small, auditable decisions — each with a probability you can inspect.

---

## How it works (in plain terms)

Three steps, and the AI only touches the middle one:

1. **Read** — plain code scans the letter and pulls out every *candidate*: the
   company, dates, organisms, and every product name actually written in the
   text. Code does the reading; nothing is invented.
2. **Decide** — Jev looks at the candidates and makes bounded calls: which one
   is the drug, is it sterile, what violations apply, how serious. It only
   *selects* and *judges* — it never writes a new name.
3. **Assemble** — code copies the chosen answers into a clean object, and flags
   anything the model was unsure about for a human to double-check.

Every product name in the output is a word that appears **verbatim in the
letter**. If it's not in the letter, it doesn't make it into the answer.

---

## How well does it work?

Tested on a corpus of **230 real FDA Warning Letters** spanning every type —
drug manufacturing, compounding pharmacies, medical devices, biologics, dietary
supplements, veterinary. Crucially, the numbers below are on a **held-out set of
48 letters the system was never tuned against** — the honest test of whether it
generalizes.

| What it extracts | Accuracy (unseen letters) |
|---|---|
| Company name | **100%** |
| Letter date | **100%** |
| Facility ID (FEI) | **100%** |
| Document type | **100%** |
| "Organisms linked to complaints?" | **100%** |
| Facility location | **92%** |
| Sterile product? | **90%** |
| Recall concern raised? | **94%** |
| Violation categories | **0.93** (F1) |
| Products found in the letter | **0.98** (F1) |
| The specific drug | **85%** |
| Every subject product | **0.81** (F1) |

The whole 230-letter corpus is classified in **about a minute**, and it runs
entirely on TypeSafe — no other AI service in the loop.

And the headline result — the reason the project exists:

> On letters where the product name is redacted `(b)(4)`, the model returns
> **`unknown`**, every time, instead of inventing a drug. It even declines when
> handed a list of plausible decoy products. That's the discipline a
> text-writing model can't give you.

### It also knows when a letter *isn't* about a drug

FDA sends Warning Letters about food, produce, and sanitation too. The tool
labels every letter with what it regulates — `drug`, `biologic`, `device`,
`compounding`, `food_or_supplement`, `veterinary` — and when a letter is really
about, say, a syrup maker's sanitation, it reports `regulated_product: "food"`
and leaves the drug field empty instead of pretending a food is a drug. Knowing
the limits of your own scope is part of being trustworthy.

---

## Try it

You'll need [Node.js](https://nodejs.org) 20+ and a free TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys).

```bash
# 1. install
npm install

# 2. add your key
cp .env.example .env         # then paste your key into TYPESAFE_AI_API_KEY

# 3. run the demo (a real Bausch & Lomb letter)
npm run demo
```

Classify your own letter (any FDA Warning Letter saved as a .txt file):

```bash
npx tsx src/run.ts path/to/letter.txt
```

Want to see the extraction step without using any AI or a key? Add `--extract-only`:

```bash
npx tsx src/run.ts path/to/letter.txt --extract-only
```

### Use it in your own code

```ts
import { classifyWarningLetter } from "./src/index.js";

const result = await classifyWarningLetter(letterText);

console.log(result.drug.name);            // the product, or null if redacted
console.log(result.violation_categories); // ["CGMP", "sterility", ...]
console.log(result.needs_review);         // true if a human should double-check
console.log(result.review);               // exactly which answers were uncertain
```

If the product name is blacked out, `result.drug.name` is `null` and
`result.drug.cross_reference_leads` offers possible matches for a human to verify
— never asserted as fact.

---

## What's inside

| File | What it does |
|------|------|
| `src/extract.ts`   | Reads the letter: company, facility, dates, organisms |
| `src/enumerate.ts` | Finds every candidate product name written in the letter |
| `src/redaction.ts` | Works out what the `(b)(4)` blackouts are hiding |
| `src/citations.ts` | Maps legal citations (21 CFR …) to violation types |
| `src/classify.ts`  | The Jev calls — the only place the model is used |
| `src/assemble.ts`  | Builds the final answer and flags uncertain fields |
| `src/review.ts`    | Decides which answers a human should double-check |
| `eval/`            | 230 labelled letters + a scoring harness (`npm run eval`) |

---

## Honest limitations

- **It's a research/learning project**, not a certified regulatory tool. Treat
  its output as a fast first pass, not the final word.
- The **specific drug** is the hardest field (~85%): device and biologics
  products have unusual names, and some letters genuinely name several products.
  That's why every answer carries a probability and an `is uncertain` flag —
  the system is built to *say when it's not sure* rather than guess.
- Extraction is tuned for FDA's letter formats; a very different document may
  need new patterns.

---

## What I took away from building this

- **"Selection, not generation" is a real design pattern.** For anything where a
  wrong answer is costly, having the model *choose from evidence* instead of
  *writing prose* changes what you can trust.
- **Probabilities are a feature, not decoration.** Because every answer comes
  with a confidence, the system can route the shaky ones to a human — which is
  how you make AI you can actually rely on.
- **Keep the code in charge.** The model supplies judgment; ordinary code does
  the counting, copying, and rules. That division is what keeps the output
  honest.

Built while learning [TypeSafe / Jev](https://docs.typesafe.ai). 🤖
