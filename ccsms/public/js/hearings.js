// =====================================================================
// hearings.js - Use Case: View Hearing Schedule (all actors)
// Court Clerk : Reschedule Hearing, Cancel Hearing
// Judge       : Record Hearing Outcome
// Lawyer / Defendant: view only
// =====================================================================
const user = initPage('hearings.html');
const panel = document.getElementById('hearingPanel');
let courtrooms = [];

if (user && user.role === 'Judge') document.getElementById('pageTitle').textContent = 'My Hearings & Outcomes';
if (user && ['Lawyer', 'Defendant'].includes(user.role)) document.getElementById('pageTitle').textContent = 'Hearing Schedule';

async function init() {
  try {
    // Filter options are built from the hearings this user is allowed to see.
    const all = await api('GET', '/api/hearings');
    const caseOptions = uniqueBy(all, 'caseId').map(h => ({ id: h.caseId, text: `${h.caseId} - ${h.caseNumber}` }));
    const judgeOptions = uniqueBy(all, 'judgeId').map(h => ({ id: h.judgeId, text: h.judgeName }));
    fillSelect(document.getElementById('caseFilter'), caseOptions, 'id', o => o.text, 'All');
    fillSelect(document.getElementById('judgeFilter'), judgeOptions, 'id', o => o.text, 'All');
    if (user.role === 'Judge') document.getElementById('judgeFilterBox').classList.add('hidden');
    if (user.role === 'CourtClerk') courtrooms = await api('GET', '/api/courtrooms');
    await loadHearings();
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter(item => !seen.has(item[key]) && seen.add(item[key]));
}

async function loadHearings() {
  const f = readForm(document.getElementById('filterForm'));
  const query = new URLSearchParams(f).toString();
  try {
    const hearings = await api('GET', '/api/hearings?' + query);
    renderRows(document.getElementById('hearingRows'), hearings, h => `
      <tr>
        <td>${esc(h.hearingId)}</td>
        <td>${esc(h.caseNumber)}</td>
        <td>${esc(h.hearingDate)}</td>
        <td>${esc(h.startTime)}</td>
        <td>${esc(h.endTime)}</td>
        <td>${esc(h.judgeName)}</td>
        <td>${esc(h.roomNumber)}</td>
        <td>${badge(h.status)}</td>
        <td>${esc(h.purpose)}</td>
        <td><div class="actions">${hearingButtons(h)}</div></td>
      </tr>`, 10);
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

function hearingButtons(h) {
  let html = `<button class="small secondary" onclick="viewHearing('${h.hearingId}')">Details</button>`;
  const active = h.status === 'Scheduled' || h.status === 'Adjourned';
  if (user.role === 'CourtClerk' && active) {
    html += `<button class="small" onclick="showReschedule('${h.hearingId}')">Reschedule</button>`;
    html += `<button class="small danger" onclick="showCancel('${h.hearingId}')">Cancel</button>`;
  }
  if (user.role === 'Judge' && h.status === 'Scheduled') {
    html += `<button class="small" onclick="showOutcome('${h.hearingId}')">Record Outcome</button>`;
  }
  return html;
}

// ---------- Details: outcome + scheduling history ----------
async function viewHearing(id) {
  try {
    const h = await api('GET', '/api/hearings/' + id);
    panel.innerHTML = `
      <h2>Hearing ${esc(h.hearingId)}</h2>
      ${hearingSummary(h)}
      <h3 style="margin-top:16px">Hearing Outcome</h3>
      ${h.outcome
        ? `<table class="details-table">
             <tr><th>Decision</th><td>${esc(h.outcome.decision)}</td></tr>
             <tr><th>Remarks</th><td>${esc(h.outcome.remarks)}</td></tr>
             <tr><th>Recorded At</th><td>${esc(h.outcome.recordedAt)}</td></tr></table>`
        : '<p class="muted">No outcome recorded yet.</p>'}
      <h3 style="margin-top:16px">Scheduling History</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th>Details</th><th>By</th></tr></thead>
        <tbody>${h.history.map(s => `<tr><td>${esc(s.performedAt)}</td><td>${esc(s.action)}</td>
          <td>${esc(s.details)}</td><td>${esc(s.performedByName || '-')}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="actions"><button class="secondary" onclick="hidePanel()">Close Panel</button></div>`;
    showPanel();
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

function hearingSummary(h) {
  return `
    <table class="details-table">
      <tr><th>Case Number</th><td>${esc(h.caseNumber)}</td></tr>
      <tr><th>Judge</th><td>${esc(h.judgeName)}</td></tr>
      <tr><th>Date / Time</th><td>${esc(h.hearingDate)}, ${esc(h.startTime)} - ${esc(h.endTime)}</td></tr>
      <tr><th>Courtroom</th><td>${esc(h.roomNumber)}</td></tr>
      <tr><th>Purpose</th><td>${esc(h.purpose)}</td></tr>
      <tr><th>Status</th><td>${badge(h.status)}</td></tr>
    </table>`;
}

// ---------- Use Case: Reschedule Hearing (Court Clerk) ----------
// Select hearing -> enter new date/time -> check Judge + Courtroom
// -> valid: update + notify | conflict: show conflict (+ alternatives)
async function showReschedule(id) {
  try {
    const h = await api('GET', '/api/hearings/' + id);
    panel.innerHTML = `
      <h2>Reschedule Hearing ${esc(h.hearingId)}</h2>
      ${hearingSummary(h)}
      <form id="rescheduleForm" style="margin-top:16px">
        <div class="form-grid">
          <div><label>New Date *</label><input type="date" name="hearingDate" min="${todayText()}" value="${esc(h.hearingDate)}"></div>
          <div><label>Start Time *</label><input type="time" name="startTime" value="${esc(h.startTime)}"></div>
          <div><label>End Time *</label><input type="time" name="endTime" value="${esc(h.endTime)}"></div>
          <div><label>Courtroom *</label><select name="courtroomId" id="rsRoom"></select></div>
        </div>
        <label class="checkbox" style="margin-top:12px"><input type="checkbox" name="simulateFailure">
          Simulate notification failure (demo mode)</label>
        <div class="actions">
          <button type="submit">Check Availability &amp; Reschedule</button>
          <button type="button" class="secondary" onclick="hidePanel()">Cancel</button>
        </div>
      </form>
      <div id="rescheduleConflict"></div>`;
    fillSelect(document.getElementById('rsRoom'), courtrooms.filter(r => r.status === 'Available'),
      'courtroomId', r => r.roomNumber);
    document.getElementById('rsRoom').value = h.courtroomId;
    showPanel();

    document.getElementById('rescheduleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      document.getElementById('rescheduleConflict').innerHTML = '';
      try {
        const result = await api('PUT', `/api/hearings/${id}/reschedule`, readForm(form));
        hidePanel();
        showMessage('hearingMessage', `${result.message} ${result.notificationMessage}`, 'success');
        loadHearings();
      } catch (err) {
        if (err.status === 409 && err.data.conflicts) {
          showRescheduleConflict(err.data, form);
        } else {
          showMessage('hearingMessage', err.message, 'error');
        }
      }
    });
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

// Same conflict display as Schedule Hearing; "Use" copies an alternative into the form.
function showRescheduleConflict(data, form) {
  const box = document.getElementById('rescheduleConflict');
  box.innerHTML = `
    <div class="conflict-box" style="margin-top:16px">
      <strong>Scheduling Conflict:</strong>
      <ul>${data.conflicts.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    </div>
    ${data.alternatives.length ? `
      <h3>Compatible Alternative Slots</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Start</th><th>End</th><th>Courtroom</th><th></th></tr></thead>
        <tbody>${data.alternatives.map((a, i) => `<tr><td>${esc(a.hearingDate)}</td><td>${esc(a.startTime)}</td>
          <td>${esc(a.endTime)}</td><td>${esc(a.roomNumber)}</td>
          <td><button type="button" class="small" data-index="${i}">Use This Slot</button></td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="message warning">No alternative slot found. Try another date.</p>'}`;

  box.querySelectorAll('button[data-index]').forEach(button => {
    button.addEventListener('click', () => {
      const a = data.alternatives[button.dataset.index];
      form.elements.hearingDate.value = a.hearingDate;
      form.elements.startTime.value = a.startTime;
      form.elements.endTime.value = a.endTime;
      form.elements.courtroomId.value = a.courtroomId;
      box.innerHTML = '<p class="message info">Alternative slot copied into the form. Click "Check Availability &amp; Reschedule".</p>';
    });
  });
}

// ---------- Use Case: Cancel Hearing (Court Clerk) ----------
async function showCancel(id) {
  try {
    const h = await api('GET', '/api/hearings/' + id);
    panel.innerHTML = `
      <h2>Cancel Hearing ${esc(h.hearingId)}</h2>
      ${hearingSummary(h)}
      <form id="cancelForm" style="margin-top:16px">
        <label>Cancellation Reason *</label>
        <textarea name="reason" placeholder="e.g. Judge on leave"></textarea>
        <p class="muted">The hearing is kept in the database with status "Cancelled" and all participants are notified.</p>
        <div class="actions">
          <button type="submit" class="danger">Cancel Hearing</button>
          <button type="button" class="secondary" onclick="hidePanel()">Back</button>
        </div>
      </form>`;
    showPanel();

    document.getElementById('cancelForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('POST', `/api/hearings/${id}/cancel`, readForm(event.target));
        hidePanel();
        showMessage('hearingMessage', `${result.message} ${result.notificationMessage}`, 'success');
        loadHearings();
      } catch (err) {
        showMessage('hearingMessage', err.message, 'error');
      }
    });
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

// ---------- Use Case: Record Hearing Outcome (Judge) ----------
async function showOutcome(id) {
  try {
    const h = await api('GET', '/api/hearings/' + id);
    panel.innerHTML = `
      <h2>Record Outcome - Hearing ${esc(h.hearingId)}</h2>
      ${hearingSummary(h)}
      <form id="outcomeForm" style="margin-top:16px">
        <div class="form-grid">
          <div><label>Decision *</label>
            <select name="decision">
              <option value="">-- Select --</option>
              <option value="Completed">Completed (hearing concluded)</option>
              <option value="Adjourned">Adjourned (to be rescheduled)</option>
            </select></div>
          <div class="full"><label>Remarks *</label>
            <textarea name="remarks" placeholder="e.g. Additional documents required."></textarea></div>
        </div>
        <div class="actions">
          <button type="submit">Save Outcome</button>
          <button type="button" class="secondary" onclick="hidePanel()">Cancel</button>
        </div>
      </form>`;
    showPanel();

    document.getElementById('outcomeForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('POST', `/api/hearings/${id}/outcome`, readForm(event.target));
        hidePanel();
        showMessage('hearingMessage', result.message, 'success');
        loadHearings();
      } catch (err) {
        showMessage('hearingMessage', err.message, 'error');
      }
    });
  } catch (err) {
    showMessage('hearingMessage', err.message, 'error');
  }
}

function showPanel() {
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth' });
}

function hidePanel() {
  panel.classList.add('hidden');
}

document.getElementById('filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadHearings();
});

document.getElementById('clearFilters').addEventListener('click', () => {
  document.getElementById('filterForm').reset();
  loadHearings();
});

if (user) init();
