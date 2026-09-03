// Paste this into the spreadsheet's Extensions > Apps Script editor, then deploy as a
// Web App (Execute as: Me, Who has access: Anyone). See CLAUDE.md for full deploy steps.
// This file lives here for reference only -- Apps Script doesn't run from this repo.
//
// IMPORTANT: after editing this file in the Apps Script editor, redeploy the web app as a
// NEW version, or /exec keeps running the old code and both endpoints below keep their old
// behaviour silently.
//
// Newest reading is always row 2 (right after the header): doPost INSERTS at row 2 instead
// of appending at the bottom, so the sheet reads newest-first without ever having to scroll.
// doGet reads that same leading block -- the top HARD_ROW_CEILING rows -- rather than a
// trailing slice. Older rows appended under the previous (bottom-append) version stay put
// beneath the insert point; doGet only ever looks at the top of the sheet, so that legacy
// tail is invisible to it and does not need migrating.
//
// -- Backend-outage fallback path ---------------------------------------------------------
// main.py's own Sheets relay (webconfig.json's googleSheetsWebhookUrl) POSTs here on every
// reading normally. When the backend PC can't be reached, firmware/esp32/esp32.ino instead
// buffers readings on-device and POSTs each one straight to THIS SAME Web App once it's able
// to (see esp32.ino's "Google Sheets fallback" section) -- same JSON shape doPost already
// accepts below, so no separate buffer tab or migration trigger is needed: a fallback reading
// lands in the sheet exactly like a normal one, just later and via a different sender. One
// difference worth knowing: the firmware doesn't have the backend's calibration.json, so a
// fallback reading's `tds` field is the sensor's raw voltage, not calibrated ppm (matching
// how `turbidity` is already always raw ADC regardless of source -- see below).
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  insertReadingAtTop_(
    sheet,
    new Date(),
    data.temperature !== undefined ? data.temperature : "",
    data.turbidity !== undefined ? data.turbidity : "",
    data.tds !== undefined ? data.tds : "",
    data.flowRate !== undefined ? data.flowRate : "",
    data.station !== undefined && data.station !== "" ? data.station : "default"
  );

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Shared "insert one reading at row 2" logic, used by doPost for both a normal live reading
// (relayed by main.py) and a recovered one (posted directly by esp32.ino's fallback once the
// backend's been unreachable) -- both go through the exact same code path here, so there's
// nothing else to migrate or reconcile later. Creates the header row on first use.
//
// flowRate is instantaneous L/min (not the daily cumulative usage total -- that's a separate
// daily-bucketed aggregate in storage.py's daily_usage table, a different shape/cadence that
// doesn't fit this per-reading log; see CLAUDE.md's Flow sensor section). Older rows written
// before this column existed simply have a blank cell here -- doGet treats a blank the same
// as any other missing value (see below).
//
// Station is APPENDED as the last column (not inserted after Timestamp, even though that
// reads more naturally) so that rows written before multi-station support existed keep their
// existing column meanings intact -- Temperature/Turbidity/TDS/Flow Rate stay in the same
// columns they've always been in. An older row simply has a blank Station cell, which doGet
// (below) treats the same as main.py's own DEFAULT_STATION sentinel: "default". No backfill
// needed or attempted.
function insertReadingAtTop_(sheet, timestamp, temperature, turbidity, tds, flowRate, station) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Timestamp", "Temperature (C)", "Turbidity (raw ADC)", "TDS (ppm)", "Flow Rate (L/min)", "Station"]);
  }

  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 6).setValues([[timestamp, temperature, turbidity, tds, flowRate, station]]);
}

// Serves recent rows back as JSON so the dashboard's history graph can read a chosen window
// (5m / 15m / 1h / 3h / 12h / 24h). The backend (GET /history) passes ?seconds= and
// ?maxPoints=; this reads a LEADING slice of the sheet (rows 2..N, newest first -- see
// doPost above), reverses it back to chronological ascending order (oldest first, matching
// what the backend's live in-memory buffer already returns), filters to the window, and
// STRIDE-DOWNSAMPLES to at most maxPoints so long windows stay small and fast.
//
// LIMIT: a single Apps Script call can't return a full day+ at a 2s cadence (tens of
// thousands of rows), so reads are capped at HARD_ROW_CEILING. Beyond that cap, long windows
// return coarse data and may not reach the full window back (accepted trade-off).
var HARD_ROW_CEILING = 45000; // ~24h at a 2s cadence; safety cap on read size / exec time

function doGet(e) {
  var params = (e && e.parameter) || {};
  var seconds = parseInt(params.seconds, 10);
  if (isNaN(seconds) || seconds <= 0) seconds = 15 * 60; // default 15 min
  var maxPoints = parseInt(params.maxPoints, 10);
  if (isNaN(maxPoints) || maxPoints <= 0) maxPoints = 400;
  // Optional station filter (main.py's GET /history?station= proxies this through) -- mirrors
  // main.py's own DEFAULT_STATION sentinel: an unset/blank Station cell (rows written before
  // multi-station support existed) is treated as "default", same as everywhere else.
  var stationFilter = params.station && params.station !== "" ? params.station : null;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonOutput_({ rows: [], seconds: seconds }); // header only (or empty)
  }

  // Estimate rows needed for the window (assume ~2s cadence), clamped to the ceiling.
  var wantRows = Math.ceil(seconds / 2);
  var numRows = Math.min(wantRows, HARD_ROW_CEILING, lastRow - 1);
  // Leading slice: row 2 is the newest reading, row (2 + numRows - 1) is the oldest one
  // still inside our read budget. This is correct regardless of how much older, previously
  // bottom-appended data sits further down the sheet -- we simply never read that far.
  // 6 columns even though older rows (written before the Flow Rate / Station columns existed)
  // only have 5 or 4 -- getRange on a short row just returns "" for the missing cell(s), handled below.
  var values = sheet.getRange(2, 1, numRows, 6).getValues();
  values.reverse(); // newest-first -> chronological ascending (oldest first)

  // Keep only rows inside the window (and matching stationFilter, if given).
  var cutoffMs = Date.now() - seconds * 1000;
  var filtered = [];
  for (var i = 0; i < values.length; i++) {
    var ts = (values[i][0] && values[i][0].getTime) ? values[i][0].getTime() : null;
    if (ts !== null && ts >= cutoffMs) {
      // "" (blank cell, either an unset flowRate or a pre-Flow-Rate-column row) -> null,
      // matching how the backend represents "no flow reading" everywhere else.
      var flowRate = values[i][4];
      var station = values[i][5] === "" ? "default" : values[i][5];
      if (stationFilter !== null && station !== stationFilter) continue;
      filtered.push({
        timestamp: ts,
        temperature: values[i][1],
        turbidity: values[i][2],
        tds: values[i][3],
        flowRate: flowRate === "" ? null : flowRate,
        station: station,
      });
    }
  }

  // Downsample by striding so the response never exceeds maxPoints.
  var stride = Math.max(1, Math.ceil(filtered.length / maxPoints));
  var rows = [];
  for (var j = 0; j < filtered.length; j += stride) rows.push(filtered[j]);

  return jsonOutput_({ rows: rows, seconds: seconds, stride: stride, total: filtered.length });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
