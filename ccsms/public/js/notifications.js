// =====================================================================
// notifications.js
// Judge / Lawyer / Defendant / Witness : view own notifications, Acknowledge
// Court Clerk   : notification log (read only)
// Administrator : Retrigger Failed Notifications
// =====================================================================
const user = initPage('notifications.html');
const showAll = user && (user.role === 'CourtClerk' || user.role === 'Administrator');
const statusFilter = document.getElementById('statusFilter');

function init() {
  if (user.role === 'Administrator') {
    document.getElementById('pageTitle').textContent = 'Failed Notifications';
    statusFilter.value = 'Failed';
  } else if (user.role === 'CourtClerk') {
    document.getElementById('pageTitle').textContent = 'Notification Log';
  } else {
    document.getElementById('pageTitle').textContent = 'My Notifications';
  }
  const columns = ['#', ...(showAll ? ['Recipient'] : []), 'Hearing', 'Message', 'Type', 'Sent At', 'Status', 'Actions'];
  document.getElementById('headRow').innerHTML = columns.map(c => `<th>${c}</th>`).join('');
  loadNotifications();
}

async function loadNotifications() {
  try {
    const rows = await api('GET', '/api/notifications?status=' + statusFilter.value);
    renderRows(document.getElementById('notifRows'), rows, n => `
      <tr>
        <td>${n.notificationId}</td>
        ${showAll ? `<td>${esc(n.userName)}<br><span class="muted">${esc(ROLE_LABELS[n.userRole])}</span></td>` : ''}
        <td>${esc(n.hearingId || '-')}</td>
        <td>${esc(n.message)}</td>
        <td>${esc(n.type)}</td>
        <td>${esc(n.sentAt)}</td>
        <td>${badge(n.status)}</td>
        <td><div class="actions">${notificationButton(n)}</div></td>
      </tr>`, showAll ? 8 : 7);
  } catch (err) {
    showMessage('notifMessage', err.message, 'error');
  }
}

function notificationButton(n) {
  if (user.role === 'Administrator' && n.status === 'Failed') {
    return `<button class="small" onclick="retrigger(${n.notificationId})">Retrigger</button>`;
  }
  if (!showAll && n.status === 'Delivered') {
    return `<button class="small success" onclick="acknowledge(${n.notificationId})">Acknowledge</button>`;
  }
  return '';
}

async function acknowledge(id) {
  try {
    const result = await api('POST', `/api/notifications/${id}/acknowledge`);
    showMessage('notifMessage', result.message, 'success');
    loadNotifications();
  } catch (err) {
    showMessage('notifMessage', err.message, 'error');
  }
}

// Use Case: Retrigger Failed Notifications (Administrator)
async function retrigger(id) {
  try {
    const result = await api('POST', `/api/notifications/${id}/retrigger`);
    showMessage('notifMessage', result.message, 'success');
    loadNotifications();
  } catch (err) {
    showMessage('notifMessage', err.message, 'error');
  }
}

statusFilter.addEventListener('change', loadNotifications);

if (user) init();
