# Guest/Admin Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side-only Guest/Admin role toggle that hides the Calibration tab from Guests and gates a new real station-rename feature (which migrates a station's history/calibration/usage data to a new name) behind Admin mode.

**Architecture:** A `RoleProvider` React context persists `guest`/`admin` to `localStorage` and drives conditional rendering in the sidebar/mobile nav and the station switcher — no backend auth. A new `POST /station/rename` endpoint on the backend does the actual data migration across eight in-memory structures plus one SQLite table, then broadcasts a `station_renamed` WebSocket message so connected dashboards pick up the new name immediately instead of waiting for the next reading.

**Tech Stack:** FastAPI (`main.py`), SQLite via `storage.py`, React 19 + TypeScript (`frontend/src`), TanStack Query, `sonner` toasts.

## Global Constraints

- No password, no session, no backend enforcement of role — UI gate only (per spec's Explicit non-goals).
- Exactly two roles (`guest`, `admin`), no per-user identity.
- Only the Calibration tab and station rename are gated. Nothing else changes access.
- Rename is a real migration of the canonical station key, not a display alias.
- **No test suite exists in this repo** (`CLAUDE.md`: "No test suite exists on either side"). Every task's verification step is a manual command (curl, or a described UI check) run by the implementer, not an automated test file.
- Frontend copy: no trailing period on short labels, full sentences do end in a period, three-ASCII-dot ellipses only, no em/en dashes (see `strings.ts`'s own header comment).
- Every new frontend string key needs both an `en` and a `th` entry (the `th` block is typed `satisfies Record<keyof typeof en, string>` — a missing key is a compile error).

---

### Task 1: `storage.py` — station rename helpers for the `daily_usage` table

**Files:**
- Modify: `storage.py` (add two functions after `reset_daily_usage`, which ends the file today)

**Interfaces:**
- Produces: `storage.station_has_usage(station: str) -> bool`, `storage.rename_station_usage(old: str, new: str) -> None`, both following the existing `_conn`/`_lock`/try-except-print pattern used by every other function in this file.

- [ ] **Step 1: Add `station_has_usage`**

Open `storage.py` and add this function at the end of the file (after `reset_daily_usage`):

```python
def station_has_usage(station: str) -> bool:
    """True if `station` has any daily_usage row at all (any date) -- used by
    main.py's /station/rename to detect a name collision even for a station whose
    in-memory state was wiped by a restart but still has historical usage on disk."""
    if _conn is None:
        return False
    try:
        with _lock:
            row = _conn.execute(
                "SELECT 1 FROM daily_usage WHERE station = ? LIMIT 1", (station,)
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Daily usage existence check failed: {exc}")
        return False
    return row is not None
```

- [ ] **Step 2: Add `rename_station_usage`**

Add this function directly below `station_has_usage`:

```python
def rename_station_usage(old: str, new: str) -> None:
    """Moves every daily_usage row from `old` to `new`. Caller (main.py) must have
    already confirmed `new` has zero existing rows (via station_has_usage) -- this
    does a plain UPDATE, which would violate the (date, station) primary key if `new`
    already had a row for some date `old` also has one for."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("UPDATE daily_usage SET station = ? WHERE station = ?", (new, old))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage rename failed: {exc}")
```

- [ ] **Step 3: Verify manually**

Run:

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
python -c "
import storage
storage.init('history.db')
storage.add_daily_usage('2026-01-01', 'RenameTestOld', 12.5)
print('has old:', storage.station_has_usage('RenameTestOld'))
print('has new (should be False):', storage.station_has_usage('RenameTestNew'))
storage.rename_station_usage('RenameTestOld', 'RenameTestNew')
print('has old after rename (should be False):', storage.station_has_usage('RenameTestOld'))
print('has new after rename (should be True):', storage.station_has_usage('RenameTestNew'))
print('total for new:', storage.get_daily_usage('2026-01-01', 'RenameTestNew'))
"
```

Expected output:
```
has old: True
has new (should be False): False
has old after rename (should be False): False
has new after rename (should be True): True
total for new: 12.5
```

- [ ] **Step 4: Clean up the test rows and commit**

```bash
python -c "
import storage
storage.init('history.db')
storage._conn.execute(\"DELETE FROM daily_usage WHERE station IN ('RenameTestOld','RenameTestNew')\")
storage._conn.commit()
"
git add storage.py
git commit -m "Add station-rename helpers to storage.py's daily_usage table"
```

---

### Task 2: `main.py` — `POST /station/rename` endpoint

**Files:**
- Modify: `main.py` (add the endpoint after `reset_flow_usage_today`, before the "WiFi provisioning API" section comment; add a broadcast helper near `broadcast_sensor_update`)

**Interfaces:**
- Consumes: `storage.station_has_usage`, `storage.rename_station_usage` (Task 1), `_normalize_station`, `_save_calibration`, `ui_clients`, `ui_clients_lock` (all already in `main.py`).
- Produces: `POST /station/rename` — request `{"old": str, "new": str}`, response `{"old": str, "new": str}` (200), or `{"error": str}` with 400/404/409. WS clients receive `{"type": "station_renamed", "old": str, "new": str}`.

- [ ] **Step 1: Add the broadcast helper**

Find `broadcast_sensor_update` in `main.py` (search `async def broadcast_sensor_update`). Directly below its closing line, add:

```python
async def broadcast_station_renamed(old: str, new: str) -> None:
    disconnected_clients = []
    message = json.dumps({"type": "station_renamed", "old": old, "new": new})
    async with ui_clients_lock:
        for client in list(ui_clients):
            try:
                await client.send_text(message)
            except Exception:
                disconnected_clients.append(client)
        for client in disconnected_clients:
            ui_clients.discard(client)
```

- [ ] **Step 2: Add a station-existence helper**

Find `_station_raw_buffers` (search `def _station_raw_buffers`). Directly below its closing line, add:

```python
def _station_known_in_memory(station: str) -> bool:
    """True if `station` appears in any of the in-memory per-station structures.
    Deliberately checks raw dict membership, NOT the _station_*() accessor functions
    above -- those lazily CREATE an entry on first access, which would make every
    station "exist" the moment you asked about it."""
    return (
        station in history_buffer
        or station in calibration
        or station in sensor_stats
        or station in latest_raw
    )
```

- [ ] **Step 3: Add the endpoint**

Find `reset_flow_usage_today` (search `async def reset_flow_usage_today`). Directly below its closing `return JSONResponse(...)` line (and before the `# --- WiFi provisioning API` comment block), add:

```python
@app.post("/station/rename")
async def rename_station(request: Request):
    body = await request.json()
    old = _normalize_station(body.get("old"))
    new_raw = body.get("new")
    if not isinstance(new_raw, str) or not new_raw.strip():
        return JSONResponse({"error": "new station name is required"}, status_code=400)
    new = _normalize_station(new_raw)
    if new == DEFAULT_STATION and old != DEFAULT_STATION:
        return JSONResponse(
            {"error": f'cannot rename to the reserved name "{DEFAULT_STATION}"'}, status_code=400
        )
    if old == new:
        return JSONResponse({"error": "new name must differ from the current name"}, status_code=400)

    old_exists = _station_known_in_memory(old) or (
        storage.enabled() and await asyncio.to_thread(storage.station_has_usage, old)
    )
    if not old_exists:
        return JSONResponse({"error": f'station "{old}" not found'}, status_code=404)

    new_exists = _station_known_in_memory(new) or (
        storage.enabled() and await asyncio.to_thread(storage.station_has_usage, new)
    )
    if new_exists:
        return JSONResponse({"error": f'station "{new}" already exists'}, status_code=409)

    def move(mapping: dict, old_key: str, new_key: str) -> None:
        if old_key in mapping:
            mapping[new_key] = mapping.pop(old_key)

    move(history_buffer, old, new)
    move(sensor_stats, old, new)
    move(last_severity, old, new)
    move(calibration, old, new)
    move(calibration_mode, old, new)
    move(latest_raw, old, new)
    move(_raw_buffers, old, new)
    move(_daily_usage_totals, old, new)
    if old in _daily_usage_seeded:
        _daily_usage_seeded.discard(old)
        _daily_usage_seeded.add(new)

    if storage.enabled():
        await asyncio.to_thread(storage.rename_station_usage, old, new)

    if new in calibration:
        try:
            _save_calibration()
        except OSError as exc:
            print(f"⚠️ Failed to persist calibration.json after renaming station: {exc}")

    await broadcast_station_renamed(old, new)

    print(f"✏️ Renamed station {old!r} -> {new!r}")
    return JSONResponse({"old": old, "new": new})
```

- [ ] **Step 4: Verify manually**

Start the backend (`python main.py`, or reuse an already-running instance), then:

```bash
# Seed a station with a reading so it "exists"
curl -s -X POST http://localhost:8080/update -H "Content-Type: application/json" \
  -d '{"station":"RenameTestA","temperature":24.0,"turbidity":1000,"tdsVoltage":1.0}'

# Rename it
curl -s -X POST http://localhost:8080/station/rename -H "Content-Type: application/json" \
  -d '{"old":"RenameTestA","new":"RenameTestB"}'
```

Expected: `{"old":"RenameTestA","new":"RenameTestB"}`.

```bash
# Old name should now be gone from calibration/history
curl -s "http://localhost:8080/calibration?station=RenameTestA"
curl -s "http://localhost:8080/history?window=5m&station=RenameTestB"
```

Expected: the calibration response for the OLD name looks freshly-default (no error, since `_station_calibration` lazily creates an empty default on GET — this is expected, not evidence the migration failed; confirm instead that the NEW name's `/history` response contains the reading actually posted under the old name). Also confirm:

```bash
# Collision: renaming to an existing station should 409
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8080/station/rename \
  -H "Content-Type: application/json" -d '{"old":"RenameTestB","new":"default"}'
# Nonexistent old station should 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8080/station/rename \
  -H "Content-Type: application/json" -d '{"old":"NoSuchStation","new":"Whatever"}'
```

Expected: first prints `400` (renaming to the reserved `"default"` name is blocked before the collision check even runs, since `old != DEFAULT_STATION`), second prints `404`.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add main.py
git commit -m "Add POST /station/rename: migrates a station's data to a new name"
```

---

### Task 3: `RoleProvider.tsx` — role state + persistence

**Files:**
- Create: `frontend/src/lib/RoleProvider.tsx`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Produces: `export type Role = 'guest' | 'admin'`, `export function RoleProvider({ children })`, `export function useRole(): { role: Role; toggleRole: () => void }`.

- [ ] **Step 1: Create `RoleProvider.tsx`**

```tsx
/**
 * Guest/Admin UI role. NOT authentication -- there is no password and the backend does
 * not enforce this; it only drives which controls the frontend shows (Calibration tab,
 * station rename). See docs/superpowers/specs/2026-09-04-guest-admin-roles-design.md.
 * Modeled on DashboardPrefsProvider.tsx's localStorage read/write pattern.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type Role = 'guest' | 'admin'

const STORAGE_KEY = 'aqua-role'

function readStoredRole(): Role {
  if (typeof window === 'undefined') return 'guest'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'admin' ? 'admin' : 'guest'
  } catch {
    // localStorage can throw in restrictive environments (private browsing, etc).
    return 'guest'
  }
}

interface RoleContextValue {
  role: Role
  toggleRole: () => void
}

const RoleContext = createContext<RoleContextValue | null>(null)

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>(() => readStoredRole())

  const toggleRole = useCallback(() => {
    setRoleState((prev) => {
      const next: Role = prev === 'admin' ? 'guest' : 'admin'
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Ignore write failures (private browsing, storage disabled, etc).
      }
      return next
    })
  }, [])

  const value = useMemo<RoleContextValue>(() => ({ role, toggleRole }), [role, toggleRole])

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext)
  if (!ctx) {
    throw new Error('useRole() must be used within a <RoleProvider>')
  }
  return ctx
}
```

- [ ] **Step 2: Mount `RoleProvider` in `main.tsx`**

Open `frontend/src/main.tsx`. Add the import alongside the existing `DashboardPrefsProvider` import:

```tsx
import { DashboardPrefsProvider } from '@/lib/DashboardPrefsProvider'
import { RoleProvider } from '@/lib/RoleProvider'
```

Then wrap `<App />` with it, nested inside `DashboardPrefsProvider` (order doesn't matter functionally since they're independent contexts, but keep the tree readable):

```tsx
          <DashboardPrefsProvider>
            <RoleProvider>
              <MotionConfig reducedMotion="user">
                <QueryClientProvider client={queryClient}>
                  <App />
                  <Toaster richColors position="top-right" />
                </QueryClientProvider>
              </MotionConfig>
            </RoleProvider>
          </DashboardPrefsProvider>
```

- [ ] **Step 3: Verify manually**

```bash
cd frontend && npm run build
```

Expected: build succeeds with no TypeScript errors (a `RoleProvider` that's imported but not yet consumed anywhere is not an error — it's a valid, exported, unused-outside-this-file component).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/lib/RoleProvider.tsx frontend/src/main.tsx
git commit -m "Add RoleProvider: client-side guest/admin role, persisted to localStorage"
```

---

### Task 4: `strings.ts` — new copy for role switching and station rename

**Files:**
- Modify: `frontend/src/lib/strings.ts`

**Interfaces:**
- Produces new `MessageKey`s: `user.admin`, `user.roleAdmin`, `user.switchToAdmin`, `user.switchToGuest`, `station.rename`, `station.renameLabel`, `station.renameWarning`, `station.renameSuccess`, `station.renameFailedCollision`, `station.renameFailedNotFound`, `station.renameFailedGeneric`, `station.renameCancel`, `station.renameSave`.

- [ ] **Step 1: Add English keys**

Open `frontend/src/lib/strings.ts`. Find the `// --- user` block (currently `'user.guest'`, `'user.role'`, `'user.signOut'` around line 38-40). Replace that block:

```ts
  'user.guest': 'Guest',
  'user.role': 'View only',
  'user.signOut': 'Sign out',
```

with:

```ts
  'user.guest': 'Guest',
  'user.role': 'View only',
  'user.admin': 'Admin',
  'user.roleAdmin': 'Full access',
  'user.switchToAdmin': 'Switch to Admin',
  'user.switchToGuest': 'Switch to Guest',
```

(`user.signOut` is removed — the button no longer signs out, it switches roles, and no other file references `user.signOut` yet since `UserBadge.tsx`'s wiring happens in Task 5.)

Find the `// --- station` block (currently `'station.defaultLabel'`, `'station.switcherLabel'` around line 34-35). Add two lines after `'station.switcherLabel': 'Station',`:

```ts
  'station.switcherLabel': 'Station',
  'station.rename': 'Rename station',
  'station.renameLabel': 'Station name',
  'station.renameWarning':
    "This only renames it here. The board itself still reports the old name and will start a new, uncalibrated station under it next time it reports, unless you also reprovision the board's name over USB.",
  'station.renameSuccess': 'Station renamed.',
  'station.renameFailedCollision': 'A station with that name already exists.',
  'station.renameFailedNotFound': 'That station no longer exists.',
  'station.renameFailedGeneric': 'Failed to rename station.',
  'station.renameCancel': 'Cancel',
  'station.renameSave': 'Save',
```

- [ ] **Step 2: Add matching Thai keys**

Find the Thai `// --- user` block (currently `'user.guest': 'ผู้เยี่ยมชม'`, `'user.role'`, `'user.signOut'` around line 384-386). Replace:

```ts
    'user.guest': 'ผู้เยี่ยมชม',
    'user.role': 'ดูอย่างเดียว',
    'user.signOut': 'ออกจากระบบ',
```

with:

```ts
    'user.guest': 'ผู้เยี่ยมชม',
    'user.role': 'ดูอย่างเดียว',
    'user.admin': 'ผู้ดูแลระบบ',
    'user.roleAdmin': 'สิทธิ์เต็ม',
    'user.switchToAdmin': 'สลับเป็นผู้ดูแลระบบ',
    'user.switchToGuest': 'สลับเป็นผู้เยี่ยมชม',
```

Find the Thai `// --- station` block (currently `'station.defaultLabel'`, `'station.switcherLabel'` around line 381-382). Add after `'station.switcherLabel': 'สถานี',`:

```ts
    'station.switcherLabel': 'สถานี',
    'station.rename': 'เปลี่ยนชื่อสถานี',
    'station.renameLabel': 'ชื่อสถานี',
    'station.renameWarning':
      'การเปลี่ยนชื่อนี้มีผลเฉพาะที่นี่เท่านั้น บอร์ดยังคงรายงานชื่อเดิม และจะสร้างสถานีใหม่ที่ยังไม่ได้ปรับเทียบภายใต้ชื่อเดิมในครั้งถัดไปที่รายงาน เว้นแต่จะตั้งชื่อบอร์ดใหม่ผ่าน USB ด้วย',
    'station.renameSuccess': 'เปลี่ยนชื่อสถานีแล้ว',
    'station.renameFailedCollision': 'มีสถานีชื่อนี้อยู่แล้ว',
    'station.renameFailedNotFound': 'ไม่พบสถานีนี้แล้ว',
    'station.renameFailedGeneric': 'เปลี่ยนชื่อสถานีไม่สำเร็จ',
    'station.renameCancel': 'ยกเลิก',
    'station.renameSave': 'บันทึก',
```

- [ ] **Step 3: Verify manually**

```bash
cd frontend && npm run build
```

Expected: build succeeds. If a Thai key is missing, this fails with a TypeScript error naming the missing key (the `satisfies Record<keyof typeof en, string>` on the `th` object enforces this) — fix any reported gap before moving on.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/lib/strings.ts
git commit -m "Add role-switching and station-rename copy (EN + TH)"
```

---

### Task 5: `UserBadge.tsx` — wire the Switch Account button

**Files:**
- Modify: `frontend/src/components/shell/UserBadge.tsx`

**Interfaces:**
- Consumes: `useRole()` from Task 3, `user.admin`/`user.roleAdmin`/`user.switchToAdmin`/`user.switchToGuest` string keys from Task 4.

- [ ] **Step 1: Rewrite `UserBadge.tsx`**

Replace the entire file with:

```tsx
import { LogOut, ShieldCheck, User } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useRole } from '@/lib/RoleProvider'

interface UserBadgeProps {
  /** Icon-only compact form, for the collapsed tablet rail. */
  collapsed?: boolean
  className?: string
}

/**
 * Bottom-of-sidebar role badge. Shows the current Guest/Admin role and a button that
 * switches between them -- NOT a real sign-in/sign-out (see RoleProvider.tsx: no
 * password, no backend enforcement).
 */
export function UserBadge({ collapsed = false, className }: UserBadgeProps) {
  const { t } = useT()
  const { role, toggleRole } = useRole()
  const isAdmin = role === 'admin'
  const roleLabel = isAdmin ? t('user.admin') : t('user.guest')
  const roleSubLabel = isAdmin ? t('user.roleAdmin') : t('user.role')
  const switchLabel = isAdmin ? t('user.switchToGuest') : t('user.switchToAdmin')
  const RoleIcon = isAdmin ? ShieldCheck : User

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleRole}
        title={`${roleLabel} — ${switchLabel}`}
        aria-label={switchLabel}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary/25',
          className,
        )}
      >
        <RoleIcon className="h-4 w-4" />
      </button>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2.5',
        className,
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <RoleIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight text-foreground">{roleLabel}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">{roleSubLabel}</p>
      </div>
      <button
        type="button"
        onClick={toggleRole}
        aria-label={switchLabel}
        title={switchLabel}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify manually**

```bash
cd frontend && npm run build
```

Expected: build succeeds (no other file references the removed `user.signOut` key — confirm with `grep -rn "user.signOut" frontend/src`, expect no matches).

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/components/shell/UserBadge.tsx
git commit -m "Wire UserBadge's button to actually switch guest/admin role"
```

---

### Task 6: Gate the Calibration nav item by role

**Files:**
- Modify: `frontend/src/components/shell/Sidebar.tsx`
- Modify: `frontend/src/components/shell/MobileNav.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useRole()` from Task 3.
- Produces: `export function visibleNavItems(role: Role): NavItem[]` from `Sidebar.tsx`, used by both nav render sites.

- [ ] **Step 1: Add `visibleNavItems` to `Sidebar.tsx`**

Open `frontend/src/components/shell/Sidebar.tsx`. Add the import:

```tsx
import type { Role } from '@/lib/RoleProvider'
import { useRole } from '@/lib/RoleProvider'
```

Directly below the existing `export const NAV_ITEMS: NavItem[] = [...]` array, add:

```tsx
/** Guests never see the Calibration tab (hidden entirely, not disabled) -- see
 * docs/superpowers/specs/2026-09-04-guest-admin-roles-design.md. */
export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.id !== 'calibration' || role === 'admin')
}
```

Inside the `Sidebar` component function, add `const { role } = useRole()` right after the existing `const { t } = useT()` line, and change the `nav` block's `{NAV_ITEMS.map((item) => {` to `{visibleNavItems(role).map((item) => {`.

- [ ] **Step 2: Use it in `MobileNav.tsx`**

Open `frontend/src/components/shell/MobileNav.tsx`. Change the import:

```tsx
import { NAV_ITEMS, type ViewId } from './Sidebar'
```

to:

```tsx
import { visibleNavItems, type ViewId } from './Sidebar'
```

Add the role import:

```tsx
import { useRole } from '@/lib/RoleProvider'
```

In `MobileTopBar`, add `const { role } = useRole()` right after `const { t } = useT()`, and change `{NAV_ITEMS.map((item) => {` (inside the `<nav>` in the Sheet) to `{visibleNavItems(role).map((item) => {`.

In `MobileBottomNav`, add `const { role } = useRole()` right after `const { t } = useT()`, and change `{NAV_ITEMS.map((item) => {` to `{visibleNavItems(role).map((item) => {`.

- [ ] **Step 3: Redirect away from Calibration if role becomes/starts Guest**

Open `frontend/src/App.tsx`. Add the import:

```tsx
import { useRole } from '@/lib/RoleProvider'
```

Inside `export default function App()`, right after `const [view, setView] = useState<ViewId>('dashboard')`, add:

```tsx
  const { role } = useRole()

  // A guest session must never land on (or stay on) the Calibration view -- covers both
  // an admin mid-session switching to guest, and (if view state is ever persisted in the
  // future) a guest reload landing on a stale 'calibration' value.
  useEffect(() => {
    if (role === 'guest' && view === 'calibration') {
      setView('dashboard')
    }
  }, [role, view])
```

(`useEffect` is already imported in `App.tsx`'s existing `import { useEffect, useState } from 'react'` line — no import change needed for it.)

- [ ] **Step 4: Verify manually**

```bash
cd frontend && npm run build
python main.py
```

Then in a browser at `http://localhost:8080/`:
1. Fresh load (no `localStorage` entry yet) → confirm Calibration does **not** appear in the sidebar (default role is `guest`).
2. Click the Switch Account button in the bottom-left badge → confirm Calibration now appears in the sidebar, and the badge shows "Admin — Full access".
3. Click into the Calibration tab, then click Switch Account again → confirm it immediately navigates back to Dashboard and Calibration disappears from the sidebar.
4. Reload the page while in Admin mode → confirm it stays Admin (localStorage persistence).
5. Repeat steps 1-3 on a narrow/mobile viewport (or browser dev tools mobile emulation) to confirm the same behavior in `MobileTopBar`'s drawer and `MobileBottomNav`.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/components/shell/Sidebar.tsx frontend/src/components/shell/MobileNav.tsx frontend/src/App.tsx
git commit -m "Hide Calibration tab from Guests, redirect away if role changes mid-view"
```

---

### Task 7: `api.ts` + `useSensorSocket.ts` — rename API call and WS handling

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/useSensorSocket.ts`

**Interfaces:**
- Produces: `export function renameStation(oldName: string, newName: string): Promise<{ old: string; new: string }>` from `api.ts`.
- Produces (internal, consumed by Task 8 indirectly via `stations`/`stationNames` updating): `useSensorSocket`'s returned `stations` map renames its key live when a `station_renamed` WS message arrives.

- [ ] **Step 1: Add `renameStation` to `api.ts`**

Open `frontend/src/lib/api.ts`. Add near the other station-related exports (e.g. right after `getCalibration`):

```ts
export interface RenameStationResponse {
  old: string
  new: string
}

export function renameStation(oldName: string, newName: string): Promise<RenameStationResponse> {
  return request<RenameStationResponse>('/station/rename', {
    method: 'POST',
    body: JSON.stringify({ old: oldName, new: newName }),
  })
}
```

- [ ] **Step 2: Handle `station_renamed` in `useSensorSocket.ts`**

Open `frontend/src/lib/useSensorSocket.ts`. Inside `useSensorSocket()`, find `const applyReading = (r: SensorReading) => { ... }` and add a sibling function directly below its closing brace:

```ts
    /** A station was renamed server-side (see main.py's POST /station/rename). Moves its
     * live reading + sparkline series from the old key to the new one so the dashboard
     * reflects the rename immediately, without waiting for the renamed board's next
     * reading (which, per the rename UI's own warning, may still arrive under the OLD
     * name until the board is separately reprovisioned over USB). */
    const applyStationRenamed = (oldName: string, newName: string) => {
      setStations((prev) => {
        if (!(oldName in prev)) return prev
        const { [oldName]: moved, ...rest } = prev
        return { ...rest, [newName]: moved }
      })
    }
```

Then find `ws.onmessage = (event) => { ... }` and change its body from:

```ts
      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now()
        setConnected(true)
        armStaleTimer()
        try {
          const data = JSON.parse(event.data)
          const parsed = extractReading(data)
          if (parsed) applyReading(parsed)
        } catch {
          // Ignore malformed frames.
        }
      }
```

to:

```ts
      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now()
        setConnected(true)
        armStaleTimer()
        try {
          const data = JSON.parse(event.data)
          if (
            data &&
            typeof data === 'object' &&
            data.type === 'station_renamed' &&
            typeof data.old === 'string' &&
            typeof data.new === 'string'
          ) {
            applyStationRenamed(data.old, data.new)
            return
          }
          const parsed = extractReading(data)
          if (parsed) applyReading(parsed)
        } catch {
          // Ignore malformed frames.
        }
      }
```

- [ ] **Step 3: Verify manually**

```bash
cd frontend && npm run build
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/lib/api.ts frontend/src/lib/useSensorSocket.ts
git commit -m "Add renameStation() API call and live station_renamed WS handling"
```

---

### Task 8: `StationSwitcher.tsx` — rename UI

**Files:**
- Modify: `frontend/src/components/shell/StationSwitcher.tsx`

**Interfaces:**
- Consumes: `useRole()` (Task 3), `renameStation()` (Task 7), `useSensorData()`'s `setSelectedStation` (already exists in `SensorProvider.tsx`), `station.rename`/`station.renameLabel`/`station.renameWarning`/`station.renameSuccess`/`station.renameFailedCollision`/`station.renameFailedNotFound`/`station.renameFailedGeneric`/`station.renameCancel`/`station.renameSave` (Task 4).

- [ ] **Step 1: Rewrite `StationSwitcher.tsx`**

Replace the entire file with:

```tsx
/**
 * Station picker for the Dashboard tab: one tab per ESP32 board that has reported this
 * session (see useSensorSocket's `stations` map), switching which station's live data and
 * history the rest of the dashboard shows. Renders nothing for a single-station deployment
 * (the common case -- one board, never given a custom name) so it doesn't clutter the UI
 * with a switcher that has nothing to switch between.
 *
 * Admin-only rename: a pencil icon next to each tab opens an inline rename input. See
 * docs/superpowers/specs/2026-09-04-guest-admin-roles-design.md for why this is a real
 * data migration (POST /station/rename), not a cosmetic label.
 */
import { useState } from 'react'
import { Check, Pencil, Radio, X } from 'lucide-react'
import { toast } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useT } from '@/lib/i18n'
import { renameStation } from '@/lib/api'
import { useRole } from '@/lib/RoleProvider'
import { useSensorData } from '@/lib/SensorProvider'

/** "default" is the backend's sentinel for a board with no station name provisioned (see
 * main.py's DEFAULT_STATION) -- shown as a friendly label instead of the raw key. */
export function stationLabel(station: string, t: ReturnType<typeof useT>['t']): string {
  return station === 'default' ? t('station.defaultLabel') : station
}

interface RenameFormProps {
  station: string
  onDone: () => void
}

/** Inline rename input replacing a tab's label while editing. */
function RenameForm({ station, onDone }: RenameFormProps) {
  const { t } = useT()
  const { setSelectedStation, selectedStation } = useSensorData()
  const [value, setValue] = useState(station)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === station) {
      onDone()
      return
    }
    setSaving(true)
    try {
      const result = await renameStation(station, trimmed)
      if (selectedStation === station) setSelectedStation(result.new)
      toast.success(t('station.renameSuccess'))
      onDone()
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('409')) {
        toast.error(t('station.renameFailedCollision'))
      } else if (message.includes('404')) {
        toast.error(t('station.renameFailedNotFound'))
      } else {
        toast.error(t('station.renameFailedGeneric'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onDone()
        }}
        autoFocus
        disabled={saving}
        title={t('station.renameWarning')}
        className="w-32 bg-transparent text-sm outline-none"
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        aria-label={t('station.renameSave')}
        className="flex h-6 w-6 items-center justify-center rounded text-primary hover:bg-primary/10"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onDone}
        disabled={saving}
        aria-label={t('station.renameCancel')}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function StationSwitcher() {
  const { t } = useT()
  const { role } = useRole()
  const { stationNames, selectedStation, setSelectedStation } = useSensorData()
  const [renaming, setRenaming] = useState<string | null>(null)

  if (stationNames.length <= 1) return null

  return (
    <div className="flex items-center gap-2">
      <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {renaming ? (
        <RenameForm station={renaming} onDone={() => setRenaming(null)} />
      ) : (
        <Tabs value={selectedStation} onValueChange={setSelectedStation}>
          <TabsList>
            {stationNames.map((station) => (
              <div key={station} className="flex items-center">
                <TabsTrigger value={station}>{stationLabel(station, t)}</TabsTrigger>
                {role === 'admin' && (
                  <button
                    type="button"
                    onClick={() => setRenaming(station)}
                    aria-label={t('station.rename')}
                    title={t('station.rename')}
                    className="ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </TabsList>
        </Tabs>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify manually**

```bash
cd frontend && npm run build
python main.py
```

Using the 3-station simulator from earlier in this session (or by posting 2+ distinct `station` values to `/update` manually), in a browser:
1. As Guest: confirm the station tabs show, with **no** pencil icons.
2. Switch to Admin: confirm a pencil icon appears next to each tab.
3. Click a pencil icon, type a new name, press Enter: confirm a success toast, the tab now shows the new name, and (if it was the selected station) the dashboard stays on that station's data without a blank flash.
4. Try renaming a station to another existing station's name: confirm a "already exists" toast and no data is lost (verify via `curl http://localhost:8080/calibration?station=<original-name>` that the original station is untouched).
5. Press Escape while editing: confirm it cancels with no request sent (check the Network tab).

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add frontend/src/components/shell/StationSwitcher.tsx
git commit -m "Add admin-only station rename UI to StationSwitcher"
```

---

## Self-review notes

- **Spec coverage**: RoleProvider + persistence (Task 3), Switch Account button (Task 5),
  Calibration gating + view redirect (Task 6), real station rename with all 8
  in-memory structures + SQLite table migrated (Tasks 1-2), rename UI with required
  warning copy (Task 8), live WS sync so the switcher reflects a rename immediately
  (Task 7). All spec sections are covered.
- **No password/session/backend enforcement**: confirmed — `/station/rename` has no
  auth check, matching every other write endpoint in `main.py` today.
- **Type consistency checked**: `Role` type defined once in `RoleProvider.tsx` (Task 3),
  imported (not redefined) in `Sidebar.tsx` (Task 6). `renameStation(oldName, newName)`
  signature in `api.ts` (Task 7) matches its one call site in `StationSwitcher.tsx`
  (Task 8). `station_renamed` WS message shape (`{type, old, new}`) matches between the
  backend broadcast (Task 2) and the frontend handler (Task 7).
