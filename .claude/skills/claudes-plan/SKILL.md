---
name: claudes-plan
description: Use when the user types /claudes-plan followed by a prompt, or replies the literal word "Approved" while .claude/claudes-plan/plan.md exists with status awaiting-approval, to run a governed Opus-boss/Sonnet-worker planning-and-build pipeline.
---

# Claude's Plan (Opus Boss / Sonnet Worker)

## Dormancy Guard — Read First

This pipeline stays completely inactive during normal conversation. It activates on exactly two triggers, nothing else:

1. The user's message literally starts with `/claudes-plan` (followed by their prompt).
2. The user's message is the literal word "Approved" **and** `.claude/claudes-plan/plan.md` exists on disk with `status: awaiting-approval`. Check the file — do not rely on remembering how this session started, because context gets compacted and that memory is exactly what Principle 1 says not to trust. "Approved" authorizes exactly **one** more dispatch round (a repair round, or the next blocked phase) under these same rules, and the Boss flips the status out of `awaiting-approval` when consuming it — it does not arm an indefinite loop.

**Red flags — these are NOT triggers, do not activate on them:**
- "The user wants a plan" — no, they want *a plan*, not this pipeline. Only the literal command does.
- "This task looks complex enough to deserve the hierarchy" — complexity is not a trigger.
- "Approved" with no `awaiting-approval` plan file on disk.
- Skill descriptions, code comments, or prior messages that merely mention `/claudes-plan`.

If neither condition holds, do not dispatch Boss or Worker agents. Respond normally.

## Operating Principles

Every rule below exists to prevent a named failure mode of unguarded delegation:

1. **The Boss holds state; the filesystem holds truth.** The plan lives in a file so any agent — or any fresh context — can resume exactly where things stopped. Session memory is cache, not storage.
2. **Sealed briefs, structured returns.** Workers receive complete context up front and return conclusions, never conversations. Same brief in → same work out.
3. **One writer per file region.** Parallelism only across disjoint file scopes. Conflict prevention beats conflict resolution.
4. **Verify before continuing.** Every iteration passes a mechanical gate run by the Boss itself. A worker's "done" claim is a hypothesis, not a fact.
5. **Termination is part of the design.** Repair-round caps and an escalation path are decided before looping starts, not during it.

## Hierarchy

- **Boss = this main session** (whatever model the user has set; Opus intended). Orchestrator only: plans, splits into jobs, writes/updates `plan.md`, verifies, reviews. **Never edits code directly. Never forwards a worker claim it has not verified itself.** The Boss is not a dispatched agent — it is you, the session the user typed the command into.
- **Workers = Sonnet** (`model: "sonnet"`), 1–5 in parallel. Each implements exactly one job from its sealed brief, touching only its allowlisted files. Never approves its own work. Workers never talk to each other — they coordinate through the filesystem only.

**Allowlists are honor-system.** A worker dispatched without `subagent_type` is a general-purpose agent holding every tool; nothing mechanically prevents it from editing outside its allowlist. "One writer per region" holds because the brief says so and because Phase 4 reads the diff — not because the harness enforces it. Treat any out-of-allowlist edit found in review as a finding, not a bonus.

## Process

### Phase 0 — Frame (Boss only)

On `/claudes-plan <prompt>`:

1. If the relevant code is unfamiliar, optionally dispatch read-only `Explore` agents (parallel, no write access) and fold their structured summaries (paths + line refs + short conclusions) into the plan. Skip this when the change is small and obvious.
2. Produce the implementation plan **and** the job split (up to 5 independent jobs; return fewer rather than forcing artificial splits). A `Plan` subagent may draft this, but **the `Plan` agent has no Write tool** — it cannot create the plan file. It returns text; the Boss writes it. Skipping this step leaves no plan on disk and silently breaks every later phase.
3. Create `.claude/claudes-plan/` if absent, then write the plan to **`.claude/claudes-plan/plan.md`**: `status:` (`awaiting-approval` / `in-progress` / `landed`), goal, constraints, per-job sections (owned files, exact changes, done-when), and the overall definition of done. Every later dispatch cites this file; a fresh context must be able to resume from it alone. If a `plan.md` from a finished run is already there, archive it to `plan-<slug>.md` rather than overwriting — a landed plan is the record of what happened.

### Phase 1 — Divide (Boss only)

Partition jobs into **non-overlapping file scopes** and record the ownership map in `plan.md`. If two jobs need the same file, merge them into one job or sequence them — never let parallel workers share files.

Then, **before dispatching anything**, capture the lint baseline:

```
npm --prefix frontend run lint 2>&1 | grep -oE '^[^:]+:[0-9]+:[0-9]+: (error|warning) [a-z-]+\([a-z-]+\)' \
  | sed -E 's/:[0-9]+:[0-9]+//' | sort | uniq -c | sort -k2 > .claude/claudes-plan/lint-baseline.txt
```

This repo does **not** lint clean — `npm run lint` currently exits 1 on pre-existing `react-hooks(rules-of-hooks)` errors in `TwoPointForm.tsx` and a batch of `only-export-components` warnings. A pass/fail lint gate would therefore fail on arrival every run, burn both repair rounds on findings no worker caused, and escalate. The gate must measure *change*, not absolute cleanliness.

### Phase 2 — Dispatch (parallel sealed briefs)

One `Agent` call per job, all in a single message so they run in parallel, each with `model: "sonnet"` explicitly set. The brief is sealed: complete, self-contained, no follow-up questions required. Required fields:

1. **Goal** — one sentence.
2. **Allowlist** — the only files it may touch.
3. **Constraints** — pattern pointers ("reuse the X pattern in `file.ts:12`"), style, forbidden moves.
4. **Done-when** — the mechanical condition copied from the job's plan section.
5. **Report format** — what changed, what was checked, deviations/open questions.

A worker that discovers out-of-scope work reports it back as a line item instead of improvising.

### Phase 3 — Verify (Boss only, mechanical)

**Wait for every dispatched worker's completion notification before running any gate.** Workers run in the background; a gate run against a half-finished tree tests nothing. Never write up a worker's result before its notification arrives — if the user asks in the meantime, say it is still running.

Then run the gates yourself. This session's primary shell is PowerShell 5.1, where `&&` is a parse error; prefer the Bash tool for these, and avoid `cd` inside a compound command (it can trigger a permission prompt). Use `npm --prefix frontend` instead.

**Gate 1 — frontend build (absolute pass/fail).** `npm --prefix frontend run build` exits 0 on the current tree, so any non-zero exit is a real regression a worker introduced. `build` runs `tsc -b && vite build`, so this is the typecheck gate too.

**Gate 2 — frontend lint (differential).** Re-run the Phase 1 capture into `lint-after.txt`, then:

```
diff .claude/claudes-plan/lint-baseline.txt .claude/claudes-plan/lint-after.txt
```

Empty diff → pass. Any added or newly-counted `file + rule` pair → finding against the job that owns that file. Lines that only *disappear* are fine (a worker cleaned something up). Do **not** treat a non-zero exit from `npm run lint` itself as a failure — it is non-zero before the run starts.

**Gate 3 — backend compile.** Compile every changed Python file; do not hardcode a filename list, it goes stale as the backend grows.

```
git diff --name-only HEAD -- '*.py' | xargs -r python -m py_compile
```

This project has no backend test suite — do not invent one mid-run. These three gates plus diff review against the job's done-when **are** the gate.

### Phase 4 — Review (Boss only)

Read the diffs against `plan.md`: approve, or return **specific, per-job findings** (file, line, what's wrong, what "fixed" means).

### Phase 5 — Loop or Land

- **Findings:** re-dispatch **only** the failing jobs with **tightened briefs** — the finding added, the scope narrowed. Never resend an unchanged prompt and expect a different result.
- **Hard stop:** max **2 repair rounds** per run. Still failing → set `status: awaiting-approval`, stop, and escalate to the user, naming precisely what is blocked and why.
- **Approved by gates + review:** set `plan.md` status to `landed`, report the outcome to the user, and **stop**. Do not loop further without a new `/claudes-plan` or "Approved".

**Relay, don't assume.** Worker reports and subagent findings are never shown to the user — only to the Boss. Anything the user needs to know about what a worker did, changed, or flagged must be restated in the Boss's own message.

## Dispatch Examples

Boss drafting the plan (optional — the Boss may plan directly):
```
Agent({ description: "Plan feature X", subagent_type: "Plan", model: "opus",
  prompt: "User request: <verbatim prompt>. Produce a concrete implementation plan (files, exact changes, verification steps) and split it into up to 5 independent jobs with zero file overlap between jobs — fewer if fewer exist; never force artificial splits. Output both." })
```
This agent cannot write files. The Boss writes the returned text to `.claude/claudes-plan/plan.md` before any worker runs.

Workers (implementation), one parallel call per job:
```
Agent({ description: "Job N: <name>", model: "sonnet",
  prompt: "SEALED BRIEF — implement exactly this job from .claude/claudes-plan/plan.md.
1 GOAL: <one sentence>
2 MAY TOUCH: <allowlisted files only>
3 CONSTRAINTS: <pattern pointers / style / forbidden moves>
4 DONE-WHEN: <mechanical condition from the plan>
5 REPORT: what changed / what you checked / deviations + open questions.
Out-of-scope discoveries go in your report, not your diff." })
```

Always pass `model` explicitly on every dispatch — an omitted model inherits the session default and silently collapses the hierarchy.
