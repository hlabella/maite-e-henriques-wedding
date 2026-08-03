/*
  RSVP Wedding Backend
  Handles POST requests from index.html

  This file is the source of truth for the Google Apps Script deployment.
  After editing, paste it into the Apps Script editor (spreadsheet →
  Extensions → Apps Script) and deploy with:
  Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.
  Using "Manage deployments" keeps the /exec URL unchanged; "New deployment"
  would generate a new URL and js/scripts.js would have to be updated.
*/
function doGet(e) {
  // GET never writes: crawlers or anyone opening the URL in a browser
  // used to create near-empty rows in the sheet.
  return ContentService
    .createTextOutput(JSON.stringify({ "result": "error", "message": "Use o formulário do site para confirmar presença." }))
    .setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  return handleRequest(e);
}

// Neutralize spreadsheet formula injection: setValues() treats cell
// values starting with =, +, - or @ as live formulas. A leading
// apostrophe forces Sheets to store them as literal text (the
// apostrophe itself is not displayed in the cell).
function sanitizeCell(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return "'" + value;
  }
  return value;
}
function handleRequest(e) {
  var lock = LockService.getScriptLock();
  // Fail fast if the lock can't be acquired: the frontend retries
  // automatically, so a clean error beats writing without the lock.
  if (!lock.tryLock(20000)) {
    return ContentService
      .createTextOutput(JSON.stringify({ "result": "error", "message": "Muita gente confirmando ao mesmo tempo. Tente novamente em alguns segundos." }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheets()[0]; // Writes to the first sheet
    var params = e.parameter;

    // Idempotency: the frontend retries failed requests with the same
    // submission_id. If that id is already somewhere in the sheet (it is
    // stored inside the FullData JSON), the first attempt actually
    // succeeded and only the response was lost — return success instead
    // of writing a duplicate row.
    if (params.submission_id) {
      var existing = sheet.createTextFinder(params.submission_id).findNext();
      if (existing) {
        return ContentService
          .createTextOutput(JSON.stringify({ "result": "success", "row": existing.getRow(), "duplicate": true }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var newRow = [];
    var rowData = {
      'Timestamp': new Date(),
      'Name': params.name,
      'Attendance': params.attendance,
      'Adults': params.adults,
      'Kids': params.kids,
      'Email': params.email,
      'Phone': params.phone,
      'Obs': params.obs, // dead field
      'FullData': JSON.stringify(params) // Backup of all data including dynamic names and submission_id
    };
    // Fill row based on header order
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      newRow.push(sanitizeCell(rowData[header] || "")); // Default to empty string if not found
    }
    // Single call instead of getLastRow + getRange + setValues:
    // fewer Sheets round-trips = faster response for the guest.
    sheet.appendRow(newRow);
    SpreadsheetApp.flush(); // Commit the write before answering
    return ContentService
      .createTextOutput(JSON.stringify({ "result": "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ "result": "error", "message": err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
