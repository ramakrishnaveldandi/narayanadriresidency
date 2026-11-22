/**
 * Narayanadri Residency - maintenance payments backend (Google Apps Script).
 *
 * Storage: the Google Sheet this script is bound to, with tabs
 *   Months   | month, title, version, publishedAt, publishedBy, columnsJson, sourceJson
 *   Bills    | month, flat, total, sourceRow, valuesJson
 *   Payments | id, month, flat, amount, paidAt, txnRef, mode, source, verified, note, recordedAt, recordedBy, voided, voidReason
 *   Audit    | at, actor, action, month, details
 *   BillLines| month, flat, columnKey, label, role, value, total   (one row per line item - for analytics / pivots)
 *
 * Google Drive (in the account that deploys the script):
 *   My Drive / NR Maintenance /            <- drop files here to import them from the app ("Browse Google Drive")
 *                              Latest /    <- source file (image / Excel) of the latest published month
 *                              History /   <- previous months' source files, named "YYYY-MM <original name>"
 *   The folders are created automatically (run setup once); their IDs are saved in script properties.
 *
 * Script properties (Project Settings -> Script properties):
 *   GOOGLE_CLIENT_ID - OAuth web client ID used by the frontend's "Sign in with Google" (required)
 *   ADMIN_EMAIL      - the only admin account (default nrassociation123@gmail.com)
 *   ROOT_FOLDER_ID, LATEST_FOLDER_ID, HISTORY_FOLDER_ID - filled in automatically by setup()
 *
 * Access rules:
 *   - Public (residents): read the LATEST published month only; submit unverified payment references.
 *   - Admin (verified Google ID token for ADMIN_EMAIL): read all months, publish, record/verify/void payments, Drive import.
 *
 * Deploy as a web app: Execute as "Me", access "Anyone". See README.md.
 */

var SHEETS = {
  Months: ['month', 'title', 'version', 'publishedAt', 'publishedBy', 'columnsJson', 'sourceJson'],
  Bills: ['month', 'flat', 'total', 'sourceRow', 'valuesJson'],
  Payments: ['id', 'month', 'flat', 'amount', 'paidAt', 'txnRef', 'mode', 'source', 'verified', 'note', 'recordedAt', 'recordedBy', 'voided', 'voidReason'],
  Audit: ['at', 'actor', 'action', 'month', 'details'],
  BillLines: ['month', 'flat', 'columnKey', 'label', 'role', 'value', 'total'],
};

// ------------------------------------------------------------------ routing

function doGet(e) {
  return handle_(function () {
    var p = e.parameter || {};
    if (p.action === 'index') return readIndex_(false);
    if (p.action === 'month') return readMonth_(p.month, false);
    if (p.action === 'sourceFile') return readSourceFile_(p.month, false);
    throw new Error('Unknown action');
  });
}

function doPost(e) {
  return handle_(function () {
    var body = JSON.parse(e.postData.contents || '{}');

    // Public actions.
    if (body.action === 'submitPayment') return submitPayment_(body.payment);
    var admin = verifyAdmin_(body.idToken); // null when not a valid admin token
    if (body.action === 'index') return readIndex_(!!admin);
    if (body.action === 'month') return readMonth_(body.month, !!admin);
    if (body.action === 'sourceFile') return readSourceFile_(body.month, !!admin);

    // Everything below is admin-only.
    if (!admin) throw new Error('Administrator sign-in required (only ' + adminEmail_() + ').');
    var actor = admin.email;
    switch (body.action) {
      case 'publishMonth':
        return withLock_(function () { return publishMonth_(body.bill, body.correctionReason, actor, body.sourceFile); });
      case 'addPayment':
        return withLock_(function () { return addPayment_(body.payment, actor, true); });
      case 'updatePayment':
        return withLock_(function () { return updatePayment_(body.month, body.id, body.patch, body.reason, actor); });
      case 'listDriveFiles':
        return listDriveFiles_();
      case 'getDriveFile':
        return getDriveFile_(body.id);
      default:
        throw new Error('Unknown action');
    }
  });
}

function handle_(fn) {
  var out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------------ auth

function adminEmail_() {
  return (PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL') || 'nrassociation123@gmail.com').toLowerCase();
}

/**
 * Verifies a Google ID token with Google's tokeninfo endpoint and checks that it was
 * issued to our OAuth client for the admin email. Results are cached for 5 minutes.
 * Returns { email } or null.
 */
function verifyAdmin_(idToken) {
  if (!idToken) return null;
  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured on the server.');
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var cached = cache.get(key);
  if (cached) return cached === 'no' ? null : { email: cached };

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  var ok = null;
  if (res.getResponseCode() === 200) {
    var t = JSON.parse(res.getContentText());
    var validIssuer = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
    var notExpired = Number(t.exp) * 1000 > Date.now();
    var verified = t.email_verified === true || t.email_verified === 'true';
    if (validIssuer && notExpired && verified && t.aud === clientId && String(t.email).toLowerCase() === adminEmail_()) {
      ok = { email: String(t.email).toLowerCase() };
    }
  }
  cache.put(key, ok ? ok.email : 'no', 300);
  return ok;
}

// ------------------------------------------------------------------ visibility

function latestMonth_() {
  var list = listMonths_();
  return list.length ? list[0].month : null;
}

function readIndex_(isAdmin) {
  var list = listMonths_();
  return isAdmin ? list : list.slice(0, 1);
}

/** Source image / Excel of a month from Drive (residents: latest month only). */
function readSourceFile_(month, isAdmin) {
  if (!isAdmin && month !== latestMonth_()) return null;
  var m = rows_('Months').filter(function (r) { return r.month === month; })[0];
  if (!m) return null;
  var src = JSON.parse(m.sourceJson || '{}');
  if (!src.driveFileId) return null;
  var file = DriveApp.getFileById(src.driveFileId);
  if (file.getSize() > 15 * 1024 * 1024) throw new Error('Source file is too large to display.');
  var blob = file.getBlob();
  return { name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

function readMonth_(month, isAdmin) {
  if (!isAdmin && month !== latestMonth_()) return null; // residents see only the latest month
  return getMonth_(month);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ reads

function listMonths_() {
  return rows_('Months')
    .map(function (r) { return { month: r.month, title: r.title }; })
    .sort(function (a, b) { return a.month < b.month ? 1 : -1; });
}

function getMonth_(month) {
  var m = rows_('Months').filter(function (r) { return r.month === month; })[0];
  if (!m) return null;
  var flats = rows_('Bills')
    .filter(function (r) { return r.month === month; })
    .map(function (r) {
      return { flat: String(r.flat), total: Number(r.total), sourceRow: r.sourceRow ? Number(r.sourceRow) : undefined, values: JSON.parse(r.valuesJson || '{}') };
    });
  var payments = rows_('Payments')
    .filter(function (r) { return r.month === month; })
    .map(toPayment_);
  var audit = rows_('Audit').filter(function (r) { return r.month === month; });
  return {
    bill: {
      month: m.month,
      title: m.title,
      version: Number(m.version),
      publishedAt: m.publishedAt,
      publishedBy: m.publishedBy,
      columns: JSON.parse(m.columnsJson),
      source: JSON.parse(m.sourceJson),
      flats: flats,
    },
    payments: payments,
    audit: audit,
  };
}

function toPayment_(r) {
  return {
    id: r.id, month: r.month, flat: String(r.flat), amount: Number(r.amount), paidAt: String(r.paidAt),
    txnRef: r.txnRef ? String(r.txnRef) : undefined, mode: r.mode || undefined, source: r.source,
    verified: r.verified === true || r.verified === 'TRUE', note: r.note || undefined,
    recordedAt: r.recordedAt, recordedBy: r.recordedBy, voided: r.voided === true || r.voided === 'TRUE',
    voidReason: r.voidReason || undefined,
  };
}

// ------------------------------------------------------------------ writes

function publishMonth_(bill, correctionReason, actor, sourceFile) {
  if (!bill || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(bill.month)) throw new Error('Invalid month.');
  if (!bill.flats || !bill.flats.length) throw new Error('No flats in bill.');
  var seen = {};
  bill.flats.forEach(function (f) {
    if (!f.flat) throw new Error('Empty flat number.');
    if (seen[f.flat]) throw new Error('Duplicate flat ' + f.flat);
    if (typeof f.total !== 'number' || !isFinite(f.total)) throw new Error('Flat ' + f.flat + ': invalid total.');
    seen[f.flat] = true;
  });

  var months = sheet_('Months');
  var existing = findRowIndex_(months, 0, bill.month);
  if (existing > 0 && (!correctionReason || !String(correctionReason).trim())) {
    throw new Error(bill.month + ' is already published; a correction reason is required.');
  }

  // Save the source image / Excel to Drive: Latest/ for the newest month (older Latest files move to History/).
  bill.source = bill.source || {};
  var stored = storeSourceFile_(bill.month, sourceFile, bill.source.driveFileId);
  if (stored) {
    bill.source.driveFileId = stored.id;
    bill.source.driveFileName = stored.name;
    bill.source.driveFolder = stored.folder;
  }

  var version = 1;
  if (existing > 0) {
    version = Number(months.getRange(existing, 3).getValue()) + 1;
    months.deleteRow(existing);
    deleteRowsWhere_(sheet_('Bills'), 0, bill.month);
    deleteRowsWhere_(sheet_('BillLines'), 0, bill.month);
  }
  var now = new Date().toISOString();
  months.appendRow(["'" + bill.month, bill.title, version, now, actor, JSON.stringify(bill.columns), JSON.stringify(bill.source)]);
  var billRows = bill.flats.map(function (f) { return ["'" + bill.month, "'" + f.flat, f.total, f.sourceRow || '', JSON.stringify(f.values || {})]; });
  var bills = sheet_('Bills');
  bills.getRange(bills.getLastRow() + 1, 1, billRows.length, billRows[0].length).setValues(billRows);
  writeBillLines_(bill);
  audit_(actor, existing > 0 ? 'correct-month' : 'publish', bill.month,
    existing > 0 ? 'v' + version + ': ' + correctionReason : bill.flats.length + ' flats from ' + (bill.source && bill.source.fileName));
  return { version: version, driveFile: stored };
}

/** Long-format copy of every line item, handy for pivot tables / Looker Studio. */
function writeBillLines_(bill) {
  var cols = (bill.columns || []).filter(function (c) { return c.role !== 'ignore' && c.role !== 'flat'; });
  var lines = [];
  bill.flats.forEach(function (f) {
    cols.forEach(function (c) {
      var v = f.values ? f.values[c.key] : null;
      lines.push(["'" + bill.month, "'" + f.flat, c.key, c.label, c.role, v === undefined || v === null ? '' : v, f.total]);
    });
  });
  if (!lines.length) return;
  var sh = sheet_('BillLines');
  sh.getRange(sh.getLastRow() + 1, 1, lines.length, lines[0].length).setValues(lines);
}

function submitPayment_(p) {
  if (!p) throw new Error('Missing payment.');
  if (!p.txnRef || !String(p.txnRef).trim()) throw new Error('Transaction reference is required.');
  if (p.month !== latestMonth_()) throw new Error('Payments can only be submitted for the latest month.');
  p.source = 'resident';
  p.verified = false;
  p.recordedBy = 'resident';
  return withLock_(function () { return addPayment_(p, 'resident', false); });
}

function addPayment_(p, actor, verified) {
  if (!p || !p.month || !p.flat) throw new Error('Month and flat are required.');
  var amount = Number(p.amount);
  if (!(amount > 0) || amount > 1000000) throw new Error('Invalid amount.');
  var bill = rows_('Bills').filter(function (r) { return r.month === p.month && String(r.flat) === String(p.flat); })[0];
  if (!bill) throw new Error('No bill for flat ' + p.flat + ' in ' + p.month + '.');
  var ref = normRef_(p.txnRef);
  if (ref) {
    var dup = rows_('Payments').filter(function (r) { return !(r.voided === true || r.voided === 'TRUE') && normRef_(r.txnRef) === ref; })[0];
    if (dup) throw new Error('Reference ' + p.txnRef + ' is already recorded for flat ' + dup.flat + ' (' + dup.month + ').');
  }
  var id = p.id || 'p_' + Utilities.getUuid();
  var now = new Date().toISOString();
  sheet_('Payments').appendRow([
    id, "'" + p.month, "'" + String(p.flat), amount, "'" + String(p.paidAt || now.slice(0, 10)), p.txnRef ? "'" + String(p.txnRef).trim() : '',
    String(p.mode || ''), verified ? (p.source || 'admin') : 'resident', verified, String(p.note || '').slice(0, 300), now,
    verified ? actor : 'resident', false, '',
  ]);
  audit_(verified ? actor : 'resident', 'add-payment', p.month, 'Flat ' + p.flat + ': Rs ' + amount + ' ref ' + (p.txnRef || '-') + (verified ? '' : ' (awaiting verification)'));
  return { id: id };
}

function updatePayment_(month, id, patch, reason, actor) {
  var sh = sheet_('Payments');
  var row = findRowIndex_(sh, 0, id);
  if (row < 0) throw new Error('Payment not found.');
  var cols = SHEETS.Payments;
  var action = 'update-payment';
  if (patch.verified === true) {
    sh.getRange(row, cols.indexOf('verified') + 1).setValue(true);
    action = 'verify-payment';
  }
  if (patch.voided === true) {
    if (!reason) throw new Error('A reason is required to void a payment.');
    sh.getRange(row, cols.indexOf('voided') + 1).setValue(true);
    sh.getRange(row, cols.indexOf('voidReason') + 1).setValue(String(reason).slice(0, 300));
    action = 'void-payment';
  }
  var values = sh.getRange(row, 1, 1, cols.length).getValues()[0];
  audit_(actor, action, month, 'Flat ' + values[2] + ' Rs ' + values[3] + ' ref ' + (values[5] || '-') + ': ' + (reason || ''));
  return true;
}

// ------------------------------------------------------------------ Drive

/** NR Maintenance / Latest / History folders, created on first use. */
function folders_() {
  var props = PropertiesService.getScriptProperties();
  var root = folderProp_(props, 'ROOT_FOLDER_ID', function () {
    var it = DriveApp.getRootFolder().getFoldersByName('NR Maintenance');
    return it.hasNext() ? it.next() : DriveApp.createFolder('NR Maintenance');
  });
  var latest = folderProp_(props, 'LATEST_FOLDER_ID', function () { return childFolder_(root, 'Latest'); });
  var history = folderProp_(props, 'HISTORY_FOLDER_ID', function () { return childFolder_(root, 'History'); });
  return { root: root, latest: latest, history: history };
}

function folderProp_(props, key, create) {
  var id = props.getProperty(key);
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* deleted - recreate */ }
  }
  var folder = create();
  props.setProperty(key, folder.getId());
  return folder;
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function inOurFolders_(file, f) {
  var ids = [f.root.getId(), f.latest.getId(), f.history.getId()];
  var parents = file.getParents();
  while (parents.hasNext()) if (ids.indexOf(parents.next().getId()) >= 0) return true;
  return false;
}

/**
 * Stores the month's source file. Newest month -> Latest/ (everything previously in
 * Latest/ is moved to History/). Back-filled older month -> History/ directly.
 */
function storeSourceFile_(month, sourceFile, driveFileId) {
  if (!sourceFile && !driveFileId) return null;
  var f = folders_();
  var latest = latestMonth_();
  var isLatest = !latest || month >= latest;
  var target = isLatest ? f.latest : f.history;
  var prefix = month + ' ';
  var file;
  if (sourceFile && sourceFile.base64) {
    var bytes = Utilities.base64Decode(sourceFile.base64);
    if (bytes.length > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB.');
    var name = String(sourceFile.name || 'maintenance').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    if (isLatest) archiveLatest_(f, null);
    file = target.createFile(Utilities.newBlob(bytes, sourceFile.mimeType || 'application/octet-stream', prefix + name));
  } else {
    file = DriveApp.getFileById(driveFileId);
    if (!inOurFolders_(file, f)) throw new Error('The selected Drive file is not inside the NR Maintenance folder.');
    if (isLatest) archiveLatest_(f, file.getId());
    if (file.getName().indexOf(prefix) !== 0) file.setName(prefix + file.getName());
    file.moveTo(target);
  }
  return { id: file.getId(), name: file.getName(), folder: isLatest ? 'Latest' : 'History' };
}

function archiveLatest_(f, keepId) {
  var it = f.latest.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (file.getId() !== keepId) file.moveTo(f.history);
  }
}

/** Files the admin can import from: the NR Maintenance folder itself and Latest/. */
function listDriveFiles_() {
  var f = folders_();
  var out = [];
  [[f.root, 'NR Maintenance'], [f.latest, 'Latest']].forEach(function (pair) {
    var it = pair[0].getFiles();
    while (it.hasNext()) {
      var file = it.next();
      var mime = file.getMimeType();
      if (/spreadsheet|excel|csv|image\//i.test(mime) || /\.(xlsx|xls|csv)$/i.test(file.getName())) {
        out.push({ id: file.getId(), name: pair[1] + ' / ' + file.getName(), mimeType: mime, modifiedTime: file.getLastUpdated().toISOString() });
      }
    }
  });
  return out.sort(function (a, b) { return a.modifiedTime < b.modifiedTime ? 1 : -1; });
}

function getDriveFile_(id) {
  var f = folders_();
  var file = DriveApp.getFileById(id);
  if (!inOurFolders_(file, f)) throw new Error('File is not in the NR Maintenance folder.');
  var blob = file.getMimeType() === MimeType.GOOGLE_SHEETS
    ? file.getAs('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    : file.getBlob();
  return { name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

// ------------------------------------------------------------------ helpers

/** Run once from the Apps Script editor: creates the sheet tabs and the Drive folders. */
function setup() {
  Object.keys(SHEETS).forEach(sheet_);
  var f = folders_();
  Logger.log('Drive folder: ' + f.root.getUrl());
  Logger.log('  Latest:  ' + f.latest.getUrl());
  Logger.log('  History: ' + f.history.getUrl());
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var header = values.shift();
  return values.map(function (v) {
    var o = {};
    header.forEach(function (h, i) { o[h] = v[i] instanceof Date ? v[i].toISOString() : v[i]; });
    return o;
  });
}

function findRowIndex_(sh, col, value) {
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) if (String(values[i][col]) === String(value)) return i + 1;
  return -1;
}

function deleteRowsWhere_(sh, col, value) {
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) if (String(values[i][col]) === String(value)) sh.deleteRow(i + 1);
}

function normRef_(ref) {
  return String(ref || '').replace(/^'/, '').replace(/\s+/g, '').toUpperCase();
}

function audit_(actor, action, month, details) {
  // Leading apostrophe keeps Sheets from converting '2026-10' into a date.
  sheet_('Audit').appendRow([new Date().toISOString(), actor, action, month ? "'" + month : '', details]);
}
