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

// Serves recent rows back as JSON so the dashboard's 15-minute graph can read history.
// The backend (GET /history) calls this, filters to the last 15 minutes, and hands the
// result to the browser same-origin. Reads only the last few hundred rows for speed.
// IMPORTANT: after adding this, redeploy the web app as a NEW version, or /exec keeps
// running the old code and GET returns nothing.
function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonOutput_({ rows: [] }); // header only (or empty)
  }

  var maxRows = 500;                                  // ~16 min at a 2s cadence
  var startRow = Math.max(2, lastRow - maxRows + 1);  // skip the header on row 1
  var numRows = lastRow - startRow + 1;
  var values = sheet.getRange(startRow, 1, numRows, 4).getValues();

  var rows = values.map(function (r) {
    return {
      timestamp: (r[0] && r[0].getTime) ? r[0].getTime() : r[0], // epoch ms
      temperature: r[1],
      turbidity: r[2],
      tds: r[3]
    };
  });

  return jsonOutput_({ rows: rows });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
