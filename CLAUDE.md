# DriverTrax — Working Conventions

DriverTrax is a single-page PWA for rental-car lot operations at Enterprise. No build step, no framework — plain HTML/CSS/JS loaded directly in the browser, backed by Supabase. **Reuse the patterns below instead of inventing new ones.** When in doubt, grep for an existing example and mirror it.

> `backlot.html` and `backlot.js` are a separate dashboard surface. **Ignore them** when answering questions about app patterns, palette, or conventions — the driver app is the source of truth.

## File layout

The whole app lives in the repo root (no `src/`).

- `index.html` — single page. Contains all panels, modals, templates. Load order for scripts at the bottom matters — don't reorder without reason.
- `app.css` — **canonical design tokens and component styles** for the driver app. Light/dark themes live here via `:root[data-theme="..."]`. Always prefer adding to `app.css` over inline styles or a new stylesheet.
- `app.js` — the main controller: panels, records, entry form, maps, toasts, session/shift logic. Huge file — search before adding.
- `utils.js` — shared helpers exposed as globals: `DT_ESC`, `DT_FORMAT`, `DT_TOAST`, `DT_ERR`, `DT_UI`, `DT_MEDIA`, `DT_LIFECYCLE`. **Use these, do not redefine.**
- `auth.js` — exposes `window.DT_AUTH` (client, role checks, profile, PIN). Every feature module should gate on it.
- `idb.js` — `window.DT_IDB`, a tiny IndexedDB key/value wrapper. Fails closed (private mode, locked storage) so callers never crash.
- `a11y.js` — keyboard + ARIA retrofit for `<div onclick>` elements and overlays. See the Accessibility section below.
- `sync.js` — local ⇄ Supabase record sync: diffs every `setRecords()`, queues to IDB, flushes with retry backoff.
- Feature modules — `announcements.js`, `damage.js`, `detailer.js`, `drop-offs.js`, `elearning.js`, `fleet-counts.js`, `locations.js`, `notifications.js`, `pull-refresh.js`, `pwa.js`, `requests.js`, `users.js`, `vehicle-info.js`. Each is an IIFE wrapping its own state.
- `backlot.js` / `backlot.html` and `backlot/` — the separate manager dashboard. Not a pattern source; see the note at the top.
- `elearning-admin.js` / `elearning-admin.html` — quiz authoring, its own page (not loaded by `index.html`).
- `eslint.config.mjs` — CI lint config. Its `appGlobals` list is the app's cross-file surface; add to it when a module starts exposing something new, or `no-undef` will fail the build.
- `scripts/check-precache.mjs` — CI guard that every asset `index.html` loads is in `sw.js`'s `APP_SHELL`.
- `*-schema.sql` — Supabase schema snippets paired with the feature that owns them.

## Module pattern (use this verbatim for new features)

```js
// Brief header comment: what this module does, what surface it mounts into.
(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;
  // ...module-local state and functions...
})();
```

- Wrap in an IIFE; expose only what other modules need on `window.DT_*`.
- Bail early if `DT_AUTH` is missing.
- Reuse `DT_ESC` for HTML escaping — never write your own.
- Reuse `DT_FORMAT` (`time`, `date`, `timeAgo`, `timeAgoOrClock`, `TZ = "America/New_York"`) for any time/date display.
- Reuse `DT_TOAST.show(msg, "success" | "warn" | "error")` and `DT_TOAST.missing("record")` for user feedback.
- Use `DT_ERR.isMissing(error, data)` to detect Supabase row-not-found, then call `DT_TOAST.missing(...)`.
- Use `DT_UI.setMessage(el, text, "ok" | "err")` for inline modal status lines.
- Listen for `document.addEventListener("dt-auth-change", ...)` if you need to react to profile/role changes.
- Add the new `<script src="...">` to `index.html` in dependency order (utils → auth → app → features).

## Styling — palette and components

**Always use CSS variables from `app.css`. Never hardcode colors, spacing, or font sizes.**

> **Visual reference: [`components.html`](components.html)** — a static style-guide page showing every reusable primitive (buttons, tabs, fields, badges, status chips, stat cards, modal, toast, role colors) with copy-pasteable markup. Open it in a browser to see what's already available before designing anything new. When you add a new component to `app.css`, add a section to `components.html` too — that's the only way it stays a living reference.

- Surfaces: `--header-bg`, `--bg`, `--panel`, `--card`, `--card-soft`, `--surface-hover`
- Lines: `--border`, `--divider`
- Text: `--text`, `--text-soft`, `--muted`, `--text-on-accent`, `--text-on-status`
- Brand/status: `--accent`, `--warn`, `--danger`, `--info`, `--success` (+ `-strong`, `-soft`, `-text` variants)
- Roles: `--role-manager`, `--role-cxr`, `--role-driver`, `--role-admin`, `--role-detailer`
- Spacing: `--space-1` (4) … `--space-7` (48). Inputs are `--dt-input-h` (44px).
- Type: `--font-xs` … `--font-2xl`. Weights: `--weight-normal/medium/bold/heavy/black`.
- Shadows: `--shadow-sm/md/lg`. Scrim: `--scrim`.

Component classes already defined — reuse them:

- Buttons: `.btn` + variant (`.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-destructive`, `.btn-icon`) + size/shape (`.btn--sm`, `.btn--hero`, `.btn--block`, `.btn--full`, `.btn--pill`, `.btn--dashed`).
- Tabs: `.tab`, `.tab.active`, `.tab-badge`.
- Panels: `.panel`, `.panel.active`, `.panel-back-row`.
- Form fields: `.field-label`, `.field-row`, `.input-with-clear`.
- Toasts: `.toast`, `.toast-success`, `.toast-warn`, `.toast-error` (driven by `showToast()` / `DT_TOAST`).
- Modals: follow the **`.users-modal`** pattern (see `index.html` ~line 1074 and `#usersModal` markup ~line 2611). Structure: `.users-modal` > `.users-modal-card` > `.users-modal-header` / body / `.users-modal-msg` / `.users-modal-actions`. Toggle visibility with `.show`. Status messages use `DT_UI.setMessage` with `"ok"` / `"err"` kinds.

Role-aware visibility: the body gets `is-manager` / `is-admin` / `is-cxr` / `is-detailer` classes from `DT_AUTH._setProfile`. Prefer CSS selectors like `body.is-manager .something` over JS hide/show when possible.

## Accessibility

The app uses many `<div onclick=...>` elements for tabs, cards, and tiles. `a11y.js` retrofits keyboard + screen-reader support so you generally don't have to think about it, but follow these rules so the retrofit keeps working:

- **Prefer `<button>`** for any new clickable element. Reach for a `<div onclick>` only when matching an existing visual pattern (e.g. `.record`, `.stat-card.clickable`). Real buttons are skipped by `a11y.js` entirely — that's the cleanest path.
- For a clickable `<div>`, `a11y.js` will auto-add `role="button"` and `tabindex="0"` and wire Enter/Space to trigger click — as long as it has an inline `onclick` attribute *or* matches one of the known classes (`.record`, `.map-legend-row`, `.stat-card.clickable`, `.quiz-author-item`, `.quiz-recent-row`, `.day-table tr.has-entries`, `.training-list-item.clickable`). If you invent a new clickable class, **add it to the selector list in `a11y.js`** instead of duplicating the role/tabindex retrofit.
- **Icon-only buttons must have `aria-label`** — there's no other text for AT to announce.
- **Overlays/modals**: any new full-screen overlay should be added to the Escape-to-close handler and `tagDialog()` block in `a11y.js`. Use `role="dialog"` + `aria-modal="true"` + `aria-label="..."` on the overlay root (auto-applied if you wire it through `tagDialog`).
- **Focus rings** come from `--focus-ring`; don't override `:focus-visible` styling per component.
- The `MutationObserver` in `a11y.js` re-scans dynamically-rendered nodes, so you don't need to manually re-tag cards after a render.

## Data / Supabase conventions

- Single client: `DT_AUTH.client`. Don't create another `supabase.createClient(...)` call.
- Privileged operations route through the `admin-users` edge function (see `users.js` `adminCall`) — mirror that pattern for any service-role work, never embed the service key.
- Catalogs (statuses, destinations, conditions, fuel levels) live in `DT_OPTIONS` in `app.js` and are shared across entry, notes, and detailer forms. **Extend `DT_OPTIONS`, don't fork it.**
- Status display labels go through `statusLabel()` / `STATUS_LABELS` — stored values stay short and canonical.
- For records cached in memory, invalidate via `invalidateRecordsCache()` after writes.

## Service worker cache

`sw.js` precaches the app shell (`index.html`, `app.css`, `app.js`, feature modules, icons) under a `CACHE_VERSION` constant at the top of the file. **Any change to a precached asset must bump `CACHE_VERSION`** — otherwise installed PWAs keep serving the stale file and users see "half my styles are missing" after a deploy. Bump the suffix to describe the change (e.g. `drivertrax-v3.7-vin-tl-css-move`). A hard refresh isn't enough; the SW intercepts the request and only swaps caches when the version string changes.

## Sanitization & safety

- HTML: always `esc(...)` (= `DT_ESC`) any user-provided string before inserting into innerHTML.
- Text inputs: `sanitizeText`, `sanitizeSerial`, `sanitizeNotes`, `sanitizeName` live in `app.js` — use them for entry form inputs.
- The page has a strict CSP (see `<meta http-equiv="Content-Security-Policy">` in `index.html`). No new external script/style/connect origins without updating it.

## Things to avoid

- Don't add a framework, bundler, or TypeScript step. The app is intentionally plain JS loaded by `<script>` tags.
- Don't hardcode `#hexcolors`, pixel spacing, or font sizes when a variable exists.
- Don't introduce inline `<style>` blocks in `index.html` for component styling — extend `app.css`. The existing inline blocks (splash, auth modal) are bootstrapped before `app.css` loads on purpose; don't add to that pattern unless you have the same constraint.
- Don't write a second time/date formatter, HTML escaper, or toast helper — use `DT_FORMAT`, `DT_ESC`, `DT_TOAST`.
- Don't call `alert()` or `confirm()`. Use `DT_TOAST.show(msg, type)` and `await DT_UI.confirm({ title, body, okLabel, danger })`. Native dialogs block the main thread, can't be themed, and some WKWebView configurations suppress them — a suppressed `confirm()` returns false, so the action silently does nothing.
- Don't hardcode a color in JS for anything drawn to canvas, a Leaflet `divIcon`, or an inline SVG fill. Those can't use `var()`, so resolve the token at draw time with `DT_UI.cssVar("--token")` — otherwise it keeps the dark-theme color on a light page.
- Don't reference `backlot.html` / `backlot.js` as a pattern source — they're a separate dashboard.
- Don't gate on raw role strings outside `DT_AUTH` — use `DT_AUTH.isManager()`, `.isAdmin()`, `.isCxr()`, `.isDetailer()`.

## When extending an existing feature

1. Grep for the feature module (`grep -n "feature-name" *.js`).
2. Read its IIFE end-to-end — they're short.
3. Mirror its load/render/realtime structure rather than introducing a new shape.
4. If a new shared helper would be useful in 2+ modules, add it to `utils.js` on `window.DT_*` rather than duplicating.
