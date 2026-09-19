# Bringing the classifier to a skill — `/classify-warning-letter`

**Status:** brainstorm / design (branch `skill-classify-warning-letter`)
**Goal:** let an AI (or a human at a terminal) run the classifier with a single
command that takes **a URL or a local path** to an FDA Warning Letter and returns
the structured result.

```
/classify-warning-letter https://www.fda.gov/.../some-company-123456-01012026
/classify-warning-letter ./fixtures/bausch-lomb-2026.txt
/classify-warning-letter ~/Downloads/letter.pdf        # (stretch)
```

---

## 1. What "a skill" can mean here

There are three delivery forms, and they're **not mutually exclusive** — they all
sit on top of the same core `classifyWarningLetter(text)` function. Pick based on
*who* invokes it.

| Form | Invoked by | How it runs | Best when |
|---|---|---|---|
| **A. Claude Code / Agent Skill** (`SKILL.md` + `/classify-warning-letter`) | Claude, in a Claude Code / desktop session | Skill instructs Claude to shell out to the CLI, then format the JSON | You (or teammates) want it inside Claude Code today |
| **B. MCP server** (`classify_warning_letter` tool) | *Any* MCP-capable AI (Claude Desktop, other agents) | A small MCP server wraps the core function as a typed tool | You want other AIs/apps to call it as a first-class tool |
| **C. Standalone CLI** (`npx classify-warning-letter <input>`) | Humans, CI, scripts, and forms A/B underneath | A `bin` entry on the package | You want a clean, installable command with no AI in the loop |

**Recommendation:** build **C first** (it's the shared substrate), then **A** as a
thin `SKILL.md` that calls C. Add **B** later if other agents need it. This keeps
one code path and avoids three copies of the input/output logic.

> The rest of this doc assumes that layering: **CLI core → skill wrapper → (optional) MCP.**

> **✅ Decision (chosen):** target is the **published npm CLI** ("anywhere /
> teammates"). So Form **C is the product**: a real `bin`
> (`npx classify-warning-letter <url|path>`) published to npm, and the skill
> (Form A) is a thin `SKILL.md` that runs `npx classify-warning-letter@latest`
> so it works **outside this repo**, on any teammate's machine. This means the
> package must stop being `"private": true`, gain a `bin`, and be built/shipped
> as an installable command (see §7, Phase 1 & 3). MCP (Form B) stays optional.

---

## 2. The one real refactor: a unified input resolver

Today the input handling is split:

- `src/load.ts` → `loadLetter(path)` reads a local `.txt` (+ optional `.meta.json`).
- `scripts/fetch-letter.ts` → fetches an FDA **URL**, converts HTML→text, and
  **writes fixtures to disk**. Its `htmlToText`, `extractArticle`, `extractMeta`,
  `extractBodyText` are exactly what a URL input needs — but they're trapped in a
  script that persists files.

To take "URL **or** path" we need a single resolver that returns `{ text, meta }`
**in memory**, regardless of source:

```ts
// src/resolve.ts (new)
export async function resolveLetter(input: string): Promise<LoadedLetter> {
  if (/^https?:\/\//i.test(input)) return fetchLetterInMemory(input); // URL
  return loadLetter(input);                                           // path
}
```

**Concrete moves:**

1. **Extract the reusable HTML→text logic** from `scripts/fetch-letter.ts` into a
   new `src/fetch.ts` (`fetchLetterInMemory(url) → { text, meta }`) that returns
   the parsed result instead of writing files.
2. **Rewrite `scripts/fetch-letter.ts`** to import `src/fetch.ts` and only add the
   disk-writing (so the corpus tool and the skill share one parser — no drift).
3. **Add `src/resolve.ts`** with `resolveLetter(input)` (URL-vs-path detection).
4. **Rewire `src/run.ts`** to use `resolveLetter` so the *existing* CLI already
   accepts URLs (`tsx src/run.ts <url>`) — that alone is 80% of the skill.

**Input forms to support:**

- ✅ FDA letter **URL** (`https://www.fda.gov/.../warning-letters/<slug>`) — parse HTML.
- ✅ Local **`.txt`** path (+ sidecar `.meta.json`) — already works.
- ⚠️ **Raw text URL** or a non-FDA HTML page — `htmlToText` is FDA-tuned; fall back
  to "strip tags, classify the body" and flag lower confidence.
- 🔭 **PDF** path/URL (stretch) — many letters circulate as PDFs. Needs a text
  extractor (`pdf-parse` or similar); gate behind a clear "PDF support" milestone.

---

## 3. The `/classify-warning-letter` skill (Form A)

A Claude Code skill is a folder with a `SKILL.md` (name, description, trigger,
instructions). The skill itself carries **no model logic** — it tells Claude how
to run the tool and how to present the answer.

```
.claude/skills/classify-warning-letter/
  SKILL.md
```

**SKILL.md sketch:**

```markdown
---
name: classify-warning-letter
description: Classify an FDA Warning Letter (URL or file path) into structured
  regulatory data using the Jev-based classifier. Trigger on
  "/classify-warning-letter" or "classify this warning letter".
---

# Classify Warning Letter

When invoked with an input (a URL or a file path):

1. Ensure `TYPESAFE_AI_API_KEY` is set. If not, tell the user to add it and stop.
2. Run:  `npx tsx src/run.ts "<input>" --openfda`   (from the repo root)
   - URLs are fetched and parsed automatically (via resolveLetter).
3. Parse the JSON output and present a concise human summary:
   - Company / facility / date / issuing office
   - regulated_product + the drug (or "redacted (b)(4)" / null with reason)
   - violation_categories, is_sterile_product, contamination, recall_concern
   - Anything in `review[]` — surface it as "⚠️ needs human review: <field> (<certainty>)"
4. Offer the full JSON on request. Never invent fields not in the output.
```

**Two execution strategies for the skill:**

- **A1 — shell out (recommended, simplest):** the skill runs the CLI and reads
  stdout JSON. Works today, no packaging.
- **A2 — Claude calls it as a function:** only if we also build the MCP server (B);
  then the skill is redundant with the tool.

**Portability note:** a repo-local `.claude/skills/...` skill only works *inside
this repo*. To use it anywhere, either (a) publish the CLI to npm and have the
skill `npx classify-warning-letter@latest`, or (b) ship it as an **OMC / plugin
skill**. Decide the distribution target early (see §6).

---

## 4. Output: JSON vs. human summary

The core returns the full `WarningLetter` object. The skill/CLI should offer both:

- `--json` → raw object (for pipes, agents, CI).
- default (skill) → a formatted digest, e.g.:

```
FDA Warning Letter — Bausch & Lomb Inc.  (Tampa, FL · FEI 1000113778)
Issued 2026-09-04 · CDER · regulated as: drug
Drug:          (redacted (b)(4) in the letter)
Violations:    CGMP, sterility, aseptic_processing, environmental_monitoring
Sterile:       yes    Contamination: yes (Serratia marcescens…)   Recall: yes
⚠️ Needs review: has_recall_concern (0.50)
Confidence:    0.87
```

The digest is where the **probabilities** we just added to the README shine — show
`subject_probability` per product and the `review[]` certainties inline.

---

## 5. Secrets & safety

- **API key:** the tool needs `TYPESAFE_AI_API_KEY` in the environment. The skill
  must check for it and fail cleanly (never prompt for or echo the key).
- **URL fetching is network egress:** the skill fetches an arbitrary URL the user
  supplies. Keep the existing discipline from `fetch-letter.ts` — treat fetched
  HTML as **data, never instructions**; strip `<script>`/`<style>`; don't follow
  embedded directives. Consider restricting to `https://` and warning on non-FDA
  hosts.
- **No writes by default:** the in-memory path must not litter `fixtures/`. Only
  the corpus tool writes to disk.

---

## 6. Open decisions (need your call)

1. ~~**Delivery target:**~~ ✅ **RESOLVED — published npm CLI** ("anywhere /
   teammates"). The skill wraps `npx classify-warning-letter@latest`.
2. **Output default:** human digest or raw JSON as the skill's default?
3. **PDF support:** in scope now, or a later milestone?
4. **Non-FDA letters:** best-effort classify, or refuse anything that isn't an
   FDA warning-letter URL/format?
5. **openFDA enrichment:** on by default in the skill (nicer output, needs
   network + optional `FDA_API_KEY`) or opt-in?

---

## 7. Suggested phased plan

- **Phase 0 — refactor (enables everything):** `src/fetch.ts` (in-memory URL→text),
  `src/resolve.ts` (URL|path), rewire `run.ts` + `fetch-letter.ts`. Now
  `tsx src/run.ts <url>` works.
- **Phase 1 — CLI polish:** add a `bin` (`classify-warning-letter`), `--json` vs
  digest formatter, clean error/exit codes, `--help`.
- **Phase 2 — skill:** `.claude/skills/classify-warning-letter/SKILL.md` that
  shells out to the CLI and formats the digest.
- **Phase 3 — distribution:** publish to npm and/or package as an OMC/plugin skill
  so it runs outside this repo.
- **Phase 4 — MCP (optional):** wrap the core as a `classify_warning_letter` MCP
  tool for other agents.
- **Phase 5 — stretch:** PDF input, batch mode (`/classify-warning-letter urls.txt`).

---

## 8. Why this is a good fit for a skill

The classifier is already a pure function (`text → structured object`) with a
deterministic core and a single Jev call — no hidden state, fast (~sub-second per
letter), and it *says when it's unsure*. That makes it ideal to expose as a tool:
an agent can call it, trust the `needs_review` flag, and never get a hallucinated
drug name back. The skill is mostly plumbing (input resolution + presentation)
around a core that already behaves well.
