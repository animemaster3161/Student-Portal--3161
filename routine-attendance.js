import { supabase } from './supabase-config.js';
import { requireAuth } from './auth.js';

const SUBJECTS = {
  PY: 'Python Programming', DS: 'Data Structures', DSTL: 'Discrete Structures & Logic',
  COA: 'Computer Organization & Architecture', TC: 'Technical Communication',
  'MATH-IV': 'Mathematics IV', AR: 'AR', WT: 'Web Technology',
  DWDM: 'Data Warehousing & Data Mining', DBMS: 'Database Management Systems',
  DAA: 'Design & Analysis of Algorithms', DA: 'Data Analytics', CoI: 'Constitution of India',
  CC: 'Cloud Computing', AI: 'Artificial Intelligence', DT: 'Design Thinking',
  DL: 'Deep Learning', MM: 'Mentor Meeting',
};

const TEACHERS = {
  KK: 'Dr. Karamjeet Kaur', PY: 'Dr. Poonam Yadav', SKM: 'Mr. Shashi Kant Mourya',
  SG: 'Dr. Shalu Gupta', MJ: 'Ms. Monika Jaglan', RG: 'Ms. Roovi',
  PS: 'Ms. Pooja Singh', VT: 'Ms. Vandana Tripathi', AW: 'Mr. Akhtar Warsi',
  AS: 'Ms. Anisha Singh', RP: 'Dr. Ram Prakash', UY: 'Mr. Umesh Yadav',
  SS: 'Mr. Sanjay Sharma', KP: 'Mr. Krishan Pal Goswami',
  PV: 'Ms. Priyanka Verma', RC: 'Ms. Rajni Chaudhary',
};

const state = { user: null, classes: [], selectedClass: null, entries: [], logs: [], busy: false };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayNumber(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function formatTime(time) {
  const [h, m] = String(time).slice(0, 5).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
}

function subjectName(code) {
  return SUBJECTS[code] || code;
}

function teacherName(code) {
  return code ? (TEACHERS[code] || code) : '';
}

function toast(message, isError = false) {
  let el = $('scheduleToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'scheduleToast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3300);
}

function addSharedStyles() {
  if ($('routineSharedStyles')) return;
  const style = document.createElement('style');
  style.id = 'routineSharedStyles';
  style.textContent = `
    .class-switch{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.38);background:rgba(255,255,255,.12);color:#fff;padding:9px 13px;border-radius:12px;font:600 12px Inter, sans-serif;cursor:pointer}
    .class-switch:hover{background:rgba(255,255,255,.2)}
    .routine-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid rgba(15,27,51,.08)}
    .routine-row:last-child{border-bottom:0}.routine-period{flex:0 0 96px;font:600 11px 'JetBrains Mono',monospace;color:#68748d;line-height:1.5}
    .routine-copy{flex:1;min-width:0;padding-left:12px;border-left:2px solid #dce5f8}
    .routine-copy.is-live{border-color:#1da35f}.routine-copy h4{font:700 13px Sora,Inter,sans-serif;color:#14213b;margin:0 0 4px}
    .routine-copy p{font-size:11px;color:#68748d;line-height:1.45;margin:0}.routine-live{display:inline-flex;margin-top:5px;padding:3px 7px;border-radius:20px;background:#e9f8ef;color:#18834b;font-size:9px;font-weight:800;letter-spacing:.06em}
    .routine-empty{padding:24px 12px;text-align:center;color:#77839a;font-size:13px;line-height:1.55}
    .class-dialog-backdrop{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(10,19,40,.52);backdrop-filter:blur(8px)}
    .class-dialog-backdrop.open{display:flex}.class-dialog{width:min(100%,440px);max-height:min(90vh,620px);overflow:auto;padding:26px;background:#fff;border:1px solid #e3e9f4;border-radius:22px;box-shadow:0 24px 70px rgba(10,24,55,.3);color:#18243d}
    .class-dialog h2{font:700 21px Sora,Inter,sans-serif;margin:0 0 8px}.class-dialog p{font-size:13px;line-height:1.55;color:#68748d;margin:0 0 20px}
    .class-dialog label{display:block;font-size:12px;font-weight:700;color:#536079;margin-bottom:8px}.class-dialog select{width:100%;padding:13px 14px;border:1px solid #d7deeb;border-radius:12px;background:#fff;color:#18243d;font:600 14px Inter,sans-serif}
    .class-dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}.class-dialog-actions button{border:0;border-radius:11px;padding:11px 16px;font:700 13px Inter,sans-serif;cursor:pointer}
    .class-dialog-cancel{background:#f1f4f9;color:#536079}.class-dialog-save{background:#2e5ce6;color:#fff}.class-dialog-save:disabled{opacity:.55;cursor:wait}
    #scheduleToast{position:fixed;z-index:100001;left:50%;bottom:24px;transform:translate(-50%,12px);opacity:0;pointer-events:none;max-width:min(92vw,560px);padding:12px 16px;border-radius:12px;background:#15233e;color:#fff;font:600 13px Inter,sans-serif;box-shadow:0 8px 30px rgba(15,27,51,.25);transition:.2s}
    #scheduleToast.show{opacity:1;transform:translate(-50%,0)}#scheduleToast.error{background:#9b3029}
    @media(max-width:560px){.class-dialog{padding:22px 18px}.routine-period{flex-basis:82px;font-size:10px}.routine-row{gap:9px}}
  `;
  document.head.append(style);
}

function migrationHint(error) {
  console.error('Routine/attendance setup error:', error);
  const text = String(error?.message || error || '');
  if (/set_student_class_preference|could not find the function|function .* does not exist/i.test(text)) {
    return 'To enable class changes, run schema_set_student_class_preference.sql in this Supabase project’s SQL Editor, then reload the page.';
  }
  if (/schema_class_schedule_attendance|timetable_classes|student_class_preferences|attendance_logs|relation .* does not exist/i.test(text)) {
    return 'Supabase setup is incomplete. Run schema_class_schedule_attendance.sql in the Supabase SQL Editor.';
  }
  return `Unable to load data from Supabase: ${text || 'network error'}`;
}

async function loadClassOptions() {
  const { data, error } = await supabase.from('timetable_classes')
    .select('id,label,year_no,semester_no,section,academic_year,semester_label,effective_from')
    .order('year_no').order('section');
  if (error) throw error;
  state.classes = (data || []).sort((a, b) => {
    if (a.year_no !== b.year_no) return a.year_no - b.year_no;
    const order = { A: 0, B: 1, 'AI/ML': 2 };
    return (order[a.section] ?? 9) - (order[b.section] ?? 9);
  });
  if (!state.classes.length) throw new Error('timetable_classes has no seeded rows');
}

async function loadPreference() {
  const { data, error } = await supabase.from('student_class_preferences')
    .select('class_id').eq('user_id', state.user.id).maybeSingle();
  if (error) throw error;
  state.selectedClass = state.classes.find((item) => item.id === data?.class_id) || null;
}

async function saveClassPreference(classId) {
  const selectedClass = state.classes.find((item) => item.id === classId);
  if (!selectedClass) throw new Error('The selected class was not found. Reload the page and try again.');

  const { error } = await supabase.rpc('set_student_class_preference', {
    p_class_id: classId,
  });
  if (error) throw error;

  // The RPC validates and persists this exact class for auth.uid(). Update the
  // current page from that successful selection instead of re-reading a stale
  // preference response and accidentally keeping the previous class visible.
  state.selectedClass = selectedClass;
  state.entries = [];
  state.logs = [];
  updateStudentHeader();
  renderCurrentPage();
  await loadSelectedClassData(classId);
  await loadDashboardAssignments();
  renderCurrentPage();
}

async function loadSelectedClassData(classId = state.selectedClass?.id) {
  if (!classId) return;
  const [entryResult, logResult] = await Promise.all([
    supabase.from('timetable_entries').select('*').eq('class_id', classId)
      .order('day_of_week').order('period_no'),
    supabase.from('attendance_logs').select('id,student_id,class_id,timetable_entry_id,attendance_date,status,created_at')
      .eq('student_id', state.user.id).eq('class_id', classId)
      .order('attendance_date', { ascending: false }).limit(1000),
  ]);
  if (entryResult.error) throw entryResult.error;
  if (logResult.error) throw logResult.error;
  state.entries = entryResult.data || [];
  state.logs = logResult.data || [];
}

function renderDashboardAssignments(items, error = '') {
  const target = $('dashboardAssignments');
  if (!target) return;
  if (error) {
    target.innerHTML = `<div class="assignment-empty">Unable to load assignments. ${esc(error)}</div>`;
    return;
  }
  if (!items.length) {
    target.innerHTML = '<div class="assignment-empty">There are no upcoming assignments.</div>';
    return;
  }
  target.innerHTML = items.map((item) => {
    const date = new Date(item.due_at).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    return `<article class="dashboard-assignment"><h4>${esc(item.title || 'Assignment')}</h4><p>${esc(item.subjectName || 'Class assignment')} · Due ${esc(date)}</p></article>`;
  }).join('');
}

async function loadDashboardAssignments() {
  const target = $('dashboardAssignments');
  if (!target || !state.selectedClass) return;
  target.innerHTML = '<div class="assignment-empty">Loading assignments…</div>';
  try {
    const { data, error } = await supabase.from('academic_assignments')
      .select('id,title,due_at,branch,year,subject_id').order('due_at', { ascending: true });
    if (error) throw error;
    const yearNo = Number(state.selectedClass.year_no);
    const yearName = `${yearNo}${yearNo === 1 ? 'st' : yearNo === 2 ? 'nd' : yearNo === 3 ? 'rd' : 'th'} Year`.toLowerCase();
    const matchesClass = (item) => {
      const branch = String(item.branch || '').trim().toLowerCase();
      const year = String(item.year || '').trim().toLowerCase();
      const branchMatches = !branch || branch === 'cse' || branch.includes('computer science');
      return branchMatches && (!year || year === yearName);
    };
    const now = Date.now();
    const upcoming = (data || []).filter((item) => {
      const due = item.due_at ? new Date(item.due_at).getTime() : NaN;
      return matchesClass(item) && Number.isFinite(due) && due >= now;
    }).slice(0, 5);
    const subjectIds = [...new Set(upcoming.map((item) => item.subject_id).filter(Boolean))];
    let subjectNames = {};
    if (subjectIds.length) {
      const subjectResult = await supabase.from('academic_subjects').select('id,name').in('id', subjectIds);
      if (subjectResult.error) throw subjectResult.error;
      subjectNames = Object.fromEntries((subjectResult.data || []).map((subject) => [subject.id, subject.name]));
    }
    renderDashboardAssignments(upcoming.map((item) => ({ ...item, subjectName: subjectNames[item.subject_id] })));
  } catch (error) {
    console.error('Dashboard assignments failed to load:', error);
    renderDashboardAssignments([], error.message || 'Unable to connect to Supabase.');
  }
}

function openClassDialog(required = false) {
  let backdrop = $('classDialogBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'classDialogBackdrop';
    backdrop.className = 'class-dialog-backdrop';
    backdrop.innerHTML = `
      <section class="class-dialog" role="dialog" aria-modal="true" aria-labelledby="classDialogTitle">
        <h2 id="classDialogTitle">Select your class</h2>
        <p>Choose your year and section to personalize your timetable and attendance. Your selection will be saved to your account.</p>
        <label for="classDialogSelect">Course / year / section</label>
      <select id="classDialogSelect"><option value="">Choose a class</option></select>
        <div class="class-dialog-actions">
          <button class="class-dialog-cancel" id="classDialogCancel" type="button">Cancel</button>
          <button class="class-dialog-save" id="classDialogSave" type="button">Save class</button>
        </div>
      </section>`;
    document.body.append(backdrop);
    $('classDialogCancel').addEventListener('click', () => {
      if (backdrop.dataset.required !== 'true') backdrop.classList.remove('open');
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && backdrop.dataset.required !== 'true') backdrop.classList.remove('open');
    });
    $('classDialogSave').addEventListener('click', async () => {
      const id = $('classDialogSelect').value;
      if (!id) { toast('Select your class first.', true); return; }
      const button = $('classDialogSave');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await saveClassPreference(id);
        backdrop.classList.remove('open');
        renderCurrentPage();
        toast('Class saved. Your timetable has been personalized.');
      } catch (error) {
        // Preference save ho chuki ho sakti hai, chahe timetable/log refresh fail ho.
        // Aise mein purani class ka stale UI mat chhodo.
        if (state.selectedClass?.id === id) {
          backdrop.classList.remove('open');
          renderCurrentPage();
          toast(`Class saved, but the timetable and attendance could not be refreshed. ${migrationHint(error)}`, true);
        } else {
          toast(migrationHint(error), true);
        }
      } finally {
        button.disabled = false;
        button.textContent = 'Save class';
      }
    });
  }
  const select = $('classDialogSelect');
  const byYear = new Map();
  for (const item of state.classes) {
    if (!byYear.has(item.year_no)) byYear.set(item.year_no, []);
    byYear.get(item.year_no).push(item);
  }
  select.innerHTML = '<option value="">Choose a class</option>' + [...byYear.entries()].map(([year, items]) =>
    `<optgroup label="${year}${year === 2 ? 'nd' : year === 3 ? 'rd' : 'th'} Year">${items.map((item) =>
      `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('')}</optgroup>`).join('');
  select.value = state.selectedClass?.id || '';
  backdrop.dataset.required = required ? 'true' : 'false';
  $('classDialogCancel').hidden = required;
  backdrop.classList.add('open');
  setTimeout(() => select.focus(), 0);
}

function bindClassSwitchers() {
  document.querySelectorAll('[data-change-class]').forEach((button) => {
    button.addEventListener('click', () => openClassDialog(false));
  });
}

function classLabelLine() {
  if (!state.selectedClass) return 'Class not selected';
  const c = state.selectedClass;
  return `${c.year_no}${c.year_no === 2 ? 'nd' : c.year_no === 3 ? 'rd' : 'th'} Year · CSE · Semester ${c.semester_no} · Section ${c.section}`;
}

function updateStudentHeader() {
  const metadata = state.user.user_metadata || {};
  const name = metadata.full_name || metadata.name || state.user.email?.split('@')[0] || 'Student';
  const roll = metadata.roll_no || '';
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  for (const id of ['profileMiniName', 'studentName']) if ($(id)) $(id).textContent = name;
  for (const id of ['profileMiniRoll', 'studentRoll']) if ($(id)) $(id).textContent = roll;
  for (const id of ['profileInitial', 'avatarInitial']) if ($(id)) $(id).textContent = initials || 'S';
  if ($('classIdentity')) $('classIdentity').textContent = classLabelLine();
  if ($('attendanceClassLabel')) $('attendanceClassLabel').textContent = state.selectedClass?.label || 'Select your class';
  if ($('dayLabel')) $('dayLabel').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  if ($('greetingText')) $('greetingText').textContent = `${greeting}, ${name}`;
  if ($('attendanceGreeting')) $('attendanceGreeting').textContent = name;
}

function entriesForDay(date) {
  return state.entries.filter((entry) => Number(entry.day_of_week) === dayNumber(date));
}

function periodMinutes(value) {
  const [hour, minute] = String(value).slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

function renderRoutine(target, entries, emptyText = 'No timetable entries for this day.') {
  if (!target) return;
  if (!entries.length) {
    target.innerHTML = `<div class="routine-empty">${esc(emptyText)}</div>`;
    return;
  }
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  target.innerHTML = entries.map((entry) => {
    const live = localDateKey(now) === localDateKey(new Date())
      && nowMinutes >= periodMinutes(entry.starts_at) && nowMinutes < periodMinutes(entry.ends_at);
    const teacher = teacherName(entry.teacher_code);
    const details = [
      `${formatTime(entry.starts_at)}–${formatTime(entry.ends_at)}`,
      teacher,
      entry.room ? `Room ${entry.room}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="routine-row">
      <div class="routine-period">Period ${entry.period_no}<br>${esc(formatTime(entry.starts_at))}</div>
      <div class="routine-copy ${live ? 'is-live' : ''}">
        <h4>${esc(subjectName(entry.subject_code))}</h4>
        <p>${esc(details)}</p>
        ${live ? '<span class="routine-live">LIVE NOW</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

function attendanceStats() {
  const total = state.logs.length;
  const attended = state.logs.filter((row) => row.status === 'present').length;
  const absent = total - attended;
  const percent = total ? Math.round(attended / total * 100) : 0;
  const required = percent < 75 && total ? Math.max(0, Math.ceil((0.75 * total - attended) / 0.25)) : 0;
  return { total, attended, absent, percent, required };
}

function renderDashboard() {
  updateStudentHeader();
  const stats = attendanceStats();
  const today = new Date();
  const todaysEntries = entriesForDay(today);
  const now = today.getHours() * 60 + today.getMinutes();
  const live = todaysEntries.find((entry) => now >= periodMinutes(entry.starts_at) && now < periodMinutes(entry.ends_at));
  const next = todaysEntries.find((entry) => periodMinutes(entry.starts_at) > now);
  renderRoutine($('dashboardRoutine'), todaysEntries, 'No periods are scheduled for this class today.');
  if ($('routineDate')) $('routineDate').textContent = today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  if ($('heroAttendanceValue')) $('heroAttendanceValue').textContent = `${stats.percent}%`;
  if ($('heroCurrentValue')) $('heroCurrentValue').textContent = live ? live.subject_code : '—';
  if ($('heroNextValue')) $('heroNextValue').textContent = next ? next.subject_code : 'No more';
  if ($('heroClassValue')) $('heroClassValue').textContent = state.selectedClass
    ? `${state.selectedClass.year_no}Y ${state.selectedClass.section}` : 'Choose class';
  if ($('attendancePct')) $('attendancePct').textContent = `${stats.percent}%`;
  if ($('attendanceStatus')) {
    const status = $('attendanceStatus');
    status.className = `status-clear ${stats.total ? (stats.percent >= 75 ? '' : 'status-warning') : 'status-neutral'}`;
    status.textContent = stats.total
      ? (stats.percent >= 75 ? 'Status: Clear (≥75%)' : 'Status: Below 75%')
      : 'No attendance logged yet';
  }
  if ($('attendanceHint')) $('attendanceHint').textContent = stats.total
    ? `${stats.attended} present · ${stats.absent} absent · ${stats.total} periods marked`
    : 'Mark attendance on the Attendance page to build your personal summary.';
  const ring = document.querySelector('.ring-fg');
  if (ring) ring.style.strokeDashoffset = 345.6 - Math.min(stats.percent, 100) / 100 * 345.6;
  if ($('classSummary')) $('classSummary').textContent = state.selectedClass
    ? `${state.selectedClass.label} · ${state.selectedClass.semester_label} ${state.selectedClass.academic_year}`
    : 'Select your course, year and section.';
  if ($('todayScheduleCount')) $('todayScheduleCount').textContent = `${todaysEntries.length} periods today`;
}

function attendanceLogFor(entryId, dateString) {
  return state.logs.find((row) => row.timetable_entry_id === entryId && row.attendance_date === dateString);
}

async function refreshLogs() {
  const { data, error } = await supabase.from('attendance_logs')
    .select('id,student_id,class_id,timetable_entry_id,attendance_date,status,created_at')
    .eq('student_id', state.user.id).eq('class_id', state.selectedClass.id)
    .order('attendance_date', { ascending: false }).limit(1000);
  if (error) throw error;
  state.logs = data || [];
}

async function setAttendance(entryId, date, status) {
  if (state.busy) return;
  state.busy = true;
  try {
    const entry = state.entries.find((item) => item.id === entryId);
    if (!entry) throw new Error('The timetable period was not found. Reload the page and try again.');
    const { error } = await supabase.from('attendance_logs').upsert({
      student_id: state.user.id,
      class_id: state.selectedClass.id,
      timetable_entry_id: entryId,
      attendance_date: date,
      status,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'student_id,timetable_entry_id,attendance_date' });
    if (error) throw error;
    await refreshLogs();
    renderAttendancePage();
    toast(status === 'present' ? 'Marked present.' : 'Marked absent.');
  } catch (error) {
    toast(migrationHint(error), true);
  } finally {
    state.busy = false;
  }
}

function renderAttendanceSubjects() {
  const wrap = $('subjectList');
  if (!wrap) return;
  const today = new Date();
  const date = localDateKey(today);
  const entries = entriesForDay(today);
  if (!entries.length) {
    wrap.innerHTML = '<div class="routine-empty">No periods are scheduled for your selected class today.</div>';
    return;
  }
  wrap.innerHTML = entries.map((entry) => {
    const log = attendanceLogFor(entry.id, date);
    const teacher = teacherName(entry.teacher_code);
    const subline = [
      `Period ${entry.period_no} · ${formatTime(entry.starts_at)}–${formatTime(entry.ends_at)}`,
      teacher,
      entry.room ? `Room ${entry.room}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="subject-row">
      <div class="s-icon icon-indigo"><i class="fas fa-book-open"></i></div>
      <div class="s-name">${esc(subjectName(entry.subject_code))}<small>${esc(subline)}</small></div>
      <div class="log-btns">
        <button class="log-btn present ${log?.status === 'present' ? 'active' : ''}" data-entry="${esc(entry.id)}" data-status="present" aria-label="Mark ${esc(subjectName(entry.subject_code))} present"><i class="fas fa-check"></i> Present</button>
        <button class="log-btn absent ${log?.status === 'absent' ? 'active' : ''}" data-entry="${esc(entry.id)}" data-status="absent" aria-label="Mark ${esc(subjectName(entry.subject_code))} absent"><i class="fas fa-times"></i> Absent</button>
      </div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-entry][data-status]').forEach((button) => {
    button.addEventListener('click', () => setAttendance(button.dataset.entry, date, button.dataset.status));
  });
}

function renderAttendanceRing() {
  const stats = attendanceStats();
  const ring = $('ringFg');
  if (ring) ring.style.strokeDashoffset = 345.6 - Math.min(stats.percent, 100) / 100 * 345.6;
  if ($('pctText')) $('pctText').textContent = `${stats.percent}%`;
  if ($('totalStat')) $('totalStat').textContent = stats.total;
  if ($('attendedStat')) $('attendedStat').textContent = stats.attended;
  if ($('missedStat')) $('missedStat').textContent = stats.absent;
  if ($('requiredStat')) $('requiredStat').textContent = stats.required;
  const pill = $('statusPill');
  const text = $('statusText');
  if (pill && text) {
    pill.className = `status-pill ${stats.total && stats.percent >= 75 ? 'ok' : 'warn'}`;
    text.textContent = stats.total ? (stats.percent >= 75 ? 'Status: Clear (≥75%)' : 'Status: Below 75%') : 'No attendance recorded';
  }
}

function renderLogTable() {
  const body = $('logTableBody');
  if (!body) return;
  const sorted = [...state.logs].sort((a, b) => b.attendance_date.localeCompare(a.attendance_date));
  if ($('logCount')) $('logCount').textContent = `${sorted.length} entries`;
  if (!sorted.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">No attendance records yet. Mark your status for today’s scheduled periods.</td></tr>';
    return;
  }
  body.innerHTML = sorted.slice(0, 100).map((log) => {
    const entry = state.entries.find((item) => item.id === log.timetable_entry_id);
    const date = new Date(`${log.attendance_date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const label = entry ? `${subjectName(entry.subject_code)} · P${entry.period_no}` : 'Timetable period';
    return `<tr>
      <td class="date-cell">${esc(date)}</td>
      <td>${esc(label)}</td>
      <td><div class="status-toggle">
        <button class="p-btn ${log.status === 'present' ? 'on' : ''}" data-log="${esc(log.id)}" data-status="present" aria-label="Mark present">P</button>
        <button class="a-btn ${log.status === 'absent' ? 'on' : ''}" data-log="${esc(log.id)}" data-status="absent" aria-label="Mark absent">A</button>
      </div></td>
      <td><button class="del-btn" data-delete-log="${esc(log.id)}" aria-label="Delete attendance entry"><i class="fas fa-trash"></i></button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-log][data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const { error } = await supabase.from('attendance_logs')
        .update({ status: button.dataset.status, updated_at: new Date().toISOString() })
        .eq('id', button.dataset.log).eq('student_id', state.user.id);
      if (error) { toast(migrationHint(error), true); return; }
      await refreshLogs();
      renderAttendancePage();
    });
  });
  body.querySelectorAll('[data-delete-log]').forEach((button) => {
    button.addEventListener('click', async () => {
      const { error } = await supabase.from('attendance_logs').delete()
        .eq('id', button.dataset.deleteLog).eq('student_id', state.user.id);
      if (error) { toast(migrationHint(error), true); return; }
      await refreshLogs();
      renderAttendancePage();
      toast('Attendance entry deleted.');
    });
  });
}

function dayStatusColor(date) {
  const dayLogs = state.logs.filter((row) => row.attendance_date === date);
  if (!dayLogs.length) return '';
  const present = dayLogs.filter((row) => row.status === 'present').length;
  if (present === dayLogs.length) return 'green';
  if (present === 0) return 'red';
  return 'mixed';
}

let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
function renderCalendar() {
  const grid = $('calGrid');
  if (!grid) return;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  if ($('calMonthLabel')) $('calMonthLabel').textContent = calendarCursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  let html = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => `<div class="cal-dow">${day}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (let day = 1; day <= days; day++) {
    const date = new Date(year, month, day);
    const key = localDateKey(date);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const today = key === localDateKey(new Date());
    const dot = dayStatusColor(key);
    html += `<div class="cal-day ${weekend ? 'weekend' : ''} ${today ? 'today' : ''}" data-date="${key}">${day}${dot ? `<span class="dot ${dot}"></span>` : ''}</div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-day:not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => openDateLog(cell.dataset.date));
  });
}

function openDateLog(date) {
  const today = localDateKey(new Date());
  const earliest = state.selectedClass?.effective_from || '2026-07-20';
  if (date > today) { toast('Attendance cannot be marked for a future date.', true); return; }
  if (date < earliest) { toast(`Attendance records for this timetable are available from ${new Date(`${earliest}T00:00:00`).toLocaleDateString('en-IN')}.`, true); return; }
  const dateObject = new Date(`${date}T00:00:00`);
  const entries = entriesForDay(dateObject);
  if (!entries.length) { toast('No periods are scheduled for the selected class on this date.', true); return; }
  $('modalDate').textContent = dateObject.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('modalSubject').innerHTML = entries.map((entry) => {
    const log = attendanceLogFor(entry.id, date);
    return `<option value="${esc(entry.id)}">P${entry.period_no} · ${esc(subjectName(entry.subject_code))} · ${esc(formatTime(entry.starts_at))}${log ? ` · currently ${esc(log.status)}` : ''}</option>`;
  }).join('');
  $('modalOverlay').classList.add('open');
  $('modalOverlay').dataset.date = date;
}

function renderAttendancePage() {
  updateStudentHeader();
  renderAttendanceRing();
  renderAttendanceSubjects();
  renderLogTable();
  renderCalendar();
}

function renderCurrentPage() {
  if (document.body.dataset.page === 'attendance') renderAttendancePage();
  else renderDashboard();
}

function bindAttendanceControls() {
  if ($('calPrev')) $('calPrev').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  if ($('calNext')) $('calNext').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  const overlay = $('modalOverlay');
  if (!overlay) return;
  const close = () => overlay.classList.remove('open');
  $('modalClose').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  $('modalPresent').addEventListener('click', () => {
    if (overlay.dataset.date && $('modalSubject').value) setAttendance($('modalSubject').value, overlay.dataset.date, 'present').then(close);
  });
  $('modalAbsent').addEventListener('click', () => {
    if (overlay.dataset.date && $('modalSubject').value) setAttendance($('modalSubject').value, overlay.dataset.date, 'absent').then(close);
  });
}

async function initialize(page) {
  addSharedStyles();
  bindClassSwitchers();
  if (page === 'attendance') bindAttendanceControls();
  const session = await requireAuth();
  if (!session) return;
  state.user = session.user;
  try {
    await loadClassOptions();
    await loadPreference();
    if (!state.selectedClass) {
      updateStudentHeader();
      openClassDialog(true);
      return;
    }
    await loadSelectedClassData();
    await loadDashboardAssignments();
    renderCurrentPage();
  } catch (error) {
    console.error(error);
    const message = migrationHint(error);
    const target = $('dashboardRoutine') || $('subjectList');
    if (target) target.innerHTML = `<div class="routine-empty">${esc(message)}</div>`;
    if ($('attendanceStatus')) $('attendanceStatus').textContent = 'Supabase setup required';
    if ($('statusText')) $('statusText').textContent = 'Supabase setup required';
    toast(message, true);
  }
}

export function initDashboard() { initialize('dashboard'); }
export function initAttendancePage() { initialize('attendance'); }
