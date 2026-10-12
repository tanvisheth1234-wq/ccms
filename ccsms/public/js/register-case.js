// Use Case: Register New Case + Assign Judge (Court Clerk)
const user = initPage('register-case.html');

// Loads the users of one role into a <select>.
async function loadUserOptions(selectId, role, placeholder) {
  const users = await api('GET', '/api/users?role=' + role);
  fillSelect(document.getElementById(selectId), users, 'userId', u => u.name, placeholder);
}

async function loadForm() {
  try {
    await loadUserOptions('assignedJudgeId', 'Judge', '-- Select Judge --');
    await loadUserOptions('lawyerId', 'Lawyer', '-- None --');
    await loadUserOptions('defendantId', 'Defendant', '-- None --');
    await loadUserOptions('witnessId', 'Witness', '-- None --');
    document.getElementById('filingDate').value = todayText();
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
}

document.getElementById('caseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = readForm(event.target);

  // Step 1: validate fields (the server validates again)
  if (!data.caseNumber || !data.caseType || !data.filingDate || !data.assignedJudgeId) {
    showMessage('caseMessage', 'Please fill in all required (*) fields, including the Judge.', 'error');
    return;
  }

  try {
    // Steps 2-4: create case, assign Judge, save to SQLite (server side)
    const result = await api('POST', '/api/cases', data);
    // Step 5: show success message
    showMessage('caseMessage', result.message, 'success');
    event.target.reset();
    document.getElementById('filingDate').value = todayText();
  } catch (err) {
    showMessage('caseMessage', err.message, 'error');
  }
});

if (user) loadForm();
