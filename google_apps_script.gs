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
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Timestamp", "Temperature (C)", "Turbidity (raw ADC)", "TDS (ppm)"]);
  }

  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 4).setValues([[
    new Date(),
    data.temperature !== undefined ? data.temperature : "",
    data.turbidity !== undefined ? data.turbidity : "",
    data.tds !== undefined ? data.tds : "",
  ]]);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
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
