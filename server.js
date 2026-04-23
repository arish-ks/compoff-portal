require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const Database   = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const https      = require('https');
const { google } = require('googleapis');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO   = 'arish-ks/compoff-portal';
const DB_FILE_PATH  = 'data/db.json';
const DB_BRANCH     = 'db-backup';   // separate branch — never triggers Render auto-deploy
const SHEET_ID      = '1G-Y9JHGhxSqV2-hhp6bixVBASvNU_s99f1OYYzSbPgM';
const RENDER_API_KEY = process.env.RENDER_API_KEY || 'rnd_FE8kdkEpWqPk2WnuUhiTW9Us0IFb';
const RENDER_SVC_ID  = 'srv-d7k3q2d7vvec7393pjr0';

// ── Google OAuth2 client ──────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth/callback`
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// ── GitHub API helper ─────────────────────────────────────────────────────────
function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: endpoint, method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'compoff-portal',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── GitHub DB backup/restore ──────────────────────────────────────────────────
let _dbFileSha = null;
let _backupInProgress = false;

async function fetchDbFromGitHub() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}?ref=${DB_BRANCH}`);
      if (!res.sha) { console.warn('fetchDb: no sha on attempt', attempt); continue; }
      const content = Buffer.from(res.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return { sha: res.sha, data: JSON.parse(content) };
    } catch (e) {
      console.error(`fetchDb attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

async function backupToGitHub() {
  if (!GITHUB_TOKEN || _backupInProgress) return;
  _backupInProgress = true;
  try {
    const all = db.prepare('SELECT * FROM requests ORDER BY created_at ASC').all();
    const content = Buffer.from(JSON.stringify({ requests: all }, null, 2)).toString('base64');
    // Always fetch fresh SHA before writing to avoid conflicts
    if (!_dbFileSha) {
      const cur = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}?ref=${DB_BRANCH}`);
      if (cur.sha) _dbFileSha = cur.sha;
    }
    const body = {
      message: `db: backup ${new Date().toISOString()}`,
      content,
      branch: DB_BRANCH,
      ...(_dbFileSha ? { sha: _dbFileSha } : {}),
    };
    const res = await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}`, body);
    if (res.content?.sha) {
      _dbFileSha = res.content.sha;
      console.log('✅ DB backed up to GitHub');
    } else if (res.message) {
      // SHA conflict — refresh and retry once
      console.warn('Backup SHA conflict, retrying...');
      _dbFileSha = null;
      const cur2 = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}?ref=${DB_BRANCH}`);
      if (cur2.sha) {
        const body2 = { message: `db: backup-retry ${new Date().toISOString()}`, content, branch: DB_BRANCH, sha: cur2.sha };
        const res2 = await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}`, body2);
        if (res2.content?.sha) { _dbFileSha = res2.content.sha; console.log('✅ DB backed up (retry)'); }
      }
    }
  } catch (e) { console.error('GitHub backup error:', e.message); }
  finally { _backupInProgress = false; }
}

// ── Render env var updater (to persist refresh token) ────────────────────────
async function saveRefreshTokenToRender(token) {
  try {
    // Get current env vars first
    const getRes = await renderRequest('GET', `/services/${RENDER_SVC_ID}/env-vars`);
    const existing = (getRes || []).map(e => e.envVar).filter(Boolean);
    // Upsert GOOGLE_REFRESH_TOKEN
    const updated = existing.filter(e => e.key !== 'GOOGLE_REFRESH_TOKEN');
    updated.push({ key: 'GOOGLE_REFRESH_TOKEN', value: token });
    await renderRequest('PUT', `/services/${RENDER_SVC_ID}/env-vars`, updated);
  } catch (e) { console.error('Render env save error:', e.message); }
}

function renderRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.render.com',
      path: `/v1${endpoint}`, method,
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('compoff.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id            TEXT PRIMARY KEY,
    employee      TEXT NOT NULL,
    worked_dates  TEXT NOT NULL,
    request_type  TEXT NOT NULL DEFAULT 'take_leave',
    compoff_dates TEXT,
    reason        TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec(`ALTER TABLE requests ADD COLUMN compoff_dates TEXT`); } catch (_) {}
try {
  const rows = db.prepare(`SELECT id, compoff_date FROM requests WHERE compoff_dates IS NULL AND compoff_date IS NOT NULL`).all();
  for (const r of rows)
    db.prepare(`UPDATE requests SET compoff_dates = ? WHERE id = ?`).run(JSON.stringify([r.compoff_date]), r.id);
} catch (_) {}
db.prepare(`UPDATE requests SET status = 'approved' WHERE status = 'approve'`).run();
db.prepare(`UPDATE requests SET status = 'rejected' WHERE status = 'reject'`).run();

// ── Restore from GitHub on startup ───────────────────────────────────────────
async function restoreFromGitHub() {
  console.log('🔄 Restoring DB from GitHub backup branch...');
  const result = await fetchDbFromGitHub();
  if (!result) {
    console.warn('⚠️  No GitHub backup found — starting with empty DB.');
    return;
  }
  _dbFileSha = result.sha;
  const { requests } = result.data;
  if (!requests?.length) {
    console.log('ℹ️  Backup is empty — no records to restore.');
    return;
  }
  const insert = db.prepare(`
    INSERT OR REPLACE INTO requests (id, employee, worked_dates, request_type, compoff_dates, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction(rows => {
    for (const r of rows)
      insert.run(r.id, r.employee, r.worked_dates, r.request_type, r.compoff_dates, r.reason, r.status, r.created_at);
  });
  insertMany(requests);
  console.log(`✅ Restored ${requests.length} records from GitHub (branch: ${DB_BRANCH}).`);
}

// ── Mailer ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDates(json) {
  try { return JSON.parse(json) || []; } catch { return []; }
}
function formatDates(datesJson) {
  return parseDates(datesJson).map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }).join(', ');
}
function formatSingle(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  return dt.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
function formatDateShort(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Balance helper ────────────────────────────────────────────────────────────
function getBalance(employee) {
  const all = db.prepare(`SELECT * FROM requests WHERE employee = ? AND status = 'approved'`).all(employee);
  const earned = all.reduce((s, r) => s + parseDates(r.worked_dates).length, 0);
  const used = all
    .filter(r => r.request_type === 'take_leave' || r.request_type === 'use_balance')
    .reduce((s, r) => s + parseDates(r.compoff_dates).length, 0);
  return { earned, used, remaining: earned - used };
}

// ── Google Sheets ─────────────────────────────────────────────────────────────
const SUMMARY_TAB = '📋 Leave Tracker';

// Color palette
const C = {
  purple:      { red: 0.404, green: 0.353, blue: 0.976 },   // #675AF9
  purpleDark:  { red: 0.227, green: 0.196, blue: 0.698 },   // #3A32B2
  purpleLight: { red: 0.933, green: 0.922, blue: 1.000 },   // #EEEBff
  navy:        { red: 0.000, green: 0.000, blue: 0.165 },   // #00002A
  white:       { red: 1.000, green: 1.000, blue: 1.000 },
  offWhite:    { red: 0.976, green: 0.976, blue: 0.988 },   // #F9F9FC
  accent:      { red: 0.659, green: 0.612, blue: 1.000 },   // #A89CFF
  mintLight:   { red: 0.878, green: 0.973, blue: 0.941 },   // #E0F8F0
  orangeLight: { red: 1.000, green: 0.945, blue: 0.851 },   // #FFF1D9
  borderGray:  { red: 0.878, green: 0.878, blue: 0.910 },   // #E0E0E8
  textDark:    { red: 0.133, green: 0.133, blue: 0.180 },   // #22222E
  textMid:     { red: 0.400, green: 0.400, blue: 0.467 },   // #666677
};

const BORDER_STYLE = {
  style: 'SOLID',
  width: 1,
  color: C.borderGray,
};
const THIN_BORDER = {
  top: BORDER_STYLE, bottom: BORDER_STYLE,
  left: BORDER_STYLE, right: BORDER_STYLE,
};

function cellFmt(bg, fg, bold = false, fontSize = 10, align = 'LEFT', wrap = true) {
  return {
    userEnteredFormat: {
      backgroundColor: bg,
      textFormat: { foregroundColor: fg, bold, fontSize, fontFamily: 'Arial' },
      horizontalAlignment: align,
      verticalAlignment: 'MIDDLE',
      wrapStrategy: wrap ? 'WRAP' : 'CLIP',
      borders: THIN_BORDER,
      padding: { top: 6, bottom: 6, left: 10, right: 10 },
    },
  };
}

async function getSheetId(tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.find(s => s.properties.title === tabName)?.properties.sheetId ?? null;
}

async function initSummaryTab() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === SUMMARY_TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SUMMARY_TAB, index: 0 } } }] },
    });
  }

  const sheetId = await getSheetId(SUMMARY_TAB);

  // Write title + headers
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        {
          range: `'${SUMMARY_TAB}'!A1:G1`,
          values: [['DPDzero — Comp-Off Leave Tracker', '', '', '', '', '', '']],
        },
        {
          range: `'${SUMMARY_TAB}'!A2:G2`,
          values: [['Employee', 'Leave Type', 'Leave Date(s)', 'Days Taken', 'Reason', 'Approved On', 'Balance Left']],
        },
      ],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Merge title row
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: 'MERGE_ALL' } },
        // Title row format
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
            cell: {
              userEnteredFormat: {
                backgroundColor: C.purple,
                textFormat: { foregroundColor: C.white, bold: true, fontSize: 14, fontFamily: 'Arial' },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
                padding: { top: 14, bottom: 14, left: 10, right: 10 },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)',
          },
        },
        // Header row format
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 7 },
            cell: {
              userEnteredFormat: {
                backgroundColor: C.purpleDark,
                textFormat: { foregroundColor: C.white, bold: true, fontSize: 11, fontFamily: 'Arial' },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
                borders: THIN_BORDER,
                padding: { top: 8, bottom: 8, left: 10, right: 10 },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,borders,padding)',
          },
        },
        // Freeze 2 rows
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: 'gridProperties.frozenRowCount' } },
        // Column widths: Employee, Type, Dates, Days, Reason, Approved, Balance
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 90 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
        // Row heights
        { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 50 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 36 }, fields: 'pixelSize' } },
      ],
    },
  });
}

async function initEmployeeTab(tabName, employeeName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }

  const sheetId = await getSheetId(tabName);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        {
          range: `'${tabName}'!A1:F1`,
          values: [[`Comp-Off Leave History — ${employeeName}`, '', '', '', '', '']],
        },
        {
          range: `'${tabName}'!A2:F2`,
          values: [['Leave Type', 'Leave Date(s)', 'Days Taken', 'Reason', 'Approved On', 'Balance Left']],
        },
      ],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 }, mergeType: 'MERGE_ALL' } },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                backgroundColor: C.navy,
                textFormat: { foregroundColor: C.accent, bold: true, fontSize: 14, fontFamily: 'Arial' },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
                padding: { top: 14, bottom: 14, left: 10, right: 10 },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)',
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                backgroundColor: C.purple,
                textFormat: { foregroundColor: C.white, bold: true, fontSize: 11, fontFamily: 'Arial' },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
                borders: THIN_BORDER,
                padding: { top: 8, bottom: 8, left: 10, right: 10 },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,borders,padding)',
          },
        },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: 'gridProperties.frozenRowCount' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 90 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 50 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 36 }, fields: 'pixelSize' } },
      ],
    },
  });
}

async function appendLeaveRow(tabName, rowValues, isSummary, rowBg) {
  // Append values
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A3`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });

  const sheetId = await getSheetId(tabName);
  const colCount = rowValues.length;
  const allVals = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tabName}'!A:A` });
  const lastRow = (allVals.data.values || []).length;
  const isEven  = (lastRow - 2) % 2 === 0; // alternating from row 3
  const altBg   = isEven ? C.offWhite : C.white;
  const finalBg = rowBg || altBg;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Background + text format for whole row
        {
          repeatCell: {
            range: { sheetId, startRowIndex: lastRow - 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: colCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: finalBg,
                textFormat: { foregroundColor: C.textDark, fontSize: 10, fontFamily: 'Arial' },
                verticalAlignment: 'MIDDLE',
                wrapStrategy: 'WRAP',
                borders: THIN_BORDER,
                padding: { top: 6, bottom: 6, left: 10, right: 10 },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy,borders,padding)',
          },
        },
        // Bold employee/type in col A
        {
          repeatCell: {
            range: { sheetId, startRowIndex: lastRow - 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 10, fontFamily: 'Arial', foregroundColor: C.textDark } } },
            fields: 'userEnteredFormat.textFormat',
          },
        },
        // Days col center-aligned + bold
        {
          repeatCell: {
            range: { sheetId, startRowIndex: lastRow - 1, endRowIndex: lastRow, startColumnIndex: isSummary ? 3 : 2, endColumnIndex: isSummary ? 4 : 3 },
            cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true, fontSize: 11, foregroundColor: C.purple, fontFamily: 'Arial' } } },
            fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
          },
        },
        // Balance col center-aligned
        {
          repeatCell: {
            range: { sheetId, startRowIndex: lastRow - 1, endRowIndex: lastRow, startColumnIndex: colCount - 1, endColumnIndex: colCount },
            cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true, fontSize: 10, fontFamily: 'Arial', foregroundColor: C.purpleDark } } },
            fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
          },
        },
        // Row height
        { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: lastRow - 1, endIndex: lastRow }, properties: { pixelSize: 44 }, fields: 'pixelSize' } },
      ],
    },
  });
}

async function pushToSheet(data) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return;
  // Only leaves go to the sheet
  if (data.type === 'Accumulate Credit') return;

  try {
    const leaveDates = (data.leaveDates || []).map(d => formatDateShort(d)).join('\n') || '—';
    const days       = data.leaveDates?.length || 0;
    const rowBg      = data.type === 'Use Banked Leave' ? C.mintLight : C.purpleLight;

    // ── Summary tab ──
    await initSummaryTab();
    await appendLeaveRow(SUMMARY_TAB,
      [data.employee, data.type, leaveDates, days, data.reason, data.approvedOn, `${data.balance} day(s)`],
      true, rowBg
    );

    // ── Per-employee tab ──
    const empTab = `👤 ${data.employee}`;
    await initEmployeeTab(empTab, data.employee);
    await appendLeaveRow(empTab,
      [data.type, leaveDates, days, data.reason, data.approvedOn, `${data.balance} day(s)`],
      false, rowBg
    );

    console.log(`✅ Sheet updated for ${data.employee}`);
  } catch (e) { console.error('Sheets error:', e.message); }
}

// ── OAuth2 routes ─────────────────────────────────────────────────────────────
app.get('/setup-sheets', (req, res) => {
  const isConnected = !!process.env.GOOGLE_REFRESH_TOKEN;
  res.send(`<!DOCTYPE html>
  <html><head><meta charset="UTF-8"><title>Connect Google Sheets — DPDzero</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:#00002A;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 30% 30%,rgba(103,90,249,0.3) 0%,transparent 60%);pointer-events:none}
    .card{position:relative;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:480px;width:100%;text-align:center;backdrop-filter:blur(20px);box-shadow:0 32px 80px rgba(0,0,0,0.4)}
    .logo{margin-bottom:32px;font-family:'Red Hat Display',sans-serif;font-size:12px;color:rgba(255,255,255,0.3);letter-spacing:1px;text-transform:uppercase}
    .icon{font-size:48px;margin-bottom:20px}
    h1{font-family:'Red Hat Display',sans-serif;font-size:1.6rem;font-weight:900;color:#FBFBFF;margin-bottom:12px}
    p{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.7;margin-bottom:28px}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:24px}
    .badge.on{background:rgba(8,202,151,0.15);color:#6BDFC1;border:1px solid rgba(8,202,151,0.3)}
    .badge.off{background:rgba(255,180,50,0.12);color:#FFCC55;border:1px solid rgba(255,180,50,0.3)}
    .btn{display:inline-flex;align-items:center;gap:10px;padding:14px 28px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:600;transition:all 0.2s;background:linear-gradient(135deg,#675AF9,#4A3FD4);color:#fff;box-shadow:0 4px 20px rgba(103,90,249,0.35)}
    .btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(103,90,249,0.5)}
    .btn-back{display:inline-flex;align-items:center;gap:6px;margin-top:20px;padding:10px 20px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:500;color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)}
  </style></head>
  <body><div class="card">
    <div class="logo">DPDzero · Comp-Off Portal</div>
    <div class="icon">📊</div>
    <h1>Google Sheets Sync</h1>
    ${isConnected
      ? `<div class="badge on">✅ Connected &amp; Active</div>
         <p>Leave data is automatically synced to Google Sheets on every approval. Each employee gets their own tab plus a combined summary.</p>
         <a href="${oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/spreadsheets'], prompt: 'consent' })}" class="btn">🔄 Re-authorise</a>`
      : `<div class="badge off">⚠️ Not Connected</div>
         <p>Click below to connect Google Sheets. You'll be asked to sign in with your Google account — this is a one-time step.</p>
         <a href="${oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/spreadsheets'], prompt: 'consent' })}" class="btn">🔗 Connect Google Sheets</a>`
    }
    <br><a class="btn-back" href="/">← Back to Portal</a>
  </div></body></html>`);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(page('Auth Failed', `Google returned: ${error}`, '#f44336'));
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    // Save to Render so it survives redeploys
    await saveRefreshTokenToRender(tokens.refresh_token);
    res.send(page('Sheets Connected!',
      'Google Sheets is now connected. Every approved leave will automatically appear in your sheet — no action needed again.',
      '#4caf50'));
  } catch (e) {
    res.send(page('Auth Failed', `Error: ${e.message}`, '#f44336'));
  }
});

// ── Dashboard API ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/:employee', (req, res) => {
  const employee = req.params.employee;
  const all = db.prepare(`SELECT * FROM requests WHERE employee = ? ORDER BY created_at DESC`).all(employee);
  const bal = getBalance(employee);
  const pendingCount = all.filter(r => r.status === 'pending').length;
  const history = all.map(r => {
    const workedDates  = parseDates(r.worked_dates);
    const compoffDates = parseDates(r.compoff_dates);
    return {
      id: r.id, type: r.request_type, status: r.status,
      workedDates, workedDatesFormatted: formatDates(r.worked_dates), daysWorked: workedDates.length,
      compoffDates, compoffDatesFormatted: compoffDates.map(d => formatDateShort(d)).join(', '),
      leaveDaysTaken: compoffDates.length, reason: r.reason,
      createdAt: new Date(r.created_at + 'Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    };
  });
  res.json({ employee, ...bal, pendingCount, history });
});

// ── Balance check API ─────────────────────────────────────────────────────────
app.get('/api/balance/:employee', (req, res) => {
  res.json(getBalance(req.params.employee));
});

// ── Submit ────────────────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { employeeName, workedDates, requestType, compoffDates, reason } = req.body;

  if (!employeeName || !requestType || !reason)
    return res.status(400).json({ error: 'All fields are required.' });
  if (requestType !== 'use_balance' && !workedDates?.length)
    return res.status(400).json({ error: 'Please select at least one weekend day worked.' });
  if ((requestType === 'take_leave' || requestType === 'use_balance') && !compoffDates?.length)
    return res.status(400).json({ error: 'Please select at least one leave date.' });
  if (requestType === 'take_leave' && compoffDates.length > workedDates.length)
    return res.status(400).json({ error: `You selected ${workedDates.length} weekend day${workedDates.length !== 1 ? 's' : ''} worked but requested ${compoffDates.length} leave day${compoffDates.length !== 1 ? 's' : ''}. You can only take up to ${workedDates.length}.` });
  if (requestType === 'use_balance') {
    const bal = getBalance(employeeName);
    if (compoffDates.length > bal.remaining)
      return res.status(400).json({ error: `You only have ${bal.remaining} banked day${bal.remaining !== 1 ? 's' : ''} available. You requested ${compoffDates.length}.` });
  }

  const id = uuidv4();
  db.prepare(`INSERT INTO requests (id, employee, worked_dates, request_type, compoff_dates, reason) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, employeeName, JSON.stringify(workedDates || []), requestType,
         (requestType === 'take_leave' || requestType === 'use_balance') ? JSON.stringify(compoffDates) : null, reason);

  await backupToGitHub(); // await so data is safe before responding

  const workedFormatted  = workedDates?.length ? formatDates(JSON.stringify(workedDates)) : '—';
  const isLeave          = requestType === 'take_leave' || requestType === 'use_balance';
  const isUseBalance     = requestType === 'use_balance';
  const leaveDaysCount   = isLeave ? compoffDates.length : 0;
  const compoffFormatted = isLeave ? compoffDates.map(d => formatSingle(d)).join('<br>') : null;
  const compoffShort     = isLeave ? compoffDates.map(d => formatDateShort(d)).join(', ') : null;

  const approveUrl = `${BASE_URL}/api/action?id=${id}&action=approve`;
  const rejectUrl  = `${BASE_URL}/api/action?id=${id}&action=reject`;

  const typeLabel = isUseBalance
    ? `<span style="display:inline-block;padding:3px 10px;background:#fff8e1;color:#f57f17;border-radius:20px;font-size:12px;font-weight:600">💳 Use Banked Leave (${leaveDaysCount} day${leaveDaysCount > 1 ? 's' : ''})</span>`
    : isLeave
      ? `<span style="display:inline-block;padding:3px 10px;background:#e8f5e9;color:#2e7d32;border-radius:20px;font-size:12px;font-weight:600">🏖️ Leave Request (${leaveDaysCount} day${leaveDaysCount > 1 ? 's' : ''})</span>`
      : `<span style="display:inline-block;padding:3px 10px;background:#e3f2fd;color:#1565c0;border-radius:20px;font-size:12px;font-weight:600">🏦 Accumulate Credit (+${workedDates.length} day${workedDates.length > 1 ? 's' : ''})</span>`;

  const dateRow = isUseBalance
    ? `<tr><td style="padding:8px 0;color:#555;width:40%;vertical-align:top"><strong>Leave Date(s)</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
       <tr><td style="padding:8px 0;color:#555"><strong>Days Requested</strong></td><td style="color:#c62828"><strong>−${leaveDaysCount} day${leaveDaysCount > 1 ? 's' : ''} from banked balance</strong></td></tr>`
    : isLeave
      ? `<tr><td style="padding:8px 0;color:#555;width:40%;vertical-align:top"><strong>Leave Date(s)</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
         <tr><td style="padding:8px 0;color:#555"><strong>Days Requested</strong></td><td style="color:#c62828"><strong>−${leaveDaysCount} comp-off day${leaveDaysCount > 1 ? 's' : ''} will be deducted</strong></td></tr>`
      : `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Days to Credit</strong></td><td style="color:#1565c0"><strong>+${workedDates.length} comp-off day${workedDates.length > 1 ? 's' : ''} to be banked</strong></td></tr>`;

  const weekendRow = isUseBalance ? ''
    : `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Weekend(s) Worked</strong></td><td style="color:#222">${workedFormatted}</td></tr>`;

  const actionButtons = isLeave
    ? `<div style="margin-top:30px">
         <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:#4caf50;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px">✅ Approve Leave</a>
         <a href="${rejectUrl}"  style="display:inline-block;padding:12px 28px;background:#f44336;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">❌ Reject</a>
       </div>`
    : `<div style="margin-top:30px">
         <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:#1976d2;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px">✅ Acknowledge & Bank Credit</a>
         <a href="${rejectUrl}"  style="display:inline-block;padding:12px 28px;background:#f44336;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">❌ Reject</a>
       </div>`;

  const html = `
    <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
        <h2 style="color:#1a1a2e;margin:0">Comp-Off Request</h2>${typeLabel}
      </div>
      <p style="color:#888;font-size:13px;margin-bottom:24px">DPDzero — Data Support Team</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#555;width:40%"><strong>Employee</strong></td><td style="color:#222">${employeeName}</td></tr>
        ${weekendRow}${dateRow}
        <tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>Work Done</strong></td><td style="color:#222">${reason}</td></tr>
      </table>
      ${actionButtons}
      <p style="margin-top:24px;font-size:12px;color:#aaa">Submitted via DPDzero Comp-Off Portal.</p>
    </div>`;

  try {
    await transporter.sendMail({
      from: `"DPDzero Comp-Off Portal" <${process.env.GMAIL_USER}>`,
      to: 'sandeep@dpdzero.com',
      subject: isUseBalance
        ? `💳 Balance Leave (${leaveDaysCount} day${leaveDaysCount > 1 ? 's' : ''}): ${employeeName} — ${compoffShort}`
        : isLeave
          ? `🏖️ Leave Request (${leaveDaysCount} day${leaveDaysCount > 1 ? 's' : ''}): ${employeeName} — ${compoffShort}`
          : `🏦 Credit Request (+${workedDates.length} days): ${employeeName}`,
      html,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Mail error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please contact admin.' });
  }
});

// ── Approve / Reject ──────────────────────────────────────────────────────────
app.get('/api/action', async (req, res) => {
  const { id, action } = req.query;
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

  if (!row) return res.status(404).send(page('Not Found', 'Request not found.', '#f44336'));
  if (row.status !== 'pending') {
    return res.send(page('Already Processed',
      `This request was already <strong>${row.status}</strong>.`,
      row.status === 'approved' ? '#4caf50' : '#f44336'));
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(newStatus, id);
  await backupToGitHub(); // await so status change is persisted before email sends

  const workedFormatted  = formatDates(row.worked_dates);
  const isLeave          = row.request_type === 'take_leave' || row.request_type === 'use_balance';
  const isUseBalance     = row.request_type === 'use_balance';
  const compoffDates     = parseDates(row.compoff_dates);
  const leaveDays        = compoffDates.length;
  const compoffFormatted = compoffDates.map(d => formatSingle(d)).join(', ');
  const daysWorked       = parseDates(row.worked_dates).length;

  if (newStatus === 'approved') {
    const balAfter = getBalance(row.employee);

    // Push to Google Sheet — leaves only (fire-and-forget)
    if (isLeave) {
      pushToSheet({
        employee:   row.employee,
        type:       isUseBalance ? 'Use Banked Leave' : 'Take Leave Now',
        leaveDates: compoffDates,
        reason:     row.reason,
        approvedOn: new Date().toISOString().split('T')[0],
        balance:    balAfter.remaining,
      });
    }

    const impactRow = isLeave
      ? `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Leave Dates</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
         <tr><td style="padding:8px 0;color:#555"><strong>Days Deducted</strong></td><td style="color:#c62828"><strong>−${leaveDays} comp-off day${leaveDays > 1 ? 's' : ''}</strong></td></tr>
         <tr><td style="padding:8px 0;color:#555"><strong>Remaining Balance</strong></td><td style="color:#222"><strong>${balAfter.remaining} day${balAfter.remaining !== 1 ? 's' : ''} left</strong></td></tr>`
      : `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Credits Added</strong></td><td style="color:#2e7d32"><strong>+${daysWorked} day${daysWorked > 1 ? 's' : ''} banked ✓</strong></td></tr>
         <tr><td style="padding:8px 0;color:#555"><strong>Total Balance</strong></td><td style="color:#222"><strong>${balAfter.remaining} day${balAfter.remaining !== 1 ? 's' : ''} available</strong></td></tr>`;

    return res.send(page(
      isLeave ? 'Leave Approved!' : 'Credit Banked!',
      isLeave
        ? `<strong>${leaveDays} comp-off day${leaveDays > 1 ? 's' : ''}</strong> approved for <strong>${row.employee}</strong>. Remaining balance: <strong>${balAfter.remaining} day${balAfter.remaining !== 1 ? 's' : ''}</strong>.`
        : `<strong>+${daysWorked} comp-off day${daysWorked > 1 ? 's' : ''}</strong> added to <strong>${row.employee}</strong>'s balance. New balance: <strong>${balAfter.remaining} day${balAfter.remaining !== 1 ? 's' : ''}</strong>.`,
      '#4caf50'
    ));
  } else {
    return res.send(page('Rejected',
      `Comp-off request for <strong>${row.employee}</strong> has been rejected.`,
      '#f44336'));
  }
});

// ── Branded response page ─────────────────────────────────────────────────────
function page(title, message, color) {
  const isSuccess    = color === '#4caf50';
  const accentBg     = isSuccess ? 'rgba(8,202,151,0.12)'  : 'rgba(249,76,70,0.12)';
  const accentBorder = isSuccess ? 'rgba(8,202,151,0.3)'   : 'rgba(249,76,70,0.3)';
  const emoji        = isSuccess ? '✅' : '❌';
  return `<!DOCTYPE html>
  <html><head><meta charset="UTF-8"><title>${title} — DPDzero</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:#00002A;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 30% 30%,rgba(103,90,249,0.3) 0%,transparent 60%);pointer-events:none}
    .card{position:relative;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:480px;width:100%;text-align:center;backdrop-filter:blur(20px);box-shadow:0 32px 80px rgba(0,0,0,0.4)}
    .icon-wrap{width:72px;height:72px;border-radius:50%;background:${accentBg};border:1px solid ${accentBorder};display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 24px}
    h1{font-family:'Red Hat Display',sans-serif;font-size:1.75rem;font-weight:900;color:#FBFBFF;margin-bottom:12px}
    p{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.7} p strong{color:rgba(255,255,255,0.85)}
    .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:28px}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600;transition:all 0.2s}
    .btn-primary{background:linear-gradient(135deg,#675AF9,#4A3FD4);color:#fff;box-shadow:0 4px 20px rgba(103,90,249,0.3)}
    .btn-secondary{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.1)}
    .btn:hover{transform:translateY(-1px)}
    .logo{margin-bottom:32px;font-family:'Red Hat Display',sans-serif;font-size:12px;color:rgba(255,255,255,0.3);letter-spacing:1px;text-transform:uppercase}
  </style></head>
  <body><div class="card">
    <div class="logo">DPDzero · Comp-Off Portal</div>
    <div class="icon-wrap">${emoji}</div>
    <h1>${title}</h1><p>${message}</p>
    <div class="btns">
      <a class="btn btn-secondary" href="/"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M11 6.5H2M5.5 3L2 6.5L5.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Back to Portal</a>
      <a class="btn btn-primary" href="/dashboard.html"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1.5" y="1.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="7.5" y="1.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="1.5" y="7.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="7.5" y="7.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/></svg>View Dashboard</a>
    </div>
  </div></body></html>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
restoreFromGitHub().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
