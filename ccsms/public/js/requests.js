// =====================================================================
// requests.js
// Lawyer      : Submit Adjournment Request         (AdjournmentRequest)
// Judge       : Request Hearing Cancellation       (cancellation request)
// Court Clerk : review both kinds of request (Approve / Reject)
// =====================================================================
const user = initPage('requests.html');
const isClerk = user && user.role === 'CourtClerk';

async function init() {
  if (user.role === 'Lawyer') {
    document.getElementById('pageTitle').textContent = 'Adjournment Requests';
    document.getElementById('formTitle').textContent = 'Submit Adjournment Request';
    document.getElementById('formNote').textContent =
      'The request is reviewed by the Court Clerk. If approved, the hearing becomes "Adjourned".';
    document.getElementById('requestForm').classList.remove('hidden');
    document.getElementById('adjournmentCard').classList.remove('hidden');
  }
  if (user.role === 'Judge') {
    document.getElementById('pageTitle').textContent = 'Hearing Cancellation Requests';
    document.getElementById('formTitle').textContent = 'Request Hearing Cancellation';
    document.getElementById('formNote').textContent =
      'The hearing is NOT cancelled immediately. The Court Clerk reviews the request and performs the cancellation.';
    document.getElementById('requestForm').classList.remove('hidden');
    document.getElementById('cancellationCard').classList.remove('hidden');
  }
  if (isClerk) {
    document.getElementById('pageTitle').textContent = 'Review Requests';
    document.getElementById('adjournmentCard').classList.remove('hidden');
    document.getElementById('cancellationCard').classList.remove('hidden');
  }

  if (user.role === 'Lawyer' || user.role === 'Judge') {
    try {
      // Only Scheduled hearings visible to this user can be selected.
      const hearings = await api('GET', '/api/hearings?status=Scheduled');
      fillSelect(document.getElementById('hearingId'), hearings, 'hearingId',
        h => `${h.hearingId} - ${h.caseNumber} - ${h.hearingDate} ${h.startTime}-${h.endTime}`, '-- Select Hearing --');
    } catch (err) {
      showMessage('requestMessage', err.message, 'error');
    }
  }
  loadRequests();
}

async function loadRequests() {
  try {
    if (user.role === 'Lawyer' || isClerk) {
      const rows = await api('GET', '/api/adjournment-requests');
      renderRows(document.getElementById('adjournmentRows'), rows, r => requestRow(r, r.lawyerName, 'adjournment'), 9);
    }
    if (user.role === 'Judge' || isClerk) {
      const rows = await api('GET', '/api/cancellation-requests');
      renderRows(document.getElementById('cancellationRows'), rows, r => requestRow(r, r.judgeName, 'cancellation'), 9);
    }
  } catch (err) {
    showMessage('requestMessage', err.message, 'error');
  }
}

function requestRow(r, byName, kind) {
  const buttons = isClerk && r.status === 'Pending'
    ? `<button class="small success" onclick="review('${kind}', ${r.requestId}, 'approve')">Approve</button>
       <button class="small danger" onclick="review('${kind}', ${r.requestId}, 'reject')">Reject</button>`
    : '';
  return `
    <tr>
      <td>${r.requestId}</td>
      <td>${esc(r.hearingId)} ${badge(r.hearingStatus)}</td>
      <td>${esc(r.caseNumber)}</td>
      <td>${esc(r.hearingDate)} ${esc(r.startTime)}-${esc(r.endTime)}</td>
      <td>${esc(byName)}</td>
      <td>${esc(r.reason)}</td>
      <td>${esc(r.requestDate)}</td>
      <td>${badge(r.status)}</td>
      <td><div class="actions">${buttons}</div></td>
    </tr>`;
}

// Court Clerk reviews a request.
async function review(kind, requestId, decision) {
  const question = kind === 'cancellation' && decision === 'approve'
    ? 'Approve this request and CANCEL the hearing?'
    : `${decision === 'approve' ? 'Approve' : 'Reject'} this request?`;
  if (!confirm(question)) return;
  try {
    const result = await api('POST', `/api/${kind}-requests/${requestId}/${decision}`);
    showMessage('requestMessage', result.message + (result.notificationMessage ? ' ' + result.notificationMessage : ''), 'success');
    loadRequests();
  } catch (err) {
    showMessage('requestMessage', err.message, 'error');
  }
}

document.getElementById('requestForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = readForm(event.target);
  if (!data.hearingId || !data.reason) {
    showMessage('requestMessage', 'Please select a hearing and enter a reason.', 'error');
    return;
  }
  const url = user.role === 'Lawyer' ? '/api/adjournment-requests' : '/api/cancellation-requests';
  try {
    const result = await api('POST', url, data);
    showMessage('requestMessage', result.message, 'success');
    event.target.reset();
    loadRequests();
  } catch (err) {
    showMessage('requestMessage', err.message, 'error');
  }
});

if (user) init();
