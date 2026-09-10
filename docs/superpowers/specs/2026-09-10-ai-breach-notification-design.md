# AI-enriched breach push notifications — design spec

Date: 2026-09-10
Status: approved, ready for planning
Branch: `main`

## Context

Threshold-breach push notifications (`_check_breaches_and_dispatch` → `dispatch_push_breaches`)
already fire an instant, fixed-template alert (`_format_push_text`) the moment a parameter
crosses from good into warn/danger. That template is deliberately terse — a title/value/range
one-liner — and gives no guidance on *why* it matters or what to do about it. This feature adds
a second, Gemini-generated follow-up notification carrying a short plain-language explanation of
the current problem plus an actionable instruction, without touching the existing instant
alert's reliability.

## Timing: instant template first, AI enrichment second

The existing `dispatch_push_breaches` call (and everything it does) is completely unchanged —
the templated alert still fires immediately, with zero new latency or failure risk. A **second**,
independent dispatch is added alongside it: it calls Gemini (which can take a few seconds, and
has been observed to occasionally time out at its existing 20s limit) and only sends its own
notification once that response comes back. A slow or failed Gemini call can never delay or
block the original alert — worst case, the enrichment follow-up simply never arrives for that
incident, which is the same fail-soft posture the AI daily report already has.

## Trigger: once per breach episode, not per transition or per timer

A new per-station in-memory flag, `_ai_enrichment_sent: dict[str, bool] = {}`, sits alongside
the existing `last_severity` dict:

- When `_check_breaches_and_dispatch` returns a non-empty `breaches` list for a station whose
  flag isn't already `True`, the enrichment dispatch fires (covering every parameter in that
  reading's `breaches` list — see Batching below) and the flag is set `True` immediately, before
  the Gemini call even starts, so nothing re-fires while Gemini is still in flight.
- When a station's `last_severity` entries are all `"good"` again (full recovery), the flag
  resets to `False`. The next breach starts a fresh episode with its own enrichment call.
- **A parameter that breaches for the first time mid-episode (station already flagged, not yet
  fully recovered) does NOT get its own enrichment call.** The whole episode — from the first
  breach until full recovery — is treated as one incident, one Gemini call. This was confirmed
  explicitly during design review as the intended behavior, not an oversight.

This directly implements "cooldown resets once all red disappears" from design review: no
timer, no fixed window — state-based, tied to actual recovery.

## Batching: one Gemini call per episode, covering everything currently breaching

`breaches` (the list `_check_breaches_and_dispatch` already returns) can contain more than one
`(param, severity)` pair when multiple parameters cross their thresholds in the same reading —
the enrichment prompt lists all of them in one call, producing one combined explanation instead
of a burst of separate AI calls/notifications for what is, from the dashboard's perspective, one
incident.

## Prompt

New function, `_build_breach_enrichment_prompt(station: str, breaches: list, payload: dict) -> str`,
placed next to `_build_daily_report_prompt` and sharing its style (Thai, short, addressed to a
non-technical school administrator) but scoped to the current incident instead of a daily
aggregate:

```python
def _build_breach_enrichment_prompt(station: str, breaches: list, payload: dict) -> str:
    lines = [
        "เกิดปัญหาคุณภาพน้ำที่ตรวจพบตอนนี้ กรุณาอธิบายปัญหาปัจจุบันสั้นๆ และให้คำแนะนำว่าควรทำอย่างไร "
        "เป็นภาษาไทย ไม่เกิน 2-3 ประโยค:"
    ]
    for param, severity in breaches:
        value = payload.get(param)
        emoji, label, unit = PARAM_DISPLAY.get(param, ("", param.capitalize(), ""))
        band = thresholds.RANGE_BANDS.get(param, {})
        good_range = f"{band.get('goodMin', '-')}–{band.get('goodMax', '-')}"
        try:
            formatted_value = f"{float(value):.1f}"
        except (TypeError, ValueError):
            formatted_value = str(value)
        lines.append(
            f"- {label}: ค่าที่วัดได้ {formatted_value} {unit} อยู่ในระดับ{severity} "
            f"(ช่วงปกติ: {good_range} {unit})"
        )
    return "\n".join(lines)
```

(`thresholds.RANGE_BANDS` is already imported as `thresholds` in `main.py`; `goodMin`/`goodMax`
are absent for turbidity's upper-only band, so the `.get(..., '-')` fallback keeps that case
readable rather than crashing.)

## Delivery

New function, `dispatch_ai_breach_enrichment(station: str, breaches: list, payload: dict) -> None`,
placed after `dispatch_push_breaches`:

```python
async def dispatch_ai_breach_enrichment(station: str, breaches: list, payload: dict) -> None:
    if not breaches or not gemini_available() or not vapid_available():
        return
    if _ai_enrichment_sent.get(station):
        return
    _ai_enrichment_sent[station] = True  # set before the Gemini call, not after -- see Trigger
    prompt = _build_breach_enrichment_prompt(station, breaches, payload)
    text = await asyncio.to_thread(_call_gemini, prompt)
    if text is None:
        return
    subs = await asyncio.to_thread(storage.get_all_push_subscriptions)
    title = "🤖 AI Guidance"
    for sub in subs:
        eligible = any(
            sub["prefs"].get(param, {}).get(severity, False) for param, severity in breaches
        )
        if eligible:
            await asyncio.to_thread(_send_one_push, sub, title, text, f"ai-{station}", "info")
```

Reuses the existing `_send_one_push`/`_push_payload` machinery unchanged — the notification's
`tag` becomes `f"ai-{station}-info"` (via `_send_one_push`'s existing `f"{param}-{severity}"`
tag construction, with `param="ai-{station}"` and `severity="info"`), which never collides with
an original alert's own `f"{param}-{severity}"` tag, so the enrichment shows as a distinct,
separate notification rather than replacing the original.

**Eligibility** mirrors the existing per-param check: a subscriber gets the enrichment if their
saved prefs have at least one of the currently-breaching `(param, severity)` pairs enabled — the
same population who'd have received at least one of the original template alerts for this
episode, not a broader or narrower set.

## Call site

In `POST /update` (`update_sensor`), where `breaches` is computed and
`asyncio.create_task(dispatch_push_breaches(breaches, payload))` already fires — add one more
fire-and-forget task alongside it:

```python
if breaches:
    asyncio.create_task(dispatch_push_breaches(breaches, payload))
    asyncio.create_task(dispatch_ai_breach_enrichment(station, breaches, payload))
```

Both tasks run independently; a slow/failed enrichment call has no effect on the (already-sent-
by-the-time-Gemini-even-starts) templated alert.

## Non-goals

- No change to the AI daily report (`_build_daily_report_prompt`/`_daily_report_scheduler`) —
  a separate, already-working feature with its own once-a-day cooldown, untouched here.
- No change to the instant templated alert's content, timing, or reliability.
- Scoped to the `main` branch only (this session's active branch) — not ported to
  `feature/vercel-migration`, which has its own separate `IS_VERCEL`-gated fire-and-forget
  posture for push dispatch; porting this feature there, if wanted later, is a separate task.
- No new REST endpoint, no frontend changes — this is entirely a backend push-notification
  content change, consumed the same way the existing push notifications already are (the
  service worker, `sw.js`, already handles any push payload with `title`/`body`/`tag`).

## Testing

No automated test suite exists in this repo. Verification is manual: POST fake bad-range
readings via `/update` (mirroring the fake-good-data test already run this session), confirm
the instant templated alert still fires immediately, confirm a second AI-enriched notification
arrives shortly after with the expected problem+instruction content, confirm a second breach of
a different parameter *before* full recovery does NOT trigger a second enrichment call, and
confirm a fresh breach *after* returning to all-good does trigger a new one.
