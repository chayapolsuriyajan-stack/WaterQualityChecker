# AI Reporting Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two AI-reporting features to `main.py`/the dashboard, both spec'd together per
explicit instruction: (1) a second, Gemini-generated push notification following every
threshold-breach alert with a plain-language problem description + instruction; (2) week/month
comparison context appended to the daily AI report's prompt, plus a manual per-station baseline
reset for relocating a board.

**Architecture:** Part 1 adds one new prompt-builder, one new dispatch function, and one new
fire-and-forget task alongside the existing breach-dispatch call site in `POST /update` — the
existing instant templated alert is completely untouched. Part 2 adds two new rolling,
per-station in-memory stat accumulators (mirroring `_daily_stats`'s existing shape but with an
elapsed-time-since-reset rollover instead of a shared midnight clock), a new reset endpoint, and
extends the daily report's prompt-builder (now `async`) to append comparison lines once enough
post-reset data has accumulated.

**Tech Stack:** FastAPI (`main.py`), Gemini REST API (existing `_call_gemini` helper, no new
dependency), `pywebpush` (existing push-send plumbing, no new dependency), React/TypeScript
frontend (`api.ts`, `AiReportCard.tsx`, `strings.ts`).

## Global Constraints

- No automated test suite exists in this repo — verification is manual throughout (direct
  `/update` POSTs, direct endpoint calls, and for Part 2's time-gated logic, monkeypatching
  the relevant `_period_start` dict backward in time rather than waiting real days).
- Match the surrounding code's comment density and style in every function added.
- Every new async dispatch follows the existing fire-and-forget pattern already used for the
  Sheets relay/push dispatch in `update_sensor`: `asyncio.create_task(...)`, never awaited
  inline, so a slow/failed call never delays the ESP32's `/update` response.
- Every new Gemini call goes through the existing `_call_gemini(prompt) -> str | None` helper
  unchanged — no new HTTP/API-key plumbing.
- This plan is scoped to `main`-derived branches only, not `feature/vercel-migration`.

---

### Task 1: AI-enriched breach push notifications

**Files:**
- Modify: `main.py`

**Interfaces:**
- Produces: `_ai_enrichment_sent: dict[str, bool]` (module global), `_build_breach_enrichment_prompt(station: str, breaches: list, payload: dict) -> str`, `async def dispatch_ai_breach_enrichment(station: str, breaches: list, payload: dict) -> None`

- [ ] **Step 1: Add the per-station enrichment-sent flag**

Add near `last_severity: dict[str, dict] = {}` (main.py:253):

```python
# Tracks whether an AI-enriched follow-up notification has already been sent for a
# station's CURRENT breach episode (see dispatch_ai_breach_enrichment) -- reset to False
# only once the station returns to all-good, so one episode (however many params breach
# or how long it lasts before recovery) produces exactly one Gemini call, not one per
# transition and not on a timer.
_ai_enrichment_sent: dict[str, bool] = {}
```

- [ ] **Step 2: Reset the flag on full recovery inside `_check_breaches_and_dispatch`**

Read the current function body (main.py:720-734) first. After the existing `for param in
PUSH_PARAMS:` loop finishes updating `station_severity`, add a check: if every entry in
`station_severity` is now `"good"`, reset `_ai_enrichment_sent[station] = False`. Insert this
right before the `return breaches` line:

```python
def _check_breaches_and_dispatch(station: str, payload: dict) -> list:
    breaches = []
    station_severity = last_severity.setdefault(station, {})
    for param in PUSH_PARAMS:
        value = payload.get(param)
        if not isinstance(value, (int, float)):
            continue
        if thresholds.is_sensor_fault(param, value):
            continue
        status = thresholds.range_status_for(param, value)
        prev = station_severity.get(param, "good")
        if status in ("warn", "danger") and prev == "good":
            breaches.append((param, status))
        station_severity[param] = status
    # Full recovery -- every tracked param back to "good" -- ends the current breach
    # episode, so the NEXT breach (of anything) starts a fresh one and gets its own AI
    # enrichment call. A station with zero tracked params yet (station_severity still
    # empty) is not "recovered", it just hasn't reported anything breach-relevant yet --
    # `all(...)` on an empty dict/values() is True in Python, so guard on non-empty too.
    if station_severity and all(s == "good" for s in station_severity.values()):
        _ai_enrichment_sent[station] = False
    return breaches
```

- [ ] **Step 3: Add `_build_breach_enrichment_prompt`**

Add after `_format_push_text` (main.py:745, right before `_push_payload`):

```python
def _build_breach_enrichment_prompt(station: str, breaches: list, payload: dict) -> str:
    lines = [
        "เกิดปัญหาคุณภาพน้ำที่ตรวจพบตอนนี้ กรุณาอธิบายปัญหาปัจจุบันสั้นๆ และให้คำแนะนำว่าควรทำอย่างไร "
        "เป็นภาษาไทย ไม่เกิน 2-3 ประโยค:"
    ]
    for param, severity in breaches:
        value = payload.get(param)
        _emoji, label, unit = PARAM_DISPLAY.get(param, ("", param.capitalize(), ""))
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

- [ ] **Step 4: Add `dispatch_ai_breach_enrichment`**

Add after `dispatch_push_breaches` (main.py:794):

```python
async def dispatch_ai_breach_enrichment(station: str, breaches: list, payload: dict) -> None:
    """Second, independent dispatch alongside dispatch_push_breaches -- the instant
    templated alert (above) has already been sent by the time this even starts; a slow or
    failed Gemini call here can never delay or block it. Fires at most once per breach
    episode (see _ai_enrichment_sent / _check_breaches_and_dispatch's recovery reset)."""
    if not breaches or not gemini_available() or not vapid_available():
        return
    if _ai_enrichment_sent.get(station):
        return
    _ai_enrichment_sent[station] = True  # set before the Gemini call, not after -- a
    # concurrent reading landing while this call is in flight must not also fire.
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

- [ ] **Step 5: Wire it into `POST /update`**

Read the current breach-dispatch block (main.py:1051-1056) first. Add the new task alongside
the existing one:

```python
            breaches = _check_breaches_and_dispatch(station, payload)
            if breaches:
                asyncio.create_task(dispatch_push_breaches(breaches, payload))
                asyncio.create_task(dispatch_ai_breach_enrichment(station, breaches, payload))
```

- [ ] **Step 6: Verify**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"` — expect no output.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` — expect a clean startup banner, no traceback.

Manual verification (no automated test suite exists): with `python main.py` running locally and
a real Gemini key configured (already the case per this session's earlier test), POST a
danger-range reading (e.g. `temperature: 35`) via `/update`, confirm the instant templated push
still arrives immediately (if a subscription exists — otherwise confirm via server logs that
`dispatch_push_breaches` ran), then confirm a second push with title "🤖 AI Guidance" arrives a
few seconds later. POST a second, different-param danger reading (e.g. `tds: 900`) *without*
first returning to good — confirm no second "AI Guidance" notification fires (still the same
episode). POST good-range readings until full recovery, then POST a new danger reading — confirm
a fresh "AI Guidance" notification fires this time.

- [ ] **Step 7: Commit**

```bash
git add main.py
git commit -m "Add AI-enriched breach push notifications (second, Gemini-generated follow-up alert)"
```

---

### Task 2: Week/month comparison context + baseline reset (backend)

**Files:**
- Modify: `main.py`

**Interfaces:**
- Consumes: `storage.get_recent_daily_usage(station, days) -> list[dict]` (existing, unchanged)
- Produces: `_weekly_stats`/`_weekly_breach_counts`/`_weekly_period_start`,
  `_monthly_stats`/`_monthly_breach_counts`/`_monthly_period_start` (module globals),
  `_update_period_stats(...)`, `_format_period_comparison(...)`, `POST /ai-report/reset-baseline`,
  `_build_daily_report_prompt` becomes `async`

- [ ] **Step 1: Add the six new module globals**

Add near `_daily_stats`/`_daily_breach_counts` (main.py:334-336):

```python
# Rolling per-station comparison windows for the daily AI report (see
# _build_daily_report_prompt below) -- unlike _daily_stats's single shared midnight clock,
# each station's weekly/monthly window rolls over independently, a fixed number of days
# after THAT STATION'S OWN period_start (see _update_period_stats). This is what
# POST /ai-report/reset-baseline manually triggers on demand, for "this station just moved
# to a new physical location, the old baseline is meaningless now."
_weekly_stats: dict[str, dict] = {}
_weekly_breach_counts: dict[str, dict] = {}
_weekly_period_start: dict[str, float] = {}

_monthly_stats: dict[str, dict] = {}
_monthly_breach_counts: dict[str, dict] = {}
_monthly_period_start: dict[str, float] = {}
```

- [ ] **Step 2: Add `_update_period_stats`**

Add right after `_update_daily_stats` (main.py:366):

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

Note: `PUSH_PARAMS` is defined later in the file (main.py:707) than `_update_daily_stats`/this
new function (main.py:~339-366) — this is already how `_update_daily_stats` itself works today
(its own docstring notes `PUSH_PARAMS` is "resolved at call time, not definition time"), so no
reordering is needed; the same reasoning applies unchanged to this new function.

- [ ] **Step 3: Call it from `POST /update`**

Read the current call site (main.py:1012-1013) first. Add the two new calls right after the
existing `_update_daily_stats` call:

```python
        _update_stats(station, payload)
        _update_daily_stats(station, payload)
        _update_period_stats(_weekly_stats, _weekly_breach_counts, _weekly_period_start, station, payload, 7)
        _update_period_stats(_monthly_stats, _monthly_breach_counts, _monthly_period_start, station, payload, 30)
        payload["stats"] = _stats_snapshot(station)
```

- [ ] **Step 4: Add `POST /ai-report/reset-baseline`**

Add near the existing `POST /ai-report/generate` route (search for `@app.post("/ai-report/generate")`):

```python
@app.post("/ai-report/reset-baseline")
async def reset_ai_baseline(station: str = DEFAULT_STATION):
    """Admin-triggered reset for 'this station just moved to a new physical location' --
    discards the accumulated weekly/monthly comparison baseline and restarts both rolling
    windows from now, exactly like their natural elapsed-time rollover already does (see
    _update_period_stats) -- this just triggers it on demand instead of waiting up to 30
    days for the old-location data to age out. The daily report keeps generating normally
    throughout; it simply omits the week/month comparison lines until enough fresh
    post-reset data has accumulated again. Not backend-auth-gated, same precedent as
    /station/rename and /ai-report/generate -- "admin" is a frontend-only UI role
    (RoleProvider.tsx), enforced by only showing the button to admins, not by this endpoint."""
    station = _normalize_station(station)
    _weekly_stats.pop(station, None)
    _weekly_breach_counts.pop(station, None)
    _weekly_period_start[station] = time.time()
    _monthly_stats.pop(station, None)
    _monthly_breach_counts.pop(station, None)
    _monthly_period_start[station] = time.time()
    return JSONResponse({"ok": True, "station": station})
```

- [ ] **Step 5: Add `_format_period_comparison`**

Add immediately BEFORE `_build_daily_report_prompt` (find it via `def
_build_daily_report_prompt`, currently main.py:809) — it must come first since Step 6 calls it
from within that function:

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

- [ ] **Step 6: Make `_build_daily_report_prompt` async, append comparison lines**

Read the current function (main.py:809-827) first. Change its signature from `def
_build_daily_report_prompt(station: str) -> str:` to `async def
_build_daily_report_prompt(station: str) -> str:`. Everything in its existing body (the daily
per-param lines, ending in the original `return "\n".join(lines)`) is unchanged — replace only
that final `return` line with:

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

- [ ] **Step 7: Update `_generate_ai_report`'s call site**

Read the current function (main.py:845-874-ish) first. Change:

```python
    prompt = _build_daily_report_prompt(station)
```

to:

```python
    prompt = await _build_daily_report_prompt(station)
```

This is the function's only caller — no other call site needs updating.

- [ ] **Step 8: Verify**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"` — expect no output.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` — expect a clean startup banner, no traceback.

Write and run a standalone script (scratchpad, delete after) that:
1. POSTs a few readings via a `starlette.testclient.TestClient` against `main.app`.
2. Confirms `main._weekly_period_start['default']` and `main._monthly_period_start['default']`
   are both set (non-`None`) after the first POST.
3. Monkeypatches `main._weekly_period_start['default']` to `time.time() - 8 * 86400` (8 days
   ago) and `main._monthly_period_start['default']` similarly to `time.time() - 31 * 86400`,
   then calls `await main._build_daily_report_prompt('default')` directly and confirms the
   returned string contains both `สัปดาห์นี้` and `เดือนนี้` (the comparison lines now appear
   since the gate is crossed).
4. Calls `POST /ai-report/reset-baseline?station=default` via the TestClient, confirms the
   response is `{"ok": true, "station": "default"}`, then confirms
   `main._weekly_period_start['default']` and `main._monthly_period_start['default']` are both
   now very recent (within the last few seconds) and `main._weekly_stats`/`main._monthly_stats`
   no longer have a `'default'` entry.
5. Calls `await main._build_daily_report_prompt('default')` again immediately after the reset
   and confirms the returned string does NOT contain `สัปดาห์นี้`/`เดือนนี้` this time (gate no
   longer crossed, freshly reset).

- [ ] **Step 9: Commit**

```bash
git add main.py
git commit -m "Add week/month comparison context to the daily AI report + POST /ai-report/reset-baseline"
```

---

### Task 3: Baseline reset button (frontend)

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/components/dashboard/AiReportCard.tsx`
- Modify: `frontend/src/lib/strings.ts`

**Interfaces:**
- Consumes: `POST /ai-report/reset-baseline` (Task 2)
- Produces: `resetAiBaseline(station: string): Promise<{ ok: boolean; station: string }>`

- [ ] **Step 1: Add the fetcher**

In `frontend/src/lib/api.ts`, add right after `generateAiReport` (currently api.ts:138-142):

```typescript
/** Admin-only: discards this station's accumulated weekly/monthly comparison baseline and
 * restarts both rolling windows from now (see main.py's POST /ai-report/reset-baseline) --
 * for "this station just moved to a new physical location, the old baseline no longer
 * applies." The daily report itself keeps generating normally; it just won't show
 * week/month comparison context again until enough fresh data has accumulated. */
export function resetAiBaseline(station: string): Promise<{ ok: boolean; station: string }> {
  return request(`/ai-report/reset-baseline?station=${encodeURIComponent(station)}`, {
    method: 'POST',
  })
}
```

- [ ] **Step 2: Add EN/Thai strings**

In `frontend/src/lib/strings.ts`, add to the English block (right after `'aiReport.lastGenerated'`, currently strings.ts:164):

```typescript
  'aiReport.resetBaseline': 'New location',
  'aiReport.resetBaselineConfirm': 'Reset this station\'s AI comparison baseline? Use this after physically moving the board to a new place.',
  'aiReport.resetBaselineSuccess': 'Baseline reset — comparison context will rebuild over the next week',
  'aiReport.resetBaselineFailed': "Couldn't reset the baseline",
```

Add the matching Thai block (right after the Thai `'aiReport.lastGenerated'`, currently
strings.ts:537):

```typescript
    'aiReport.resetBaseline': 'สถานที่ใหม่',
    'aiReport.resetBaselineConfirm': 'รีเซ็ตข้อมูลเปรียบเทียบของสถานีนี้? ใช้เมื่อย้ายอุปกรณ์ไปสถานที่ใหม่',
    'aiReport.resetBaselineSuccess': 'รีเซ็ตข้อมูลเปรียบเทียบแล้ว — ระบบจะสะสมข้อมูลใหม่ในช่วงสัปดาห์หน้า',
    'aiReport.resetBaselineFailed': 'รีเซ็ตข้อมูลเปรียบเทียบไม่สำเร็จ',
```

Read the actual current file around both insertion points first — line numbers may have
shifted; match the existing key-quoting/formatting style exactly (single-quoted keys, as shown
in both existing blocks).

- [ ] **Step 3: Add the button to `AiReportCard.tsx`**

Read the current file (already shown above) in full first. Import `resetAiBaseline` alongside
the existing `api.ts` imports:

```typescript
import { ApiError, generateAiReport, getAiReport, resetAiBaseline } from '@/lib/api'
```

Add a second `useMutation`, right after the existing `generateMutation`:

```typescript
  const resetBaselineMutation = useMutation({
    mutationFn: () => resetAiBaseline(station),
    onSuccess: () => {
      toast.success(t('aiReport.resetBaselineSuccess'))
    },
    onError: () => toast.error(t('aiReport.resetBaselineFailed')),
  })
```

In the `CardHeader`'s admin-only button row (currently just the "Generate now" button), add the
new button alongside it, gated behind a `window.confirm` (matching how a destructive/one-way
admin action should get a confirmation step — no existing confirm-dialog component is used
elsewhere in this codebase for a single button, so a plain `window.confirm` is the simplest
consistent choice; note this for the implementer to reconsider if the codebase gains a proper
confirm-dialog component before this lands):

```tsx
        {role === 'admin' && !notConfigured && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={resetBaselineMutation.isPending}
              onClick={() => {
                if (window.confirm(t('aiReport.resetBaselineConfirm'))) {
                  resetBaselineMutation.mutate()
                }
              }}
            >
              {t('aiReport.resetBaseline')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              {generateMutation.isPending ? t('aiReport.generating') : t('aiReport.generateNow')}
            </Button>
          </div>
        )}
```

(This replaces the existing single `{role === 'admin' && !notConfigured && (<Button ...>` block
— wrap both buttons in the new `<div className="flex items-center gap-2">` shown above instead
of just the one.)

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc -b --noEmit` — expect no errors.

Run: `cd frontend && npm run lint` — expect no new errors (there may be pre-existing unrelated
lint errors elsewhere in the codebase — confirm any you see are unchanged in count/nature from
before this task, don't attempt to fix them).

Run: `cd frontend && npm run build` — expect a clean build.

Manual verification (no automated frontend test suite exists): with `python main.py` running
locally and `npm run dev`, open the dashboard as an admin, confirm the new "New location" button
appears next to "Generate now" on the AI Report card, click it, confirm the browser's native
confirm dialog appears, confirm it, and confirm the success toast appears.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/strings.ts frontend/src/components/dashboard/AiReportCard.tsx
git commit -m "Add baseline-reset button to the AI Report card"
```
