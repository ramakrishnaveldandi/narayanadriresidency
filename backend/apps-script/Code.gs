/**
 * Narayanadri Residency - maintenance payments backend (Google Apps Script).
 *
 * Monthly bills live in GOOGLE DRIVE (account that deploys this script):
 *
 *   My Drive / NR Maintenance /                 <- optional drop folder ("Pick from Google Drive" in the app)
 *                              Latest /         <- newest month: "2026-11 Nov-2026.xlsx" + "2026-11.json"
 *                              History /        <- older months, same naming
 *
 *   - "<month> <name>.xlsx" is the Excel sheet the admin uploaded (kept as the original record).
 *   - "<month>.json" is the reviewed data published from the app; residents' screens are served from it.
 *   Publishing a newer month moves everything in Latest/ to History/. Folders are created by setup().
 *
 * Changing records live in the GOOGLE SHEET this script is bound to:
 *   Payments  | id, month, flat, amount, paidAt, txnRef, mode, source, verified, note, recordedAt, recordedBy, voided, voidReason
 *   Audit     | at, actor, action, month, details
 *   BillLines | month, flat, columnKey, label, role, value, total   (one row per line item - for analytics)
 *
 * Script properties (Project Settings -> Script properties):
 *   GOOGLE_CLIENT_ID - OAuth web client ID used by the app's "Sign in with Google" (required)
 *   ADMIN_EMAIL      - the only admin account (default nrassociation123@gmail.com)
 *   ROOT_FOLDER_ID, LATEST_FOLDER_ID, HISTORY_FOLDER_ID - filled in automatically by setup()
 *
 * Access rules:
 *   - Public (residents): read the LATEST month only; submit unverified payment references.
 *   - Admin (verified Google ID token for ADMIN_EMAIL): all months, publish, payments, Drive picker.
 *
 * Deploy as a web app: Execute as "Me", access "Anyone". See README.md.
 */

var SHEETS = {
  Payments: ['id', 'month', 'flat', 'amount', 'paidAt', 'txnRef', 'mode', 'source', 'verified', 'note', 'recordedAt', 'recordedBy', 'voided', 'voidReason'],
  Audit: ['at', 'actor', 'action', 'month', 'details'],
  BillLines: ['month', 'flat', 'columnKey', 'label', 'role', 'value', 'total'],
};

var MONTH_JSON = /^(20\d{2}-(0[1-9]|1[0-2]))\.json$/;
var INDEX_CACHE_KEY = 'month_index_v1';

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
        return withLock_(function () { return publishMonth_(body.bill, body.correctionReason, actor, body.sourceFile, body.markPaid); });
      case 'deleteMonth':
        return withLock_(function () { return deleteMonth_(body.month, body.reason, actor); });
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

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
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

// ------------------------------------------------------------------ month index (from Drive)

/** All published months found in Drive (Latest + History), newest first: [{ month, title, fileId, folder }]. */
function monthIndex_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(INDEX_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  var f = folders_();
  var list = [];
  [[f.latest, 'Latest'], [f.history, 'History']].forEach(function (pair) {
    var it = pair[0].getFiles();
    while (it.hasNext()) {
      var file = it.next();
      var m = file.getName().match(MONTH_JSON);
      if (m) list.push({ month: m[1], title: file.getDescription() || m[1], fileId: file.getId(), folder: pair[1] });
    }
  });
  list.sort(function (a, b) { return a.month < b.month ? 1 : -1; });
  cache.put(INDEX_CACHE_KEY, JSON.stringify(list), 300);
  return list;
}

function clearIndexCache_() {
  CacheService.getScriptCache().remove(INDEX_CACHE_KEY);
}

function latestMonth_() {
  var list = monthIndex_();
  return list.length ? list[0].month : null;
}

/** The reviewed bill for a month, read from "<month>.json" in Drive (or null). */
function getBill_(month) {
  var entry = monthIndex_().filter(function (m) { return m.month === month; })[0];
  if (!entry) return null;
  try {
    return JSON.parse(DriveApp.getFileById(entry.fileId).getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    clearIndexCache_(); // file moved or deleted outside the app - rebuild next time
    throw new Error('Could not read ' + month + '.json from Drive. Please retry.');
  }
}

// ------------------------------------------------------------------ reads

function readIndex_(isAdmin) {
  var list = monthIndex_().map(function (m) { return { month: m.month, title: m.title }; });
  return isAdmin ? list : list.slice(0, 1); // residents: latest month only
}

function readMonth_(month, isAdmin) {
  if (!isAdmin && month !== latestMonth_()) return null; // residents: latest month only
  var bill = getBill_(month);
  if (!bill) return null;
  var payments = rows_('Payments').filter(function (r) { return r.month === month; }).map(toPayment_);
  var audit = rows_('Audit').filter(function (r) { return r.month === month; });
  return { bill: bill, payments: payments, audit: audit };
}

/** The original Excel file of a month (residents: latest month only). */
function readSourceFile_(month, isAdmin) {
  if (!isAdmin && month !== latestMonth_()) return null;
  var bill = getBill_(month);
  var id = bill && bill.source && bill.source.driveFileId;
  if (!id) return null;
  var file = DriveApp.getFileById(id);
  if (file.getSize() > 15 * 1024 * 1024) throw new Error('File is too large to download here - open it in Google Drive.');
  var blob = file.getBlob();
  return { name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
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

// ------------------------------------------------------------------ publish

/**
 * Publishes a reviewed month:
 *   1. newest month -> everything currently in Latest/ moves to History/
 *   2. the Excel file is saved as "<month> <name>.xlsx" (Latest/ or, for an older month, History/)
 *   3. the reviewed data is saved next to it as "<month>.json" - residents read this
 *   4. BillLines (analytics) and Audit are updated in the sheet
 */
function publishMonth_(bill, correctionReason, actor, sourceFile, markPaid) {
  if (!bill || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(bill.month)) throw new Error('Invalid month.');
  if (!bill.flats || !bill.flats.length) throw new Error('No flats in bill.');
  var seen = {};
  bill.flats.forEach(function (f) {
    if (!f.flat) throw new Error('Empty flat number.');
    if (seen[f.flat]) throw new Error('Duplicate flat ' + f.flat);
    if (typeof f.total !== 'number' || !isFinite(f.total)) throw new Error('Flat ' + f.flat + ': invalid total.');
    seen[f.flat] = true;
  });
  if (!sourceFile && !(bill.source && bill.source.driveFileId)) throw new Error('The Excel file is missing.');

  var existing = getBill_(bill.month);
  if (existing && (!correctionReason || !String(correctionReason).trim())) {
    throw new Error(bill.month + ' is already published; a correction reason is required.');
  }

  var f = folders_();
  var latest = latestMonth_();
  var isLatest = !latest || bill.month >= latest;
  var target = isLatest ? f.latest : f.history;

  // Replace the previous data file of this month (the old Excel stays in History as a record).
  trashMonthJson_(f, bill.month);
  var keepId = sourceFile ? null : bill.source.driveFileId;
  if (isLatest) archiveLatest_(f, keepId);

  var excel = storeExcel_(f, target, bill.month, sourceFile, keepId);
  bill.source = bill.source || {};
  bill.source.driveFileId = excel.getId();
  bill.source.driveFileName = excel.getName();
  bill.version = existing ? Number(existing.version || 1) + 1 : 1;
  bill.publishedAt = new Date().toISOString();
  bill.publishedBy = actor;

  var json = target.createFile(Utilities.newBlob(JSON.stringify(bill), 'application/json', bill.month + '.json'));
  json.setDescription(String(bill.title || bill.month).slice(0, 200));
  clearIndexCache_();

  deleteRowsWhere_(sheet_('BillLines'), 0, bill.month);
  writeBillLines_(bill);
  var markedPaid = markPaidFromSheet_(bill, markPaid || [], actor);
  audit_(actor, existing ? 'correct-month' : 'publish', bill.month,
    (existing ? 'v' + bill.version + ': ' + correctionReason + ' - ' : '') +
    bill.flats.length + ' flats from ' + excel.getName() + ' (' + (isLatest ? 'Latest' : 'History') + ')');
  return { version: bill.version, folder: isLatest ? 'Latest' : 'History', excelFile: excel.getName(), markedPaid: markedPaid };
}

/**
 * Flats marked paid ("P") in the sheet's Status column get one verified payment for
 * their remaining balance (nothing is added if already fully paid).
 */
function markPaidFromSheet_(bill, flats, actor) {
  if (!flats.length) return 0;
  var paid = {};
  rows_('Payments').forEach(function (r) {
    var counted = r.month === bill.month && (r.verified === true || r.verified === 'TRUE') && !(r.voided === true || r.voided === 'TRUE');
    if (counted) paid[String(r.flat)] = (paid[String(r.flat)] || 0) + Number(r.amount);
  });
  var now = new Date().toISOString();
  var rows = [];
  bill.flats.forEach(function (fl) {
    if (flats.indexOf(fl.flat) < 0) return;
    var due = Math.round((fl.total - (paid[fl.flat] || 0)) * 100) / 100;
    if (due <= 1) return;
    rows.push(['p_' + Utilities.getUuid(), "'" + bill.month, "'" + fl.flat, due, "'" + now.slice(0, 10), '', 'Sheet status', 'sheet', true,
      'Status "P" in ' + (bill.source && bill.source.fileName), now, actor, false, '']);
  });
  if (!rows.length) return 0;
  var sh = sheet_('Payments');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  audit_(actor, 'mark-paid-from-sheet', bill.month, rows.length + ' flats marked Paid from the Status column of the sheet');
  return rows.length;
}

/**
 * Deletes a published month so the admin can correct and re-upload it. The month's
 * data file and Excel go to the Drive Trash (restorable for 30 days); payments and the
 * audit trail stay in the sheet and reappear when the month is published again. If the
 * latest month is deleted, the previous month's files move back from History to Latest,
 * so residents always see the newest remaining month.
 */
function deleteMonth_(month, reason, actor) {
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to delete a month.');
  var bill = getBill_(month);
  if (!bill) throw new Error(month + ' is not published.');
  var wasLatest = latestMonth_() === month;
  var f = folders_();
  trashMonthJson_(f, month);
  var excelId = bill.source && bill.source.driveFileId;
  if (excelId) {
    try { DriveApp.getFileById(excelId).setTrashed(true); } catch (e) { /* already gone */ }
  }
  deleteRowsWhere_(sheet_('BillLines'), 0, month);
  clearIndexCache_();
  var latest = latestMonth_();
  if (wasLatest && latest) restoreToLatest_(f, latest);
  audit_(actor, 'delete-month', month, String(reason).slice(0, 300) + (latest ? ' - residents now see ' + latest : ''));
  return { latest: latest };
}

/** Moves a month's data file and its Excel from History back to Latest. */
function restoreToLatest_(f, month) {
  var bill = getBill_(month);
  var it = f.history.getFilesByName(month + '.json');
  while (it.hasNext()) it.next().moveTo(f.latest);
  var excelId = bill && bill.source && bill.source.driveFileId;
  if (excelId) {
    try { DriveApp.getFileById(excelId).moveTo(f.latest); } catch (e) { /* missing */ }
  }
  clearIndexCache_();
}

function storeExcel_(f, target, month, sourceFile, driveFileId) {
  var prefix = month + ' ';
  if (sourceFile && sourceFile.base64) {
    var bytes = Utilities.base64Decode(sourceFile.base64);
    if (bytes.length > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB.');
    var name = String(sourceFile.name || 'maintenance.xlsx').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    if (!/\.(xlsx|xls|csv)$/i.test(name)) throw new Error('Only Excel files can be published.');
    return target.createFile(Utilities.newBlob(bytes, sourceFile.mimeType || 'application/octet-stream', prefix + name));
  }
  var file = DriveApp.getFileById(driveFileId);
  if (!inOurFolders_(file, f)) throw new Error('The selected Drive file is not inside the NR Maintenance folder.');
  if (file.getName().indexOf(prefix) !== 0) file.setName(prefix + file.getName());
  file.moveTo(target);
  return file;
}

function trashMonthJson_(f, month) {
  [f.latest, f.history].forEach(function (folder) {
    var it = folder.getFilesByName(month + '.json');
    while (it.hasNext()) it.next().setTrashed(true);
  });
}

function archiveLatest_(f, keepId) {
  var it = f.latest.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (file.getId() !== keepId) file.moveTo(f.history);
  }
}

/** Long-format copy of every line item, handy for pivot tables / Looker Studio. */
function writeBillLines_(bill) {
  var cols = (bill.columns || []).filter(function (c) { return c.role !== 'ignore' && c.role !== 'flat'; });
  var lines = [];
  bill.flats.forEach(function (fl) {
    cols.forEach(function (c) {
      var v = fl.values ? fl.values[c.key] : null;
      lines.push(["'" + bill.month, "'" + fl.flat, c.key, c.label, c.role, v === undefined || v === null ? '' : v, fl.total]);
    });
  });
  if (!lines.length) return;
  var sh = sheet_('BillLines');
  sh.getRange(sh.getLastRow() + 1, 1, lines.length, lines[0].length).setValues(lines);
}

// ------------------------------------------------------------------ payments

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
  var bill = getBill_(p.month);
  var hasFlat = bill && bill.flats.some(function (fl) { return String(fl.flat) === String(p.flat); });
  if (!hasFlat) throw new Error('No bill for flat ' + p.flat + ' in ' + p.month + '.');
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

// ------------------------------------------------------------------ Drive folders & picker

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

function isExcel_(file) {
  return /spreadsheet|excel|csv/i.test(file.getMimeType()) || /\.(xlsx|xls|csv)$/i.test(file.getName());
}

/** Excel files the admin can pick from: the NR Maintenance folder itself and Latest/. */
function listDriveFiles_() {
  var f = folders_();
  var out = [];
  [[f.root, 'NR Maintenance'], [f.latest, 'Latest']].forEach(function (pair) {
    var it = pair[0].getFiles();
    while (it.hasNext()) {
      var file = it.next();
      if (isExcel_(file)) {
        out.push({ id: file.getId(), name: pair[1] + ' / ' + file.getName(), mimeType: file.getMimeType(), modifiedTime: file.getLastUpdated().toISOString() });
      }
    }
  });
  return out.sort(function (a, b) { return a.modifiedTime < b.modifiedTime ? 1 : -1; });
}

function getDriveFile_(id) {
  var f = folders_();
  var file = DriveApp.getFileById(id);
  if (!inOurFolders_(file, f)) throw new Error('File is not in the NR Maintenance folder.');
  if (!isExcel_(file)) throw new Error('Only Excel files can be imported.');
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
  clearIndexCache_();
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
