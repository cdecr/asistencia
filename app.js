(() => {
  const API = String(window.CDE_CONFIG?.apiUrl || '');
  const reasons = ['Enfermedad','Cita médica','Viaje','Motivo familiar','Ausencia justificada','Ausencia no justificada','Otro'];
  const $ = selector => document.querySelector(selector);
  let session = null;
  let students = [];
  let pendingData = null;
  let attendancePhoto = null;

  function configured() { return API.startsWith('https://script.google.com/') && API.endsWith('/exec'); }

  async function api(action, data = {}) {
    if (!configured()) throw new Error('La URL de Apps Script todavía no está configurada en config.js.');
    const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...data }) });
    const result = await response.json();
    if (!result.ok && result.code !== 'DUPLICATE') throw new Error(result.message || 'No fue posible completar la solicitud.');
    return result;
  }

  function today() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function show(id) {
    ['login-view','attendance-view','kitchen-view','success-view'].forEach(view => $('#'+view).classList.toggle('hidden', view !== id));
    $('#logout').classList.toggle('hidden', id === 'login-view');
  }

  function setBusy(button, busy, busyText) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.label;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  function normalizeText(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zñ0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function renderAdminTools(groups = []) {
    const isAdmin = session?.teacher?.canSelectGroup;
    $('#admin-tools').classList.toggle('hidden', !isAdmin);
    if (!isAdmin) return;
    $('#group-select').innerHTML = groups.map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('');
    $('#group-select').value = session.teacher.group;
  }

  function renderStudents() {
    $('#student-list').innerHTML = students.map((student, index) => `<article class="student-card" data-index="${index}"><div class="student-info"><b>${escapeHtml(student.name)}</b><small>${escapeHtml(student.id)}${student.provisional ? ' · Provisional' : ''}${student.hasAllergy ? ' · Alergia' : ''}</small></div><div class="attendance-choice"><label><input type="radio" name="status-${index}" value="P">✓ Presente</label><label><input type="radio" name="status-${index}" value="T">◷ Tardía</label><label><input type="radio" name="status-${index}" value="A">— Ausente</label></div><div class="absence-fields hidden"><select aria-label="Motivo de ausencia"><option value="">Selecciona el motivo</option>${reasons.map(reason => `<option>${reason}</option>`).join('')}</select><input class="other-detail hidden" placeholder="Especifica el motivo" aria-label="Detalle de otro motivo"></div></article>`).join('');
    updateProgress();
  }

  function updateWarning(codeWarnings = []) {
    const warning = $('#code-warning');
    warning.classList.toggle('hidden', !codeWarnings.length);
    warning.textContent = codeWarnings.length ? `Aviso: ${codeWarnings.length} código(s) provisional(es) en este grupo. La asistencia puede registrarse, pero Administración debe completar el año de ingreso para confirmarlos.` : '';
  }

  function updateProgress() {
    let present = 0, late = 0, absent = 0, valid = 0;
    document.querySelectorAll('.student-card').forEach(card => {
      const status = card.querySelector('input:checked')?.value;
      const reason = card.querySelector('select').value;
      const detail = card.querySelector('.other-detail').value.trim();
      if (status === 'P') { present++; valid++; }
      if (status === 'T') { late++; valid++; }
      if (status === 'A') { absent++; if (reason && (reason !== 'Otro' || detail)) valid++; }
    });
    const total = students.length;
    const pct = total ? Math.round(valid / total * 100) : 0;
    $('#progress-text').textContent = `${valid} de ${total} estudiantes registrados`;
    $('#progress-percent').textContent = `${pct}%`;
    $('#progress-bar').style.width = `${pct}%`;
    $('#present-count').textContent = present;
    $('#late-count').textContent = late;
    $('#absent-count').textContent = absent;
    $('#submit-summary').textContent = valid === total ? `${present} presentes · ${late} tardías · ${absent} ausentes` : 'Completa la lista';
    $('#submit-attendance').disabled = valid !== total;
    return { present, late, absent, valid, total };
  }

  function buildPayload() {
    return {
      token: session.token,
      group: session.teacher.group,
      date: $('#attendance-date').value,
      photo: attendancePhoto,
      records: [...document.querySelectorAll('.student-card')].map((card, index) => {
        const selected = card.querySelector('input:checked').value;
        const reason = card.querySelector('select').value;
        const statusCode = selected === 'A' && reason === 'Ausencia justificada' ? 'J' : selected;
        return {
          student_id: students[index].id,
          student_name: students[index].name,
          status_code: statusCode,
          absence_reason: selected === 'A' ? reason : '',
          other_detail: reason === 'Otro' ? card.querySelector('.other-detail').value.trim() : ''
        };
      })
    };
  }

  function readAttendancePhoto(file) {
    attendancePhoto = null;
    $('#attendance-photo-status').textContent = 'Opcional: sube una foto como respaldo del registro.';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      $('#attendance-photo-status').textContent = 'El archivo debe ser una imagen.';
      $('#attendance-photo').value = '';
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      $('#attendance-photo-status').textContent = 'La foto es muy grande. Usa una imagen menor a 4 MB.';
      $('#attendance-photo').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      attendancePhoto = { name: file.name, mimeType: file.type, data: String(reader.result).split(',')[1] || '' };
      $('#attendance-photo-status').textContent = `Foto lista: ${file.name}`;
    };
    reader.onerror = () => {
      attendancePhoto = null;
      $('#attendance-photo-status').textContent = 'No se pudo leer la foto. Intenta de nuevo.';
    };
    reader.readAsDataURL(file);
  }

  async function refreshCalendar() {
    $('#form-error').textContent = '';
    try {
      const result = await api('check', { token: session.token, group: session.teacher.group, date: $('#attendance-date').value });
      const calendar = result.calendar;
      $('#school-year').textContent = `Año lectivo ${calendar.schoolYear}`;
      $('#block-week').textContent = `Semana ${calendar.schoolWeek || ''} (${calendar.block} · ${calendar.week})`;
      $('#calendar-note').textContent = calendar.month;
    } catch (error) {
      $('#school-year').textContent = 'Fecha no configurada';
      $('#block-week').textContent = 'Revisa Attendance_Calendar';
      $('#calendar-note').textContent = '';
      $('#form-error').textContent = error.message;
    }
  }

  async function loadGroup(group) {
    const result = await api('students', { token: session.token, group });
    session.teacher.group = result.group;
    students = result.students;
    $('#group-name').textContent = result.group;
    $('#teacher-name').textContent = session.teacher.canSelectGroup ? `Administración · ${session.teacher.name}` : `Profesora ${session.teacher.name}`;
    updateWarning(result.codeWarnings || []);
    renderStudents();
    await refreshCalendar();
  }

  function renderKitchenSelectors(groups = []) {
    $('#kitchen-group-select').innerHTML = `<option value="TODOS">Todos los grados</option>${groups.map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('')}`;
  }

  async function loadKitchenSummary() {
    const button = $('#load-kitchen-summary');
    setBusy(button, true, 'Cargando…');
    $('#kitchen-error').textContent = '';
    try {
      const result = await api('kitchen', { token: session.token, date: $('#kitchen-date').value, group: $('#kitchen-group-select').value });
      const sections = (result.sections || []).map(section => {
        const groups = section.groups.map(item => {
          const allergies = item.allergyDetails?.length
            ? `<ul>${item.allergyDetails.map(row => `<li><b>${escapeHtml(row.student)}</b>: ${escapeHtml(row.detail)}</li>`).join('')}</ul>`
            : '<small>Sin alergias registradas para presentes/tardíos.</small>';
          return `<div class="receipt-row"><span>${escapeHtml(item.group)}</span><b>${item.totalForKitchen} comidas · ${item.allergiesCount} alergias</b></div>${allergies}`;
        }).join('');
        return `<h2>${escapeHtml(section.section)}</h2><div class="receipt-row"><span>Total ${escapeHtml(section.section)}</span><b>${section.totalForKitchen} comidas</b></div><div class="receipt-row"><span>Alergias ${escapeHtml(section.section)}</span><b>${section.allergiesCount}</b></div>${groups}`;
      }).join('');
      $('#kitchen-summary').innerHTML = `<div class="receipt-row"><span>Total general para cocina</span><b>${result.totalForKitchen}</b></div><div class="receipt-row"><span>Total general con alergias</span><b>${result.allergiesCount}</b></div>${sections || '<p>No hay asistencia registrada para esa fecha.</p>'}`;
    } catch (error) {
      $('#kitchen-error').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  }

  function renderSuccess(result) {
    const date = new Date(`${pendingData.date}T12:00:00`).toLocaleDateString('es-CR', { dateStyle: 'long' });
    $('#success-details').innerHTML = [
      ['Fecha', date],
      ['Grupo', session.teacher.group],
      ['Registrado por', session.teacher.name],
      ['Total', result.total],
      ['Presentes', result.present],
      ['Tardías', result.late],
      ['Ausentes', result.absent],
      ['Justificadas', result.justified],
      ['Cocina', `${result.kitchen?.totalForKitchen || 0} comidas`],
      ['Alergias', result.kitchen?.allergiesCount || 0],
      ['Foto', result.photoUrl ? 'Guardada en Drive' : 'No adjunta']
    ].map(([label, value]) => `<div class="receipt-row"><span>${label}</span><b>${value}</b></div>`).join('');
    $('#notification-status').textContent = '✓ Reporte enviado a Sandra y a la profesora. Sandra recibe el resumen para cocina.';
    show('success-view');
  }

  async function send(confirmUpdate = false) {
    const button = $('#submit-attendance');
    setBusy(button, true, confirmUpdate ? 'Actualizando…' : 'Enviando…');
    $('#form-error').textContent = '';
    try {
      const result = await api('submit', { ...pendingData, confirmUpdate });
      if (result.code === 'DUPLICATE') {
        setBusy(button, false);
        $('#update-dialog').showModal();
        return;
      }
      renderSuccess(result);
    } catch (error) {
      $('#form-error').textContent = error.message;
      setBusy(button, false);
    }
  }

  function applyPhotoListText() {
    const text = normalizeText($('#photo-list-text').value);
    if (!text) {
      $('#photo-list-result').textContent = 'Pega primero el texto de la foto.';
      return;
    }
    let matched = 0;
    document.querySelectorAll('.student-card').forEach((card, index) => {
      const fullName = normalizeText(students[index].name);
      const parts = fullName.split(' ').filter(part => part.length > 2);
      const strongMatch = text.includes(fullName);
      const partialMatch = parts.length >= 2 && parts.filter(part => text.includes(part)).length >= Math.min(2, parts.length);
      if (strongMatch || partialMatch) {
        card.querySelector('input[value="P"]').checked = true;
        card.classList.remove('is-absent');
        card.querySelector('.absence-fields').classList.add('hidden');
        matched++;
      }
    });
    updateProgress();
    $('#photo-list-result').textContent = `Encontrados y marcados presentes: ${matched}. Revisa antes de enviar.`;
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#login-button');
    setBusy(button, true, 'Validando…');
    $('#login-error').textContent = '';
    try {
      const result = await api('login', { code: $('#access-code').value });
      session = { token: result.token, teacher: result.teacher, groups: result.groups || [result.teacher.group] };
      if (result.teacher.kitchenOnly) {
        $('#kitchen-date').value = today();
        $('#kitchen-user-name').textContent = `${result.teacher.name} · acceso solo lectura`;
        renderKitchenSelectors(session.groups);
        show('kitchen-view');
        await loadKitchenSummary();
        return;
      }
      students = result.students;
      $('#attendance-date').value = today();
      renderAdminTools(session.groups);
      $('#group-name').textContent = result.teacher.group;
      $('#teacher-name').textContent = result.teacher.canSelectGroup ? `Administración · ${result.teacher.name}` : `Profesora ${result.teacher.name}`;
      updateWarning(result.codeWarnings || []);
      renderStudents();
      show('attendance-view');
      await refreshCalendar();
    } catch (error) {
      $('#login-error').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#toggle-code').addEventListener('click', () => {
    const input = $('#access-code');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-code').textContent = input.type === 'password' ? 'Ver' : 'Ocultar';
  });
  $('#group-select').addEventListener('change', event => loadGroup(event.target.value).catch(error => $('#form-error').textContent = error.message));
  $('#attendance-photo').addEventListener('change', event => readAttendancePhoto(event.target.files?.[0]));
  $('#load-kitchen-summary').addEventListener('click', loadKitchenSummary);
  $('#kitchen-date').addEventListener('change', loadKitchenSummary);
  $('#kitchen-group-select').addEventListener('change', loadKitchenSummary);
  $('#apply-photo-list').addEventListener('click', applyPhotoListText);
  $('#attendance-date').addEventListener('change', refreshCalendar);
  $('#student-list').addEventListener('change', event => {
    const card = event.target.closest('.student-card');
    if (!card) return;
    const status = card.querySelector('input:checked')?.value;
    const fields = card.querySelector('.absence-fields');
    const other = card.querySelector('.other-detail');
    fields.classList.toggle('hidden', status !== 'A');
    card.classList.toggle('is-absent', status === 'A');
    other.classList.toggle('hidden', card.querySelector('select').value !== 'Otro');
    updateProgress();
  });
  $('#student-list').addEventListener('input', updateProgress);
  $('#mark-all').addEventListener('click', () => {
    document.querySelectorAll('.student-card input[value="P"]').forEach(input => input.checked = true);
    document.querySelectorAll('.student-card').forEach(card => {
      card.classList.remove('is-absent');
      card.querySelector('.absence-fields').classList.add('hidden');
    });
    updateProgress();
  });
  $('#attendance-form').addEventListener('submit', event => {
    event.preventDefault();
    if (updateProgress().valid !== students.length) {
      $('#form-error').textContent = 'Completa la asistencia y los motivos pendientes.';
      return;
    }
    pendingData = buildPayload();
    send(false);
  });
  $('#update-dialog').addEventListener('close', () => { if ($('#update-dialog').returnValue === 'confirm') send(true); });
  $('#logout').addEventListener('click', () => {
    session = null;
    students = [];
    $('#access-code').value = '';
    $('#photo-list-text').value = '';
    $('#photo-list-result').textContent = '';
    $('#attendance-photo').value = '';
    attendancePhoto = null;
    $('#attendance-photo-status').textContent = 'Opcional: sube una foto como respaldo del registro.';
    show('login-view');
  });
  $('#back-home').addEventListener('click', () => $('#logout').click());
  if (!configured()) $('#login-error').textContent = 'Pendiente: configura la URL de Apps Script en config.js.';
})();
