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
// -- IFTTT fallback (backend-outage recovery path) ---------------------------------------
// firmware/esp32/esp32.ino POSTs straight to this Web App on every reading; if the backend PC
// (main.py) can't be reached, the firmware instead POSTs the same reading to an IFTTT Maker
// Webhooks event so it isn't silently dropped. To make that path work, set up (one-time,
// manual, in the IFTTT and Apps Script UIs -- none of this is configurable from code):
//   1. An IFTTT applet: trigger = Webhooks "Receive a web request", event name = whatever
//      the firmware's `iftttEventName` constant is set to (they must match exactly).
//   2. That applet's action = Google Sheets "Add row to spreadsheet", targeting a separate
//      tab in this same spreadsheet named IFTTT_Buffer, with columns
//      `Timestamp | value1 | value2 | value3` (IFTTT's own fixed Maker Webhooks schema --
//      value1=temperature, value2=turbidity raw ADC, value3=TDS voltage, matching the order
//      the firmware sends). IFTTT's Sheets action always appends at the bottom, which is why
//      it needs its own tab instead of writing straight into the main sheet (which is
//      newest-first via insertRowBefore -- see doPost below).
//   3. A time-driven trigger on migrateIftttBuffer() (Apps Script editor -> Triggers ->
//      Add Trigger -> time-driven -> every 5-10 minutes), which folds any buffered rows into
//      the main sheet at row 2, in the same shape doPost produces, then clears them from
//      IFTTT_Buffer. Until that trigger is configured, buffered rows just sit in IFTTT_Buffer
//      unread -- harmless, but they won't reach the dashboard.
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  insertReadingAtTop_(
    sheet,
    new Date(),
    data.temperature !== undefined ? data.temperature : "",
    data.turbidity !== undefined ? data.turbidity : "",
    data.tds !== undefined ? data.tds : ""
  );

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Shared "insert one reading at row 2" logic, used by both doPost (live readings posted
// directly by the firmware) and migrateIftttBuffer (readings recovered from the IFTTT
// fallback buffer after a backend outage) so both paths produce identically-shaped rows on
// the main sheet. Creates the header row on first use, same as doPost always did.
function insertReadingAtTop_(sheet, timestamp, temperature, turbidity, tds) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Timestamp", "Temperature (C)", "Turbidity (raw ADC)", "TDS (ppm)"]);
  }

  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 4).setValues([[timestamp, temperature, turbidity, tds]]);
}

// Time-driven (manually configured, see the setup comment at the top of this file): folds
// any rows IFTTT has buffered into IFTTT_Buffer (while the backend PC was unreachable) into
// the main sheet, using the same insert-at-row-2 logic doPost uses, then clears the buffer
// tab. Safe to run on a schedule whether or not IFTTT is actually configured yet -- if the
// IFTTT_Buffer tab doesn't exist, this just logs and returns.
function migrateIftttBuffer() {
  var buffer = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("IFTTT_Buffer");
  if (!buffer) {
    Logger.log("migrateIftttBuffer: no IFTTT_Buffer tab found, skipping (IFTTT not set up yet?).");
    return;
  }

  var lastRow = buffer.getLastRow();
  if (lastRow < 2) {
    return; // header only (or empty) -- nothing buffered
  }

  var numRows = lastRow - 1;
  var values = buffer.getRange(2, 1, numRows, 4).getValues();
  var mainSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    // value1=temperature, value2=turbidity (raw ADC), value3=tds -- same order the firmware
    // sends to the IFTTT Maker Webhooks event.
    insertReadingAtTop_(mainSheet, row[0], row[1], row[2], row[3]);
  }

  // Buffer is small (just readings accumulated during a backend outage until this trigger
  // next runs), so clearing it wholesale is fine -- unlike the main sheet, there's no
  // history/downsampling contract riding on IFTTT_Buffer's row positions.
  buffer.deleteRows(2, numRows);
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
  var values = sheet.getRange(2, 1, numRows, 4).getValues();
  values.reverse(); // newest-first -> chronological ascending (oldest first)

  // Keep only rows inside the window.
  var cutoffMs = Date.now() - seconds * 1000;
  var filtered = [];
  for (var i = 0; i < values.length; i++) {
    var ts = (values[i][0] && values[i][0].getTime) ? values[i][0].getTime() : null;
    if (ts !== null && ts >= cutoffMs) {
      filtered.push({ timestamp: ts, temperature: values[i][1], turbidity: values[i][2], tds: values[i][3] });
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
