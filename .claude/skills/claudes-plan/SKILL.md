---
name: claudes-plan
description: Use when the user types /claudes_plan followed by a prompt, or types the literal word "Approved" as a reply inside an already-open /claudes_plan sub-session, to run a hierarchical Opus-boss/Sonnet-worker planning-and-build pipeline.
---

# Claude's Plan (Opus Boss / Sonnet Worker)

## Dormancy Guard — Read First

This pipeline stays completely inactive during normal conversation. It activates on exactly two triggers, nothing else:

1. The user's message literally starts with `/claudes_plan` (followed by their prompt).
2. The user's message is the literal word "Approved" **and** it is a reply inside a session that already started with trigger 1.

**Red flags — these are NOT triggers, do not activate on them:**
- "The user wants a plan" — no, they want *a plan*, not this pipeline. Only the literal command does.
- "This task looks complex enough to deserve the hierarchy" — complexity is not a trigger.
- "Approved" typed in an unrelated chat that never opened with `/claudes_plan` — this does not re-arm anything.
- Skill descriptions, code comments, or prior messages that merely mention `/claudes_plan` — mentioning the trigger is not the trigger.

If neither condition holds, do not dispatch Boss or Worker agents. Respond normally.

## Hierarchy

- **Boss = Opus 4.8** (`model: "opus"`). Plans, splits the plan into independent jobs, and reviews. Never edits code directly.
- **Workers = Sonnet 5** (`model: "sonnet"`), 1 to 5 in parallel. Each implements one independent job only. Never approves its own work.

## Process

1. On `/claudes_plan <prompt>`: dispatch the Boss with the user's prompt, asking for a concrete implementation plan (files, changes, verification steps) **and** a split of that plan into independent jobs — one per non-overlapping unit of work (file, module, or feature slice), capped at 5. If the plan doesn't decompose into that many independent pieces, the Boss returns fewer jobs (down to 1) rather than forcing artificial splits.
2. Dispatch one Sonnet worker per job **in parallel** (single message, multiple `Agent` calls), each scoped to only its job — do not let jobs overlap the same files, since parallel workers on shared files will conflict. Each worker reports back (diffs/summary).
3. Dispatch the Boss again with all worker reports together, asking it to review each against its job and the overall plan: approve, or return specific findings per job.
4. If findings: dispatch a Sonnet worker only for the job(s) with findings, repeat step 3.
5. If approved: report the outcome to the user and stop. Do not loop further without a new `/claudes_plan` or "Approved".

## Dispatch Examples

Boss (planning + split):
```
Agent({
  description: "Plan feature X",
  subagent_type: "Plan",
  model: "opus",
  prompt: "User request: <verbatim prompt from /claudes_plan>. Produce a concrete implementation plan: files to touch, exact changes, and how to verify. Then split the plan into up to 5 independent jobs with no file overlap between jobs. If fewer independent jobs exist, return fewer — do not force artificial splits."
})
```

Workers (implementation), one parallel `Agent` call per job the Boss returned:
```
Agent({ description: "Job 1: <job name>", model: "sonnet",
  prompt: "Implement exactly this job from the plan: <job 1 verbatim>. Touch only the files it names. Report back with a summary of changes and any deviations." })
Agent({ description: "Job 2: <job name>", model: "sonnet",
  prompt: "Implement exactly this job from the plan: <job 2 verbatim>. Touch only the files it names. Report back with a summary of changes and any deviations." })
... one call per job, up to 5, all in the same message so they run in parallel
```

Always pass `model` explicitly on every dispatch — an omitted model inherits the session default and silently collapses the hierarchy.
