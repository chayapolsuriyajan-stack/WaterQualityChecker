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
