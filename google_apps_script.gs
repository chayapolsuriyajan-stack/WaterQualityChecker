// Paste this into the spreadsheet's Extensions > Apps Script editor, then deploy as a
// Web App (Execute as: Me, Who has access: Anyone). See CLAUDE.md for full deploy steps.
// This file lives here for reference only -- Apps Script doesn't run from this repo.
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Timestamp", "Temperature (C)", "Turbidity (raw ADC)", "TDS (ppm)"]);
  }

  sheet.appendRow([
    new Date(),
    data.temperature !== undefined ? data.temperature : "",
    data.turbidity !== undefined ? data.turbidity : "",
    data.tds !== undefined ? data.tds : "",
  ]);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Serves recent rows back as JSON so the dashboard's history graph can read a chosen window
// (5m / 15m / 1h / 3h / 12h / 24h / 7d). The backend (GET /history) passes ?seconds= and
// ?maxPoints=; this reads a trailing slice of the sheet, filters to that window, and
// STRIDE-DOWNSAMPLES to at most maxPoints so long windows stay small and fast.
// IMPORTANT: after editing this, redeploy the web app as a NEW version, or /exec keeps
// running the old code and GET returns nothing.
//
// LIMIT: a single Apps Script call can't return a full 7 days at a 2s cadence (~300k rows),
// so reads are capped at HARD_ROW_CEILING. Beyond that cap, long windows return coarse data
// and may not reach the full window back (accepted trade-off — Option A in the plan).
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
  var readRows = Math.min(wantRows, HARD_ROW_CEILING, lastRow - 1);
  var startRow = Math.max(2, lastRow - readRows + 1); // skip the header on row 1
  var numRows = lastRow - startRow + 1;
  var values = sheet.getRange(startRow, 1, numRows, 4).getValues();

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
