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
- **OneDrive / Excel sync (optional)** — connect your Microsoft account and
  the app keeps an Excel workbook (`TimeTracker.xlsx`) in your OneDrive in
  sync with your data. Every device you connect reads and writes the same
  spreadsheet, so projects, sessions, and deletions sync across your browser
  and iPhone — and you can open the workbook directly in Excel any time.

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

## OneDrive sync setup (one-time, ~5 minutes)

The sync talks directly from your browser to Microsoft's API — there is no
middleman server, so you need to register a (free) "app" with Microsoft once
to get a Client ID:

1. Go to <https://entra.microsoft.com> (or portal.azure.com) and sign in
   with the same Microsoft account your OneDrive is on.
2. Navigate to **Identity → Applications → App registrations → New registration**.
3. Name: `TimeTracker` (anything works). Supported account types: choose
   **"Personal Microsoft accounts only"** (or "Accounts in any organizational
   directory and personal Microsoft accounts" if you also want work accounts).
4. Under **Redirect URI**, pick platform **Single-page application (SPA)**
   and enter the exact URL where the app is hosted, e.g.
   `https://<username>.github.io/timetracker/`. (Add `http://localhost:8000/`
   too if you want to test locally.) The SPA platform type is required — it's
   what allows the browser to talk to Microsoft's token endpoint.
5. Click **Register**, then copy the **Application (client) ID** from the
   overview page.
6. In TimeTracker, open **Reports → OneDrive sync**, paste the Client ID,
   and hit **Connect to OneDrive**. Sign in, and you're done — the app
   creates `TimeTracker.xlsx` in your OneDrive root and starts syncing.

On each additional device, just paste the same Client ID and connect.
Permissions used: `Files.ReadWrite` (to manage the workbook) and
`User.Read` (to show which account is connected).

### How the sync works

- The workbook has three tables: **Sessions**, **Projects**, and **Deleted**.
- Sessions are append-only and merged by id, so devices can work offline and
  reconcile later. Project edits (rename/color/archive) resolve by
  last-write-wins. Deletions are recorded in the Deleted table so they
  propagate to every device instead of resurrecting.
- Sync runs automatically after each saved session (can be toggled off) and
  on app start; there's also a manual **Sync now** button.
- You can *read* the workbook in Excel freely. Avoid hand-editing the table
  rows though — the app treats the tables as its database.

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
