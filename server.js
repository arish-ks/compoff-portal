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
    id           TEXT PRIMARY KEY,
    employee     TEXT NOT NULL,
    worked_dates TEXT NOT NULL,
    request_type TEXT NOT NULL DEFAULT 'take_leave',
    compoff_date TEXT,
    reason       TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
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
    return dt.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }).join(', ');
}

function formatSingle(dateStr) {
  const dt = new Date(dateStr);
  return dt.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function formatDateShort(dateStr) {
  const dt = new Date(dateStr);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Dashboard API ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/:employee', (req, res) => {
  const employee = req.params.employee;

  const all = db.prepare(`
    SELECT * FROM requests WHERE employee = ? ORDER BY created_at DESC
  `).all(employee);

  // Credits earned = sum of worked days from approved accumulate requests
  const approvedCredits = all.filter(r => r.request_type === 'accumulate' && r.status === 'approved');
  const totalCreditsEarned = approvedCredits.reduce((sum, r) => {
    return sum + JSON.parse(r.worked_dates).length;
  }, 0);

  // Leaves taken = count of approved take_leave requests
  const approvedLeaves = all.filter(r => r.request_type === 'take_leave' && r.status === 'approved');
  const totalLeavesTaken = approvedLeaves.length;

  // Remaining balance
  const remaining = totalCreditsEarned - totalLeavesTaken;

  // Pending requests
  const pendingCount = all.filter(r => r.status === 'pending').length;

  // Format history for frontend
  const history = all.map(r => {
    const workedDates = JSON.parse(r.worked_dates);
    return {
      id: r.id,
      type: r.request_type,
      status: r.status,
      workedDates: workedDates,
      workedDatesFormatted: formatDates(r.worked_dates),
      daysWorked: workedDates.length,
      compoffDate: r.compoff_date ? formatDateShort(r.compoff_date) : null,
      reason: r.reason,
      createdAt: new Date(r.created_at).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      }),
    };
  });

  res.json({
    employee,
    totalCreditsEarned,
    totalLeavesTaken,
    remaining,
    pendingCount,
    history,
  });
});

// ── Submit comp-off request ───────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { employeeName, workedDates, requestType, compoffDate, reason } = req.body;

  if (!employeeName || !workedDates?.length || !requestType || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (requestType === 'take_leave' && !compoffDate) {
    return res.status(400).json({ error: 'Please select a comp-off date.' });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO requests (id, employee, worked_dates, request_type, compoff_date, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, employeeName, JSON.stringify(workedDates), requestType, compoffDate || null, reason);

  const workedFormatted  = formatDates(JSON.stringify(workedDates));
  const isLeave          = requestType === 'take_leave';
  const compoffFormatted = isLeave ? formatSingle(compoffDate) : null;

  const approveUrl = `${BASE_URL}/api/action?id=${id}&action=approve`;
  const rejectUrl  = `${BASE_URL}/api/action?id=${id}&action=reject`;

  const typeLabel = isLeave
    ? `<span style="display:inline-block;padding:3px 10px;background:#e8f5e9;color:#2e7d32;border-radius:20px;font-size:12px;font-weight:600">🏖️ Leave Request</span>`
    : `<span style="display:inline-block;padding:3px 10px;background:#e3f2fd;color:#1565c0;border-radius:20px;font-size:12px;font-weight:600">🏦 Accumulate Credit</span>`;

  const dateRow = isLeave
    ? `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Comp-Off Leave Date</strong></td><td style="color:#222">${compoffFormatted}</td></tr>`
    : `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Days to Credit</strong></td><td style="color:#1565c0"><strong>+${workedDates.length} comp-off day${workedDates.length > 1 ? 's' : ''} to be banked</strong></td></tr>`;

  const actionButtons = isLeave ? `
      <div style="margin-top:30px">
        <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:#4caf50;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px">✅ Approve Leave</a>
        <a href="${rejectUrl}"  style="display:inline-block;padding:12px 28px;background:#f44336;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">❌ Reject</a>
      </div>` : `
      <div style="margin-top:30px">
        <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:#1976d2;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px">✅ Acknowledge & Bank Credit</a>
        <a href="${rejectUrl}"  style="display:inline-block;padding:12px 28px;background:#f44336;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">❌ Reject</a>
      </div>`;

  const html = `
    <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
        <h2 style="color:#1a1a2e;margin:0">Comp-Off Request</h2>
        ${typeLabel}
      </div>
      <p style="color:#888;font-size:13px;margin-bottom:24px">DPDzero — Data Support Team</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#555;width:40%"><strong>Employee</strong></td><td style="color:#222">${employeeName}</td></tr>
        <tr><td style="padding:8px 0;color:#555"><strong>Weekend(s) Worked</strong></td><td style="color:#222">${workedFormatted}</td></tr>
        ${dateRow}
        <tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>Work Done</strong></td><td style="color:#222">${reason}</td></tr>
      </table>
      ${actionButtons}
      <p style="margin-top:24px;font-size:12px;color:#aaa">Submitted via DPDzero Comp-Off Portal.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"DPDzero Comp-Off Portal" <${process.env.GMAIL_USER}>`,
      to: 'arish@dpdzero.com',
      subject: isLeave
        ? `🏖️ Leave Request: ${employeeName} — ${compoffFormatted}`
        : `🏦 Comp-Off Credit (+${workedDates.length} days): ${employeeName}`,
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
  const isLeave          = row.request_type === 'take_leave';
  const compoffFormatted = isLeave && row.compoff_date ? formatSingle(row.compoff_date) : null;
  const daysWorked       = JSON.parse(row.worked_dates).length;

  if (action === 'approve') {
    const dateRow = isLeave
      ? `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Leave Date</strong></td><td style="color:#222">${compoffFormatted}</td></tr>
         <tr><td style="padding:8px 0;color:#555"><strong>Balance Impact</strong></td><td style="color:#c62828"><strong>−1 comp-off day used</strong></td></tr>`
      : `<tr><td style="padding:8px 0;color:#555;width:40%"><strong>Credits Added</strong></td><td style="color:#2e7d32"><strong>+${daysWorked} comp-off day${daysWorked > 1 ? 's' : ''} banked ✓</strong></td></tr>`;

    const hrHtml = `
      <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="color:#2e7d32;margin-bottom:4px">${isLeave ? '✅ Comp-Off Leave Approved' : '🏦 Comp-Off Credit Banked'}</h2>
        <p style="color:#888;font-size:13px;margin-bottom:24px">DPDzero — Data Support Team</p>
        <p style="font-size:14px;color:#333;margin-bottom:20px">
          ${isLeave
            ? `Comp-off leave for <strong>${row.employee}</strong> has been <strong style="color:#2e7d32">approved by Sandeep</strong>. Their comp-off balance will be reduced by 1.`
            : `Weekend work by <strong>${row.employee}</strong> acknowledged by Sandeep. <strong>+${daysWorked} comp-off day${daysWorked > 1 ? 's' : ''}</strong> added to their balance.`}
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#555;width:40%"><strong>Employee</strong></td><td style="color:#222">${row.employee}</td></tr>
          <tr><td style="padding:8px 0;color:#555"><strong>Weekend(s) Worked</strong></td><td style="color:#222">${workedFormatted}</td></tr>
          ${dateRow}
          <tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>Work Done</strong></td><td style="color:#222">${row.reason}</td></tr>
          <tr><td style="padding:8px 0;color:#555"><strong>Approved By</strong></td><td style="color:#222">Sandeep</td></tr>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#aaa">Dashboard updated automatically. Please also update the attendance system.</p>
      </div>
    `;

    try {
      await transporter.sendMail({
        from: `"DPDzero Comp-Off Portal" <${process.env.GMAIL_USER}>`,
        to: 'arish@dpdzero.com',
        subject: isLeave
          ? `✅ Leave Approved: ${row.employee} — ${compoffFormatted}`
          : `🏦 +${daysWorked} Credit Banked: ${row.employee}`,
        html: hrHtml,
      });
    } catch (err) {
      console.error('HR mail error:', err.message);
    }

    return res.send(page(
      isLeave ? 'Leave Approved!' : 'Credit Banked!',
      isLeave
        ? `Comp-off leave for <strong>${row.employee}</strong> on <strong>${compoffFormatted}</strong> approved. Their balance has been updated. HR team notified.`
        : `<strong>+${daysWorked} comp-off day${daysWorked > 1 ? 's' : ''}</strong> added to <strong>${row.employee}</strong>'s balance. HR team notified.`,
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

// ── Branded response page ─────────────────────────────────────────────────────
function page(title, message, color) {
  const isSuccess = color === '#4caf50';
  const accentBg     = isSuccess ? 'rgba(8,202,151,0.12)'  : 'rgba(249,76,70,0.12)';
  const accentBorder = isSuccess ? 'rgba(8,202,151,0.3)'   : 'rgba(249,76,70,0.3)';
  const emoji        = isSuccess ? '✅' : '❌';
  return `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>${title} — DPDzero</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:#00002A;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 30% 30%,rgba(103,90,249,0.3) 0%,transparent 60%),radial-gradient(ellipse 60% 50% at 80% 70%,rgba(8,202,151,0.12) 0%,transparent 55%);pointer-events:none}
    .card{position:relative;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:480px;width:100%;text-align:center;backdrop-filter:blur(20px);box-shadow:0 32px 80px rgba(0,0,0,0.4)}
    .icon-wrap{width:72px;height:72px;border-radius:50%;background:${accentBg};border:1px solid ${accentBorder};display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 24px}
    h1{font-family:'Red Hat Display',sans-serif;font-size:1.75rem;font-weight:900;color:#FBFBFF;margin-bottom:12px;letter-spacing:-0.3px}
    p{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.7}
    p strong{color:rgba(255,255,255,0.85)}
    .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:28px}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600;transition:all 0.2s}
    .btn-primary{background:linear-gradient(135deg,#675AF9,#4A3FD4);color:#fff;box-shadow:0 4px 20px rgba(103,90,249,0.3)}
    .btn-secondary{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.1)}
    .btn:hover{transform:translateY(-1px)}
    .logo{margin-bottom:32px;font-family:'Red Hat Display',sans-serif;font-size:12px;color:rgba(255,255,255,0.3);letter-spacing:1px;text-transform:uppercase}
  </style></head>
  <body>
    <div class="card">
      <div class="logo">DPDzero · Comp-Off Portal</div>
      <div class="icon-wrap">${emoji}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <div class="btns">
        <a class="btn btn-secondary" href="/">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M11 6.5H2M5.5 3L2 6.5L5.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Back to Portal
        </a>
        <a class="btn btn-primary" href="/dashboard.html">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1.5" y="1.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="7.5" y="1.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="1.5" y="7.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/><rect x="7.5" y="7.5" width="4" height="4" rx="1" stroke="white" stroke-width="1.5"/></svg>
          View Dashboard
        </a>
      </div>
    </div>
  </body></html>`;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
