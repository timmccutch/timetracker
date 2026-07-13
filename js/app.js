/* TimeTracker — time tracking + pomodoro PWA.
 * All data lives in localStorage on this device. No server, no account.
 */
(() => {
  'use strict';

  /* ================= storage ================= */

  const LS = {
    projects: 'tt_projects',
    sessions: 'tt_sessions',
    settings: 'tt_settings',
    running: 'tt_running',
  };

  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const DEFAULT_SETTINGS = {
    workMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    rounds: 4,
    sound: true,
    notify: false,
    autoBreak: false,
  };

  let projects = load(LS.projects, []);
  let sessions = load(LS.sessions, []);
  let settings = { ...DEFAULT_SETTINGS, ...load(LS.settings, {}) };
  // running: null | { mode:'timer'|'pomodoro', projectId, startedAt, segmentStart,
  //   accumulatedSec, paused, originalStart, phase, phaseTotalSec, completedRounds }
  let running = load(LS.running, null);

  const saveProjects = () => save(LS.projects, projects);
  const saveSessions = () => save(LS.sessions, sessions);
  const saveSettings = () => save(LS.settings, settings);
  const saveRunning = () => save(LS.running, running);

  /* ================= helpers ================= */

  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();

  const pad = (n) => String(n).padStart(2, '0');

  function fmtHMS(totalSec) {
    totalSec = Math.max(0, Math.round(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function fmtMS(totalSec) {
    totalSec = Math.max(0, Math.ceil(totalSec));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${pad(m)}:${pad(s)}`;
  }

  function fmtHuman(totalSec) {
    totalSec = Math.round(totalSec);
    const h = Math.floor(totalSec / 3600);
    const m = Math.round((totalSec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${totalSec}s`;
  }

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) =>
    new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

  function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  const projectById = (id) => projects.find((p) => p.id === id) || null;
  const projectName = (id) => (projectById(id) ? projectById(id).name : '(deleted project)');
  const projectColor = (id) => (projectById(id) ? projectById(id).color : '#666');

  /* ================= alarm sound ================= */

  let audioCtx = null;

  // iOS/Safari only allow audio after a user gesture; call this from click handlers.
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep(freq, startAt, duration) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.5, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.05);
  }

  function playAlarm() {
    if (!settings.sound) return;
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    // three rounds of a rising double-chime
    for (let i = 0; i < 3; i++) {
      beep(880, t + i * 0.9, 0.25);
      beep(1174.66, t + i * 0.9 + 0.3, 0.35);
    }
  }

  function notifyUser(title, body) {
    if (!settings.notify || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: 'icons/icon-192.png' });
      } catch { /* some platforms need a service-worker notification; ignore */ }
    }
  }

  /* ================= projects ================= */

  const COLORS = [
    '#4f8cff', '#3ecf8e', '#f5b942', '#f26d6d', '#b57edc',
    '#4dd0e1', '#ff8a5c', '#7986cb', '#aed581', '#f06292',
  ];
  let selectedColor = COLORS[0];

  function activeProjects() {
    return projects.filter((p) => !p.archived);
  }

  function addProject(name, color) {
    name = name.trim();
    if (!name) return null;
    if (projects.some((p) => p.name.toLowerCase() === name.toLowerCase() && !p.archived)) {
      toast('A project with that name already exists');
      return null;
    }
    const project = { id: uid(), name, color: color || COLORS[projects.length % COLORS.length], archived: false, createdAt: now() };
    projects.push(project);
    saveProjects();
    renderProjects();
    renderProjectSelects();
    return project;
  }

  function promptNewProject(selectEl) {
    const name = prompt('New project name:');
    if (!name) return;
    const project = addProject(name);
    if (project && selectEl) {
      selectEl.value = project.id;
      persistFormState();
    }
  }

  function renderProjectSelects() {
    const active = activeProjects();
    for (const sel of [$('timer-project'), $('pomo-project')]) {
      const prev = sel.value;
      sel.innerHTML = '';
      if (active.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No projects yet — tap ＋';
        sel.appendChild(opt);
      }
      for (const p of active) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      }
      if (prev && active.some((p) => p.id === prev)) sel.value = prev;
    }
    // report filter includes archived projects and "all"
    const filter = $('report-project-filter');
    const prevFilter = filter.value;
    filter.innerHTML = '<option value="">All projects</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.archived ? ' (archived)' : '');
      filter.appendChild(opt);
    }
    if (prevFilter && projects.some((p) => p.id === prevFilter)) filter.value = prevFilter;
  }

  function projectTotalSec(id) {
    return sessions.filter((s) => s.projectId === id).reduce((sum, s) => sum + s.durationSec, 0);
  }

  function renderProjects() {
    const ul = $('project-list');
    ul.innerHTML = '';
    if (projects.length === 0) {
      ul.innerHTML = '<li class="muted">No projects yet. Create one above to start tracking.</li>';
      return;
    }
    for (const p of projects) {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'project-dot';
      dot.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'project-name' + (p.archived ? ' archived' : '');
      name.textContent = p.name;

      const total = document.createElement('span');
      total.className = 'project-total';
      total.textContent = fmtHuman(projectTotalSec(p.id));

      const rename = document.createElement('button');
      rename.className = 'icon-btn';
      rename.title = 'Rename';
      rename.textContent = '✏️';
      rename.onclick = () => {
        const newName = prompt('Rename project:', p.name);
        if (newName && newName.trim()) {
          p.name = newName.trim();
          saveProjects();
          renderAll();
        }
      };

      const archive = document.createElement('button');
      archive.className = 'icon-btn';
      archive.title = p.archived ? 'Unarchive' : 'Archive (hide from pickers, keep history)';
      archive.textContent = p.archived ? '📤' : '📥';
      archive.onclick = () => {
        p.archived = !p.archived;
        saveProjects();
        renderAll();
      };

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.title = 'Delete';
      del.textContent = '🗑';
      del.onclick = () => {
        const n = sessions.filter((s) => s.projectId === p.id).length;
        const msg = n
          ? `Delete "${p.name}" AND its ${n} tracked session${n > 1 ? 's' : ''}? This cannot be undone.`
          : `Delete "${p.name}"?`;
        if (!confirm(msg)) return;
        projects = projects.filter((x) => x.id !== p.id);
        sessions = sessions.filter((s) => s.projectId !== p.id);
        saveProjects();
        saveSessions();
        renderAll();
      };

      li.append(dot, name, total, rename, archive, del);
      ul.appendChild(li);
    }
  }

  function renderColorPicker() {
    const wrap = $('color-picker');
    wrap.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-swatch' + (c === selectedColor ? ' selected' : '');
      b.style.background = c;
      b.onclick = () => {
        selectedColor = c;
        renderColorPicker();
      };
      wrap.appendChild(b);
    }
  }

  /* ================= running-session engine ================= */

  // Seconds of active (non-paused) time in the current run.
  function activeSec() {
    if (!running) return 0;
    let sec = running.accumulatedSec;
    if (!running.paused) sec += (now() - running.segmentStart) / 1000;
    return sec;
  }

  function requireProject(selectEl) {
    const id = selectEl.value;
    if (!id || !projectById(id)) {
      toast('Create or select a project first');
      switchTab('projects');
      return null;
    }
    return id;
  }

  function startRun(mode, projectId) {
    const t = now();
    running = {
      mode,
      projectId,
      originalStart: t,
      segmentStart: t,
      accumulatedSec: 0,
      paused: false,
      phase: 'work',
      phaseTotalSec: settings.workMin * 60,
      completedRounds: 0,
    };
    saveRunning();
  }

  function pauseRun() {
    if (!running || running.paused) return;
    running.accumulatedSec += (now() - running.segmentStart) / 1000;
    running.paused = true;
    saveRunning();
  }

  function resumeRun() {
    if (!running || !running.paused) return;
    running.segmentStart = now();
    running.paused = false;
    saveRunning();
  }

  function clearRun() {
    running = null;
    localStorage.removeItem(LS.running);
  }

  function logSession(projectId, description, type, startTs, endTs, durationSec) {
    if (durationSec < 1) return null;
    const session = {
      id: uid(),
      projectId,
      description: (description || '').trim(),
      type,
      start: startTs,
      end: endTs,
      durationSec: Math.round(durationSec),
    };
    sessions.push(session);
    saveSessions();
    return session;
  }

  function blockIfOtherRunning(mode) {
    if (running && running.mode !== mode) {
      toast(running.mode === 'timer'
        ? 'A timer is already running — stop it first (Track tab)'
        : 'A pomodoro is already running — reset it first (Pomodoro tab)');
      return true;
    }
    return false;
  }

  /* ================= regular timer ================= */

  function timerStart() {
    ensureAudio();
    if (blockIfOtherRunning('timer')) return;
    const projectId = requireProject($('timer-project'));
    if (!projectId) return;
    startRun('timer', projectId);
    renderTimerUI();
  }

  function timerStop(discard = false) {
    if (!running || running.mode !== 'timer') return;
    const duration = activeSec();
    if (!discard) {
      const s = logSession(
        running.projectId,
        $('timer-description').value,
        'timer',
        running.originalStart,
        now(),
        duration
      );
      if (s) toast(`Saved ${fmtHuman(s.durationSec)} to ${projectName(s.projectId)}`);
      else toast('Session under 1 second — not saved');
    }
    clearRun();
    $('timer-description').value = '';
    persistFormState();
    renderAll();
  }

  function renderTimerUI() {
    const isTimer = running && running.mode === 'timer';
    $('timer-display').textContent = fmtHMS(isTimer ? activeSec() : 0);
    $('timer-status').textContent = !isTimer
      ? 'Ready to track'
      : running.paused
        ? 'Paused'
        : `Tracking ${projectName(running.projectId)} since ${fmtTime(running.originalStart)}`;

    $('timer-start').classList.toggle('hidden', !!isTimer);
    $('timer-pause').classList.toggle('hidden', !isTimer || running.paused);
    $('timer-resume').classList.toggle('hidden', !isTimer || !running.paused);
    $('timer-stop').classList.toggle('hidden', !isTimer);
    $('timer-discard').classList.toggle('hidden', !isTimer);
    $('timer-project').disabled = !!isTimer;
  }

  /* ================= pomodoro ================= */

  const PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

  function phaseDurationSec(phase) {
    if (phase === 'work') return settings.workMin * 60;
    if (phase === 'short') return settings.shortBreakMin * 60;
    return settings.longBreakMin * 60;
  }

  function pomoStart() {
    ensureAudio();
    if (blockIfOtherRunning('pomodoro')) return;
    const projectId = requireProject($('pomo-project'));
    if (!projectId) return;
    if (settings.notify) requestNotifyPermission();
    startRun('pomodoro', projectId);
    renderPomoUI();
  }

  function pomoReset() {
    if (!running || running.mode !== 'pomodoro') return;
    if (running.phase === 'work' && activeSec() >= 60) {
      if (confirm('Save the partial focus time before resetting?')) {
        logSession(running.projectId, $('pomo-description').value, 'pomodoro',
          running.originalStart, now(), activeSec());
      }
    }
    clearRun();
    renderAll();
  }

  // Called on tick when remaining hits 0, and on load if a phase finished while the app was closed.
  function pomoPhaseComplete() {
    const wasWork = running.phase === 'work';
    const phaseEnd = running.phaseEndsAtEstimate || now();

    if (wasWork) {
      logSession(running.projectId, $('pomo-description').value, 'pomodoro',
        running.originalStart, phaseEnd, running.phaseTotalSec);
      running.completedRounds += 1;
    }

    playAlarm();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);

    const nextPhase = wasWork
      ? (running.completedRounds % settings.rounds === 0 ? 'long' : 'short')
      : 'work';

    notifyUser(
      wasWork ? '🍅 Focus round done!' : '⏰ Break over!',
      wasWork ? `Time for a ${nextPhase === 'long' ? 'long' : 'short'} break.` : 'Back to focus.'
    );
    toast(wasWork ? `Focus round done — ${PHASE_LABEL[nextPhase].toLowerCase()} time!` : 'Break over — back to focus!');

    running.phase = nextPhase;
    running.phaseTotalSec = phaseDurationSec(nextPhase);
    running.accumulatedSec = 0;
    running.originalStart = now();
    running.segmentStart = now();
    // auto-start breaks if configured; work rounds always wait for the user
    running.paused = !(wasWork && settings.autoBreak);
    saveRunning();
  }

  function pomoSkip() {
    if (!running || running.mode !== 'pomodoro') return;
    if (running.phase === 'work' && activeSec() >= 60 &&
        confirm('Save the partial focus time from this round?')) {
      logSession(running.projectId, $('pomo-description').value, 'pomodoro',
        running.originalStart, now(), activeSec());
    }
    const wasWork = running.phase === 'work';
    if (wasWork) running.completedRounds += 1;
    const nextPhase = wasWork
      ? (running.completedRounds % settings.rounds === 0 ? 'long' : 'short')
      : 'work';
    running.phase = nextPhase;
    running.phaseTotalSec = phaseDurationSec(nextPhase);
    running.accumulatedSec = 0;
    running.originalStart = now();
    running.segmentStart = now();
    running.paused = true;
    saveRunning();
    renderAll();
  }

  function pomoRemainingSec() {
    return running.phaseTotalSec - activeSec();
  }

  function renderPomoUI() {
    const isPomo = running && running.mode === 'pomodoro';
    const phase = isPomo ? running.phase : 'work';

    const phaseEl = $('pomo-phase');
    phaseEl.textContent = PHASE_LABEL[phase] + (isPomo && running.paused ? ' · paused' : '');
    phaseEl.className = 'pomo-phase ' + (phase === 'work' ? 'work' : 'break');

    $('pomo-display').textContent = fmtMS(isPomo ? pomoRemainingSec() : settings.workMin * 60);

    const dots = $('pomo-dots');
    dots.innerHTML = '';
    const doneInCycle = isPomo ? running.completedRounds % settings.rounds : 0;
    const showFull = isPomo && running.completedRounds > 0 && doneInCycle === 0 && phase === 'long';
    for (let i = 0; i < settings.rounds; i++) {
      const d = document.createElement('span');
      if (i < (showFull ? settings.rounds : doneInCycle)) d.className = 'done';
      dots.appendChild(d);
    }

    $('pomo-start').classList.toggle('hidden', !!isPomo);
    $('pomo-pause').classList.toggle('hidden', !isPomo || running.paused);
    $('pomo-resume').classList.toggle('hidden', !isPomo || !running.paused);
    $('pomo-skip').classList.toggle('hidden', !isPomo);
    $('pomo-reset').classList.toggle('hidden', !isPomo);
    $('pomo-project').disabled = !!isPomo;
  }

  /* ================= notifications ================= */

  function requestNotifyPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission();
  }

  /* ================= tick loop ================= */

  function tick() {
    if (!running) return;
    if (running.mode === 'timer') {
      if (currentTab === 'track') $('timer-display').textContent = fmtHMS(activeSec());
    } else {
      running.phaseEndsAtEstimate = now();
      if (pomoRemainingSec() <= 0 && !running.paused) {
        pomoPhaseComplete();
        renderAll();
      } else if (currentTab === 'pomodoro') {
        $('pomo-display').textContent = fmtMS(pomoRemainingSec());
      }
    }
    renderRunningIndicator();
  }
  setInterval(tick, 500);

  function renderRunningIndicator() {
    const el = $('running-indicator');
    if (!running) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.classList.toggle('paused', running.paused);
    const label = running.mode === 'timer'
      ? fmtHMS(activeSec())
      : `${PHASE_LABEL[running.phase]} ${fmtMS(pomoRemainingSec())}`;
    $('running-indicator-text').textContent =
      `${projectName(running.projectId)} · ${label}${running.paused ? ' (paused)' : ''}`;
  }

  /* ================= today panel ================= */

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function renderToday() {
    const todayStart = startOfDay(now());
    const todays = sessions.filter((s) => s.end >= todayStart).sort((a, b) => b.end - a.end);
    const total = todays.reduce((sum, s) => sum + s.durationSec, 0);
    $('today-summary').innerHTML = todays.length
      ? `<strong>${fmtHuman(total)}</strong> tracked across ${todays.length} session${todays.length > 1 ? 's' : ''}`
      : 'Nothing tracked yet today.';

    const ul = $('today-sessions');
    ul.innerHTML = '';
    for (const s of todays.slice(0, 8)) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'project-dot';
      dot.style.background = projectColor(s.projectId);
      dot.style.marginTop = '4px';

      const info = document.createElement('div');
      info.className = 'session-info';
      const proj = document.createElement('div');
      proj.className = 'session-project';
      proj.textContent = projectName(s.projectId) + (s.type === 'pomodoro' ? ' 🍅' : '');
      const desc = document.createElement('div');
      desc.className = 'session-desc';
      desc.textContent = s.description || '—';
      info.append(proj, desc);

      const time = document.createElement('span');
      time.className = 'session-time';
      time.textContent = fmtHuman(s.durationSec);

      li.append(dot, info, time);
      ul.appendChild(li);
    }
  }

  /* ================= reports ================= */

  let reportRange = 'week';

  function rangeBounds() {
    const nowTs = now();
    const today = startOfDay(nowTs);
    switch (reportRange) {
      case 'today':
        return [today, nowTs];
      case 'week': {
        const d = new Date(today);
        const dow = (d.getDay() + 6) % 7; // Monday = 0
        d.setDate(d.getDate() - dow);
        return [d.getTime(), nowTs];
      }
      case 'month': {
        const d = new Date(today);
        d.setDate(1);
        return [d.getTime(), nowTs];
      }
      case 'custom': {
        const fromVal = $('range-from').value;
        const toVal = $('range-to').value;
        const from = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : 0;
        const to = toVal ? new Date(toVal + 'T23:59:59.999').getTime() : nowTs;
        return [from, to];
      }
      default:
        return [0, nowTs];
    }
  }

  function filteredSessions() {
    const [from, to] = rangeBounds();
    const projectFilter = $('report-project-filter').value;
    return sessions
      .filter((s) => s.start >= from && s.start <= to)
      .filter((s) => !projectFilter || s.projectId === projectFilter)
      .sort((a, b) => b.start - a.start);
  }

  function renderReports() {
    const list = filteredSessions();
    const totalSec = list.reduce((sum, s) => sum + s.durationSec, 0);

    $('report-totals').innerHTML = `
      <div class="total-box"><div class="value">${fmtHuman(totalSec)}</div><div class="label">Total time</div></div>
      <div class="total-box"><div class="value">${list.length}</div><div class="label">Sessions</div></div>
      <div class="total-box"><div class="value">${list.filter((s) => s.type === 'pomodoro').length}</div><div class="label">Pomodoros</div></div>
    `;

    // per-project bars
    const byProject = new Map();
    for (const s of list) {
      byProject.set(s.projectId, (byProject.get(s.projectId) || 0) + s.durationSec);
    }
    const sorted = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
    const max = sorted.length ? sorted[0][1] : 1;
    const bars = $('report-bars');
    bars.innerHTML = '';
    for (const [pid, sec] of sorted) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const label = document.createElement('div');
      label.className = 'bar-label';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = projectName(pid);
      const timeSpan = document.createElement('span');
      timeSpan.className = 'time';
      timeSpan.textContent = fmtHuman(sec);
      label.append(nameSpan, timeSpan);
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${Math.max(2, (sec / max) * 100)}%`;
      fill.style.background = projectColor(pid);
      track.appendChild(fill);
      row.append(label, track);
      bars.appendChild(row);
    }
    if (!sorted.length) bars.innerHTML = '<p class="muted">No sessions in this range yet.</p>';

    // table
    $('session-count').textContent = list.length ? `(${list.length})` : '';
    const tbody = $('report-rows');
    tbody.innerHTML = '';
    for (const s of list.slice(0, 200)) {
      const tr = document.createElement('tr');
      const cells = [
        [fmtDate(s.start), 'nowrap'],
        [projectName(s.projectId), ''],
        [s.description || '—', 'desc-cell'],
        [s.type === 'pomodoro' ? '🍅 Pomodoro' : '⏱ Timer', 'nowrap'],
        [fmtTime(s.start), 'nowrap'],
        [fmtTime(s.end), 'nowrap'],
        [fmtHMS(s.durationSec), 'nowrap'],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      const tdDel = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.title = 'Delete session';
      delBtn.textContent = '🗑';
      delBtn.onclick = () => {
        if (!confirm('Delete this session?')) return;
        sessions = sessions.filter((x) => x.id !== s.id);
        saveSessions();
        renderAll();
      };
      tdDel.appendChild(delBtn);
      tr.appendChild(tdDel);
      tbody.appendChild(tr);
    }
    if (list.length > 200) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'muted';
      td.textContent = `Showing latest 200 of ${list.length} sessions — the CSV export includes all of them.`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  /* ================= CSV export ================= */

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function isoLocal(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function exportCSV() {
    const list = filteredSessions();
    if (!list.length) {
      toast('No sessions in this range to export');
      return;
    }
    const header = ['Date', 'Project', 'Description', 'Type', 'Start', 'End',
      'Duration (seconds)', 'Duration (hh:mm:ss)', 'Duration (hours)'];
    const rows = list
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((s) => [
        isoLocal(s.start).slice(0, 10),
        projectName(s.projectId),
        s.description,
        s.type,
        isoLocal(s.start),
        isoLocal(s.end),
        s.durationSec,
        fmtHMS(s.durationSec),
        (s.durationSec / 3600).toFixed(2),
      ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    // BOM so Excel opens it with correct encoding
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = isoLocal(now()).slice(0, 10);
    a.href = url;
    a.download = `timetracker-${reportRange}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Exported ${list.length} sessions`);
  }

  /* ================= form-state persistence ================= */

  // keep descriptions/selection across reloads so a running timer keeps its context
  function persistFormState() {
    save('tt_form', {
      timerDesc: $('timer-description').value,
      pomoDesc: $('pomo-description').value,
      timerProject: $('timer-project').value,
      pomoProject: $('pomo-project').value,
    });
  }

  function restoreFormState() {
    const f = load('tt_form', null);
    if (!f) return;
    $('timer-description').value = f.timerDesc || '';
    $('pomo-description').value = f.pomoDesc || '';
    if (f.timerProject) $('timer-project').value = f.timerProject;
    if (f.pomoProject) $('pomo-project').value = f.pomoProject;
    // a running session's project always wins
    if (running) {
      const sel = running.mode === 'timer' ? $('timer-project') : $('pomo-project');
      sel.value = running.projectId;
    }
  }

  /* ================= settings UI ================= */

  function renderSettings() {
    $('set-work').value = settings.workMin;
    $('set-short').value = settings.shortBreakMin;
    $('set-long').value = settings.longBreakMin;
    $('set-rounds').value = settings.rounds;
    $('set-sound').checked = settings.sound;
    $('set-notify').checked = settings.notify;
    $('set-autobreak').checked = settings.autoBreak;
  }

  function bindSettings() {
    const numeric = [
      ['set-work', 'workMin', 1, 180],
      ['set-short', 'shortBreakMin', 1, 60],
      ['set-long', 'longBreakMin', 1, 120],
      ['set-rounds', 'rounds', 1, 12],
    ];
    for (const [id, key, min, max] of numeric) {
      $(id).addEventListener('change', (e) => {
        let v = parseInt(e.target.value, 10);
        if (isNaN(v)) v = DEFAULT_SETTINGS[key];
        v = Math.min(max, Math.max(min, v));
        e.target.value = v;
        settings[key] = v;
        saveSettings();
        // if a pomodoro isn't running, refresh the idle display
        if (!running || running.mode !== 'pomodoro') renderPomoUI();
      });
    }
    $('set-sound').addEventListener('change', (e) => {
      settings.sound = e.target.checked;
      saveSettings();
      if (settings.sound) ensureAudio();
    });
    $('set-notify').addEventListener('change', (e) => {
      settings.notify = e.target.checked;
      saveSettings();
      if (settings.notify) requestNotifyPermission();
    });
    $('set-autobreak').addEventListener('change', (e) => {
      settings.autoBreak = e.target.checked;
      saveSettings();
    });
    $('test-sound').addEventListener('click', () => {
      ensureAudio();
      const wasOn = settings.sound;
      settings.sound = true;
      playAlarm();
      settings.sound = wasOn;
    });
  }

  /* ================= tabs ================= */

  let currentTab = 'track';

  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active'));
    $(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
    if (name === 'reports') renderReports();
    if (name === 'track') renderToday();
  }

  /* ================= render all ================= */

  function renderAll() {
    renderProjectSelects();
    renderProjects();
    renderTimerUI();
    renderPomoUI();
    renderToday();
    renderReports();
    renderRunningIndicator();
  }

  /* ================= init ================= */

  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('timer-start').addEventListener('click', timerStart);
    $('timer-pause').addEventListener('click', () => { pauseRun(); renderAll(); });
    $('timer-resume').addEventListener('click', () => { ensureAudio(); resumeRun(); renderAll(); });
    $('timer-stop').addEventListener('click', () => timerStop(false));
    $('timer-discard').addEventListener('click', () => {
      if (confirm('Discard this session without saving?')) timerStop(true);
    });
    $('timer-new-project').addEventListener('click', () => promptNewProject($('timer-project')));

    $('pomo-start').addEventListener('click', pomoStart);
    $('pomo-pause').addEventListener('click', () => { pauseRun(); renderAll(); });
    $('pomo-resume').addEventListener('click', () => { ensureAudio(); resumeRun(); renderAll(); });
    $('pomo-skip').addEventListener('click', pomoSkip);
    $('pomo-reset').addEventListener('click', pomoReset);
    $('pomo-new-project').addEventListener('click', () => promptNewProject($('pomo-project')));

    $('project-add').addEventListener('click', () => {
      const project = addProject($('project-name').value, selectedColor);
      if (project) {
        $('project-name').value = '';
        toast(`Project "${project.name}" created`);
      } else if (!$('project-name').value.trim()) {
        toast('Enter a project name');
      }
    });
    $('project-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('project-add').click();
    });

    document.querySelectorAll('#range-buttons .btn-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#range-buttons .btn-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        reportRange = btn.dataset.range;
        $('custom-range').classList.toggle('hidden', reportRange !== 'custom');
        renderReports();
      });
    });
    $('range-from').addEventListener('change', renderReports);
    $('range-to').addEventListener('change', renderReports);
    $('report-project-filter').addEventListener('change', renderReports);
    $('export-csv').addEventListener('click', exportCSV);

    for (const id of ['timer-description', 'pomo-description']) {
      $(id).addEventListener('input', persistFormState);
    }
    for (const id of ['timer-project', 'pomo-project']) {
      $(id).addEventListener('change', persistFormState);
    }

    bindSettings();

    // catch up immediately when the tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });
  }

  function recoverRunning() {
    if (!running) return;
    if (running.mode === 'pomodoro' && !running.paused && pomoRemainingSec() <= 0) {
      // a phase completed while the app was closed
      running.phaseEndsAtEstimate =
        running.segmentStart + (running.phaseTotalSec - running.accumulatedSec) * 1000;
      pomoPhaseComplete();
    }
  }

  renderColorPicker();
  renderProjectSelects();
  restoreFormState();
  recoverRunning();
  renderAll();
  renderSettings();
  bindEvents();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
