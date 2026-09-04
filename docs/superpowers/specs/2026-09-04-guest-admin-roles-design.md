# Guest/Admin roles — design spec

Date: 2026-09-04
Status: approved, ready for planning

## Purpose

Today the dashboard has no access distinction at all: `UserBadge.tsx` renders a static
"Guest / View only" badge with a sign-out button that does nothing, and every write
endpoint (`/calibration*`, and the not-yet-built `/station/rename`) is open to anyone who
can reach the backend. This adds a lightweight two-role system — Guest and Admin — so
calibration and station renaming are gated behind a deliberate "Switch Account" action,
without building real authentication.

## Explicit non-goals

- **No password, no session, no backend enforcement of role.** This is a client-side UI
  gate only. Anyone who can already reach the backend (same LAN, or further if a fixed
  backend host is configured — see `CLAUDE.md`'s WiFi provisioning section) can still call
  `/calibration/*` or `/station/rename` directly via curl/devtools while the UI shows
  "Guest." That's an accepted tradeoff for this iteration, not an oversight.
- **No per-user accounts.** Exactly two roles, no identity beyond "which one is currently
  active in this browser."
- **No gating of anything beyond Calibration + station rename** — WiFi provisioning, flow
  reset-today, notification settings, etc. stay exactly as accessible as they are today.
- **No display-alias station naming.** Rename is a real migration of the canonical station
  key (see below), not a cosmetic label layered on top of the raw name.

## Architecture

### 1. Role state — `frontend/src/lib/RoleProvider.tsx`

New React context, same shape as the existing `DashboardPrefsProvider.tsx`:

```ts
type Role = 'guest' | 'admin'

interface RoleContextValue {
  role: Role
  toggleRole: () => void
}
```

- Backed by `localStorage` (key `hydro.role`), read once on mount, defaulting to
  `'guest'` when absent or invalid.
- `toggleRole()` flips guest↔admin and persists immediately.
- Mounted once near the app root (alongside `DashboardPrefsProvider`/`SensorProvider` in
  `main.tsx`), consumed via a `useRole()` hook.

### 2. Switch Account control — `UserBadge.tsx`

- Badge text changes with role: `"Guest" / "View only"` vs. `"Admin" / "Full access"`
  (two new string keys per language in `strings.ts`, mirroring the existing
  `user.guest`/`user.role` pattern — e.g. `user.admin`, `user.roleAdmin`).
- Icon swaps too (e.g. `User` for guest, `ShieldCheck` for admin — both already
  available from `lucide-react`, no new dependency).
- The existing sign-out (`LogOut`) icon button becomes the Switch Account action: calls
  `toggleRole()`. `aria-label`/`title` change to reflect "Switch to Admin" /
  "Switch to Guest" rather than the current dead "sign out" copy.
- No confirmation dialog — a single click switches immediately, consistent with "no
  password."

### 3. Gating the Calibration nav item

- `Sidebar.tsx`'s `NAV_ITEMS` stays the single source of truth for nav entries, but the
  two render sites (`Sidebar.tsx`, `MobileNav.tsx`) filter it through
  `NAV_ITEMS.filter(item => item.id !== 'calibration' || role === 'admin')` before
  mapping, using `useRole()`.
- **View-state guard**: the top-level view state (wherever `ViewId` is held — the
  component that owns `view`/`onChange` today) must redirect to `'dashboard'` if the
  active view is `'calibration'` and role becomes/starts `'guest'` (covers: an admin
  session on the Calibration tab switches to Guest mid-session, or a `guest`-persisted
  session reloads with a stale `view=calibration` from wherever view state itself is
  persisted, if it is). Implemented as a `useEffect` keyed on `[role, view]` in that
  owning component.
- Guest sees no trace of Calibration in the sidebar at all (hidden entirely, per the
  approved answer) — not a disabled/greyed-out item.

### 4. Station rename — `POST /station/rename`

**Request**: `{"old": "Inlet", "new": "North Inlet"}`

**Validation** (in order, first failure wins):
1. `new` normalized through the *same* rules as `_normalize_station` (trim, cap at
   `MAX_STATION_NAME_LEN`) — reject with 400 if the normalized result is empty or
   equals `DEFAULT_STATION` while `old` isn't already `DEFAULT_STATION` (renaming
   *to* the reserved sentinel would silently merge with the unprovisioned-board bucket).
2. `old` must be a currently-known station (checked via `history_buffer` or
   `calibration` keys, whichever is authoritative — see Implementation notes) → 404 if
   not.
3. `new` (post-normalization) must not already be a known station → 409 (no silent
   merge of two stations' histories/calibration).

**On success**, atomically (single request handler, no `await` between the moves so no
other request can interleave) migrates every per-station structure by popping the old
key and inserting under the new one:

| Structure | Location | Migration |
|---|---|---|
| `history_buffer` | `main.py` in-memory `dict[str, deque]` | pop/reinsert |
| `sensor_stats` | `main.py` in-memory `dict[str, dict]` | pop/reinsert |
| `last_severity` | `main.py` in-memory `dict[str, dict]` | pop/reinsert |
| `calibration` | `main.py` in-memory `dict[str, dict]` (persisted to `calibration.json` on next explicit save, same as today) | pop/reinsert |
| `calibration_mode` | `main.py` in-memory `dict[str, bool]` | pop/reinsert |
| `latest_raw` | `main.py` in-memory `dict[str, dict]` | pop/reinsert |
| `_raw_buffers` | `main.py` in-memory `dict[str, dict]` | pop/reinsert |
| `_daily_usage_totals` / `_daily_usage_seeded` | `main.py` in-memory | pop/reinsert value; move membership in the seeded set |
| `daily_usage` table | `storage.py` SQLite | `UPDATE daily_usage SET station = ? WHERE station = ?` (new `storage.rename_station_usage(old, new)` function, run via `asyncio.to_thread` like the table's other writes) |

Any structure not yet touching `old` (e.g. a station that's never had a calibration
capture) is simply absent from that dict — the migration is a plain conditional
pop-if-present per structure, not a hard requirement that every structure has an entry.

**Response**: `{"old": "Inlet", "new": "North Inlet"}` on success (200).

**Immediately after a successful rename**: `calibration.json` is written to disk right
away (not deferred to the next explicit `/calibration/save`) — the file must never
reference a station name that's no longer live in memory, since a restart before the
next explicit save would otherwise silently lose the rename from the persisted file
while keeping it in the in-memory/SQLite state, an inconsistency worse than the extra
disk write.

**Not touched**: the physical ESP32 board's own provisioned name (NVS-stored, set via
`STATION_SET` over USB per `CLAUDE.md`'s WiFi provisioning section). This is backend-side
bookkeeping only.

### 5. Rename UI — `StationSwitcher.tsx`

- A small pencil/edit icon appended to each `TabsTrigger`, rendered only when
  `role === 'admin'` (via `useRole()`).
- Clicking opens an inline rename affordance (a text input replacing the tab label, or a
  small popover — implementation detail for the plan) pre-filled with the current name,
  Enter/blur-to-save, Escape to cancel.
- On save: `POST /station/rename`, then update `selectedStation` if the renamed station
  was the active one (so the UI doesn't end up pointing at a name that no longer exists).
- **Warning copy required in the rename UI** (per the approved caveat): something to the
  effect of "This only renames it here — the board itself still reports the old name and
  will start a new station under it next time it reports, unless you also reprovision the
  board's name over USB." This must be visible before/at the point of confirming a
  rename, not buried in a tooltip.
- Error handling: 404 (station vanished — e.g. a concurrent rename or the station's data
  aged out) and 409 (name collision) each get a distinct toast message via the existing
  toast pattern (`sonner`, already a dependency — see `CalibrationView.tsx`'s
  save-toast for the established pattern to follow).

## Data flow summary

```
Guest opens dashboard
  -> RoleProvider reads localStorage, defaults to 'guest'
  -> Sidebar/MobileNav render NAV_ITEMS minus 'calibration'
  -> StationSwitcher renders tabs with no rename icon

Click Switch Account (UserBadge)
  -> toggleRole() flips context state + localStorage
  -> Sidebar/MobileNav re-render with 'calibration' item present
  -> StationSwitcher re-renders tabs with rename icons

Admin renames "Inlet" -> "North Inlet"
  -> StationSwitcher POSTs /station/rename
  -> main.py validates, migrates all 8 in-memory structures + SQLite table,
     writes calibration.json immediately
  -> 200 -> frontend updates selectedStation if needed, toast success
  -> ESP32 board itself unaffected; next reading from that board (still
     reporting "Inlet") creates a fresh, uncalibrated "Inlet" station
```

## Testing

No test suite exists in this repo (`CLAUDE.md`: "No test suite exists on either side").
Verification is manual, matching the project's existing practice:

- Toggle role, confirm Calibration nav item appears/disappears and a guest session
  redirects away from a Calibration view if role flips mid-session.
- Rename a station with active calibration + history + daily usage (e.g. using the
  simulate-3-stations script from earlier in this session), confirm all data follows the
  new name and the old name has no leftover entries in `/calibration?station=<old>` or
  `/flow/usage?station=<old>` (should come back as freshly-empty, not error).
- Attempt rename to an existing station name → confirm 409, no partial migration occurs.
- Attempt rename of a nonexistent station → confirm 404.
- Restart `main.py` immediately after a rename (before any other calibration save) →
  confirm `calibration.json` reflects the new name, not the old one.

## Open questions for the implementation plan

None — all prior ambiguities were resolved during brainstorming (see the approved
answers: UI-only auth, localStorage persistence, real rename with migration, Calibration
hidden entirely for guests).
