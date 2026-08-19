"""Backend port of frontend/src/lib/thresholds.ts's RANGE_BANDS.

NOTE: this is a HAND-MIRRORED DUPLICATE of the TypeScript source of truth
(frontend/src/lib/thresholds.ts). If the bands ever change there, update them here too --
nothing enforces the two staying in sync.
"""

RANGE_BANDS = {
    "temperature": {"goodMin": 25, "goodMax": 30, "dangerMin": 20, "dangerMax": 32, "sensorFaultBelow": 0.01},
    "tds": {"goodMin": 100, "goodMax": 300, "dangerMin": 50, "dangerMax": 500, "sensorFaultBelow": 0.01},
    "ec": {"goodMin": 200, "goodMax": 600, "dangerMin": 100, "dangerMax": 1000, "sensorFaultBelow": 0.01},
    # Turbidity is upper-only: no low band (a low NTU is good).
    "turbidity": {"goodMax": 25, "dangerMax": 50, "sensorFaultBelow": 0.2},
}


def range_status_for(param: str, value: float) -> str:
    band = RANGE_BANDS[param]

    good_min = band.get("goodMin")
    if good_min is not None and value < good_min:
        danger_min = band.get("dangerMin")
        return "danger" if danger_min is not None and value <= danger_min else "warn"

    good_max = band.get("goodMax")
    if good_max is not None and value > good_max:
        danger_max = band.get("dangerMax")
        return "danger" if danger_max is not None and value >= danger_max else "warn"

    return "good"


def is_sensor_fault(param: str, value: float) -> bool:
    band = RANGE_BANDS[param]
    fault_below = band.get("sensorFaultBelow")
    return fault_below is not None and value < fault_below
