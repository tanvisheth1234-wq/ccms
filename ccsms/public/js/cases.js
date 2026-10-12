// =====================================================================
// cases.js
// Court Clerk : View / Search / Update Case Details / Close Case / Documents
// Judge       : View Assigned Cases (read only)
// Administrator: Reassign Judge
// =====================================================================
const user = initPage('cases.html');
const panel = document.getElementById('casePanel');
let usersByRole = {};          // option lists for the edit / reassign forms

if (user && user.role === 'Judge') document.getElementById('pageTitle').textContent = 'My Assigned Cases';
if (user && user.role === 'Administrator') document.getElementById('pageTitle').textContent = 'Cases & Judge Assignment';

async function loadCases() {
  const search = document.getElementById('search').value.trim();
  const status = document.getElementById('statusFilter').value;
  try {
    const cases = await api('GET', `/api/cases?search=${encodeURIComponent(search)}&status=${status}`);
    renderRows(document.getElementById('caseRows'), cases, c => `
      <tr>
        <td>${esc(c.caseId)}</td>
        <td>${esc(c.caseNumber)}</td>
        <td>${esc(c.caseType)}</td>
        <td>${esc(c.filingDate)}</td>
        <td>${esc(c.judgeName)}</td>
        <td>${badge(c.status)}</td>
        <td><div class="actions">${caseButtons(c)}</div></td>
      </tr>`, 7);
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

// Only the buttons allowed for the current actor are shown.
function caseButtons(c) {
  let html = `<button class="small secondary" onclick="viewCase('${c.caseId}')">View</button>`;
  if (user.role === 'CourtClerk') {
    html += `<button class="small" onclick="editCase('${c.caseId}')">Update</button>`;
    if (c.status !== 'Closed') html += `<button class="small danger" onclick="closeCase('${c.caseId}')">Close</button>`;
  }
  if (user.role === 'Administrator') {
    html += `<button class="small" onclick="showReassign('${c.caseId}')">Reassign Judge</button>`;
  }
  return html;
}

// ---------- View case (details, parties, hearings, documents) ----------
async function viewCase(caseId) {
  try {
    const c = await api('GET', '/api/cases/' + caseId);
    panel.innerHTML = `
      <h2>Case ${esc(c.caseId)} - ${esc(c.caseNumber)}</h2>
      <table class="details-table">
        <tr><th>Case Type</th><td>${esc(c.caseType)}</td></tr>
        <tr><th>Filing Date</th><td>${esc(c.filingDate)}</td></tr>
        <tr><th>Status</th><td>${badge(c.status)}</td></tr>
        <tr><th>Assigned Judge</th><td>${esc(c.judgeName)}</td></tr>
        <tr><th>Lawyer</th><td>${esc(c.lawyerName || '-')}</td></tr>
        <tr><th>Defendant</th><td>${esc(c.defendantName || '-')}</td></tr>
        <tr><th>Witness</th><td>${esc(c.witnessName || '-')}</td></tr>
        <tr><th>Description</th><td>${esc(c.description || '-')}</td></tr>
      </table>

      <h3 style="margin-top:20px">Hearings</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Hearing ID</th><th>Date</th><th>Time</th><th>Courtroom</th><th>Purpose</th><th>Status</th></tr></thead>
        <tbody>${c.hearings.length ? c.hearings.map(h => `
          <tr><td>${esc(h.hearingId)}</td><td>${esc(h.hearingDate)}</td><td>${esc(h.startTime)}-${esc(h.endTime)}</td>
              <td>${esc(h.roomNumber)}</td><td>${esc(h.purpose)}</td><td>${badge(h.status)}</td></tr>`).join('')
          : '<tr><td colspan="6" class="muted">No hearings yet.</td></tr>'}</tbody>
      </table></div>

      <h3 style="margin-top:20px">Documents</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>File Name</th><th>Type</th><th>Upload Date</th></tr></thead>
        <tbody>${c.documents.length ? c.documents.map(d => `
          <tr><td>${d.documentId}</td><td>${esc(d.fileName)}</td><td>${esc(d.documentType)}</td><td>${esc(d.uploadDate)}</td></tr>`).join('')
          : '<tr><td colspan="4" class="muted">No documents.</td></tr>'}</tbody>
      </table></div>

      ${user.role === 'CourtClerk' ? `
      <form id="docForm" style="margin-top:14px">
        <div class="form-grid">
          <div><label>File Name *</label><input name="fileName" placeholder="affidavit.pdf"></div>
          <div><label>Document Type *</label>
            <select name="documentType">
              <option>Petition</option><option>Evidence</option><option>Affidavit</option><option>Order</option><option>Other</option>
            </select></div>
        </div>
        <div class="actions"><button type="submit">Add Document</button></div>
      </form>` : ''}

      <div class="actions"><button class="secondary" onclick="hidePanel()">Close Panel</button></div>`;
    showPanel();

    const docForm = document.getElementById('docForm');
    if (docForm) {
      docForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const result = await api('POST', `/api/cases/${caseId}/documents`, readForm(docForm));
          await viewCase(caseId);
          showMessage('caseMessage', result.message, 'success');
        } catch (err) {
          showMessage('caseMessage', err.message, 'error');
        }
      });
    }
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

// ---------- Use Case: Update Case Details (Court Clerk) ----------
async function editCase(caseId) {
  try {
    const c = await api('GET', '/api/cases/' + caseId);
    const statusOptions = c.status === 'Closed' ? ['Closed'] : ['Open', 'Pending'];
    panel.innerHTML = `
      <h2>Update Case ${esc(c.caseId)}</h2>
      <form id="editForm">
        <div class="form-grid">
          <div><label>Case Number *</label><input name="caseNumber" value="${esc(c.caseNumber)}"></div>
          <div><label>Case Type *</label>
            <select name="caseType">${['Civil', 'Criminal', 'Family', 'Commercial']
              .map(t => `<option ${t === c.caseType ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div><label>Filing Date *</label><input type="date" name="filingDate" value="${esc(c.filingDate)}"></div>
          <div><label>Status *</label>
            <select name="status">${statusOptions
              .map(s => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div><label>Assigned Judge</label><input value="${esc(c.judgeName)} (changed via Reassign Judge)" disabled></div>
          <div><label>Lawyer</label><select name="lawyerId" id="editLawyer"></select></div>
          <div><label>Defendant</label><select name="defendantId" id="editDefendant"></select></div>
          <div><label>Witness</label><select name="witnessId" id="editWitness"></select></div>
          <div class="full"><label>Description</label><textarea name="description">${esc(c.description)}</textarea></div>
        </div>
        <div class="actions">
          <button type="submit">Save Changes</button>
          <button type="button" class="secondary" onclick="hidePanel()">Cancel</button>
        </div>
      </form>`;

    await loadUsers(['Lawyer', 'Defendant', 'Witness']);
    fillSelect(document.getElementById('editLawyer'), usersByRole.Lawyer, 'userId', u => u.name, '-- None --');
    fillSelect(document.getElementById('editDefendant'), usersByRole.Defendant, 'userId', u => u.name, '-- None --');
    fillSelect(document.getElementById('editWitness'), usersByRole.Witness, 'userId', u => u.name, '-- None --');
    document.getElementById('editLawyer').value = c.lawyerId || '';
    document.getElementById('editDefendant').value = c.defendantId || '';
    document.getElementById('editWitness').value = c.witnessId || '';
    showPanel();

    document.getElementById('editForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('PUT', '/api/cases/' + caseId, readForm(event.target));
        hidePanel();
        showMessage('caseMessage', result.message, 'success');
        loadCases();
      } catch (err) {
        showMessage('caseMessage', err.message, 'error');
      }
    });
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

// ---------- Use Case: Close Case (Court Clerk) ----------
async function closeCase(caseId) {
  if (!confirm(`Close case ${caseId}?`)) return;
  try {
    const result = await api('POST', `/api/cases/${caseId}/close`);
    showMessage('caseMessage', result.message, 'success');
    hidePanel();
    loadCases();
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

// ---------- Use Case: Reassign Judge (Administrator) ----------
async function showReassign(caseId) {
  try {
    const c = await api('GET', '/api/cases/' + caseId);
    await loadUsers(['Judge']);
    panel.innerHTML = `
      <h2>Reassign Judge - Case ${esc(c.caseId)} (${esc(c.caseNumber)})</h2>
      <p>Currently assigned: <strong>${esc(c.judgeName)}</strong></p>
      <p class="muted">Upcoming scheduled hearings of this case move to the new Judge,
         provided the new Judge is available at those times.</p>
      <form id="reassignForm">
        <div class="form-grid">
          <div><label>New Judge *</label><select name="judgeId" id="newJudge"></select></div>
        </div>
        <div class="actions">
          <button type="submit">Reassign Judge</button>
          <button type="button" class="secondary" onclick="hidePanel()">Cancel</button>
        </div>
      </form>`;
    fillSelect(document.getElementById('newJudge'),
      usersByRole.Judge.filter(j => j.userId !== c.assignedJudgeId), 'userId', j => j.name, '-- Select Judge --');
    showPanel();

    document.getElementById('reassignForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('PUT', `/api/cases/${caseId}/judge`, readForm(event.target));
        hidePanel();
        showMessage('caseMessage', result.message, 'success');
        loadCases();
      } catch (err) {
        showMessage('caseMessage', err.message, 'error');
      }
    });
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

async function loadUsers(roles) {
  for (const role of roles) {
    if (!usersByRole[role]) usersByRole[role] = await api('GET', '/api/users?role=' + role);
  }
}

function showPanel() {
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth' });
}

function hidePanel() {
  panel.classList.add('hidden');
}

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadCases();
});

document.getElementById('showAll').addEventListener('click', () => {
  document.getElementById('searchForm').reset();
  loadCases();
});

if (user) loadCases();
