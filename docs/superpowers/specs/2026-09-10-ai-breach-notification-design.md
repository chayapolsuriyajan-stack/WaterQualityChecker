# AI reporting enhancements — design spec

Two related but independently-triggered features, spec'd together per an explicit instruction
to cover both in one implementation plan: (1) AI-enriched breach push notifications, (2)
week/month comparison context in the daily AI report, plus a manual baseline-reset button for
relocating a station.

Date: 2026-09-10
Status: approved, ready for planning
Branch: `feature/ai-breach-notifications`

---

# Part 1: AI-enriched breach push notifications

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
- Scoped to `main`-derived branches only (this feature branches from `main`) — not ported to
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

---

# Part 2: Week/month comparison context + baseline reset

## Context

The daily AI report (`_build_daily_report_prompt`/`_generate_ai_report`) currently only judges
each parameter against its fixed threshold band (`thresholds.RANGE_BANDS`) — it has no sense of
what's *typical* for this specific station recently, so it can't flag "today's turbidity is
unusually high compared to this week," only "today's turbidity is in the danger range." This
feature adds that comparative context, plus a manual reset for when a station physically moves
to a new location and its accumulated baseline stops being meaningful.

Confirmed during design review: this is **not** a separate weekly/monthly report artifact —
it's additional context appended to the existing daily prompt, gated on enough baseline data
having accumulated.

## Rolling per-station windows, not calendar-aligned

Two new state triples, alongside the existing `_daily_stats`/`_daily_breach_counts`/
`_daily_stats_date`:

```python
_weekly_stats: dict[str, dict] = {}
_weekly_breach_counts: dict[str, dict] = {}
_weekly_period_start: dict[str, float] = {}  # station -> time.time() the window started

_monthly_stats: dict[str, dict] = {}
_monthly_breach_counts: dict[str, dict] = {}
_monthly_period_start: dict[str, float] = {}
```

Unlike `_daily_stats`'s single shared `_daily_stats_date` (one calendar clock, every station
rolls over together at local midnight), each station's weekly/monthly window rolls over
**independently**, a fixed number of days after *that station's own* `period_start` — 7 days for
weekly, 30 for monthly. A shared helper handles both (parameterized by which dicts and window
length, so the logic isn't duplicated):

```python
def _update_period_stats(
    stats: dict, breach_counts: dict, period_start: dict, station: str, payload: dict, window_days: int
) -> None:
    """Shared rolling-window accumulator for _weekly_stats/_monthly_stats. Unlike
    _update_daily_stats's single shared midnight rollover, each station's window rolls over
    independently, window_days after ITS OWN period_start -- either the last natural
    rollover or the last manual POST /ai-report/reset-baseline call, whichever is more
    recent. Same per-param min/max/sum/count/breach-count accumulation _update_daily_stats
    already does, just parameterized so weekly and monthly share one implementation."""
    now = time.time()
    start = period_start.get(station)
    if start is None or (now - start) >= window_days * 86400:
        period_start[station] = now
        stats.pop(station, None)
        breach_counts.pop(station, None)
    station_stats = stats.setdefault(station, {})
    station_breach_counts = breach_counts.setdefault(station, {})
    for param in PUSH_PARAMS:
        value = payload.get(param)
        if not isinstance(value, (int, float)):
            continue
        current = station_stats.get(param)
        if current is None:
            station_stats[param] = {"min": value, "max": value, "sum": value, "count": 1}
        else:
            current["min"] = min(current["min"], value)
            current["max"] = max(current["max"], value)
            current["sum"] += value
            current["count"] += 1
        if thresholds.is_sensor_fault(param, value):
            continue
        if thresholds.range_status_for(param, value) in ("warn", "danger"):
            station_breach_counts[param] = station_breach_counts.get(param, 0) + 1
```

Called in `POST /update` (`update_sensor`) alongside the existing `_update_daily_stats(station,
payload)` call:

```python
_update_period_stats(_weekly_stats, _weekly_breach_counts, _weekly_period_start, station, payload, 7)
_update_period_stats(_monthly_stats, _monthly_breach_counts, _monthly_period_start, station, payload, 30)
```

A brand-new station's first-ever reading sets its own `period_start` immediately (the `start is
None` branch) — after 7/30 days of continuous operation, comparison lines start appearing
automatically, no special-casing needed for "new station" vs. "post-reset station."

## Manual reset: the same rollover, triggered on demand

```python
@app.post("/ai-report/reset-baseline")
async def reset_ai_baseline(station: str = DEFAULT_STATION):
    """Admin-triggered reset for 'this station just moved to a new physical location' --
    discards the accumulated weekly/monthly comparison baseline and restarts both rolling
    windows from now, exactly like their natural elapsed-time rollover already does (see
    _update_period_stats) -- this just triggers it on demand instead of waiting up to 30
    days for the old-location data to age out. The daily report keeps generating normally
    throughout; it simply omits the week/month comparison lines until enough fresh
    post-reset data has accumulated again."""
    station = _normalize_station(station)
    _weekly_stats.pop(station, None)
    _weekly_breach_counts.pop(station, None)
    _weekly_period_start[station] = time.time()
    _monthly_stats.pop(station, None)
    _monthly_breach_counts.pop(station, None)
    _monthly_period_start[station] = time.time()
    return JSONResponse({"ok": True, "station": station})
```

Not backend-auth-gated, same precedent as `/station/rename` and `/ai-report/generate` — "admin"
is a frontend-only UI role (`RoleProvider.tsx`), enforced by only showing the button to admins,
not by the endpoint itself.

## Daily prompt gains comparison lines, gated on accumulated baseline

`_build_daily_report_prompt` becomes `async` (needed for the water-usage comparison's
`storage.get_recent_daily_usage` call) — its one caller, `_generate_ai_report`, changes
`prompt = _build_daily_report_prompt(station)` to `prompt = await
_build_daily_report_prompt(station)`. Everything the function already builds (the daily
per-param lines) is unchanged; appended after it:

```python
    now = time.time()
    week_start = _weekly_period_start.get(station)
    if week_start is not None and (now - week_start) >= 7 * 86400:
        week_line = _format_period_comparison("สัปดาห์นี้", _weekly_stats.get(station, {}))
        if week_line:
            lines.append(week_line)
        usage_days = min(int((now - week_start) // 86400), 7)
        weekly_usage = await asyncio.to_thread(storage.get_recent_daily_usage, station, usage_days)
        if weekly_usage:
            avg_usage = sum(r["totalLiters"] for r in weekly_usage) / len(weekly_usage)
            lines.append(f"- การใช้น้ำเฉลี่ยต่อวันในสัปดาห์นี้: {avg_usage:.1f} ลิตร")

    month_start = _monthly_period_start.get(station)
    if month_start is not None and (now - month_start) >= 30 * 86400:
        month_line = _format_period_comparison("เดือนนี้", _monthly_stats.get(station, {}))
        if month_line:
            lines.append(month_line)
        usage_days = min(int((now - month_start) // 86400), 30)
        monthly_usage = await asyncio.to_thread(storage.get_recent_daily_usage, station, usage_days)
        if monthly_usage:
            avg_usage = sum(r["totalLiters"] for r in monthly_usage) / len(monthly_usage)
            lines.append(f"- การใช้น้ำเฉลี่ยต่อวันในเดือนนี้: {avg_usage:.1f} ลิตร")

    return "\n".join(lines)
```

New shared helper, mirroring the existing daily-line format (min/max/avg/breach-count) so
Gemini sees "today: X" and "this week: Y" in a visually comparable shape:

```python
def _format_period_comparison(period_label: str, stats: dict) -> str | None:
    """One combined line per period (week/month), only for params with data -- mirrors
    _build_daily_report_prompt's per-param line format so the AI can directly compare
    today's numbers against this line. Returns None if `stats` is empty (nothing accumulated
    yet for this period, even though enough TIME has passed -- e.g. storage was disabled)."""
    parts = []
    for param in PUSH_PARAMS:
        stat = stats.get(param)
        if not stat or not stat.get("count"):
            continue
        _emoji, label, unit = PARAM_DISPLAY.get(param, ("", param.capitalize(), ""))
        avg = stat["sum"] / stat["count"]
        parts.append(f"{label} {stat['min']:.1f}-{stat['max']:.1f} (เฉลี่ย {avg:.1f} {unit})")
    if not parts:
        return None
    return f"- ข้อมูลเปรียบเทียบ{period_label}: " + ", ".join(parts)
```

## Frontend: a reset button on the Calibration tab's WiFi/station area (or AiReportCard)

A new admin-only button — "This is a new location" / reset copy TBD at implementation time,
consistent with the app's existing EN/ไทย localization pattern (`strings.ts`) — calling a new
`resetAiBaseline(station)` fetcher (`POST /ai-report/reset-baseline?station=`), toast on
success/failure, same interaction shape as the existing "Generate now" button. Exact placement
(AiReportCard vs. the station-identity area near `StationSwitcher.tsx`) is an implementation
detail, not a design fork — placing it near the AI report card (what it visibly affects) is the
natural default unless the plan finds a better fit while implementing.

## Non-goals

- No change to `_daily_stats`/`_update_daily_stats`/the daily report's own per-param lines —
  those stay exactly as they are; this only appends new lines after them.
- No new persisted storage — `_weekly_stats`/`_monthly_stats` are in-memory only, same
  restart-loses-the-window tradeoff `_daily_stats` already accepts, confirmed acceptable during
  design review.
- No calendar-alignment (ISO week, 1st-of-month) — purely rolling windows from each station's
  own `period_start`, chosen specifically so a manual reset and a natural rollover are the exact
  same operation.
- Does not touch `daily_usage`'s underlying stored rows (the Water Usage bar chart's data) —
  only reads from it via the existing `get_recent_daily_usage`, never deletes/modifies it.

## Testing

No automated test suite exists in this repo. Verification is manual: POST readings over a
simulated multi-day period (or temporarily patch `_weekly_period_start`/`_monthly_period_start`
backward in time to fast-forward past the 7/30-day gate without waiting for real time to pass),
confirm the comparison lines appear only once the gate is crossed and correctly reflect the
accumulated min/max/avg, call `POST /ai-report/reset-baseline` and confirm the comparison lines
disappear again until the window re-accumulates, and confirm the daily report still generates
normally (with just the comparison lines missing) immediately after a reset.
