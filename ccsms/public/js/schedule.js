// =====================================================================
// schedule.js - Use Case: Schedule Hearing (Court Clerk)
//
// Follows the Sequence Diagram and the Activity Diagram:
//   Select case -> Request hearing scheduling -> Enter preferred date/time
//   -> Retrieve assigned Judge -> Check Judge || Check Courtroom
//   -> [Judge and Courtroom available?]
//        Yes: Display available slot  -> Select preferred slot
//        No : Identify conflict -> Find compatible slots
//             -> Display alternatives -> Select alternative
//   -> Display selected hearing details -> Review -> [Confirm hearing?]
//        Yes: Create hearing ... Send notifications -> Display success
//        No : Cancel scheduling operation -> Discard unconfirmed selection
// =====================================================================
const user = initPage('schedule.html');

let cases = [];
let courtrooms = [];
let request = null;        // the hearing request entered in step 1
let selectedSlot = null;   // the slot chosen in step 2 (not yet confirmed)
let currentSlots = [];     // slots currently offered in step 2

const availabilitySection = document.getElementById('availabilitySection');
const reviewSection = document.getElementById('reviewSection');
const resultSection = document.getElementById('resultSection');

function setStep(number) {
  for (let i = 1; i <= 4; i++) {
    document.getElementById('step' + i).className = i < number ? 'done' : (i === number ? 'active' : '');
  }
}

async function loadForm() {
  try {
    cases = (await api('GET', '/api/cases')).filter(c => c.status !== 'Closed');
    courtrooms = (await api('GET', '/api/courtrooms')).filter(r => r.status === 'Available');
    fillSelect(document.getElementById('caseId'), cases, 'caseId',
      c => `${c.caseId} - ${c.caseNumber} (${c.caseType})`, '-- Select Case --');
    fillSelect(document.getElementById('courtroomId'), courtrooms, 'courtroomId', r => r.roomNumber);
    document.getElementById('hearingDate').min = todayText();
    setStep(1);
  } catch (err) {
    showMessage('scheduleMessage', err.message, 'error');
  }
}

// Activity: "Retrieve assigned Judge details"
document.getElementById('caseId').addEventListener('change', (event) => {
  const c = cases.find(x => x.caseId === event.target.value);
  document.getElementById('judgeName').value = c ? c.judgeName : '';
});

// ---------- STEP 1 -> STEP 2: request hearing & check availability ----------
document.getElementById('requestForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = readForm(event.target);
  if (!data.caseId || !data.hearingDate || !data.startTime || !data.endTime || !data.courtroomId || !data.purpose) {
    showMessage('scheduleMessage', 'Please fill in all required (*) fields.', 'error');
    return;
  }
  request = data;
  selectedSlot = null;
  reviewSection.classList.add('hidden');
  resultSection.classList.add('hidden');

  try {
    // Sequence Diagram 3-7: requestScheduleHearing(caseId) + checkAvailability x2
    const result = await api('POST', '/api/hearings/check-availability', data);
    showMessage('scheduleMessage', '', 'info');
    showAvailability(result);
  } catch (err) {
    // e.g. court holiday, past date, invalid time
    availabilitySection.classList.add('hidden');
    showMessage('scheduleMessage', err.message, 'error');
  }
});

// Activity Diagram Decision: "Judge and Courtroom available?"
function showAvailability(result) {
  let html = '';
  if (result.available) {
    // [Yes] -> Display available hearing slots (Sequence step 8)
    html = `
      <h2>Available Hearing Slot</h2>
      <p class="message success">Judge available &#10004; &nbsp; Courtroom available &#10004;</p>
      ${slotTable([result.requested], 'Select Slot')}`;
  } else {
    // [No] -> Identify scheduling conflict (Sequence step 18)
    html = `
      <h2>Scheduling Conflict</h2>
      <div class="conflict-box">
        <strong>Scheduling Conflict:</strong>
        <ul>${result.conflicts.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      </div>
      <h3>Compatible Alternative Slots</h3>
      <p class="muted">${result.judgeAvailable
        ? 'Courtroom-compatible slots: the Judge is free, so the same time in another courtroom is tried first.'
        : 'Judge-compatible slots: nearby times when the assigned Judge is free.'}</p>
      ${result.alternatives.length
        ? slotTable(result.alternatives, 'Select Alternative')
        : '<p class="message warning">No alternative slot found in the next 3 working days. Please try another date.</p>'}`;
  }
  html += `<pre class="trace">${result.trace.map(esc).join('\n')}</pre>`;

  availabilitySection.innerHTML = html;
  availabilitySection.classList.remove('hidden');
  availabilitySection.scrollIntoView({ behavior: 'smooth' });
  currentSlots = result.available ? [result.requested] : result.alternatives;
  setStep(2);
}

function slotTable(slots, buttonText) {
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Start</th><th>End</th><th>Courtroom</th><th></th></tr></thead>
      <tbody>${slots.map((s, i) => `
        <tr>
          <td>${esc(s.hearingDate)}</td><td>${esc(s.startTime)}</td><td>${esc(s.endTime)}</td><td>${esc(s.roomNumber)}</td>
          <td><button class="small" onclick="selectSlot(${i})">${buttonText}</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

// ---------- STEP 3: select slot -> display selected hearing details ----------
// Sequence Diagram 9-10: selectSlot(date, time, courtroom) -> displayConfirmation()
function selectSlot(index) {
  selectedSlot = currentSlots[index];
  const c = cases.find(x => x.caseId === request.caseId);

  reviewSection.innerHTML = `
    <h2>Review Hearing Details</h2>
    <p class="muted">Review date, time, Judge, Courtroom and parties before confirming.</p>
    <table class="details-table">
      <tr><th>Case Number</th><td>${esc(c.caseNumber)} (${esc(c.caseId)})</td></tr>
      <tr><th>Judge</th><td>${esc(c.judgeName)}</td></tr>
      <tr><th>Date</th><td>${esc(selectedSlot.hearingDate)}</td></tr>
      <tr><th>Start Time</th><td>${esc(selectedSlot.startTime)}</td></tr>
      <tr><th>End Time</th><td>${esc(selectedSlot.endTime)}</td></tr>
      <tr><th>Courtroom</th><td>${esc(selectedSlot.roomNumber)}</td></tr>
      <tr><th>Purpose</th><td>${esc(request.purpose)}</td></tr>
    </table>
    <label class="checkbox" style="margin-top:14px">
      <input type="checkbox" id="simulateFailure">
      Simulate notification failure (demo mode - tests the "Notifications delivered?" [No] branch)
    </label>
    <div class="actions">
      <button class="success" onclick="confirmHearing()">Confirm Hearing</button>
      <button class="secondary" onclick="cancelScheduling()">Cancel</button>
    </div>`;
  availabilitySection.classList.add('hidden');
  reviewSection.classList.remove('hidden');
  reviewSection.scrollIntoView({ behavior: 'smooth' });
  setStep(3);
}

// Activity Decision "Confirm hearing?" [No]
// -> Cancel scheduling operation -> Discard unconfirmed slot selection
function cancelScheduling() {
  selectedSlot = null;
  request = null;
  reviewSection.classList.add('hidden');
  availabilitySection.classList.add('hidden');
  document.getElementById('requestForm').reset();
  document.getElementById('judgeName').value = '';
  setStep(1);
  showMessage('scheduleMessage', 'Scheduling operation cancelled. The unconfirmed slot selection was discarded.', 'warning');
}

// Activity Decision "Confirm hearing?" [Yes]  (Sequence step 11: confirmHearing())
async function confirmHearing() {
  const body = {
    caseId: request.caseId,
    purpose: request.purpose,
    hearingDate: selectedSlot.hearingDate,
    startTime: selectedSlot.startTime,
    endTime: selectedSlot.endTime,
    courtroomId: selectedSlot.courtroomId,
    simulateFailure: document.getElementById('simulateFailure').checked
  };
  try {
    // Server: createHearing -> assignHearingID -> setStatus("Scheduled")
    //         -> sendHearingNotification -> notification status
    const result = await api('POST', '/api/hearings', body);
    const h = result.hearing;
    const notifFailed = result.notifications.failed > 0;

    resultSection.innerHTML = `
      <h2>Hearing Scheduled Successfully</h2>
      <p class="message success">${esc(result.message)}</p>
      <p class="message ${notifFailed ? 'warning' : 'success'}">${esc(result.notificationMessage)}</p>
      <table class="details-table">
        <tr><th>Hearing ID</th><td><strong>${esc(h.hearingId)}</strong></td></tr>
        <tr><th>Case Number</th><td>${esc(h.caseNumber)}</td></tr>
        <tr><th>Judge</th><td>${esc(h.judgeName)}</td></tr>
        <tr><th>Date / Time</th><td>${esc(h.hearingDate)}, ${esc(h.startTime)} - ${esc(h.endTime)}</td></tr>
        <tr><th>Courtroom</th><td>${esc(h.roomNumber)}</td></tr>
        <tr><th>Status</th><td>${badge(h.status)}</td></tr>
      </table>
      <pre class="trace">${result.trace.map(esc).join('\n')}</pre>
      <div class="actions"><button onclick="startOver()">Schedule Another Hearing</button>
        <button class="secondary" onclick="location.href='hearings.html'">View Hearings</button></div>`;
    reviewSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    resultSection.scrollIntoView({ behavior: 'smooth' });
    showMessage('scheduleMessage', '', 'info');
    setStep(5);
  } catch (err) {
    if (err.status === 409 && err.data.alternatives) {
      // The slot was taken in the meantime: back to the conflict path.
      reviewSection.classList.add('hidden');
      showAvailability({ ...err.data, trace: ['Slot no longer available - conflict detected again.'] });
    }
    showMessage('scheduleMessage', err.message, 'error');
  }
}

function startOver() {
  resultSection.classList.add('hidden');
  document.getElementById('requestForm').reset();
  document.getElementById('judgeName').value = '';
  showMessage('scheduleMessage', '', 'info');
  setStep(1);
}

if (user) loadForm();
