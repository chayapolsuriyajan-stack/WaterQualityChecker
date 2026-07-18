# Skill Observation Log

Observations captured during task-oriented work. Each entry identifies a
potential skill improvement or new skill opportunity.

**Status key:** OPEN = not yet actioned | ACTIONED = skill updated/created |
DECLINED = user decided not to pursue

---

## 2026-07-18

### Observation 1: Structured multi-select improves automation-recommender's handoff

**Date:** 2026-07-18
**Session context:** Ran `claude-code-setup:claude-automation-recommender` on the WaterQualityChecker (HydroMonitor) repo per user request ("run /claude-automation-recommender ask me question what to install based on the list").
**Skill:** claude-code-setup:claude-automation-recommender
**Type:** open-source
**Phase/Area:** Phase 3 — Output Recommendations Report, closing lines

**Issue:** The skill's Phase 3 template ends with plain narrative text — "Want more? Ask for additional recommendations..." and "Want help implementing any of these? Just ask." — leaving the user to compose free text naming which recommendations to act on. In this session, after presenting the report, using the `AskUserQuestion` tool with a multi-select listing the recommended items (instead of waiting on free text) let the user pick 2 of 4 recommendations ("context7 MCP" and "sensor-calibration skill") in one structured response, and implementation proceeded immediately with no clarifying round-trip.

**Suggested improvement:** Add a step to Phase 3 (right after the report is presented) instructing the agent to follow up with a multi-select `AskUserQuestion` (or equivalent structured-choice tool) listing each recommended item, rather than relying solely on the closing narrative text. Keep the narrative closing line as a fallback for environments without a structured-question tool.

**Principle:** When a report ends by asking the user to choose among several named, mutually-non-exclusive options, a structured multi-select question converts an open-ended "just ask" into a single deterministic turn — it removes ambiguity about which exact items were approved and eliminates a round-trip. This applies to any skill whose output is a list of discrete recommendations awaiting user selection, not just this one.

**Status:** OPEN

### Observation 2: A freshly-created skill's core assumption was invalidated within the same session

**Date:** 2026-07-18
**Session context:** Created the `sensor-calibration` skill (assumes calibration = hand-editing coefficients in `firmware/esp32/esp32.ino` + reflash). Two turns later, the user asked to design a runtime "calibration mode"; the approved design moved all calibration to the **backend** (`main.py` + `calibration.json` + a `/calibrate` web page), so calibration no longer involves editing firmware or reflashing at all.
**Skill:** sensor-calibration
**Type:** internal
**Phase/Area:** Whole skill — its premise ("conversions live in the firmware sketch; recalibration = re-fit + reflash")

**Issue:** The skill was written to match the codebase as it stood, then the codebase's calibration architecture was deliberately changed in the same session, invalidating the skill's central premise. A skill authored to describe current implementation details (rather than durable domain knowledge) went stale almost immediately.

**Suggested improvement:** Update the skill to the runtime `/calibrate` workflow (done this session). More generally: when a skill must encode implementation specifics that could change, anchor it to the durable layer (the sensor physics / calibration math, which survived the rewrite) and treat the "where it lives / how you apply it" mechanics as a thin, clearly-labeled section that's cheap to swap.

**Principle:** Skills that encode *where* logic currently lives are fragile against refactors; skills that encode *domain invariants* (here: the NTU voltage-divider math, the DFRobot temp-compensated TDS formula, the ADC non-linearity caveats) survive them. Separate the durable knowledge from the mutable mechanics so a re-architecture only touches the thin mechanics layer.

**Status:** ACTIONED — Rewrote sensor-calibration skill into "durable domain knowledge" + "runtime workflow (swappable mechanics)" sections (2026-07-18).
