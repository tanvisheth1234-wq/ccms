# Court Case Scheduling and Hearing Management System (CCSMS)

A simple end-to-end web application built directly from the CCSMS Software Engineering
design artifacts: the Use Case, Class, Sequence/Collaboration, Activity and Data Flow diagrams.
Every feature in the application traces back to one of these diagrams.

## Technology

```text
HTML
CSS
JavaScript (vanilla)
Node.js
Express
SQLite (better-sqlite3)
```

## How to Run

```bash
cd ccsms
npm install
node server.js
```

Then open:

```text
http://localhost:3000
```

The database file `ccsms.db` is created and filled with seed data on the first start.
To start again from clean seed data, stop the server and run:

```bash
npm run reset-db
```

## Demo Accounts

| Role | Email | Password |
|---|---|---|
| Court Clerk | clerk@ccsms.com | clerk123 |
| Judge (Judge R. Sharma) | judge1@ccsms.com | judge123 |
| Judge (Judge S. Mehta) | judge2@ccsms.com | judge123 |
| Lawyer / Party Representative | lawyer@ccsms.com | lawyer123 |
| Defendant | defendant@ccsms.com | defendant123 |
| Witness | witness@ccsms.com | witness123 |
| System Administrator | admin@ccsms.com | admin123 |

On the login page you can click a row of the demo table to fill in the credentials.

### Seed data

- **Cases:**
  - C001, CC/2026/001: Civil, Judge Sharma, Open
  - C002, CC/2026/002: Criminal, Judge Mehta, Pending
- **Courtrooms:** Courtroom 1, Courtroom 2 and Courtroom 3.
- **Hearing H001:** case C001 on 2026-10-15 from 10:00 to 11:00, with Judge Sharma in Courtroom 1. Its status is Scheduled. You can use it to demonstrate conflicts.
- **Court holidays:** 2026-10-02 (Gandhi Jayanti) and 2026-12-25 (Christmas).

## Project Structure

```text
ccsms/
├── server.js              Express routes + business logic (grouped by DFD process)
├── database.js            SQLite tables (one per UML class) + seed data
├── package.json
├── ccsms.db               created automatically
└── public/
    ├── index.html         Login
    ├── dashboard.html     Welcome, role, summary, use cases of the role
    ├── cases.html         View / Search / Update / Close cases, Documents, Reassign Judge
    ├── register-case.html Register New Case + Assign Judge
    ├── schedule.html      Schedule Hearing (Sequence + Activity diagram flow)
    ├── hearings.html      View hearings, Reschedule, Cancel, Record Outcome
    ├── requests.html      Adjournment requests, Judge cancellation requests
    ├── notifications.html Notifications, Acknowledge, Retrigger failed
    ├── users.html         Manage Users & Roles
    ├── holidays.html      Maintain Holiday Calendar
    ├── reports.html       Generate Reports
    ├── style.css
    └── js/
        ├── common.js      login check, role menu, API helper, messages
        ├── register-case.js, cases.js, schedule.js,
        └── hearings.js, requests.js, notifications.js
```

## Implemented Modules

1. **Login / Authentication:** role-based menu; "Login valid?" decision.
2. **Case Management:** Register, View, Search (ID, Number, Type, Status), Update, Close, Documents (metadata only).
3. **Judge Assignment:** the Clerk assigns the Judge at registration, and the Administrator reassigns.
4. **Courtroom:** seeded courtrooms. Availability is computed from existing hearings.
5. **Hearing Scheduling:** availability check, conflict handling, alternative slots, confirmation, unique Hearing ID (H001, H002, ...) and scheduling history.
6. **Reschedule / Cancel Hearing:** reuses the same availability logic. A cancelled hearing is kept with status `Cancelled`.
7. **Judge Portal:** View Assigned Cases, View Hearings, Record Hearing Outcome, Request Hearing Cancellation.
8. **Lawyer Portal:** View Hearing Schedule, Submit Adjournment Request.
9. **Defendant / Witness Portal:** View Hearings (Defendant only), View and Acknowledge Notifications.
10. **Notification Service (simulated):** Delivered, Failed or Acknowledged. You can simulate failure, and the Administrator can retrigger.
11. **Administrator:** Manage Users & Roles, Reassign Judge, Holiday Calendar, Failed Notifications, Reports.
12. **Reports:** Scheduled Hearings Report and Case Status Report, shown as HTML tables.

## UML Mapping

| Implementation Feature | Related UML Artifact |
|---|---|
| Login, role-based menus | Use Case (Login) + Activity ("Login valid?") + DFD 1 |
| `users` table with `role` column | Class Diagram (User superclass + 6 specializations) |
| Case registration | Use Case + Class Diagram (Case) |
| Judge assignment / reassignment | Use Case Diagram (Assign Judge, Reassign Judge) |
| Search / Update / Close case | Use Case Diagram |
| Documents of a case | Class Diagram (Case 1 → * Document) |
| Schedule hearing | Sequence + Activity Diagram, DFD 2 |
| Availability check (Judge ‖ Courtroom) | Sequence (msgs 4–7) + Activity (fork/join) + DFD 3 |
| Conflict and alternative slots | Sequence (msgs 18–23) + Activity ("Judge unavailable?") |
| Confirm, create hearing, Hearing ID, status Scheduled | Sequence (msgs 11–14) + Activity + DFD 4 |
| Scheduling history | Activity ("Update scheduling history") |
| Notifications (Delivered / Failed) | Class + Sequence (msgs 15–16) + Activity ("Notifications delivered?") + DFD 5 |
| Acknowledge notification | DFD 5 (Acknowledgement flows) |
| Retrigger failed notifications | Use Case Diagram |
| Reschedule / Cancel hearing | Use Case Diagram |
| Record hearing outcome | Use Case + Class Diagram (HearingOutcome) |
| Request hearing cancellation (Judge) | Use Case Diagram |
| Submit adjournment request (Lawyer) | Use Case + Class Diagram (AdjournmentRequest) |
| Holiday calendar | Use Case + Class Diagram (Holiday) |
| Reports | Use Case + Class (Report) + DFD 6 |

### DFD processes → code (`server.js`)

| DFD Process | Function / Route |
|---|---|
| 1 Authenticate User | `loginUser()`, `POST /api/login` |
| 2 Manage Hearing Request | `POST /api/hearings/check-availability`, case routes |
| 3 Check Availability | `checkJudgeAvailability()`, `checkCourtroomAvailability()`, `checkAvailability()` |
| 4 Allocate Hearing Slot | `createHearing()` |
| 5 Send Notifications | `sendNotifications()` |
| 6 Generate Reports | `generateReport()` |

Data stores: D1 User Database → `users`, D2 Case Database → `cases`, D3 Judge Database → `users` (role = Judge),
D4 Courtroom Database → `courtrooms`, D5 Hearing Schedule → `hearings`.

### Activity diagram decisions → code

| Decision | Where |
|---|---|
| Login valid? | `loginUser()` (server.js) and the login form in `index.html` |
| Judge and Courtroom available? | `checkAvailability()` (server.js) and `showAvailability()` (schedule.js) |
| Judge unavailable? | `generateAlternativeSlots()` (server.js) |
| Confirm hearing? | `confirmHearing()` / `cancelScheduling()` (schedule.js) |
| Notifications delivered? | `sendNotifications()` (server.js) |

After each step, the Schedule Hearing page prints the Sequence Diagram messages it executed
(for example `4: checkAvailability(...) -> Judge` and `13: assignHearingID() -> H002`), so you can show the
mapping live during the viva.

### Class diagram → tables

| Class | Table |
|---|---|
| User, CourtClerk, Judge, Lawyer, Defendant, Witness, Administrator | `users` (`role` column) |
| Case | `cases` (assignedJudgeId, lawyerId, defendantId, witnessId) |
| Document | `documents` |
| Courtroom | `courtrooms` |
| Hearing | `hearings` |
| HearingOutcome | `hearing_outcomes` |
| AdjournmentRequest | `adjournment_requests` |
| Notification | `notifications` |
| Holiday | `holidays` |
| Report | no table; generated from the data by `generateReport()` |
| (Activity: "Update scheduling history") | `scheduling_history` |
| (Use case: Request Hearing Cancellation) | `cancellation_requests` |

## Key Business Rules

- **Overlap rule (Judge and Courtroom):** two hearings conflict when they are on the same date and
  `newStart < existingEnd AND newEnd > existingStart`. For example, 10:30–11:30 conflicts with 10:00–11:00,
  but 11:00–12:00 does not.
- Only `Scheduled` and `Completed` hearings occupy a slot. `Cancelled` and `Adjourned` hearings free it.
- Alternative slots are nearby 30-minute steps within court hours (09:00–17:00) on the requested day and the
  next two days, skipping holidays. Each one gets a free courtroom, and the requested courtroom is preferred.
- Scheduling and rescheduling are blocked on a court holiday ("Scheduling not allowed on Court Holiday").
- A hearing is created only after the clerk clicks **Confirm Hearing**. The server re-checks availability at that moment.
- A Judge's cancellation request does not cancel the hearing. The Court Clerk approves it and performs the cancellation.
- An approved adjournment request sets the hearing to `Adjourned`, after which the Clerk can reschedule it.
- Notifications go to the Judge, Lawyer, Defendant and Witness of the case when a hearing is Scheduled,
  Rescheduled or Cancelled.

## Viva Demo Script

1. **Login:** log in as `clerk@ccsms.com`. Try a wrong password first to show the login error.
2. **Register Case:** go to Register Case, enter `CC/2026/003`, choose Civil and Judge R. Sharma, add the parties, and save. The new case is `C003`.
3. **Schedule Hearing (available):** go to Schedule Hearing and select C002 (Judge Mehta). Enter 2026-10-15, 10:00–11:00, Courtroom 2, then click Check Availability, Select Slot and Confirm. The system creates hearing H002 and sends notifications.
4. **Conflict:** select C003 (Judge Sharma) with 2026-10-15, 10:30–11:30, Courtroom 1. Both the Judge and the Courtroom are unavailable because of H001. Pick one of the alternatives and confirm it.
5. **Holiday:** log in as Admin and add the holiday 2026-10-20. Then, as Clerk, try to schedule on that date. It is blocked.
6. **Judge:** log in as `judge1@ccsms.com`. View assigned cases and hearings, record an outcome for H001 (Adjourned: "Additional documents required."), and submit a cancellation request for the hearing created in step 4.
7. **Lawyer:** log in as `lawyer@ccsms.com`. View the hearing schedule and submit an adjournment request.
8. **Clerk:** open Requests and approve or reject them. Open Hearings to reschedule or cancel a hearing.
9. **Defendant / Witness:** open Notifications and click Acknowledge.
10. **Notification failure:** when confirming a hearing, tick "Simulate notification failure". As Admin, open Failed Notifications and click Retrigger.
11. **Admin:** Manage Users & Roles, Reassign Judge (Cases & Judge Assignment), and Generate both reports.

## Notes

- The Notification Service is simulated. No e-mail or SMS API is used, and each notification is stored in the `notifications` table.
- Passwords are stored as plain text, and login sessions are kept in server memory, so restarting the server logs everyone out. This is acceptable for a lab demonstration only.
- Documents store metadata only (file name, type, date). No real file is uploaded.
