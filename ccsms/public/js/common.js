// =====================================================================
// common.js - helpers shared by every page
// (login check, role-based menu, API calls, messages, tables)
// =====================================================================

// Navigation per actor. A page is only accessible if it appears in the
// menu of the logged-in user's role (role = UML User specialization).
const NAV_MENU = {
  CourtClerk: [
    ['dashboard.html', 'Dashboard'],
    ['cases.html', 'Cases'],
    ['register-case.html', 'Register Case'],
    ['hearings.html', 'Hearings'],
    ['schedule.html', 'Schedule Hearing'],
    ['requests.html', 'Requests'],
    ['notifications.html', 'Notifications']
  ],
  Judge: [
    ['dashboard.html', 'Dashboard'],
    ['cases.html', 'Assigned Cases'],
    ['hearings.html', 'Hearings & Outcomes'],
    ['requests.html', 'Cancellation Requests'],
    ['notifications.html', 'Notifications']
  ],
  Lawyer: [
    ['dashboard.html', 'Dashboard'],
    ['hearings.html', 'Hearing Schedule'],
    ['requests.html', 'Adjournment Requests'],
    ['notifications.html', 'Notifications']
  ],
  Defendant: [
    ['dashboard.html', 'Dashboard'],
    ['hearings.html', 'Hearing Schedule'],
    ['notifications.html', 'Notifications']
  ],
  Witness: [
    ['dashboard.html', 'Dashboard'],
    ['notifications.html', 'Notifications']
  ],
  Administrator: [
    ['dashboard.html', 'Dashboard'],
    ['users.html', 'Users & Roles'],
    ['cases.html', 'Cases & Judge Assignment'],
    ['holidays.html', 'Holiday Calendar'],
    ['notifications.html', 'Failed Notifications'],
    ['reports.html', 'Reports']
  ]
};

const ROLE_LABELS = {
  CourtClerk: 'Court Clerk',
  Judge: 'Judge',
  Lawyer: 'Lawyer / Party Representative',
  Defendant: 'Defendant',
  Witness: 'Witness',
  Administrator: 'System Administrator'
};

function getCurrentUser() {
  const text = sessionStorage.getItem('ccsmsUser');
  return text ? JSON.parse(text) : null;
}

// Called at the top of every page. Returns the logged-in user.
function initPage(pageFile) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = 'index.html';
    return null;
  }
  const menu = NAV_MENU[user.role] || [];
  if (!menu.some(item => item[0] === pageFile)) {
    window.location.href = 'dashboard.html';
    return null;
  }

  document.getElementById('header').innerHTML = `
    <div class="header">
      <div class="brand">CCSMS<small>Court Case Scheduling and Hearing Management System</small></div>
      <div class="user-info">
        Welcome, <strong>${esc(user.name)}</strong> | Role: ${esc(ROLE_LABELS[user.role])}
        <button onclick="logout()">Logout</button>
      </div>
    </div>`;

  document.getElementById('sidebar').innerHTML = menu
    .map(([file, title]) => `<a href="${file}" class="${file === pageFile ? 'active' : ''}">${title}</a>`)
    .join('');
  return user;
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch (e) { /* already logged out */ }
  sessionStorage.clear();
  window.location.href = 'index.html';
}

// Sends a request to the backend and returns the JSON response.
// Throws an Error with a readable message when the server reports one.
async function api(method, url, body) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (sessionStorage.getItem('ccsmsToken') || '')
    }
  };
  if (body) options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
  } catch (e) {
    throw new Error('Cannot reach the server. Is "node server.js" running?');
  }
  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && url !== '/api/login') {
    sessionStorage.clear();
    window.location.href = 'index.html';
  }
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.data = data;          // e.g. conflicts and alternatives
    error.status = response.status;
    throw error;
  }
  return data;
}

// Shows a coloured message box (type = success / error / info / warning).
function showMessage(elementId, text, type) {
  const el = document.getElementById(elementId);
  el.className = 'message ' + (type || 'info');
  el.textContent = text;
  if (text) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Escapes text before putting it into HTML.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

// Reads all named inputs of a form into a plain object.
function readForm(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return data;
}

// Fills a <select> with options.
function fillSelect(select, items, valueKey, textFn, placeholder) {
  select.innerHTML = (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map(item => `<option value="${esc(item[valueKey])}">${esc(textFn(item))}</option>`).join('');
}

// Builds a table body; shows a friendly row when there is no data.
function renderRows(tbody, items, rowFn, columnCount) {
  tbody.innerHTML = items.length
    ? items.map(rowFn).join('')
    : `<tr><td colspan="${columnCount}" class="muted">No records found.</td></tr>`;
}

function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
