// =====================================================================
// database.js
// Creates the SQLite database (ccsms.db), its tables and the seed data.
//
// Each table corresponds to a class in the UML Class Diagram:
//   users                 -> User (+ CourtClerk, Judge, Lawyer, Defendant,
//                            Witness, Administrator via the "role" column)
//   cases                 -> Case
//   documents             -> Document          (Case 1 --- * Document)
//   courtrooms            -> Courtroom
//   hearings              -> Hearing           (Case 1 --- * Hearing)
//   scheduling_history    -> "Update scheduling history" (Activity Diagram)
//   hearing_outcomes      -> HearingOutcome    (Hearing 1 --- 0..1 HearingOutcome)
//   adjournment_requests  -> AdjournmentRequest
//   cancellation_requests -> Judge "Request Hearing Cancellation" (Use Case)
//   notifications         -> Notification      (User 1 --- * Notification)
//   holidays              -> Holiday
// The Report class has no table: reports are generated from the data above.
//
// Run "npm run reset-db" to delete the database and re-create the seed data.
// =====================================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'ccsms.db');

// "node database.js --reset" deletes the old database file first.
if (require.main === module && process.argv.includes('--reset') && fs.existsSync(DB_FILE)) {
  fs.unlinkSync(DB_FILE);
  console.log('Old database deleted.');
}

const db = new Database(DB_FILE);
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------
// 1. CREATE TABLES
// ---------------------------------------------------------------------
db.exec(`
  -- User superclass. The role column implements the UML specialization:
  -- role = CourtClerk / Judge / Lawyer / Defendant / Witness / Administrator
  CREATE TABLE IF NOT EXISTS users (
    userId   INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    email    TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN
             ('CourtClerk','Judge','Lawyer','Defendant','Witness','Administrator'))
  );

  CREATE TABLE IF NOT EXISTS cases (
    caseId          TEXT PRIMARY KEY,               -- e.g. C001
    caseNumber      TEXT NOT NULL UNIQUE,           -- e.g. CC/2026/001
    caseType        TEXT NOT NULL,
    filingDate      TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('Open','Pending','Closed')),
    description     TEXT,
    assignedJudgeId INTEGER NOT NULL REFERENCES users(userId),  -- Case -> Judge
    lawyerId        INTEGER REFERENCES users(userId),           -- Case -> Lawyer
    defendantId     INTEGER REFERENCES users(userId),           -- Case -> Defendant
    witnessId       INTEGER REFERENCES users(userId)            -- Case -> Witness
  );

  CREATE TABLE IF NOT EXISTS documents (
    documentId   INTEGER PRIMARY KEY AUTOINCREMENT,
    caseId       TEXT NOT NULL REFERENCES cases(caseId),
    fileName     TEXT NOT NULL,
    documentType TEXT NOT NULL,
    uploadDate   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courtrooms (
    courtroomId INTEGER PRIMARY KEY AUTOINCREMENT,
    roomNumber  TEXT NOT NULL UNIQUE,
    capacity    INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('Available','Unavailable'))
  );

  CREATE TABLE IF NOT EXISTS hearings (
    hearingId   TEXT PRIMARY KEY,                    -- e.g. H001
    caseId      TEXT NOT NULL REFERENCES cases(caseId),
    hearingDate TEXT NOT NULL,                       -- YYYY-MM-DD
    startTime   TEXT NOT NULL,                       -- HH:MM
    endTime     TEXT NOT NULL,                       -- HH:MM
    judgeId     INTEGER NOT NULL REFERENCES users(userId),
    courtroomId INTEGER NOT NULL REFERENCES courtrooms(courtroomId),
    purpose     TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('Scheduled','Completed','Cancelled','Adjourned'))
  );

  CREATE TABLE IF NOT EXISTS scheduling_history (
    historyId   INTEGER PRIMARY KEY AUTOINCREMENT,
    hearingId   TEXT NOT NULL REFERENCES hearings(hearingId),
    action      TEXT NOT NULL,                       -- Scheduled / Rescheduled / ...
    details     TEXT,
    performedBy INTEGER REFERENCES users(userId),
    performedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hearing_outcomes (
    outcomeId  INTEGER PRIMARY KEY AUTOINCREMENT,
    hearingId  TEXT NOT NULL UNIQUE REFERENCES hearings(hearingId),
    decision   TEXT NOT NULL,
    remarks    TEXT,
    recordedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS adjournment_requests (
    requestId   INTEGER PRIMARY KEY AUTOINCREMENT,
    hearingId   TEXT NOT NULL REFERENCES hearings(hearingId),
    lawyerId    INTEGER NOT NULL REFERENCES users(userId),
    reason      TEXT NOT NULL,
    requestDate TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('Pending','Approved','Rejected'))
  );

  CREATE TABLE IF NOT EXISTS cancellation_requests (
    requestId   INTEGER PRIMARY KEY AUTOINCREMENT,
    hearingId   TEXT NOT NULL REFERENCES hearings(hearingId),
    judgeId     INTEGER NOT NULL REFERENCES users(userId),
    reason      TEXT NOT NULL,
    requestDate TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('Pending','Approved','Rejected'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    notificationId INTEGER PRIMARY KEY AUTOINCREMENT,
    userId         INTEGER NOT NULL REFERENCES users(userId),
    hearingId      TEXT REFERENCES hearings(hearingId),
    message        TEXT NOT NULL,
    type           TEXT NOT NULL,                   -- Scheduled / Rescheduled / Cancelled
    sentAt         TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('Delivered','Failed','Acknowledged'))
  );

  CREATE TABLE IF NOT EXISTS holidays (
    holidayId   INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------------
// 2. SEED DATA (only inserted when the database is empty)
// ---------------------------------------------------------------------
function seedDatabase() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) return;

  const now = new Date().toISOString();
  const addUser = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)');

  // Simple plain-text passwords: acceptable only for a lab demonstration.
  const clerk     = addUser.run('Anil Verma',       'clerk@ccsms.com',     'clerk123',     'CourtClerk').lastInsertRowid;
  const sharma    = addUser.run('Judge R. Sharma',  'judge1@ccsms.com',    'judge123',     'Judge').lastInsertRowid;
  const mehta     = addUser.run('Judge S. Mehta',   'judge2@ccsms.com',    'judge123',     'Judge').lastInsertRowid;
  const lawyer    = addUser.run('Adv. Neha Kapoor', 'lawyer@ccsms.com',    'lawyer123',    'Lawyer').lastInsertRowid;
  const defendant = addUser.run('Rahul Singh',      'defendant@ccsms.com', 'defendant123', 'Defendant').lastInsertRowid;
  const witness   = addUser.run('Pooja Iyer',       'witness@ccsms.com',   'witness123',   'Witness').lastInsertRowid;
  addUser.run('System Administrator', 'admin@ccsms.com', 'admin123', 'Administrator');

  const addCase = db.prepare(`INSERT INTO cases
    (caseId, caseNumber, caseType, filingDate, status, description, assignedJudgeId, lawyerId, defendantId, witnessId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  addCase.run('C001', 'CC/2026/001', 'Civil', '2026-09-01', 'Open',
    'Property boundary dispute between neighbours.', sharma, lawyer, defendant, witness);
  addCase.run('C002', 'CC/2026/002', 'Criminal', '2026-09-10', 'Pending',
    'Theft complaint registered at city police station.', mehta, lawyer, defendant, witness);

  db.prepare(`INSERT INTO documents (caseId, fileName, documentType, uploadDate)
              VALUES ('C001', 'sale_deed.pdf', 'Evidence', '2026-09-01')`).run();

  const addRoom = db.prepare('INSERT INTO courtrooms (roomNumber, capacity, status) VALUES (?, ?, ?)');
  const room1 = addRoom.run('Courtroom 1', 40, 'Available').lastInsertRowid;
  addRoom.run('Courtroom 2', 30, 'Available');
  addRoom.run('Courtroom 3', 25, 'Available');

  // One existing hearing so that conflict detection can be demonstrated.
  db.prepare(`INSERT INTO hearings
    (hearingId, caseId, hearingDate, startTime, endTime, judgeId, courtroomId, purpose, status)
    VALUES ('H001', 'C001', '2026-10-15', '10:00', '11:00', ?, ?, 'First hearing', 'Scheduled')`)
    .run(sharma, room1);
  db.prepare(`INSERT INTO scheduling_history (hearingId, action, details, performedBy, performedAt)
              VALUES ('H001', 'Scheduled', '2026-10-15 10:00-11:00, Courtroom 1', ?, ?)`).run(clerk, now);

  const addNotification = db.prepare(`INSERT INTO notifications
    (userId, hearingId, message, type, sentAt, status) VALUES (?, 'H001', ?, 'Scheduled', ?, 'Delivered')`);
  const msg = '[Email/SMS] Hearing H001 for case CC/2026/001 is scheduled on 2026-10-15, 10:00-11:00 in Courtroom 1.';
  for (const userId of [sharma, lawyer, defendant, witness]) addNotification.run(userId, msg, now);

  const addHoliday = db.prepare('INSERT INTO holidays (date, description) VALUES (?, ?)');
  addHoliday.run('2026-10-02', 'Gandhi Jayanti');
  addHoliday.run('2026-12-25', 'Christmas');

  console.log('Seed data inserted.');
}

seedDatabase();

module.exports = db;
