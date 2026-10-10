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
  Timestamp | Nome | Idade | Cidade | Descricao | Foto | SubmissionId

  Photos are saved to a Google Drive folder (created automatically on first
  use, see getPhotoFolder) and the "Foto" column gets the file link. Files stay
  private to the spreadsheet owner. After adding the Drive code, run setup()
  once from the editor to grant Drive permission before redeploying.
*/
var MAX_DESCRIPTION = 500;
var MAX_SHORT_FIELD = 100;
// Keep in sync with MAX_PHOTO_BYTES in solteiros.html
var MAX_PHOTO_BYTES = 5 * 1024 * 1024;
var PHOTO_FOLDER_NAME = 'Jornal de Solteiros - Fotos';

// Run once from the Apps Script editor: triggers the Drive authorization
// prompt and creates the photo folder.
function setup() {
  var folder = getPhotoFolder();
  Logger.log('Pasta de fotos: ' + folder.getUrl());
}

// The folder id is remembered in script properties, so renaming or moving
// the folder in Drive doesn't break uploads.
function getPhotoFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('PHOTO_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (err) {
      // Folder was deleted: fall through and create a new one
    }
  }
  var folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// Detects the real image type from the file's magic bytes instead of
// trusting the name or MIME type sent by the browser.
// Returns { mime, extension } or null if it's not JPEG, PNG or HEIC/HEIF.
function detectImageType(bytes) {
  function b(i) { return bytes[i] & 0xFF; } // Apps Script bytes are signed
  if (bytes.length < 12) {
    return null;
  }
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) {
    return { mime: 'image/png', extension: 'png' };
  }
  // HEIC/HEIF (iPhone): ISO media file with "ftyp" box at offset 4
  var boxType = String.fromCharCode(b(4), b(5), b(6), b(7));
  var brand = String.fromCharCode(b(8), b(9), b(10), b(11));
  if (boxType === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) {
    var isHeic = brand.indexOf('he') === 0;
    return isHeic ? { mime: 'image/heic', extension: 'heic' } : { mime: 'image/heif', extension: 'heif' };
  }
  return null;
}

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

  var photoBytes = null;
  var photoType = null;
  if (params.photo) {
    try {
      photoBytes = Utilities.base64Decode(params.photo);
    } catch (err) {
      return jsonResponse({ "result": "error", "message": "Não conseguimos ler a foto. Tente escolher outra." });
    }
    if (photoBytes.length > MAX_PHOTO_BYTES) {
      return jsonResponse({ "result": "error", "message": "A foto pode ter no máximo 5 MB." });
    }
    photoType = detectImageType(photoBytes);
    if (!photoType) {
      return jsonResponse({ "result": "error", "message": "A foto precisa ser JPG, PNG ou HEIC (iPhone)." });
    }
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

    // Saved only after the duplicate check, so retries don't create extra files
    var photoUrl = '';
    if (photoBytes) {
      var fileName = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH-mm') +
        ' - ' + name.replace(/[\\\/:*?"<>|]/g, '') + '.' + photoType.extension;
      var file = getPhotoFolder().createFile(Utilities.newBlob(photoBytes, photoType.mime, fileName));
      photoUrl = file.getUrl();
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowData = {
      'Timestamp': new Date(),
      'Nome': name,
      'Idade': age,
      'Cidade': city,
      'Descricao': description,
      'Foto': photoUrl,
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
