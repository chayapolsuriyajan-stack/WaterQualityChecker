/**
 * Station picker for the Dashboard tab: one tab per ESP32 board that has reported this
 * session (see useSensorSocket's `stations` map), switching which station's live data and
 * history the rest of the dashboard shows. Renders nothing for a single-station deployment
 * with no Admin viewing it (the common case -- one board, never given a custom name) so it
 * doesn't clutter the UI with a switcher that has nothing to switch between; an Admin still
 * sees it even with one station, since the rename UI needs to be reachable somewhere.
 *
 * Admin-only rename: a pencil icon next to each tab opens an inline rename input. See
 * docs/superpowers/specs/2026-09-04-guest-admin-roles-design.md for why this is a real
 * data migration (POST /station/rename), not a cosmetic label.
 */
import { useEffect, useState } from 'react'
import { Check, Pencil, Radio, X } from 'lucide-react'
import { toast } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useT } from '@/lib/i18n'
import { ApiError, renameStation } from '@/lib/api'
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
      // Redundant with SensorProvider's own lastRename-driven effect (which handles every
      // connected client, this one included, once the station_renamed WS message arrives) --
      // kept as a harmless immediate optimistic update for the client that caused the rename,
      // landing slightly earlier than the WS round-trip.
      if (selectedStation === station) setSelectedStation(result.new)
      toast.success(t('station.renameSuccess'))
      onDone()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t('station.renameFailedCollision'))
      } else if (err instanceof ApiError && err.status === 404) {
        toast.error(t('station.renameFailedNotFound'))
        // The target station provably no longer exists -- leaving the form open inviting
        // another save attempt against a name that's gone is pointless.
        onDone()
      } else {
        toast.error(t('station.renameFailedGeneric'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
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
          aria-label={t('station.renameLabel')}
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
      <p className="max-w-[220px] text-[11px] leading-snug text-muted-foreground">
        {t('station.renameWarning')}
      </p>
    </div>
  )
}

export function StationSwitcher() {
  const { t } = useT()
  const { role } = useRole()
  const { stationNames, selectedStation, setSelectedStation } = useSensorData()
  const [renaming, setRenaming] = useState<string | null>(null)

  // Close the rename form if role switches away from Admin mid-edit (e.g. via UserBadge's
  // Switch Account button) -- a Guest should never see an open rename input.
  useEffect(() => {
    if (role !== 'admin') setRenaming(null)
  }, [role])

  if (stationNames.length <= 1 && role !== 'admin') return null

  return (
    <div className="flex items-center gap-2">
      <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Tabs value={selectedStation} onValueChange={setSelectedStation}>
        <TabsList>
          {stationNames.map((station) =>
            station === renaming ? (
              <RenameForm key={station} station={station} onDone={() => setRenaming(null)} />
            ) : (
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
            ),
          )}
        </TabsList>
      </Tabs>
    </div>
  )
}
