// =====================================================================
// server.js  -  CCSMS backend (Node.js + Express + SQLite)
//
// The code is grouped by the six processes of the Data Flow Diagram:
//   DFD 1  Authenticate User          -> loginUser()
//   DFD 2  Manage Hearing Request     -> case routes, check-availability route
//   DFD 3  Check Availability         -> checkJudgeAvailability(), checkCourtroomAvailability()
//   DFD 4  Allocate Hearing Slot      -> createHearing()
//   DFD 5  Send Notifications         -> sendNotifications()
//   DFD 6  Generate Reports           -> generateReport()
// The remaining routes implement the other Use Cases (Judge, Lawyer,
// Defendant, Witness and Administrator functions).
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
const COURT_OPEN = '09:00';      // court working hours (used for validation
const COURT_CLOSE = '17:00';     // and for generating alternative slots)
const SLOT_STEP_MINUTES = 30;    // alternative slots are searched every 30 minutes
const MAX_ALTERNATIVES = 5;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------
// Small helper functions
// ---------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowStamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function toTime(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function addDays(dateText, days) {
  const d = new Date(dateText + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// Generates the next ID of the form <prefix>001, <prefix>002, ...
function generateId(table, column, prefix) {
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(${column}, ${prefix.length + 1}) AS INTEGER)) AS maxNo FROM ${table}`
  ).get();
  return prefix + String((row.maxNo || 0) + 1).padStart(3, '0');
}

function getUser(userId) {
  return db.prepare('SELECT userId, name, email, role FROM users WHERE userId = ?').get(userId);
}

function getCase(caseId) {
  return db.prepare(`
    SELECT c.*, j.name AS judgeName, l.name AS lawyerName, d.name AS defendantName, w.name AS witnessName
    FROM cases c
    JOIN users j ON j.userId = c.assignedJudgeId
    LEFT JOIN users l ON l.userId = c.lawyerId
    LEFT JOIN users d ON d.userId = c.defendantId
    LEFT JOIN users w ON w.userId = c.witnessId
    WHERE c.caseId = ?`).get(caseId);
}

const HEARING_SELECT = `
  SELECT h.*, c.caseNumber, u.name AS judgeName, r.roomNumber
  FROM hearings h
  JOIN cases c      ON c.caseId = h.caseId
  JOIN users u      ON u.userId = h.judgeId
  JOIN courtrooms r ON r.courtroomId = h.courtroomId`;

function getHearing(hearingId) {
  return db.prepare(HEARING_SELECT + ' WHERE h.hearingId = ?').get(hearingId);
}

function addHistory(hearingId, action, details, userId) {
  db.prepare(`INSERT INTO scheduling_history (hearingId, action, details, performedBy, performedAt)
              VALUES (?, ?, ?, ?, ?)`).run(hearingId, action, details, userId, nowStamp());
}

function isCourtHoliday(date) {
  return db.prepare('SELECT * FROM holidays WHERE date = ?').get(date);
}

// =====================================================================
// DFD PROCESS 1: AUTHENTICATE USER
// =====================================================================
const sessions = {};   // token -> userId (kept in memory; restart = logout)

// Activity Diagram Decision: "Login valid?"
function loginUser(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND password = ?').get(email, password);
  if (!user) return null;                       // [No]  -> Display login error
  const token = crypto.randomUUID();            // [Yes] -> continue to the system
  sessions[token] = user.userId;
  return { token, user: getUser(user.userId) };
}

// Every protected route first finds the logged-in user from the token.
function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = sessions[token] ? getUser(sessions[token]) : null;
  if (!user) return sendError(res, 401, 'Please login first.');
  req.user = user;
  next();
}

// Allows a route only for the actors connected to that Use Case.
function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return sendError(res, 403, `Your role (${req.user.role}) is not allowed to perform this action.`);
    }
    next();
  };
}

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return sendError(res, 400, 'Please enter email and password.');
  const result = loginUser(email.trim(), password);
  if (!result) return sendError(res, 401, 'Invalid email or password.');
  res.json(result);
});

app.post('/api/logout', authenticate, (req, res) => {
  delete sessions[(req.headers.authorization || '').replace('Bearer ', '')];
  res.json({ message: 'Logged out.' });
});

app.get('/api/me', authenticate, (req, res) => res.json(req.user));

// =====================================================================
// DASHBOARD (summary counts for the logged-in actor)
// =====================================================================
app.get('/api/dashboard', authenticate, (req, res) => {
  const u = req.user;
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;
  let cards = [];

  if (u.role === 'CourtClerk') {
    cards = [
      { label: 'Open / Pending Cases', value: count("SELECT COUNT(*) n FROM cases WHERE status != 'Closed'") },
      { label: 'Scheduled Hearings', value: count("SELECT COUNT(*) n FROM hearings WHERE status = 'Scheduled'") },
      { label: 'Pending Adjournment Requests', value: count("SELECT COUNT(*) n FROM adjournment_requests WHERE status = 'Pending'") },
      { label: 'Pending Cancellation Requests', value: count("SELECT COUNT(*) n FROM cancellation_requests WHERE status = 'Pending'") }
    ];
  } else if (u.role === 'Judge') {
    cards = [
      { label: 'Assigned Cases', value: count('SELECT COUNT(*) n FROM cases WHERE assignedJudgeId = ?', u.userId) },
      { label: 'Scheduled Hearings', value: count("SELECT COUNT(*) n FROM hearings WHERE judgeId = ? AND status = 'Scheduled'", u.userId) },
      { label: 'My Pending Cancellation Requests', value: count("SELECT COUNT(*) n FROM cancellation_requests WHERE judgeId = ? AND status = 'Pending'", u.userId) }
    ];
  } else if (u.role === 'Lawyer') {
    cards = [
      { label: 'Scheduled Hearings', value: count("SELECT COUNT(*) n FROM hearings h JOIN cases c ON c.caseId = h.caseId WHERE c.lawyerId = ? AND h.status = 'Scheduled'", u.userId) },
      { label: 'My Pending Adjournment Requests', value: count("SELECT COUNT(*) n FROM adjournment_requests WHERE lawyerId = ? AND status = 'Pending'", u.userId) }
    ];
  } else if (u.role === 'Defendant') {
    cards = [
      { label: 'Scheduled Hearings', value: count("SELECT COUNT(*) n FROM hearings h JOIN cases c ON c.caseId = h.caseId WHERE c.defendantId = ? AND h.status = 'Scheduled'", u.userId) }
    ];
  } else if (u.role === 'Administrator') {
    cards = [
      { label: 'Users', value: count('SELECT COUNT(*) n FROM users') },
      { label: 'Cases', value: count('SELECT COUNT(*) n FROM cases') },
      { label: 'Failed Notifications', value: count("SELECT COUNT(*) n FROM notifications WHERE status = 'Failed'") },
      { label: 'Court Holidays', value: count('SELECT COUNT(*) n FROM holidays') }
    ];
  }

  if (u.role !== 'CourtClerk' && u.role !== 'Administrator') {
    cards.push({ label: 'Notifications to Acknowledge',
      value: count("SELECT COUNT(*) n FROM notifications WHERE userId = ? AND status = 'Delivered'", u.userId) });
  }
  res.json({ user: u, cards });
});

// =====================================================================
// USERS (lists used by forms) + Administrator: Manage Users & Roles
// =====================================================================
const ROLES = ['CourtClerk', 'Judge', 'Lawyer', 'Defendant', 'Witness', 'Administrator'];

app.get('/api/users', authenticate, allow('CourtClerk', 'Administrator'), (req, res) => {
  const role = req.query.role;
  const users = role
    ? db.prepare('SELECT userId, name, email, role FROM users WHERE role = ? ORDER BY name').all(role)
    : db.prepare('SELECT userId, name, email, role FROM users ORDER BY role, name').all();
  res.json(users);
});

app.post('/api/users', authenticate, allow('Administrator'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) return sendError(res, 400, 'Please fill in name, email, password and role.');
  if (!ROLES.includes(role)) return sendError(res, 400, 'Invalid role.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim())) {
    return sendError(res, 400, 'A user with this email already exists.');
  }
  const info = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.trim(), password, role);
  res.json({ message: `User "${name}" created with role ${role}.`, userId: info.lastInsertRowid });
});

// A user who is already linked to cases/hearings keeps the same role,
// otherwise existing records would point to the wrong kind of actor.
function isUserLinkedToRecords(userId) {
  return db.prepare(`
    SELECT 1 FROM cases WHERE assignedJudgeId = @id OR lawyerId = @id OR defendantId = @id OR witnessId = @id
    UNION SELECT 1 FROM hearings WHERE judgeId = @id`).get({ id: userId });
}

app.put('/api/users/:id/role', authenticate, allow('Administrator'), (req, res) => {
  const user = getUser(req.params.id);
  const role = (req.body || {}).role;
  if (!user) return sendError(res, 404, 'User not found.');
  if (!ROLES.includes(role)) return sendError(res, 400, 'Invalid role.');
  if (user.userId === req.user.userId) return sendError(res, 400, 'You cannot change your own role.');
  if (user.role === role) return sendError(res, 400, `User already has the role ${role}.`);
  if (isUserLinkedToRecords(user.userId)) {
    return sendError(res, 400, `${user.name} is linked to existing cases/hearings as ${user.role}, so the role cannot be changed.`);
  }
  db.prepare('UPDATE users SET role = ? WHERE userId = ?').run(role, user.userId);
  res.json({ message: `Role of ${user.name} changed to ${role}.` });
});

app.delete('/api/users/:id', authenticate, allow('Administrator'), (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return sendError(res, 404, 'User not found.');
  if (user.userId === req.user.userId) return sendError(res, 400, 'You cannot delete your own account.');
  try {
    db.prepare('DELETE FROM users WHERE userId = ?').run(user.userId);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return sendError(res, 400, `${user.name} is linked to cases, hearings, requests or notifications and cannot be deleted.`);
    }
    throw err;
  }
  res.json({ message: `User ${user.name} deleted.` });
});

app.get('/api/courtrooms', authenticate, (req, res) => {
  res.json(db.prepare('SELECT * FROM courtrooms ORDER BY roomNumber').all());
});

// =====================================================================
// DFD PROCESS 2 (part 1): CASE MANAGEMENT
// Use Cases: Register New Case, Assign Judge, Search Case,
//            Update Case Details, Close Case, View Assigned Cases,
//            Reassign Judge (Administrator)
// =====================================================================
const CASE_STATUSES = ['Open', 'Pending', 'Closed'];

function checkPartyRole(userId, role) {
  if (!userId) return true;                       // parties are optional
  const user = getUser(userId);
  return user && user.role === role;
}

function validateCaseFields(b) {
  if (!b.caseNumber || !b.caseType || !b.filingDate || !b.status) {
    return 'Please fill in case number, case type, filing date and status.';
  }
  if (!DATE_RE.test(b.filingDate)) return 'Invalid filing date.';
  if (b.filingDate > today()) return 'Filing date cannot be in the future.';
  if (!CASE_STATUSES.includes(b.status)) return 'Invalid case status.';
  if (!checkPartyRole(b.lawyerId, 'Lawyer')) return 'Selected lawyer is not a Lawyer user.';
  if (!checkPartyRole(b.defendantId, 'Defendant')) return 'Selected defendant is not a Defendant user.';
  if (!checkPartyRole(b.witnessId, 'Witness')) return 'Selected witness is not a Witness user.';
  return null;
}

// View / Search cases. Judges only see the cases assigned to them.
app.get('/api/cases', authenticate, allow('CourtClerk', 'Judge', 'Administrator'), (req, res) => {
  let sql = `SELECT c.*, j.name AS judgeName FROM cases c JOIN users j ON j.userId = c.assignedJudgeId WHERE 1 = 1`;
  const params = [];
  if (req.user.role === 'Judge') { sql += ' AND c.assignedJudgeId = ?'; params.push(req.user.userId); }
  if (req.query.search) {
    // Search Case: by Case ID, Case Number or Case Type
    sql += ' AND (c.caseId LIKE ? OR c.caseNumber LIKE ? OR c.caseType LIKE ?)';
    const term = `%${req.query.search.trim()}%`;
    params.push(term, term, term);
  }
  if (req.query.status) { sql += ' AND c.status = ?'; params.push(req.query.status); }
  res.json(db.prepare(sql + ' ORDER BY c.caseId').all(...params));
});

app.get('/api/cases/:id', authenticate, allow('CourtClerk', 'Judge', 'Administrator'), (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return sendError(res, 404, 'Case not found.');
  if (req.user.role === 'Judge' && c.assignedJudgeId !== req.user.userId) {
    return sendError(res, 403, 'This case is not assigned to you.');
  }
  c.documents = db.prepare('SELECT * FROM documents WHERE caseId = ? ORDER BY documentId').all(c.caseId);
  c.hearings = db.prepare(HEARING_SELECT + ' WHERE h.caseId = ? ORDER BY h.hearingDate, h.startTime').all(c.caseId);
  res.json(c);
});

// Use Case: Register New Case (+ Assign Judge)
app.post('/api/cases', authenticate, allow('CourtClerk'), (req, res) => {
  const b = req.body || {};
  // Step 1: validate fields
  const error = validateCaseFields(b);
  if (error) return sendError(res, 400, error);
  if (b.status === 'Closed') return sendError(res, 400, 'A new case must be Open or Pending.');
  if (!b.assignedJudgeId) return sendError(res, 400, 'Please assign a Judge to the case.');
  const judge = getUser(b.assignedJudgeId);
  if (!judge || judge.role !== 'Judge') return sendError(res, 400, 'Selected user is not a Judge.');
  if (db.prepare('SELECT 1 FROM cases WHERE caseNumber = ?').get(b.caseNumber.trim())) {
    return sendError(res, 400, `Case number ${b.caseNumber} already exists.`);
  }

  // Step 2-4: create case, assign Judge, save to SQLite
  const caseId = generateId('cases', 'caseId', 'C');
  db.prepare(`INSERT INTO cases
    (caseId, caseNumber, caseType, filingDate, status, description, assignedJudgeId, lawyerId, defendantId, witnessId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(caseId, b.caseNumber.trim(), b.caseType, b.filingDate, b.status, b.description || '',
      judge.userId, b.lawyerId || null, b.defendantId || null, b.witnessId || null);

  // Step 5: success message
  res.json({ message: `Case ${caseId} (${b.caseNumber}) registered and assigned to ${judge.name}.`, caseId });
});

// Use Case: Update Case Details (the Judge is changed only through Reassign Judge)
app.put('/api/cases/:id', authenticate, allow('CourtClerk'), (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return sendError(res, 404, 'Case not found.');
  const b = req.body || {};
  const error = validateCaseFields(b);
  if (error) return sendError(res, 400, error);
  if (db.prepare('SELECT 1 FROM cases WHERE caseNumber = ? AND caseId != ?').get(b.caseNumber.trim(), c.caseId)) {
    return sendError(res, 400, `Case number ${b.caseNumber} already exists.`);
  }
  if (b.status === 'Closed' && c.status !== 'Closed') return sendError(res, 400, 'Use the "Close" button to close a case.');
  db.prepare(`UPDATE cases SET caseNumber = ?, caseType = ?, filingDate = ?, status = ?, description = ?,
              lawyerId = ?, defendantId = ?, witnessId = ? WHERE caseId = ?`)
    .run(b.caseNumber.trim(), b.caseType, b.filingDate, b.status, b.description || '',
      b.lawyerId || null, b.defendantId || null, b.witnessId || null, c.caseId);
  res.json({ message: `Case ${c.caseId} updated.` });
});

// Use Case: Close Case
app.post('/api/cases/:id/close', authenticate, allow('CourtClerk'), (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return sendError(res, 404, 'Case not found.');
  if (c.status === 'Closed') return sendError(res, 400, 'Case is already closed.');
  const pending = db.prepare("SELECT COUNT(*) n FROM hearings WHERE caseId = ? AND status IN ('Scheduled','Adjourned')").get(c.caseId).n;
  if (pending > 0) {
    return sendError(res, 400, `Case has ${pending} scheduled/adjourned hearing(s). Complete or cancel them before closing.`);
  }
  db.prepare("UPDATE cases SET status = 'Closed' WHERE caseId = ?").run(c.caseId);
  res.json({ message: `Case ${c.caseId} closed.` });
});

// Use Case: Reassign Judge (Administrator)
// The case's upcoming Scheduled hearings move to the new Judge, but only
// if the new Judge is free at those times (same availability check).
app.put('/api/cases/:id/judge', authenticate, allow('Administrator'), (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return sendError(res, 404, 'Case not found.');
  const judge = getUser((req.body || {}).judgeId);
  if (!judge || judge.role !== 'Judge') return sendError(res, 400, 'Please select a valid Judge.');
  if (judge.userId === c.assignedJudgeId) return sendError(res, 400, `${judge.name} is already assigned to this case.`);

  const upcoming = db.prepare("SELECT * FROM hearings WHERE caseId = ? AND status = 'Scheduled'").all(c.caseId);
  for (const h of upcoming) {
    const check = checkJudgeAvailability(judge.userId, h.hearingDate, h.startTime, h.endTime, h.hearingId);
    if (!check.available) {
      return sendError(res, 409, `${judge.name} is not available for hearing ${h.hearingId} on ${h.hearingDate} ` +
        `${h.startTime}-${h.endTime} (busy with ${check.clash.hearingId}). Reschedule that hearing first.`);
    }
  }

  const reassign = db.transaction(() => {
    db.prepare('UPDATE cases SET assignedJudgeId = ? WHERE caseId = ?').run(judge.userId, c.caseId);
    for (const h of upcoming) {
      db.prepare('UPDATE hearings SET judgeId = ? WHERE hearingId = ?').run(judge.userId, h.hearingId);
      addHistory(h.hearingId, 'Judge Reassigned', `${c.judgeName} -> ${judge.name}`, req.user.userId);
    }
  });
  reassign();
  res.json({ message: `Case ${c.caseId} reassigned from ${c.judgeName} to ${judge.name}` +
    (upcoming.length ? ` (${upcoming.length} scheduled hearing(s) updated).` : '.') });
});

// Document (Case 1 --- * Document): metadata only, no real file upload
app.post('/api/cases/:id/documents', authenticate, allow('CourtClerk'), (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return sendError(res, 404, 'Case not found.');
  const { fileName, documentType } = req.body || {};
  if (!fileName || !documentType) return sendError(res, 400, 'Please enter file name and document type.');
  db.prepare('INSERT INTO documents (caseId, fileName, documentType, uploadDate) VALUES (?, ?, ?, ?)')
    .run(c.caseId, fileName.trim(), documentType, today());
  res.json({ message: `Document "${fileName}" added to case ${c.caseId}.` });
});

// =====================================================================
// DFD PROCESS 3: CHECK AVAILABILITY (Judge & Courtroom)
// Conflict rule: two hearings overlap when
//     newStart < existingEnd  AND  newEnd > existingStart
// Cancelled and Adjourned hearings no longer occupy their slot.
// =====================================================================

// Sequence Diagram Step 4-5: checkAvailability(date, time) -> Judge
function checkJudgeAvailability(judgeId, date, startTime, endTime, excludeHearingId) {
  const clash = db.prepare(`
    SELECT hearingId, startTime, endTime FROM hearings
    WHERE judgeId = ? AND hearingDate = ? AND status IN ('Scheduled','Completed')
      AND hearingId != ? AND startTime < ? AND endTime > ?`)
    .get(judgeId, date, excludeHearingId || '', endTime, startTime);
  return { available: !clash, clash };
}

// Sequence Diagram Step 6-7: checkAvailability(date, time) -> Courtroom
function checkCourtroomAvailability(courtroomId, date, startTime, endTime, excludeHearingId) {
  const room = db.prepare('SELECT * FROM courtrooms WHERE courtroomId = ?').get(courtroomId);
  if (!room || room.status !== 'Available') return { available: false, clash: null, roomClosed: true };
  const clash = db.prepare(`
    SELECT hearingId, startTime, endTime FROM hearings
    WHERE courtroomId = ? AND hearingDate = ? AND status IN ('Scheduled','Completed')
      AND hearingId != ? AND startTime < ? AND endTime > ?`)
    .get(courtroomId, date, excludeHearingId || '', endTime, startTime);
  return { available: !clash, clash };
}

// Candidate times with the same duration: requested date first, then the
// next two days (holidays skipped), nearest to the requested time first.
function getNearbyTimeSlots(date, startTime, endTime) {
  const duration = toMinutes(endTime) - toMinutes(startTime);
  const slots = [];
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const day = addDays(date, dayOffset);
    if (isCourtHoliday(day)) continue;
    const daySlots = [];
    for (let start = toMinutes(COURT_OPEN); start + duration <= toMinutes(COURT_CLOSE); start += SLOT_STEP_MINUTES) {
      if (dayOffset === 0 && toTime(start) === startTime) continue;   // the requested slot itself
      daySlots.push({ date: day, startTime: toTime(start), endTime: toTime(start + duration),
                      distance: Math.abs(start - toMinutes(startTime)) });
    }
    daySlots.sort((a, b) => a.distance - b.distance);
    slots.push(...daySlots);
  }
  return slots;
}

// Activity Diagram: conflict path ("Identify scheduling conflict" onwards)
function generateAlternativeSlots(judgeId, courtroomId, date, startTime, endTime, judgeUnavailable, excludeHearingId) {
  let candidateTimes;
  if (judgeUnavailable) {
    // Decision "Judge unavailable?" [Yes] -> Find Judge-compatible available slots
    candidateTimes = getNearbyTimeSlots(date, startTime, endTime);
  } else {
    // Decision "Judge unavailable?" [No] -> Find Courtroom-compatible available slots
    // (the Judge is free at the requested time, so try that time in another courtroom first)
    candidateTimes = [{ date, startTime, endTime }, ...getNearbyTimeSlots(date, startTime, endTime)];
  }
  candidateTimes = candidateTimes.filter(t =>
    checkJudgeAvailability(judgeId, t.date, t.startTime, t.endTime, excludeHearingId).available);

  // Merge -> "Generate compatible alternative slots": attach a free courtroom,
  // preferring the courtroom the clerk asked for.
  const rooms = db.prepare("SELECT * FROM courtrooms WHERE status = 'Available' ORDER BY courtroomId != ?, roomNumber")
    .all(courtroomId);
  const alternatives = [];
  for (const t of candidateTimes) {
    const room = rooms.find(r =>
      checkCourtroomAvailability(r.courtroomId, t.date, t.startTime, t.endTime, excludeHearingId).available);
    if (room) {
      alternatives.push({ hearingDate: t.date, startTime: t.startTime, endTime: t.endTime,
                          courtroomId: room.courtroomId, roomNumber: room.roomNumber });
    }
    if (alternatives.length === MAX_ALTERNATIVES) break;
  }
  return alternatives;
}

// Runs both checks and, on conflict, builds the alternatives.
// Used by Schedule Hearing AND Reschedule Hearing (same logic reused).
function checkAvailability(judgeId, courtroomId, date, startTime, endTime, excludeHearingId) {
  // Activity Diagram FORK: the Judge check and the Courtroom check are
  // independent of each other (drawn in parallel in the diagram).
  const judgeCheck = checkJudgeAvailability(judgeId, date, startTime, endTime, excludeHearingId);
  const courtroomCheck = checkCourtroomAvailability(courtroomId, date, startTime, endTime, excludeHearingId);
  // Activity Diagram JOIN: both results are now available.

  const conflicts = [];
  if (!judgeCheck.available) {
    conflicts.push(`Assigned Judge is unavailable (already has hearing ${judgeCheck.clash.hearingId} ` +
      `from ${judgeCheck.clash.startTime} to ${judgeCheck.clash.endTime}).`);
  }
  if (!courtroomCheck.available) {
    conflicts.push(courtroomCheck.roomClosed
      ? 'Selected Courtroom is unavailable (courtroom is closed).'
      : `Selected Courtroom is unavailable (occupied by hearing ${courtroomCheck.clash.hearingId} ` +
        `from ${courtroomCheck.clash.startTime} to ${courtroomCheck.clash.endTime}).`);
  }

  // Activity Diagram Decision: "Judge and Courtroom available?"
  const result = {
    available: conflicts.length === 0,
    judgeAvailable: judgeCheck.available,
    courtroomAvailable: courtroomCheck.available,
    conflicts,
    alternatives: []
  };
  if (!result.available) {
    result.alternatives = generateAlternativeSlots(judgeId, courtroomId, date, startTime, endTime,
      !judgeCheck.available, excludeHearingId);
  }
  return result;
}

// Basic validation shared by schedule and reschedule.
function validateHearingSlot(b) {
  if (!b.hearingDate || !b.startTime || !b.endTime || !b.courtroomId) {
    return 'Please fill in hearing date, start time, end time and courtroom.';
  }
  if (!DATE_RE.test(b.hearingDate)) return 'Invalid hearing date.';
  if (!TIME_RE.test(b.startTime) || !TIME_RE.test(b.endTime)) return 'Invalid time. Use HH:MM.';
  if (b.hearingDate < today()) return 'Hearing date cannot be in the past.';
  if (b.startTime >= b.endTime) return 'End time must be after start time.';
  if (b.startTime < COURT_OPEN || b.endTime > COURT_CLOSE) {
    return `Hearings must be within court hours (${COURT_OPEN} - ${COURT_CLOSE}).`;
  }
  const holiday = isCourtHoliday(b.hearingDate);
  if (holiday) return `Scheduling not allowed on Court Holiday (${holiday.date}: ${holiday.description}).`;
  if (!db.prepare('SELECT 1 FROM courtrooms WHERE courtroomId = ?').get(b.courtroomId)) return 'Courtroom not found.';
  return null;
}

// =====================================================================
// DFD PROCESS 2 (part 2): MANAGE HEARING REQUEST
// Sequence Diagram steps 3 - 8 / 18 - 23
// =====================================================================
app.post('/api/hearings/check-availability', authenticate, allow('CourtClerk'), (req, res) => {
  const b = req.body || {};
  if (!b.caseId) return sendError(res, 400, 'Please select a case.');

  // "Select case for hearing" + "Retrieve assigned Judge details"
  const c = getCase(b.caseId);
  if (!c) return sendError(res, 404, 'Case not found.');
  if (c.status === 'Closed') return sendError(res, 400, 'Hearings cannot be scheduled for a closed case.');
  const error = validateHearingSlot(b);
  if (error) return sendError(res, 400, error);

  const result = checkAvailability(c.assignedJudgeId, Number(b.courtroomId), b.hearingDate, b.startTime, b.endTime);
  const room = db.prepare('SELECT roomNumber FROM courtrooms WHERE courtroomId = ?').get(b.courtroomId);

  // Trace of the Sequence Diagram messages, shown on screen for the viva.
  result.trace = [
    `3: requestScheduleHearing(${c.caseId}) - assigned Judge: ${c.judgeName}`,
    `4: checkAvailability(${b.hearingDate}, ${b.startTime}-${b.endTime}) -> Judge`,
    `5: availability status: ${result.judgeAvailable ? 'Available' : 'Unavailable'}`,
    `6: checkAvailability(${b.hearingDate}, ${b.startTime}-${b.endTime}) -> ${room.roomNumber}`,
    `7: availability status: ${result.courtroomAvailable ? 'Available' : 'Unavailable'}`
  ];
  if (result.available) {
    result.trace.push('8: displayAvailableSlots()');
  } else {
    result.trace.push('18: displayConflict()',
      '19-22: checkNextAvailableSlots() -> Judge and Courtroom',
      `23: suggestAlternativeSlots() - ${result.alternatives.length} alternative(s) found`);
  }
  result.case = { caseId: c.caseId, caseNumber: c.caseNumber, judgeId: c.assignedJudgeId, judgeName: c.judgeName };
  result.requested = { hearingDate: b.hearingDate, startTime: b.startTime, endTime: b.endTime,
                       courtroomId: Number(b.courtroomId), roomNumber: room.roomNumber };
  res.json(result);
});

// =====================================================================
// DFD PROCESS 4: ALLOCATE HEARING SLOT
// Activity Diagram: Create hearing record -> Generate unique Hearing ID ->
// Assign Courtroom -> Associate Judge -> Set status Scheduled ->
// Save hearing details -> Update scheduling history
// =====================================================================
function createHearing(c, b, userId) {
  const hearingId = generateId('hearings', 'hearingId', 'H');   // Generate unique Hearing ID
  const hearing = {
    hearingId,
    caseId: c.caseId,
    hearingDate: b.hearingDate,
    startTime: b.startTime,
    endTime: b.endTime,
    courtroomId: Number(b.courtroomId),     // Assign selected Courtroom
    judgeId: c.assignedJudgeId,             // Associate assigned Judge
    purpose: b.purpose.trim(),
    status: 'Scheduled'                     // Set hearing status to Scheduled
  };
  const save = db.transaction(() => {
    db.prepare(`INSERT INTO hearings
      (hearingId, caseId, hearingDate, startTime, endTime, judgeId, courtroomId, purpose, status)
      VALUES (@hearingId, @caseId, @hearingDate, @startTime, @endTime, @judgeId, @courtroomId, @purpose, @status)`)
      .run(hearing);                                               // Save hearing details
    addHistory(hearingId, 'Scheduled',
      `${hearing.hearingDate} ${hearing.startTime}-${hearing.endTime}`, userId);  // Update scheduling history
  });
  save();
  return hearing;
}

// =====================================================================
// DFD PROCESS 5: SEND NOTIFICATIONS (simulated Notification Service)
// No real e-mail/SMS is sent; each message is stored as a Notification.
// =====================================================================
function sendNotifications(hearingId, type, simulateFailure) {
  const h = getHearing(hearingId);
  const c = getCase(h.caseId);
  const when = `${h.hearingDate}, ${h.startTime}-${h.endTime} in ${h.roomNumber}`;
  const messages = {
    Scheduled:   `[Email/SMS] Hearing ${h.hearingId} for case ${h.caseNumber} is scheduled on ${when}.`,
    Rescheduled: `[Email/SMS] Hearing ${h.hearingId} for case ${h.caseNumber} has been rescheduled to ${when}.`,
    Cancelled:   `[Email/SMS] Hearing ${h.hearingId} for case ${h.caseNumber} on ${h.hearingDate} has been cancelled.`
  };

  // Recipients from the Activity Diagram: Judge, Lawyers, Defendant and Witnesses
  const recipients = [...new Set([h.judgeId, c.lawyerId, c.defendantId, c.witnessId].filter(Boolean))];
  let delivered = 0;
  let failed = 0;
  const insert = db.prepare(`INSERT INTO notifications (userId, hearingId, message, type, sentAt, status)
                             VALUES (?, ?, ?, ?, ?, ?)`);
  for (const userId of recipients) {
    // Activity Diagram Decision: "Notifications delivered?"
    //   [Yes] -> Record notification status as Delivered
    //   [No]  -> Record notification status as Failed
    const status = simulateFailure ? 'Failed' : 'Delivered';
    insert.run(userId, h.hearingId, messages[type], type, nowStamp(), status);
    if (status === 'Delivered') delivered++; else failed++;
  }
  return { total: recipients.length, delivered, failed };
}

function notificationSummary(n) {
  return n.failed === 0
    ? `Notification sent successfully to ${n.delivered} participant(s).`
    : `${n.failed} notification(s) failed and ${n.delivered} delivered. The Administrator can retrigger failed notifications.`;
}

// Sequence Diagram steps 11 - 17: confirmHearing() ... hearing scheduled successfully
// Activity Diagram Decision "Confirm hearing?" [Yes]. ([No] never reaches the server:
// the browser simply discards the unconfirmed slot selection.)
app.post('/api/hearings', authenticate, allow('CourtClerk'), (req, res) => {
  const b = req.body || {};
  const c = getCase(b.caseId);
  if (!c) return sendError(res, 404, 'Case not found.');
  if (c.status === 'Closed') return sendError(res, 400, 'Hearings cannot be scheduled for a closed case.');
  if (!b.purpose || !b.purpose.trim()) return sendError(res, 400, 'Please enter the purpose of the hearing.');
  const error = validateHearingSlot(b);
  if (error) return sendError(res, 400, error);

  // Re-check just before saving, in case another clerk took the slot meanwhile.
  const check = checkAvailability(c.assignedJudgeId, Number(b.courtroomId), b.hearingDate, b.startTime, b.endTime);
  if (!check.available) {
    return res.status(409).json({ error: 'Scheduling Conflict: the selected slot is no longer available.', ...check });
  }

  const hearing = createHearing(c, b, req.user.userId);                      // DFD 4
  const notif = sendNotifications(hearing.hearingId, 'Scheduled', !!b.simulateFailure);  // DFD 5

  res.json({
    message: `Hearing ${hearing.hearingId} scheduled successfully.`,
    notificationMessage: notificationSummary(notif),
    notifications: notif,
    hearing: getHearing(hearing.hearingId),
    trace: [
      '11: confirmHearing()',
      '12: createHearing()',
      `13: assignHearingID() -> ${hearing.hearingId}`,
      '14: setStatus("Scheduled")',
      '15: sendHearingNotification()',
      `16: notification status - ${notif.delivered} delivered, ${notif.failed} failed`,
      '17: hearing scheduled successfully'
    ]
  });
});

// =====================================================================
// VIEW HEARINGS / HEARING DETAILS
// Each actor sees only the hearings that concern them.
// =====================================================================
function hearingVisibility(user) {
  switch (user.role) {
    case 'Judge':     return { sql: ' AND h.judgeId = ?', params: [user.userId] };
    case 'Lawyer':    return { sql: ' AND c.lawyerId = ?', params: [user.userId] };
    case 'Defendant': return { sql: ' AND c.defendantId = ?', params: [user.userId] };
    case 'Witness':   return { sql: ' AND c.witnessId = ?', params: [user.userId] };
    default:          return { sql: '', params: [] };   // Court Clerk, Administrator
  }
}

app.get('/api/hearings', authenticate, (req, res) => {
  const v = hearingVisibility(req.user);
  let sql = HEARING_SELECT + ' WHERE 1 = 1' + v.sql;
  const params = [...v.params];
  if (req.query.caseId) { sql += ' AND h.caseId = ?'; params.push(req.query.caseId); }
  if (req.query.judgeId) { sql += ' AND h.judgeId = ?'; params.push(req.query.judgeId); }
  if (req.query.date) { sql += ' AND h.hearingDate = ?'; params.push(req.query.date); }
  if (req.query.status) { sql += ' AND h.status = ?'; params.push(req.query.status); }
  res.json(db.prepare(sql + ' ORDER BY h.hearingDate, h.startTime').all(...params));
});

app.get('/api/hearings/:id', authenticate, (req, res) => {
  const v = hearingVisibility(req.user);
  const h = db.prepare(HEARING_SELECT + ' WHERE h.hearingId = ?' + v.sql).get(req.params.id, ...v.params);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  h.outcome = db.prepare('SELECT * FROM hearing_outcomes WHERE hearingId = ?').get(h.hearingId) || null;
  h.history = db.prepare(`SELECT s.*, u.name AS performedByName FROM scheduling_history s
                          LEFT JOIN users u ON u.userId = s.performedBy
                          WHERE s.hearingId = ? ORDER BY s.historyId`).all(h.hearingId);
  res.json(h);
});

// =====================================================================
// Use Case: Reschedule Hearing (Court Clerk)
// Reuses exactly the same availability check as Schedule Hearing.
// =====================================================================
app.put('/api/hearings/:id/reschedule', authenticate, allow('CourtClerk'), (req, res) => {
  const h = getHearing(req.params.id);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  if (!['Scheduled', 'Adjourned'].includes(h.status)) {
    return sendError(res, 400, `A ${h.status} hearing cannot be rescheduled.`);
  }
  const b = req.body || {};
  const error = validateHearingSlot(b);
  if (error) return sendError(res, 400, error);
  if (b.hearingDate === h.hearingDate && b.startTime === h.startTime && b.endTime === h.endTime &&
      Number(b.courtroomId) === h.courtroomId && h.status === 'Scheduled') {
    return sendError(res, 400, 'The new slot is the same as the current slot.');
  }

  // Check Judge availability + Check Courtroom availability (ignoring this hearing itself)
  const check = checkAvailability(h.judgeId, Number(b.courtroomId), b.hearingDate, b.startTime, b.endTime, h.hearingId);
  if (!check.available) {
    // Do not suggest the slot the hearing already occupies.
    check.alternatives = check.alternatives.filter(a => !(a.hearingDate === h.hearingDate &&
      a.startTime === h.startTime && a.endTime === h.endTime && a.courtroomId === h.courtroomId));
    return res.status(409).json({ error: 'Scheduling Conflict', ...check });
  }

  const update = db.transaction(() => {
    db.prepare(`UPDATE hearings SET hearingDate = ?, startTime = ?, endTime = ?, courtroomId = ?, status = 'Scheduled'
                WHERE hearingId = ?`).run(b.hearingDate, b.startTime, b.endTime, Number(b.courtroomId), h.hearingId);
    addHistory(h.hearingId, 'Rescheduled',
      `${h.hearingDate} ${h.startTime}-${h.endTime} -> ${b.hearingDate} ${b.startTime}-${b.endTime}`, req.user.userId);
  });
  update();
  const notif = sendNotifications(h.hearingId, 'Rescheduled', !!b.simulateFailure);
  res.json({ message: `Hearing ${h.hearingId} rescheduled to ${b.hearingDate} ${b.startTime}-${b.endTime}.`,
             notificationMessage: notificationSummary(notif) });
});

// =====================================================================
// Use Case: Cancel Hearing (Court Clerk). The record is kept, only the
// status changes to Cancelled.
// =====================================================================
function cancelHearing(h, reason, userId) {
  const cancel = db.transaction(() => {
    db.prepare("UPDATE hearings SET status = 'Cancelled' WHERE hearingId = ?").run(h.hearingId);
    addHistory(h.hearingId, 'Cancelled', reason, userId);
  });
  cancel();
  return sendNotifications(h.hearingId, 'Cancelled', false);
}

app.post('/api/hearings/:id/cancel', authenticate, allow('CourtClerk'), (req, res) => {
  const h = getHearing(req.params.id);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  if (!['Scheduled', 'Adjourned'].includes(h.status)) return sendError(res, 400, `A ${h.status} hearing cannot be cancelled.`);
  const reason = ((req.body || {}).reason || '').trim();
  if (!reason) return sendError(res, 400, 'Please enter a cancellation reason.');
  const notif = cancelHearing(h, reason, req.user.userId);
  res.json({ message: `Hearing ${h.hearingId} cancelled.`, notificationMessage: notificationSummary(notif) });
});

// =====================================================================
// Use Case: Record Hearing Outcome (Judge)  ->  HearingOutcome class
// =====================================================================
const OUTCOME_DECISIONS = ['Completed', 'Adjourned'];

app.post('/api/hearings/:id/outcome', authenticate, allow('Judge'), (req, res) => {
  const h = getHearing(req.params.id);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  if (h.judgeId !== req.user.userId) return sendError(res, 403, 'You can only record outcomes for your own hearings.');
  if (h.status !== 'Scheduled') return sendError(res, 400, `Outcome can only be recorded for a Scheduled hearing (this one is ${h.status}).`);
  const { decision, remarks } = req.body || {};
  if (!OUTCOME_DECISIONS.includes(decision)) return sendError(res, 400, 'Please select a decision.');
  if (!remarks || !remarks.trim()) return sendError(res, 400, 'Please enter remarks.');

  const record = db.transaction(() => {
    db.prepare('INSERT INTO hearing_outcomes (hearingId, decision, remarks, recordedAt) VALUES (?, ?, ?, ?)')
      .run(h.hearingId, decision, remarks.trim(), nowStamp());
    // hearing.status = Completed  or  hearing.status = Adjourned
    db.prepare('UPDATE hearings SET status = ? WHERE hearingId = ?').run(decision, h.hearingId);
    addHistory(h.hearingId, `Outcome: ${decision}`, remarks.trim(), req.user.userId);
  });
  record();
  res.json({ message: `Outcome recorded for ${h.hearingId}. Hearing status is now ${decision}.` });
});

// =====================================================================
// Use Case: Request Hearing Cancellation (Judge) - reviewed by Court Clerk
// =====================================================================
app.get('/api/cancellation-requests', authenticate, allow('CourtClerk', 'Judge'), (req, res) => {
  let sql = `SELECT r.*, u.name AS judgeName, h.hearingDate, h.startTime, h.endTime, h.status AS hearingStatus, c.caseNumber
             FROM cancellation_requests r
             JOIN users u ON u.userId = r.judgeId
             JOIN hearings h ON h.hearingId = r.hearingId
             JOIN cases c ON c.caseId = h.caseId`;
  const params = [];
  if (req.user.role === 'Judge') { sql += ' WHERE r.judgeId = ?'; params.push(req.user.userId); }
  res.json(db.prepare(sql + ' ORDER BY r.requestId DESC').all(...params));
});

app.post('/api/cancellation-requests', authenticate, allow('Judge'), (req, res) => {
  const { hearingId, reason } = req.body || {};
  const h = getHearing(hearingId);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  if (h.judgeId !== req.user.userId) return sendError(res, 403, 'You can only request cancellation of your own hearings.');
  if (h.status !== 'Scheduled') return sendError(res, 400, 'Only a Scheduled hearing can be cancelled.');
  if (!reason || !reason.trim()) return sendError(res, 400, 'Please enter a reason.');
  if (db.prepare("SELECT 1 FROM cancellation_requests WHERE hearingId = ? AND status = 'Pending'").get(hearingId)) {
    return sendError(res, 400, 'A cancellation request for this hearing is already pending.');
  }
  // The hearing is NOT cancelled here; the Court Clerk reviews the request.
  db.prepare(`INSERT INTO cancellation_requests (hearingId, judgeId, reason, requestDate, status)
              VALUES (?, ?, ?, ?, 'Pending')`).run(hearingId, req.user.userId, reason.trim(), today());
  res.json({ message: `Cancellation request for ${hearingId} submitted to the Court Clerk.` });
});

app.post('/api/cancellation-requests/:id/:decision', authenticate, allow('CourtClerk'), (req, res) => {
  const r = db.prepare('SELECT * FROM cancellation_requests WHERE requestId = ?').get(req.params.id);
  if (!r) return sendError(res, 404, 'Request not found.');
  if (r.status !== 'Pending') return sendError(res, 400, `Request is already ${r.status}.`);
  if (req.params.decision === 'reject') {
    db.prepare("UPDATE cancellation_requests SET status = 'Rejected' WHERE requestId = ?").run(r.requestId);
    return res.json({ message: 'Cancellation request rejected.' });
  }
  if (req.params.decision !== 'approve') return sendError(res, 400, 'Invalid status update.');

  const h = getHearing(r.hearingId);
  if (!['Scheduled', 'Adjourned'].includes(h.status)) return sendError(res, 400, `Hearing is already ${h.status}.`);
  db.prepare("UPDATE cancellation_requests SET status = 'Approved' WHERE requestId = ?").run(r.requestId);
  const notif = cancelHearing(h, `Judge request: ${r.reason}`, req.user.userId);
  res.json({ message: `Request approved and hearing ${h.hearingId} cancelled.`, notificationMessage: notificationSummary(notif) });
});

// =====================================================================
// Use Case: Submit Adjournment Request (Lawyer)  ->  AdjournmentRequest class
// Reviewed by the Court Clerk / Administrator.
// =====================================================================
app.get('/api/adjournment-requests', authenticate, allow('CourtClerk', 'Administrator', 'Lawyer'), (req, res) => {
  let sql = `SELECT r.*, u.name AS lawyerName, h.hearingDate, h.startTime, h.endTime, h.status AS hearingStatus, c.caseNumber
             FROM adjournment_requests r
             JOIN users u ON u.userId = r.lawyerId
             JOIN hearings h ON h.hearingId = r.hearingId
             JOIN cases c ON c.caseId = h.caseId`;
  const params = [];
  if (req.user.role === 'Lawyer') { sql += ' WHERE r.lawyerId = ?'; params.push(req.user.userId); }
  res.json(db.prepare(sql + ' ORDER BY r.requestId DESC').all(...params));
});

app.post('/api/adjournment-requests', authenticate, allow('Lawyer'), (req, res) => {
  const { hearingId, reason } = req.body || {};
  const h = getHearing(hearingId);
  if (!h) return sendError(res, 404, 'Hearing not found.');
  if (getCase(h.caseId).lawyerId !== req.user.userId) return sendError(res, 403, 'You are not the lawyer for this case.');
  if (h.status !== 'Scheduled') return sendError(res, 400, 'Adjournment can only be requested for a Scheduled hearing.');
  if (!reason || !reason.trim()) return sendError(res, 400, 'Please enter a reason.');
  if (db.prepare("SELECT 1 FROM adjournment_requests WHERE hearingId = ? AND status = 'Pending'").get(hearingId)) {
    return sendError(res, 400, 'An adjournment request for this hearing is already pending.');
  }
  db.prepare(`INSERT INTO adjournment_requests (hearingId, lawyerId, reason, requestDate, status)
              VALUES (?, ?, ?, ?, 'Pending')`).run(hearingId, req.user.userId, reason.trim(), today());
  res.json({ message: `Adjournment request for ${hearingId} submitted.` });
});

app.post('/api/adjournment-requests/:id/:decision', authenticate, allow('CourtClerk', 'Administrator'), (req, res) => {
  const r = db.prepare('SELECT * FROM adjournment_requests WHERE requestId = ?').get(req.params.id);
  if (!r) return sendError(res, 404, 'Request not found.');
  if (r.status !== 'Pending') return sendError(res, 400, `Request is already ${r.status}.`);
  if (req.params.decision === 'reject') {
    db.prepare("UPDATE adjournment_requests SET status = 'Rejected' WHERE requestId = ?").run(r.requestId);
    return res.json({ message: 'Adjournment request rejected.' });
  }
  if (req.params.decision !== 'approve') return sendError(res, 400, 'Invalid status update.');

  const h = getHearing(r.hearingId);
  if (h.status !== 'Scheduled') return sendError(res, 400, `Hearing is already ${h.status}.`);
  const approve = db.transaction(() => {
    db.prepare("UPDATE adjournment_requests SET status = 'Approved' WHERE requestId = ?").run(r.requestId);
    db.prepare("UPDATE hearings SET status = 'Adjourned' WHERE hearingId = ?").run(h.hearingId);
    addHistory(h.hearingId, 'Adjourned', `Adjournment request: ${r.reason}`, req.user.userId);
  });
  approve();
  res.json({ message: `Request approved. Hearing ${h.hearingId} is Adjourned and can now be rescheduled.` });
});

// =====================================================================
// NOTIFICATIONS: view, acknowledge (all participants),
// Retrigger Failed Notifications (Administrator)
// =====================================================================
app.get('/api/notifications', authenticate, (req, res) => {
  let sql = `SELECT n.*, u.name AS userName, u.role AS userRole FROM notifications n
             JOIN users u ON u.userId = n.userId WHERE 1 = 1`;
  const params = [];
  // Clerk and Administrator see the full log; everyone else sees their own.
  if (!['CourtClerk', 'Administrator'].includes(req.user.role)) { sql += ' AND n.userId = ?'; params.push(req.user.userId); }
  if (req.query.status) { sql += ' AND n.status = ?'; params.push(req.query.status); }
  res.json(db.prepare(sql + ' ORDER BY n.notificationId DESC').all(...params));
});

app.post('/api/notifications/:id/acknowledge', authenticate, (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE notificationId = ?').get(req.params.id);
  if (!n) return sendError(res, 404, 'Notification not found.');
  if (n.userId !== req.user.userId) return sendError(res, 403, 'You can only acknowledge your own notifications.');
  if (n.status !== 'Delivered') return sendError(res, 400, `A ${n.status} notification cannot be acknowledged.`);
  db.prepare("UPDATE notifications SET status = 'Acknowledged' WHERE notificationId = ?").run(n.notificationId);
  res.json({ message: 'Notification acknowledged.' });
});

app.post('/api/notifications/:id/retrigger', authenticate, allow('Administrator'), (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE notificationId = ?').get(req.params.id);
  if (!n) return sendError(res, 404, 'Notification not found.');
  if (n.status !== 'Failed') return sendError(res, 400, 'Only Failed notifications can be retriggered.');
  // Simulated re-send through the Notification Service.
  db.prepare("UPDATE notifications SET status = 'Delivered', sentAt = ? WHERE notificationId = ?")
    .run(nowStamp(), n.notificationId);
  res.json({ message: `Notification #${n.notificationId} retriggered and delivered.` });
});

// =====================================================================
// Use Case: Maintain Holiday Calendar (Administrator)
// =====================================================================
app.get('/api/holidays', authenticate, (req, res) => {
  res.json(db.prepare('SELECT * FROM holidays ORDER BY date').all());
});

app.post('/api/holidays', authenticate, allow('Administrator'), (req, res) => {
  const { date, description } = req.body || {};
  if (!date || !description || !description.trim()) return sendError(res, 400, 'Please enter date and description.');
  if (!DATE_RE.test(date)) return sendError(res, 400, 'Invalid date.');
  if (isCourtHoliday(date)) return sendError(res, 400, `${date} is already a court holiday.`);
  db.prepare('INSERT INTO holidays (date, description) VALUES (?, ?)').run(date, description.trim());
  const affected = db.prepare("SELECT COUNT(*) n FROM hearings WHERE hearingDate = ? AND status = 'Scheduled'").get(date).n;
  res.json({ message: `Holiday added on ${date}.` +
    (affected ? ` Note: ${affected} scheduled hearing(s) fall on this date and should be rescheduled.` : '') });
});

app.delete('/api/holidays/:id', authenticate, allow('Administrator'), (req, res) => {
  const info = db.prepare('DELETE FROM holidays WHERE holidayId = ?').run(req.params.id);
  if (info.changes === 0) return sendError(res, 404, 'Holiday not found.');
  res.json({ message: 'Holiday deleted.' });
});

// =====================================================================
// DFD PROCESS 6: GENERATE REPORTS  (Report class)
// Output goes to the Court Administrator.
// =====================================================================
function generateReport(type) {
  if (type === 'scheduled-hearings') {
    const rows = db.prepare(HEARING_SELECT + ' ORDER BY h.hearingDate, h.startTime').all();
    return {
      title: 'Scheduled Hearings Report',
      generatedAt: nowStamp(),
      columns: ['Hearing ID', 'Case Number', 'Judge', 'Date', 'Time', 'Courtroom', 'Status'],
      rows: rows.map(h => [h.hearingId, h.caseNumber, h.judgeName, h.hearingDate,
                           `${h.startTime}-${h.endTime}`, h.roomNumber, h.status]),
      summary: db.prepare('SELECT status AS label, COUNT(*) AS value FROM hearings GROUP BY status').all()
    };
  }
  if (type === 'case-status') {
    const rows = db.prepare(`SELECT c.*, j.name AS judgeName FROM cases c
                             JOIN users j ON j.userId = c.assignedJudgeId ORDER BY c.caseId`).all();
    return {
      title: 'Case Status Report',
      generatedAt: nowStamp(),
      columns: ['Case ID', 'Case Number', 'Case Type', 'Assigned Judge', 'Status'],
      rows: rows.map(c => [c.caseId, c.caseNumber, c.caseType, c.judgeName, c.status]),
      summary: db.prepare('SELECT status AS label, COUNT(*) AS value FROM cases GROUP BY status').all()
    };
  }
  return null;
}

app.get('/api/reports/:type', authenticate, allow('Administrator'), (req, res) => {
  const report = generateReport(req.params.type);
  if (!report) return sendError(res, 404, 'Unknown report type.');
  res.json(report);
});

// ---------------------------------------------------------------------
// Unknown API routes and unexpected errors: readable messages only,
// never a raw stack trace.
// ---------------------------------------------------------------------
app.use('/api', (req, res) => sendError(res, 404, 'API route not found.'));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'Invalid request data.');
  sendError(res, 500, 'Database error: the operation could not be completed.');
});

app.listen(PORT, () => {
  console.log(`CCSMS running at http://localhost:${PORT}`);
});
