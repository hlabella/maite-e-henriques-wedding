/*
  Jornal de Solteiros Backend
  Handles POST requests from solteiros.html

  This file is the source of truth for the Google Apps Script deployment of
  the "Jornal de Solteiros" spreadsheet (a different spreadsheet from the
  RSVP one, so it lives in its own Apps Script project).
  After editing, paste it into the Apps Script editor (spreadsheet →
  Extensions → Apps Script) and deploy with:
  Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.
  Using "Manage deployments" keeps the /exec URL unchanged; "New deployment"
  would generate a new URL and JORNAL_SCRIPT_URL in solteiros.html would have
  to be updated.

  Expected header row (row 1 of the first sheet), in any order:
  Timestamp | Nome | Idade | Cidade | Descricao | SubmissionId
*/
var MAX_DESCRIPTION = 500;
var MAX_SHORT_FIELD = 100;

function doGet(e) {
  // GET never writes: crawlers or anyone opening the URL in a browser
  // would otherwise create empty rows.
  return jsonResponse({ "result": "error", "message": "Use o formulário do site para enviar sua apresentação." });
}
function doPost(e) {
  return handleRequest(e);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Neutralize spreadsheet formula injection: values starting with =, +, - or @
// would be stored as live formulas. A leading apostrophe forces literal text.
function sanitizeCell(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return "'" + value;
  }
  return value;
}

function clean(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function handleRequest(e) {
  var params = e.parameter;

  // Honeypot: real people never see the "website" field, bots fill it.
  // Pretend success so the bot doesn't retry.
  if (params.website) {
    return jsonResponse({ "result": "success" });
  }

  // Server-side validation: the page validates too, but the /exec URL is public.
  var name = clean(params.name, MAX_SHORT_FIELD);
  var city = clean(params.city, MAX_SHORT_FIELD);
  var description = String(params.description || '').trim();
  var age = parseInt(params.age, 10);
  if (!name || !city || !description || isNaN(age)) {
    return jsonResponse({ "result": "error", "message": "Preencha todos os campos, por favor." });
  }
  if (age < 18 || age > 120) {
    return jsonResponse({ "result": "error", "message": "Informe uma idade válida (18 anos ou mais)." });
  }
  if (description.length > MAX_DESCRIPTION) {
    return jsonResponse({ "result": "error", "message": "A descrição pode ter no máximo 500 caracteres." });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return jsonResponse({ "result": "error", "message": "Muita gente enviando ao mesmo tempo. Tente novamente em alguns segundos." });
  }
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]; // Writes to the first sheet

    // Idempotency: the frontend retries with the same submission_id. If it is
    // already in the sheet, the first attempt succeeded and only the response
    // was lost — return success instead of writing a duplicate row.
    if (params.submission_id) {
      var existing = sheet.createTextFinder(params.submission_id).matchEntireCell(true).findNext();
      if (existing) {
        return jsonResponse({ "result": "success", "duplicate": true });
      }
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowData = {
      'Timestamp': new Date(),
      'Nome': name,
      'Idade': age,
      'Cidade': city,
      'Descricao': description,
      'SubmissionId': params.submission_id
    };
    var newRow = [];
    for (var i = 0; i < headers.length; i++) {
      var value = rowData[headers[i]];
      newRow.push(sanitizeCell(value === undefined || value === null ? "" : value));
    }
    sheet.appendRow(newRow);
    SpreadsheetApp.flush(); // Commit the write before answering
    return jsonResponse({ "result": "success" });
  } catch (err) {
    return jsonResponse({ "result": "error", "message": err.toString() });
  } finally {
    lock.releaseLock();
  }
}
