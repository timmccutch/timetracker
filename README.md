# ⏱ TimeTracker

A time tracking + pomodoro app that runs in any browser and installs on your
iPhone home screen like a native app. No server, no account — all data stays
on your device (localStorage), and you can export everything as CSV.

## Features

- **Track tab** — start / pause / resume / stop a timer against a project,
  with a description of what you're actually doing. A "Today" panel shows
  what you've tracked so far.
- **Pomodoro tab** — focus rounds with short/long breaks. Minutes for focus,
  short break, long break, and rounds-per-cycle are all adjustable. When a
  phase ends you get an **alarm sound**, an optional browser notification,
  and vibration on phones that support it. Completed focus rounds are logged
  as sessions automatically.
- **Projects tab** — create projects with a color, rename, archive
  (hide from pickers but keep history), or delete them.
- **Reports tab** — totals, session count and pomodoro count for Today /
  This week / This month / All time / a custom date range, per-project bar
  breakdown, a full session table (date, project, description, type, start,
  end, duration), and **⬇ Download CSV** which exports exactly what the
  current filter shows (Excel/Numbers/Google Sheets friendly).
- **Survives reloads** — a running timer or pomodoro is persisted, so closing
  the tab or locking your phone doesn't lose it. If a pomodoro phase finished
  while the app was closed, the session is still logged correctly.
- **Works offline** — it's a PWA with a service worker; after the first load
  it works with no connection.

## Run it

It's a static site — any web server works:

```bash
cd timetracker
python3 -m http.server 8000
# open http://localhost:8000
```

The easiest way to put it online (needed for iPhone install) is **GitHub
Pages**: repo → Settings → Pages → deploy from the `main` branch, root
folder. Your app will be at `https://<username>.github.io/timetracker/`.

> Note: the service worker and notifications need HTTPS (or localhost).
> GitHub Pages gives you HTTPS for free.

## Install on iPhone

1. Open the app's URL in **Safari** on your iPhone.
2. Tap the **Share** button (square with arrow).
3. Tap **Add to Home Screen**, then **Add**.

It opens full-screen like a native app and works offline. Data is stored
per-device — export CSV to move data between devices.

### iPhone caveats

- iOS doesn't let web pages play sound or run timers while Safari is fully
  backgrounded. The app compensates: when you come back, the countdown is
  exactly right and finished rounds are logged. For a guaranteed audible
  alarm, keep the app open (screen on) during a focus round, or enable
  notifications.
- The alarm sound is generated with the Web Audio API — no audio files, and
  it's unlocked by your first tap on Start (an iOS requirement).

## CSV format

```
Date, Project, Description, Type, Start, End,
Duration (seconds), Duration (hh:mm:ss), Duration (hours)
```

One row per session, sorted chronologically, filtered by whatever range and
project filter you have selected in Reports.

## Tech

Vanilla HTML/CSS/JS — no build step, no dependencies. `js/app.js` holds all
logic; timers are computed from timestamps (not tick counting) so they stay
accurate through tab sleeps and reloads.
