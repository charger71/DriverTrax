# DriverTrax JavaScript Audit

Read of all 21 JavaScript files in the driver app (~14,000 lines). `backlot.js` /
`backlot.html` excluded per CLAUDE.md. Line references are from the working tree at
the time of review.

**26 findings — 6 critical, 7 high, 9 medium, 4 low.**

> **Status.** The critical and high tiers are clear: **F01–F15 and F21 are fixed**
> (F03 came along with F01, F09 fell out of F01's rewrite, and F11–F13 came with
> F10). Open: **F16–F20** and **F22–F26** — conventions, the a11y retrofit's rough
> edges, and hygiene.

---

## Verdict

The codebase is in better shape than its size suggests. No `var`, no loose equality,
no `eval`, consistent IIFE module boundaries, thorough camera/scanner teardown, and
comments that explain *why*. HTML escaping is applied at essentially every
`innerHTML` site.

The problems cluster in two places:

1. **The local-to-cloud sync layer.** Its change detection can't see in-place edits,
   so several user-visible edits save locally and never reach Supabase.
2. **Module lifecycle.** The `start()`/`stop()` pattern repeated across five modules
   re-registers listeners every time it cycles, and `dt-auth-change` fires far more
   often than the modules assume.

---

## Data integrity and offline

### F01 — In-place record edits never sync to the cloud · CRITICAL · FIXED

`sync.js:163-180` · `app.js:241-250, 3567-3595, 879-885` · `drop-offs.js:206-212`

`getRecords()` returns the cached array *by reference*. Callers mutate a record in
place and then call `setRecords(sameArray)`. The sync wrapper diffs `prevById[id]`
against `nextById[id]` — but after an in-place mutation those are **the same
object**, so `JSON.stringify` always matches and nothing is queued.

Reproduced with a harness running the real diff logic:

```
after create,         queue = {"r1":"upsert"}
// simulate a successful flush, then edit in place
after in-place edit,  queue = {}
localStorage now has: [{"id":"r1","serialId":"NEWVIN1234567890X","notes":"edited"}]
```

Affected paths (once a record's initial upsert has flushed):

- `saveEdit()` — VIN corrections and notes edits from the detail overlay.
- The deferred NHTSA backfill in `saveRecord()` and `saveEdit()` — `vinData` is
  written locally and never uploaded.
- `drop-offs.js patchLocalRecord()` — the geotagged `section_id` / `section_name`.
  Its comment says *"sync.js diffs setRecords() and queues the update for the
  cloud"*, which is exactly what cannot happen here.

New records and deletions are unaffected: `unshift` creates a new object (caught by
`!prev`) and `filter` removes the key (caught by the delete pass). It is
specifically **field updates** that vanish.

**Fix.** Snapshot `prevById` as serialized strings rather than object references:

```js
- let prevById = indexBy(getRecords());
+ const snapshotOf = (arr) => {
+   const m = {};
+   for (const r of arr) m[String(r.id)] = JSON.stringify(r);
+   return m;
+ };
+ let prevJson = snapshotOf(getRecords());

  window.setRecords = function (records) {
-   origSetRecords(records);
+   const nextJson = snapshotOf(records);
+   for (const id in nextJson) {
+     if (prevJson[id] !== nextJson[id]) queue[id] = "upsert";
+   }
+   for (const id in prevJson) if (!(id in nextJson)) queue[id] = "delete";
+   prevJson = nextJson;
+   origSetRecords(records);
    persistQueue();
    scheduleFlush();
  };
```

(The write moved *below* the diff while fixing F06 — see there for why.)

This also fixes F09 for free. Add a one-time repair on next deploy that re-queues
every local record as `upsert`, otherwise edits already lost stay lost.

*Fixed.* `snapshotOf()` replaces `prevById`, and `repairInPlaceEdits()` re-queues the
local set once behind an IDB marker. The repair depends on F03's guard: without it,
`pullAndMerge` reverts the local record to the cloud copy before the queue flushes,
and the repair uploads the stale row back.

### F02 — Offline cold start can't boot; supabase-js isn't cacheable · CRITICAL · FIXED

`sw.js:4-31, 187-205` · `index.html:1631`

`APP_SHELL` precaches Leaflet and ZXing from unpkg but omits
`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/.../supabase.js`. The runtime
cache-first branch can't rescue it either — it only caches responses where
`res.type === "basic"`, and a cross-origin CORS response is `"cors"`. So that script
is **never** cached, by either path.

On an offline launch the fetch fails, the handler returns an empty `504`,
`window.supabase` stays undefined, and `auth.js` bails at line 8. Every feature
module then hits its own `if (!window.DT_AUTH) return;` guard.

`a11y.js` and `idb.js` are also missing from `APP_SHELL` — less severe (same-origin,
so they do get runtime-cached) but they miss the `cache: "reload"` freshness
guarantee on install.

**Fix.** Add all three to `APP_SHELL` and bump `CACHE_VERSION`. Consider vendoring
supabase-js locally: `@2` is an unpinned major range, so jsDelivr can serve a new
minor at any time with no review — pinning to an exact version (as Leaflet and ZXing
already do) removes both the availability and supply-chain surprise.

*Fixed.* All three added; `CACHE_VERSION` bumped to
`drivertrax-v9.24-offline-shell-supabase` (v9.26 after the F07–F21 work). Two related install-path defects surfaced
while fixing it and were fixed too, since either one keeps the precache from
actually landing:

- `cache.addAll()` is all-or-nothing and its rejection was swallowed by a
  `console.warn`, so one unreachable CDN asset during install produced an *empty*
  cache and no offline support at all — silently. Now each entry is added
  independently via `Promise.allSettled`, so the same-origin shell always lands.
- The runtime cache-first branch only stored `res.type === "basic"`, which excludes
  every cross-origin asset (`"cors"`). That's why a precache miss could never be
  backfilled. Broadened to accept `cors`; opaque responses stay excluded, since
  `res.ok` is already false for those.

Pinning the supabase version is still open — noted in a comment beside the URL.

### F03 — Pull-and-merge overwrites edits that haven't flushed · CRITICAL · FIXED

`sync.js:289-335`

`pullAndMerge()` merges with `{ ...localById, ...cloudById }` — cloud always wins,
and it runs on every `dt-auth-change`. A driver who edits offline and then
reconnects fires `dt-auth-change`, and the cloud copy replaces the pending local
edit *before* the queue flushes.

The same merge resurrects records queued for deletion: the cloud row is re-added
locally, the delete flushes server-side, and the record lingers in the UI.

**Fix.** Let the queue win:

```js
const merged = { ...localById };
for (const id in cloudById) {
  if (queue[id]) continue;            // local edit or delete pending — keep ours
  merged[id] = cloudById[id];
}
for (const id in queue) {
  if (queue[id] === "delete") delete merged[id];
}
```

*Fixed*, ahead of its place in the running order — F01's one-time repair is a no-op
without it. Note the effect was worse than "the edit doesn't upload": because
`pullAndMerge` runs on every `dt-auth-change`, the stale cloud copy was written back
over the local record at boot, so the user watched their edit disappear.

### F04 — Edits made during a flush are silently dropped · CRITICAL · FIXED

`sync.js:183-192`

`scheduleFlush()` clears `pendingFlush` before calling `flushQueue()`, and
`flushQueue()` returns immediately if `flushing` is true — without rescheduling.
Save a record while a flush is in flight and its 600 ms timer fires into a no-op.

**Fix.** Set a `flushAgain` flag on the early return and re-run in the `finally`
block.

*Fixed.* `flushAgain` is set on the early return and handed off after the flush
settles. On a *failed* flush it's cleared instead — whatever arrived mid-flush is
still queued and rides along with the F05 retry, so we don't fire an immediate
second attempt into a backend that just errored.

### F05 — A failed flush never retries on its own · CRITICAL · FIXED

`sync.js:280-285`

The catch block logs, sets the badge to `"Sync error — will retry"`, and stops.
Nothing schedules the retry the badge promises. A transient 500 parks the queue until
the user happens to save something else.

**Fix.** Capped exponential backoff — `setTimeout(flushQueue, delay)` doubling from
~5 s to a ~5 min ceiling, reset on success.

### F06 — No localStorage quota handling, no record retention cap · CRITICAL · FIXED

`app.js:247-250` — and 26 other `setItem` calls

`setRecords()` does an unguarded `localStorage.setItem`. Records accumulate forever;
each carries a decoded `vinData` object plus photo paths, tire details and damage
marks. iOS Safari caps localStorage around 5 MB.

At that ceiling `setItem` throws `QuotaExceededError` inside `doSave()`. There's no
catch, so the throw propagates out of the save handler: the entry is lost, no toast
fires, and the driver has no idea. Worst for the heaviest users.

**Fix.** Wrap `setRecords` in try/catch. On `QuotaExceededError`, prune records older
than the retention window needed locally (they're already in Supabase), retry once,
and surface `DT_TOAST.show("Storage full — older entries archived", "warn")` if it
still fails. A hard cap of the most recent N records prevents reaching that point.

*Fixed*, reactively rather than with a fixed cap — record size varies far too much
(vinData present or not, damage marks, photo arrays) for a count to mean anything.
On `QuotaExceededError` the on-disk copy is halved until it fits, down to a floor of
50, and the user gets a warn toast.

Two things the implementation has to get right:

- **Trimming must not read as a delete.** Only the on-disk copy shrinks;
  `_recordsCache` and the array sync.js diffs still hold every record, so no delete
  is ever queued and nothing is removed from Supabase. Verified explicitly.
- **A record with an unflushed cloud write outranks a newer one**, because dropping
  it loses it from the device *and* the cloud, while everything else is recoverable.
  Pending status is a sort priority rather than an exemption: when the pending set
  alone overruns the budget we still have to shed something, and an absolute
  exemption meant nothing could be written at all.

That second point forced a change in `sync.js`: the wrapper now diffs and queues
*before* calling through to the write, not after. The diff never needed the write to
have happened, and doing it first is what lets the trim see an up-to-date queue —
otherwise it reads one call stale and can drop a record whose write is still pending.

---

## Load and cost

### F07 — Announcements fires up to 100 queries a minute, forever · HIGH · FIXED

`announcements.js:46-54, 234-257, 306-307, 330-341`

`renderDriverPanel()` calls `renderThread()` once per card; each `renderThread()`
issues *two* Supabase queries. `loadAnnouncementsForDriver()` pulls up to 50
announcements — so a full render is up to 100 round-trips.

That render is on `setInterval(renderAll, 60000)` — every minute, for every
signed-in device, whether or not the Alerts panel is visible. The interval exists
only to keep "5 min ago" strings fresh. Additionally, every reply or reaction
anywhere triggers `refreshVisible()`, re-running the same fan-out for all cards.

**Fix**, in order of payoff:

- Have the minute tick update only the timestamp nodes, not re-run
  `renderDriverPanel()`. Removes the steady-state query load on its own.
- Batch the thread fetch: two queries with `.in("announcement_id", ids)` for all
  visible cards, grouped client-side — 100 queries becomes 2.
- Scope `refreshVisible()` to the announcement the realtime payload names.

*Fixed*, all three. `fetchThreads(ids)` batches with `.in()` and `paintThread()` does
the DOM work, so a panel costs two queries plus one name lookup instead of two per
card — measured at **3 round-trips for 50 announcements, down from 100+**. The minute
tick now calls `renderTimes()`, which rewrites `.ann-time[data-ts]` text and touches
no network. Realtime repaints only the card named in the payload.

`DT_ANN.renderThreads` exposes the batched path; the Backlot view still loops over
`renderThread` and could adopt it (out of scope here per CLAUDE.md).

### F08 — Every token refresh triggers a profile fetch and a full record pull · HIGH · FIXED

`auth.js:311-371, 374-385` · `sync.js:367-370`

`applySession()` runs on *every* `onAuthStateChange` event — including
`TOKEN_REFRESHED`, fired roughly hourly and on tab refocus near expiry. Each run
re-fetches the profile row and dispatches `dt-auth-change` unconditionally, which
sync.js answers with `pullAndMerge()` — a `select("*")` of every record the user
owns, with no limit.

There's also a duplicate boot: `sb.auth.getSession().then(applySession)` runs, and
supabase-js v2 *also* emits `INITIAL_SESSION` on subscribe. Two profile loads and two
full pulls on every cold start.

**Fix.** Early-return from `applySession` when `event === "TOKEN_REFRESHED"` and the
user id is unchanged. Drop the standalone `getSession()` call and let
`INITIAL_SESSION` do the boot. Separately, cap the `pullAndMerge` select with a date
window.

*Fixed*, except the select cap. `applySession` now takes the event name and returns
early on a token refresh for the same user, after updating credentials in place.
`getSession()` is demoted to a 1.5s fallback that only fires if no auth event arrived
— dropping it outright would stake the whole boot on `INITIAL_SESSION`.

The `pullAndMerge` date cap is **deliberately left open**: it would mean older records
never come back after a reinstall, which is a product call rather than a bug fix. The
churn that made the unbounded select expensive is gone either way.

### F09 — Change detection serializes every record on every write · MEDIUM · FIXED

`sync.js:167-172`

`JSON.stringify` on both sides for every record, on every `setRecords()` call.
Folded into the F01 fix.

---

## Module lifecycle

The `start()`/`stop()` shape is copied across five modules with the same defect in
each. `fleet-counts.js` is closest to correct and makes a good template.

### F10 — Listeners accumulate on every start/stop cycle · HIGH · FIXED

`announcements.js:275-319` · `users.js:315-349` · `locations.js` · `detailer.js` ·
`requests.js`

Each module guards `start()` with `if (started) return;`, and `stop()` resets
`started = false` — but `stop()` only removes the realtime channel. The DOM and
`document` listeners registered in `start()` are never removed, so the next
`start()` adds a second copy.

Not hypothetical: `announcements.js` gates on `!!DT_AUTH.getProfile()`, and
`loadProfile()` returns `null` whenever the profile fetch fails — normal on lot wifi.
Each failure/recovery cycle adds another `dt-refresh` and `dt-tab-shown` handler.
After N cycles, one pull-to-refresh launches N parallel
`loadAnnouncementsForDriver()` calls, each triggering the F07 fan-out. The two bugs
compound.

**Fix.** Split the flag in two, as `fleet-counts.js` does: a `wired` flag set once and
never reset (guards listener registration), and a `running` flag `stop()` may clear
(guards subscriptions and data loads). Worth writing once in `utils.js` as a small
`DT_LIFECYCLE` helper.

*Fixed.* `DT_LIFECYCLE.create({ wire, start, stop })` lives in `utils.js` and is
adopted by announcements, users, locations, requests and fleet-counts. Verified that
25 stop/start cycles wire exactly once while still starting and stopping each time.

`detailer.js` turned out not to need it — it has no `stop()`, so its `started` flag is
never reset and it cannot double-wire.

### F11 — The announcements thread channel is never torn down · MEDIUM · FIXED

`announcements.js:310-319, 330-343`

`stop()` removes `realtimeChan` but not `threadChan`. The `ann-threads`
subscription stays live after sign-out and keeps querying with the old session.

**Fix.** Add `if (threadChan) { sb.removeChannel(threadChan); threadChan = null; }`
to `stop()`.

*Fixed* — `teardownThreadRealtime()`, called from the lifecycle's `stop()`. Setup moved
into `start()` so the channel follows the module's running state.

### F12 — Notifications can open two realtime channels · MEDIUM · FIXED

`notifications.js:237-257`

`start()` checks `if (started) return;` but then `await ensurePermission()` before
setting `started = true`. Two `dt-auth-change` events during that await both pass the
guard. The second call overwrites `chan`, orphaning the first subscription — which
keeps delivering, producing duplicate alerts.

**Fix.** Move `started = true` above the `await`; reset it in a catch if setup fails.

*Fixed*, exactly that.

### F13 — Fleet counts stops updating live after a sign-out · MEDIUM · FIXED

`fleet-counts.js:112-119, 140-152`

`teardown()` removes the channel but leaves `wired = true`. Since `subscribe()` only
runs inside the `if (!wired)` block, a subsequent `start()` never resubscribes.

**Fix.** Call `subscribe()` from `start()` unconditionally — it already self-guards
with `if (realtimeChan) return;`.

---

## Time zone handling

The app pins `America/New_York` as its operating timezone; three date derivations
bypass it.

*Fixed* via `DT_LIFECYCLE`: `subscribe()` moved out of the one-time `wire()` and into
`start()`, so it re-runs after every teardown.

### F14 — The manager fleet view defaults to the wrong day after 8pm · HIGH · FIXED

`app.js:282-286`

`fetchFleetRecords()` defaults its date filter to
`new Date().toISOString().slice(0, 10)` — a **UTC** date. Between 8pm ET (midnight
UTC) and midnight ET that returns tomorrow, so the Records tab defaults to a day with
no entries. On a 24/7 lot with an evening shift, that's the window when it's most
likely to be used.

Second problem: `new Date(fromStr + "T00:00:00")` parses in the *device's* local
timezone, not ET, so the range shifts again for anyone whose phone isn't Eastern.

**Fix.** Use the existing `estDateStr(Date.now())` for the default, and build
boundaries with an explicit ET offset. `app.js:3667 isoDate()` has the same UTC-slice
issue in week/month bucketing.

*Fixed.* New `etOffsetAt()` / `estInstantISO()` / `estDayRangeISO()` helpers resolve ET
wall-clock times to UTC instants. Getting the offset right takes two passes — DST flips
at 2am local, so an offset sampled at midday is wrong for midnight on the two
switchover days. Verified that day windows land on exact ET midnight year-round,
including the 23-hour and 25-hour days.

`isoDate()` is now ET-backed, which also repairs a mismatch the audit missed:
`renderDashboard` compared `isoDate(r.timestamp)` (UTC) against `estDateStr(now)` (ET),
so the "today" count was wrong for anything logged after 8pm ET. Export filenames use
ET too.

Still local-time: `startOfWeek()`'s arithmetic, so week *boundaries* can shift by a day
for a device set outside Eastern. Pre-existing, no regression, and a wider change than
this finding covers.

### F15 — `DT_FORMAT.date` ignores the timezone `DT_FORMAT.time` pins · MEDIUM · FIXED

`utils.js:20-34`

`time()` passes `timeZone: TZ`. `date()` and `dateTime()` don't — they render in the
device timezone. On a phone set to Pacific, a 10pm ET entry shows the ET clock time
beside the previous day's date.

**Fix.** Add `timeZone: TZ` to both. While in the file, `estDateStr()` can drop its
`new Date(d.toLocaleString(...))` reparse trick in favour of
`new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d)`, which returns
`YYYY-MM-DD` directly.

---

## Drift from CLAUDE.md

Each of these is something the conventions file explicitly rules out.

*Fixed*, both parts.

### F16 — Three HTML escapers where the rules call for one · MEDIUM

`utils.js:14` (`DT_ESC`) · `app.js:336` (`sanitizeText`) · `app.js:2103`
(`escapeHtml`)

`escapeHtml` is a DOM-roundtrip escaper used in exactly two places (app.js:2091,
2093). `sanitizeText` is a fourth-variant escaper that also encodes `/`, used widely
through app.js — including `const esc = (s) => sanitizeText(s)` at app.js:4053, which
shadows the conventional name with a different function.

All three are correctly *applied*, so this isn't an XSS finding today. It's a
maintenance one.

**Fix.** Delete `escapeHtml` and point its two callers at `DT_ESC`. Alias
`sanitizeText` to `DT_ESC`. Keep `sanitizeSerial`/`Notes`/`Name` — those do real
input constraint, not escaping.

### F17 — pwa.js ships a second toast system with hardcoded colors · MEDIUM

`pwa.js:70-102, 262-282`

The update-available toast and install pill are built with `style.cssText` strings
containing `#13161a`, `#4a9eff`, `#2a2f36`, `#9aa3ad`, plus their own font stacks and
radii. CLAUDE.md rules out both a second toast helper and hardcoded hex. Practical
consequence: neither element responds to the theme — in light mode the user gets a
dark pill on a warm-sand page.

**Fix.** Move the styling into `app.css` as `.pwa-toast` / `.pwa-install-pill` using
existing tokens, and add both to `components.html`.

### F18 — Status and damage palettes live in JS and don't follow the theme · MEDIUM

`app.js:4355-4364` (`statusMapColor`), `4235`, `2794`, `2355-2357` · `damage.js:26`

`statusMapColor()` hardcodes a 13-entry status palette; `damage.js` has its own
five-colour damage map; parking-section status colours and two fuel-badge SVGs are
inline hex too. All fixed values, so map markers and damage pins keep dark-theme
colours on a light background.

**Fix.** Define these as CSS custom properties in `app.css` next to the status tokens
and read them once per render with
`getComputedStyle(document.documentElement).getPropertyValue("--map-status-clean")`.
Leaflet `divIcon` markup and inline SVG fills both accept the resolved string.

### F19 — `alert()` and `confirm()` in eight modules · MEDIUM

`app.js` (14) · `backlot.js` (13) · `users.js` (5) · `detailer.js` (5) ·
`elearning-admin.js` (3) · `announcements.js` (2) · `requests.js` (2) ·
`locations.js` (1)

Native dialogs block the main thread, can't be styled, look wrong in a standalone
PWA, and are suppressed in some WKWebView configurations — which matters, because
the codebase already works hard around WKWebView elsewhere. `users.js:151-152` stacks
two `confirm()` calls back to back for a delete.

**Fix.** Replace `alert()` with `DT_TOAST.show(msg, "error")` — mechanical. For
`confirm()`, add one promise-returning `DT_UI.confirm({ title, body, danger })` built
on the `.users-modal` pattern. `notifications.js`'s `#alertModal` is a working
precedent.

### F20 — `timeAgo` lives in a feature module and utils delegates back to it · LOW

`utils.js:36-44` · `announcements.js:23-36, 354`

`DT_FORMAT.timeAgo` checks for `window.dtTimeAgo` and falls back to `dateTime()` if
absent. That global is defined at the bottom of `announcements.js`. So the shared
utility depends on a feature module, and relative-time formatting silently degrades
whenever announcements hasn't loaded.

**Fix.** Move the implementation into `utils.js`; keep `window.dtTimeAgo` as a thin
alias.

---

## Accessibility

### F21 — Toasts are invisible to screen readers · HIGH · FIXED

`index.html:1512` · `app.js:386-400`

`<div id="toast" class="toast"></div>` has no `role="status"` and no `aria-live`.
Every other transient surface in the app does — `#weatherAlert`, `#splash`,
`#fleetCountsBanner`, `#annBanner` — so this reads as an oversight.

Toasts are the app's primary confirmation channel: record saved, sync failed, VIN
refreshed, storage warnings. A screen-reader user currently gets no feedback from
any of them.

**Fix.** Add `role="status" aria-live="polite" aria-atomic="true"` to the element in
`index.html`, and the same attributes in the `showToast()` fallback that creates it
dynamically. Use `aria-live="assertive"` when `type === "error"`.

*Fixed.* Only `aria-live` is toggled per type — swapping `role` on a live region
mid-flight confuses some screen readers, and an explicit `aria-live` outranks the
politeness implied by `role="status"`. `showToast` also clears the text once the toast
has slid off, so an identical repeat message still reads as a change and is announced
again.

### F22 — Two rough edges in the a11y retrofit · LOW

`a11y.js:34-53`

- `scan()` applies `role="button"` to *every* `[onclick]` element. On a
  `<tr onclick>` — which `.day-table tr.has-entries` in the selector list confirms
  exists — that replaces row semantics and breaks table navigation.
- Space activates on `keydown`. The WAI-ARIA button pattern fires Space on `keyup`
  (Enter on `keydown`), so a user can't abort by moving focus off before release.

---

## Hygiene

### F23 — ~190 lines of Scanbot beta with an expired license key · LOW

`app.js:5290-5470`

The Scanbot path is disabled — its button is commented out in `index.html`. The
embedded trial license decodes to an expiry of `2026-05-31`. The block still carries
a hardcoded key, two CDN URLs, and a `loadScript` helper whose cached-script branch
never rejects on error.

**Fix.** Delete it; it's in git history if the evaluation resumes, and a fresh trial
key would be needed anyway.

### F24 — Unguarded DOM access in the init tail · LOW

`app.js:6408-6415`

`document.getElementById("shuttle").checked = true` with no null check — the only
place in an otherwise uniformly defensive file. If that element is renamed, the throw
takes out everything below it in the same block: `checkWeatherAlert()`, the backup
scheduler, `applyProfile()`, `renderTodayEntries()`.

**Fix.** Add `?.` and wrap the block in try/catch.

### F25 — The CLAUDE.md file-layout list no longer matches the repo · LOW

`CLAUDE.md` — "File layout" · `app.js:40`

It lists `vehicle-notes.js`, which doesn't exist (a stale reference also survives in
an app.js comment), and omits eight modules that do: `damage.js`, `drop-offs.js`,
`locations.js`, `idb.js`, `a11y.js`, `pull-refresh.js`, `elearning-admin.js`,
`backlot.js`.

Outsized cost: CLAUDE.md is the first thing read before any change, so an inaccurate
map propagates into every future edit.

### F26 — CI checks syntax but not correctness · LOW

`.github/workflows/ci.yml`

The pipeline runs `node --check`, greps for conflict markers, and verifies
`CACHE_VERSION` exists. Good dependency-free instincts — but `node --check` only
catches parse errors. None of F01–F26 would have been caught.

**Fix.** Two additions that stay in the no-build spirit:

- An `npx eslint` step with a flat config enabling `no-unused-vars`, `no-undef` (with
  the `DT_*` globals declared) and `no-implicit-globals`.
- A grep step asserting every `<script src="…">` in `index.html` appears in `sw.js`'s
  `APP_SHELL`. That check alone would have caught F02.

---

## Suggested order of work

Sequenced by risk retired per hour, not severity alone. Steps 1–3 are one focused
session in `sync.js` and `sw.js`.

1. ~~**F01 — the sync diff.**~~ **Done.** Highest-value fix here. Data was being lost
   silently, and the change is contained to one function. Includes the one-time
   re-queue.
2. ~~**F02 — precache supabase-js.**~~ **Done.** Restores offline boot for the whole
   app, plus two install-path defects that would have kept the precache from landing.
3. ~~**F04, F05 — the rest of sync.js.**~~ **Done.** Flush handoff and retry backoff;
   F03 went in with F01.
4. ~~**F06 — quota guard.**~~ **Done.** Prevented the failure mode that hits heaviest
   users first and gave no signal when it did.
5. ~~**F21 — toast aria-live.**~~ **Done.** Fixed the app's entire feedback layer for
   assistive tech.
6. ~~**F07, F08 — query volume.**~~ **Done.** 50 announcements went from 100+
   round-trips per render to 3, and the per-minute refetch is gone entirely.
7. ~~**F10 — lifecycle helper.**~~ **Done.** `DT_LIFECYCLE` in `utils.js`, adopted by
   five modules; took F11–F13 with it.
8. ~~**F14, F15 — timezone.**~~ **Done.** Plus a dashboard "today" mismatch the audit
   had missed.
9. **F26 — CI.** Do this before the convention cleanups so the cleanups can't regress.
   **Next.**
10. **F16–F20, F22–F25.** Convention and hygiene. Safe to batch, worth doing before
    the next feature lands on top of them.

---

## What's already right

Worth stating so none of it gets "cleaned up" by accident.

- **No legacy JS.** Zero `var`, zero loose equality, no `eval` or `new Function`, no
  string-timeout patterns across all 21 files.
- **Escaping is applied consistently.** Every unescaped interpolation into
  `innerHTML` was traced; no reachable XSS. The near-misses are hardened rather than
  broken — `r.statusOther` at app.js:4057 looks raw but is escaped one line later.
- **Scanner and camera teardown is thorough.** `closeScanner()` cancels both
  animation loops, clears timers, unlocks orientation, resets the ZXing reader, stops
  every track, and nulls `srcObject` — plus `visibilitychange` and `pagehide` hooks
  for the iOS suspend case.
- **The RLS-recovery path in `flushQueue`** (`sync.js:221-254`) is genuinely good
  defensive work — it identifies rows owned by another account, drops just those, and
  retries the rest rather than wedging the queue.
- **`idb.js` fails closed.** Every method resolves to a safe empty value instead of
  throwing, so private mode and locked storage degrade rather than crash.
- **The comments explain why.** The iOS HEIC fallback chain in `utils.js`, the
  `cache: "reload"` rationale in `sw.js`, the `controllerchange` note in `pwa.js` —
  these stop the next person re-introducing a fixed bug.
