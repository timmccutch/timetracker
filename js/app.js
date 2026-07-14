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
    tombstones: 'tt_tombstones',
    ms: 'tt_ms',
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
  // ids deleted locally, remembered so deletions propagate through OneDrive sync
  let tombstones = load(LS.tombstones, { sessions: [], projects: [] });

  const saveProjects = () => save(LS.projects, projects);
  const saveSessions = () => save(LS.sessions, sessions);
  const saveSettings = () => save(LS.settings, settings);
  const saveRunning = () => save(LS.running, running);
  const saveTombstones = () => save(LS.tombstones, tombstones);

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
    const project = { id: uid(), name, color: color || COLORS[projects.length % COLORS.length], archived: false, createdAt: now(), updatedAt: now() };
    projects.push(project);
    saveProjects();
    renderProjects();
    renderProjectSelects();
    scheduleAutoSync();
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
          p.updatedAt = now();
          saveProjects();
          renderAll();
          scheduleAutoSync();
        }
      };

      const archive = document.createElement('button');
      archive.className = 'icon-btn';
      archive.title = p.archived ? 'Unarchive' : 'Archive (hide from pickers, keep history)';
      archive.textContent = p.archived ? '📤' : '📥';
      archive.onclick = () => {
        p.archived = !p.archived;
        p.updatedAt = now();
        saveProjects();
        renderAll();
        scheduleAutoSync();
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
        tombstones.projects.push(p.id);
        for (const s of sessions) {
          if (s.projectId === p.id) tombstones.sessions.push(s.id);
        }
        saveTombstones();
        projects = projects.filter((x) => x.id !== p.id);
        sessions = sessions.filter((s) => s.projectId !== p.id);
        saveProjects();
        saveSessions();
        renderAll();
        scheduleAutoSync();
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
    scheduleAutoSync();
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
        tombstones.sessions.push(s.id);
        saveTombstones();
        sessions = sessions.filter((x) => x.id !== s.id);
        saveSessions();
        renderAll();
        scheduleAutoSync();
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

  /* ================= OneDrive / Excel sync ================= */

  // Two-way sync with an Excel workbook (TimeTracker.xlsx) in the user's
  // OneDrive via Microsoft Graph. The workbook is the shared source of truth
  // across devices: the Sessions/Projects tables hold the data, and the
  // Deleted table propagates deletions between devices. Requires a free
  // Microsoft Entra app registration; paste its Client ID once per device
  // (setup steps in the README).

  const MS_AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const MS_SCOPES = 'Files.ReadWrite User.Read offline_access';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const WORKBOOK_PATH = '/me/drive/root:/TimeTracker.xlsx';
  const WB = `${WORKBOOK_PATH}:/workbook`;

  // minimal valid empty workbook, uploaded once to create TimeTracker.xlsx
  // (the Graph workbook API cannot operate on a zero-byte file)
  const BLANK_XLSX_B64 = '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';

  const TABLES = {
    Sessions: ['Id', 'Date', 'Project', 'ProjectId', 'Description', 'Type',
      'Start', 'End', 'DurationSeconds', 'DurationHMS', 'StartMs', 'EndMs'],
    Projects: ['Id', 'Name', 'Color', 'Archived', 'CreatedAt', 'UpdatedAt'],
    Deleted: ['Id', 'Kind', 'DeletedAt'],
  };

  let ms = {
    clientId: '', account: '', accessToken: '', refreshToken: '',
    expiresAt: 0, autoSync: true, lastSync: 0,
    ...load(LS.ms, {}),
  };
  const saveMs = () => save(LS.ms, ms);
  const msConnected = () => !!ms.refreshToken;

  let syncing = false;
  let autoSyncTimer = null;

  function scheduleAutoSync() {
    if (!msConnected() || !ms.autoSync) return;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => syncNow(true), 3000);
  }

  /* ---- OAuth: authorization code + PKCE, no libraries ---- */

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const redirectUri = () => location.origin + location.pathname;

  async function startConnect() {
    const clientId = $('ms-client-id').value.trim();
    if (!clientId) {
      toast('Paste your Microsoft app Client ID first (see README for the one-time setup)');
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      toast('Sync needs HTTPS (or localhost)');
      return;
    }
    ms.clientId = clientId;
    saveMs();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    sessionStorage.setItem('tt_pkce', verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    location.href = `${MS_AUTH_BASE}/authorize?` + new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: MS_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  }

  async function tokenRequest(params) {
    const resp = await fetch(`${MS_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ms.clientId, ...params }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error_description || data.error || 'Sign-in failed');
    ms.accessToken = data.access_token;
    if (data.refresh_token) ms.refreshToken = data.refresh_token;
    ms.expiresAt = now() + (data.expires_in - 60) * 1000;
    saveMs();
  }

  async function handleAuthRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const verifier = sessionStorage.getItem('tt_pkce');
    if (!code || !verifier) {
      if (params.get('error')) {
        toast('Microsoft sign-in failed: ' + (params.get('error_description') || params.get('error')), 6000);
        history.replaceState(null, '', redirectUri());
      }
      return;
    }
    sessionStorage.removeItem('tt_pkce');
    history.replaceState(null, '', redirectUri());
    try {
      await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      });
      const me = await graphFetch('/me');
      ms.account = me.displayName || me.userPrincipalName || 'Microsoft account';
      saveMs();
      renderSyncUI();
      switchTab('reports');
      toast(`Connected to OneDrive as ${ms.account}`);
      syncNow();
    } catch (e) {
      toast('Could not connect: ' + e.message, 6000);
    }
  }

  async function getAccessToken() {
    if (ms.accessToken && now() < ms.expiresAt) return ms.accessToken;
    await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: ms.refreshToken,
      scope: MS_SCOPES,
    });
    return ms.accessToken;
  }

  function disconnect() {
    ms = { ...ms, account: '', accessToken: '', refreshToken: '', expiresAt: 0, lastSync: 0 };
    saveMs();
    renderSyncUI();
  }

  /* ---- Graph helpers ---- */

  async function graphFetch(path, opts = {}) {
    const token = await getAccessToken();
    const isBinary = opts.body instanceof Uint8Array;
    const resp = await fetch(path.startsWith('http') ? path : GRAPH + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body && !isBinary ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).error.message; } catch { /* keep statusText */ }
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function ensureWorkbook() {
    try {
      await graphFetch(WORKBOOK_PATH);
    } catch (e) {
      if (e.status !== 404) throw e;
      await graphFetch(`${WORKBOOK_PATH}:/content`, {
        method: 'PUT',
        body: b64ToBytes(BLANK_XLSX_B64),
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      });
    }
  }

  const colLetter = (n) => String.fromCharCode(64 + n); // 1 → A (enough for our column counts)

  async function ensureTables() {
    const existing = (await graphFetch(`${WB}/tables?$select=name`)).value.map((t) => t.name);
    for (const [name, cols] of Object.entries(TABLES)) {
      if (existing.includes(name)) continue;
      try {
        await graphFetch(`${WB}/worksheets/add`, { method: 'POST', body: JSON.stringify({ name }) });
      } catch (e) {
        if (!/already exists/i.test(e.message) && e.status !== 409) throw e;
      }
      const range = `A1:${colLetter(cols.length)}1`;
      await graphFetch(`${WB}/worksheets('${name}')/range(address='${range}')`, {
        method: 'PATCH',
        body: JSON.stringify({ values: [cols] }),
      });
      const table = await graphFetch(`${WB}/tables/add`, {
        method: 'POST',
        body: JSON.stringify({ address: `${name}!${range}`, hasHeaders: true }),
      });
      await graphFetch(`${WB}/tables('${encodeURIComponent(table.name)}')`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    }
  }

  async function getTableRows(table) {
    const rows = [];
    let url = `${WB}/tables('${table}')/rows`;
    while (url) {
      const page = await graphFetch(url);
      rows.push(...page.value.map((r) => r.values[0]));
      url = page['@odata.nextLink'] || null;
    }
    return rows;
  }

  async function addTableRows(table, rows) {
    // stay well under Graph's payload limits
    for (let i = 0; i < rows.length; i += 50) {
      await graphFetch(`${WB}/tables('${table}')/rows/add`, {
        method: 'POST',
        body: JSON.stringify({ values: rows.slice(i, i + 50) }),
      });
    }
  }

  async function deleteTableRowsByIds(table, ids) {
    if (!ids.size) return;
    const rows = await getTableRows(table);
    const doomed = [];
    rows.forEach((r, i) => { if (ids.has(String(r[0]))) doomed.push(i); });
    // delete bottom-up so remaining indices stay valid
    for (const i of doomed.reverse()) {
      await graphFetch(`${WB}/tables('${table}')/rows/itemAt(index=${i})`, { method: 'DELETE' });
    }
  }

  /* ---- row (de)serialization ---- */

  const sessionToRow = (s) => [
    s.id, isoLocal(s.start).slice(0, 10), projectName(s.projectId), s.projectId,
    s.description, s.type, isoLocal(s.start), isoLocal(s.end),
    s.durationSec, fmtHMS(s.durationSec), s.start, s.end,
  ];
  const rowToSession = (r) => ({
    id: String(r[0]),
    projectId: String(r[3]),
    description: String(r[4] ?? ''),
    type: String(r[5]),
    start: Number(r[10]),
    end: Number(r[11]),
    durationSec: Number(r[8]),
  });

  const projectToRow = (p) => [
    p.id, p.name, p.color, p.archived ? 1 : 0, p.createdAt, p.updatedAt || p.createdAt,
  ];
  const rowToProject = (r) => ({
    id: String(r[0]),
    name: String(r[1]),
    color: String(r[2]),
    archived: !!Number(r[3]),
    createdAt: Number(r[4]),
    updatedAt: Number(r[5]),
  });

  /* ---- the sync itself ---- */

  async function syncNow(quiet = false) {
    if (!msConnected()) {
      toast('Connect to OneDrive first');
      return;
    }
    if (!navigator.onLine) {
      // everything is already saved locally; the 'online' listener will sync later
      if (!quiet) toast("You're offline — changes are saved here and will sync when you reconnect");
      return;
    }
    if (syncing) return;
    syncing = true;
    const btn = $('ms-sync-now');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await ensureWorkbook();
      await ensureTables();

      // 1. merge deletions: push local tombstones, learn remote ones
      const remoteDel = await getTableRows('Deleted');
      const delSessions = new Set(remoteDel.filter((r) => r[1] === 'session').map((r) => String(r[0])));
      const delProjects = new Set(remoteDel.filter((r) => r[1] === 'project').map((r) => String(r[0])));
      const newDelRows = [];
      for (const id of tombstones.sessions) {
        if (!delSessions.has(id)) { newDelRows.push([id, 'session', now()]); delSessions.add(id); }
      }
      for (const id of tombstones.projects) {
        if (!delProjects.has(id)) { newDelRows.push([id, 'project', now()]); delProjects.add(id); }
      }
      if (newDelRows.length) await addTableRows('Deleted', newDelRows);

      const nSessBefore = sessions.length;
      const nProjBefore = projects.length;
      sessions = sessions.filter((s) => !delSessions.has(s.id));
      projects = projects.filter((p) => !delProjects.has(p.id));
      if (sessions.length !== nSessBefore) saveSessions();
      if (projects.length !== nProjBefore) saveProjects();

      // 2. projects first, so imported sessions can resolve their names
      const remoteProjRows = await getTableRows('Projects');
      const remoteProj = new Map(remoteProjRows.map((r) => [String(r[0]), r]));
      const pushProj = [];
      for (const p of projects) {
        const r = remoteProj.get(p.id);
        if (!r) {
          pushProj.push(projectToRow(p));
          continue;
        }
        const remote = rowToProject(r);
        if ((p.updatedAt || 0) > remote.updatedAt) {
          await graphFetch(`${WB}/tables('Projects')/rows/itemAt(index=${remoteProjRows.indexOf(r)})`, {
            method: 'PATCH',
            body: JSON.stringify({ values: [projectToRow(p)] }),
          });
        } else if (remote.updatedAt > (p.updatedAt || 0)) {
          Object.assign(p, remote);
          saveProjects();
        }
      }
      if (pushProj.length) await addTableRows('Projects', pushProj);
      let importedProj = 0;
      for (const [id, r] of remoteProj) {
        if (!projects.some((p) => p.id === id) && !delProjects.has(id)) {
          projects.push(rowToProject(r));
          importedProj++;
        }
      }
      if (importedProj) saveProjects();

      // 3. sessions: append-only union by id
      const remoteSessRows = await getTableRows('Sessions');
      const remoteIds = new Set(remoteSessRows.map((r) => String(r[0])));
      const localIds = new Set(sessions.map((s) => s.id));
      const pushSess = sessions.filter((s) => !remoteIds.has(s.id)).map(sessionToRow);
      if (pushSess.length) await addTableRows('Sessions', pushSess);
      let importedSess = 0;
      for (const r of remoteSessRows) {
        const id = String(r[0]);
        if (!localIds.has(id) && !delSessions.has(id)) {
          sessions.push(rowToSession(r));
          importedSess++;
        }
      }
      if (importedSess) {
        sessions.sort((a, b) => a.start - b.start);
        saveSessions();
      }

      // 4. scrub tombstoned rows out of the sheet, then forget local tombstones
      //    (the Deleted table remembers them for other devices)
      if (tombstones.sessions.length) await deleteTableRowsByIds('Sessions', new Set(tombstones.sessions));
      if (tombstones.projects.length) await deleteTableRowsByIds('Projects', new Set(tombstones.projects));
      tombstones = { sessions: [], projects: [] };
      saveTombstones();

      ms.lastSync = now();
      saveMs();
      renderAll();
      renderSyncUI();
      if (!quiet || pushSess.length || importedSess || importedProj) {
        toast(`Synced with OneDrive — ${pushSess.length} pushed, ${importedSess} pulled`);
      }
    } catch (e) {
      if (e.status === 401 || /invalid_grant|AADSTS/i.test(e.message)) {
        disconnect();
        toast('OneDrive sign-in expired — please reconnect', 6000);
      } else if (!navigator.onLine || /failed to fetch|networkerror|load failed/i.test(e.message)) {
        // connection dropped mid-sync; local data is intact, retry on reconnect
        if (!quiet) toast("No connection — will sync when you're back online", 5000);
      } else {
        toast('Sync failed: ' + e.message, 6000);
      }
    } finally {
      syncing = false;
      btn.disabled = false;
      btn.textContent = '↻ Sync now';
    }
  }

  /* ---- sync UI ---- */

  function renderSyncUI() {
    const connected = msConnected();
    $('sync-setup').classList.toggle('hidden', connected);
    $('sync-connected').classList.toggle('hidden', !connected);
    $('ms-client-id').value = ms.clientId || '';
    if (connected) {
      $('ms-account').textContent = ms.account || 'Microsoft account';
      $('ms-last-sync').textContent = ms.lastSync
        ? `Last synced ${fmtDate(ms.lastSync)} ${fmtTime(ms.lastSync)} · workbook: TimeTracker.xlsx in your OneDrive`
        : 'Not synced yet';
      $('ms-autosync').checked = !!ms.autoSync;
    }
  }

  function bindSyncEvents() {
    $('ms-connect').addEventListener('click', () => {
      startConnect().catch((e) => toast(e.message, 5000));
    });
    $('ms-sync-now').addEventListener('click', () => syncNow());
    $('ms-disconnect').addEventListener('click', () => {
      if (confirm('Disconnect from OneDrive? Data on this device and in the spreadsheet is kept.')) {
        disconnect();
        toast('Disconnected from OneDrive');
      }
    });
    $('ms-autosync').addEventListener('change', (e) => {
      ms.autoSync = e.target.checked;
      saveMs();
    });
    // catch up as soon as the connection comes back
    window.addEventListener('online', () => {
      if (msConnected() && ms.autoSync) syncNow(true);
    });
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
  bindSyncEvents();
  renderSyncUI();
  handleAuthRedirect();
  if (msConnected() && ms.autoSync) syncNow(true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
