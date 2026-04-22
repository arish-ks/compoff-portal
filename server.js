require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('compoff.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id          TEXT PRIMARY KEY,
    employee    TEXT NOT NULL,
    worked_dates TEXT NOT NULL,
    compoff_date TEXT NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Mailer ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDates(datesJson) {
  const arr = JSON.parse(datesJson);
  return arr.map(d => {
    const dt = new Date(d);
    return dt.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }).join(', ');
}

function formatSingle(dateStr) {
  const dt = new Date(dateStr);
  return dt.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Submit comp-off request
app.post('/api/submit', async (req, res) => {
  const { employeeName, workedDates, compoffDate, reason } = req.body;

  if (!employeeName || !workedDates?.length || !compoffDate || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO requests (id, employee, worked_dates, compoff_date, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, employeeName, JSON.stringify(workedDates), compoffDate, reason);

  const approveUrl = `${BASE_URL}/api/action?id=${id}&action=approve`;
  const rejectUrl  = `${BASE_URL}/api/action?id=${id}&action=reject`;

  const workedFormatted  = formatDates(JSON.stringify(workedDates));
  const compoffFormatted = formatSingle(compoffDate);

  const html = `
    <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px">
      <h2 style="color:#1a1a2e;margin-bottom:4px">Comp-Off Request</h2>
      <p style="color:#888;font-size:13px;margin-bottom:24px">DPDzero — Data Support Team</p>

      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#555;width:40%"><strong>Employee</strong></td><td style="color:#222">${employeeName}</td></tr>
        <tr><td style="padding:8px 0;color:#555"><strong>Weekend(s) Worked</strong></td><td style="color:#222">${workedFormatted}</td></tr>
        <tr><td style="padding:8px 0;color:#555"><strong>Comp-Off Requested On</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
        <tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>Reason</strong></td><td style="color:#222">${reason}</td></tr>
      </table>

      <div style="margin-top:30px;display:flex;gap:12px">
        <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:#4caf50;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px">
          ✅ Approve
        </a>
        <a href="${rejectUrl}" style="display:inline-block;padding:12px 28px;background:#f44336;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">
          ❌ Reject
        </a>
      </div>

      <p style="margin-top:24px;font-size:12px;color:#aaa">This request was submitted via the DPDzero Comp-Off Portal.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"DPDzero Comp-Off Portal" <${process.env.GMAIL_USER}>`,
      to: 'arish@dpdzero.com',
      subject: `Comp-Off Request from ${employeeName} — ${compoffFormatted}`,
      html,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Mail error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please contact admin.' });
  }
});

// Approve / Reject action (Sandeep clicks link in email)
app.get('/api/action', async (req, res) => {
  const { id, action } = req.query;

  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!row) return res.status(404).send(page('Not Found', 'Request not found or already processed.', '#f44336'));

  if (row.status !== 'pending') {
    return res.send(page(
      'Already Processed',
      `This request was already <strong>${row.status}</strong>.`,
      row.status === 'approved' ? '#4caf50' : '#f44336'
    ));
  }

  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(action, id);

  const workedFormatted  = formatDates(row.worked_dates);
  const compoffFormatted = formatSingle(row.compoff_date);

  if (action === 'approve') {
    // Send confirmation to HR
    const hrHtml = `
      <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="color:#2e7d32;margin-bottom:4px">✅ Comp-Off Approved</h2>
        <p style="color:#888;font-size:13px;margin-bottom:24px">DPDzero — Data Support Team</p>

        <p style="font-size:14px;color:#333;margin-bottom:20px">
          The following comp-off request has been <strong style="color:#2e7d32">approved by Sandeep</strong>.
        </p>

        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#555;width:40%"><strong>Employee</strong></td><td style="color:#222">${row.employee}</td></tr>
          <tr><td style="padding:8px 0;color:#555"><strong>Weekend(s) Worked</strong></td><td style="color:#222">${workedFormatted}</td></tr>
          <tr><td style="padding:8px 0;color:#555"><strong>Comp-Off Date</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
          <tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>Reason</strong></td><td style="color:#222">${row.reason}</td></tr>
          <tr><td style="padding:8px 0;color:#555"><strong>Approved By</strong></td><td style="color:#222">Sandeep</td></tr>
        </table>

        <p style="margin-top:24px;font-size:12px;color:#aaa">Please update the attendance system accordingly.</p>
      </div>
    `;

    try {
      await transporter.sendMail({
        from: `"DPDzero Comp-Off Portal" <${process.env.GMAIL_USER}>`,
        to: 'arish@dpdzero.com',
        subject: `Comp-Off Approved: ${row.employee} — ${compoffFormatted}`,
        html: hrHtml,
      });
    } catch (err) {
      console.error('HR mail error:', err.message);
    }

    return res.send(page(
      'Approved!',
      `Comp-off for <strong>${row.employee}</strong> on <strong>${compoffFormatted}</strong> has been approved. HR team has been notified.`,
      '#4caf50'
    ));
  } else {
    return res.send(page(
      'Rejected',
      `Comp-off request for <strong>${row.employee}</strong> has been rejected.`,
      '#f44336'
    ));
  }
});

// Simple response page
function page(title, message, color) {
  return `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Segoe UI,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{background:#fff;padding:40px 36px;border-radius:16px;max-width:460px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12)}
    .icon{font-size:48px;margin-bottom:16px}
    h1{color:${color};font-size:22px;margin-bottom:10px}
    p{color:#555;font-size:15px;line-height:1.6}
    a{display:inline-block;margin-top:24px;padding:10px 24px;background:${color};color:#fff;border-radius:8px;text-decoration:none;font-size:14px}
  </style></head>
  <body>
    <div class="box">
      <div class="icon">${color === '#4caf50' ? '✅' : '❌'}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <a href="/">Back to Portal</a>
    </div>
  </body></html>`;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
