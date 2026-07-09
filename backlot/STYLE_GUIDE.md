# Backlot — Style & Conventions Guide

Backlot is the **manager console** for DriverTrax: a self-contained PWA in `./backlot/`. It shares the **Supabase backend** with the driver app but **none of its front-end code**. These conventions mirror the spirit of the driver app's `CLAUDE.md`, applied to Backlot's own codebase.

> Visual reference: open [`components.html`](components.html) in a browser to see every primitive. When you add a component to `styles.css`, add a section to `components.html` too — that's the only way it stays a living reference.

## Golden rule — isolation

Nothing in `./backlot/` may reference a driver-app file. No `../app.css`, no `../utils.js`, no `DT_*` globals. A change in the driver app must never be able to break Backlot (it's headed toward its own iPad app). The only shared thing is the Supabase project. Verify with:

```sh
grep -rn '\.\./' backlot/        # must return nothing
grep -rEn 'DT_|app\.css|app\.js' backlot/   # must return nothing
```

## File layout

```
backlot/
  index.html          # PWA shell + icon sprite + section containers
  styles.css          # design tokens + component layer (the source of truth)
  components.html      # living visual style guide
  STYLE_GUIDE.md       # this file
  config.js            # own Supabase URL + anon key
  utils.js             # BL_ESC, BL_FORMAT, BL_TOAST, BL_UI, BL_ERR
  auth.js              # BL_AUTH — sign-in + manager role gate
  nav.js               # shell nav, clock, topbar
  boot.js              # service-worker registration
  sw.js                # own service worker (scope ./, own CACHE_VERSION)
  manifest.webmanifest # installable PWA manifest
  icons/icon.png       # app icon
  catalogs.js          # BL_OPTIONS / BL_STATUS_LABELS / BL_SANITIZE (record vocab)
  vin.js               # BL_VIN — VIN validate, NHTSA decode, camera scan (zxing)
  dashboard.js roster.js users.js comms.js reports.js  # feature modules (per phase)
  records.js record-form.js   # records browser + create/edit form
  search.js            # global VIN/serial search (topbar) → BL_RECORDS.openVinHistory
```

## Naming

- **JS globals:** `BL_*` (`BL_AUTH`, `BL_ESC`, `BL_NAV`, …). Never `DT_*`.
- **CSS classes:** `bl-` prefix (`.bl-btn`, `.bl-card`, `.bl-kpi`).
- **Variants use BEM modifiers**: `.bl-btn--primary`, `.bl-chip--clean`, `.bl-role-pill--driver`, `.bl-lot-pin--dirty`. Never a bare `.role-driver` or `.is-dirty` on something that's a variant, not a state.
- **State classes** are shared and prefixed `is-`: `.is-active`, `.is-hidden`, `.is-show`, `.is-open` (modals/gates), `.is-selected`, `.is-disabled`, `.is-sorted`, `.is-peak`, `.is-gold`. Reserve `is-*` for runtime state; use `--modifier` for permanent variants.
- **Icon symbols:** `icon-NAME` in the sprite.

## Module pattern (use verbatim for new feature modules)

```js
// Brief header: what this module does, which section it mounts into.
(function () {
  if (!window.BL_AUTH) return;          // bail if auth isn't loaded
  const sb  = BL_AUTH.client;            // shared Supabase client
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  // ...module state + functions...
  // refresh when this section becomes visible:
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "mysection") load(); });
})();
```

- Wrap in an IIFE; expose only what other modules need on `window.BL_*`.
- Gate access with `BL_AUTH.isManager()` / `.isAdmin()` / `.isCxr()` — never compare raw role strings.
- Privileged user ops go through the shared `admin-users` edge function (`sb.functions.invoke`), never the service key.
- Add the new `<script src="...">` to `index.html` in dependency order (config → utils → auth → nav → features → boot) **and** add the file to the `SHELL` precache list in `sw.js`.

## Styling — tokens only

**Never hardcode a color, pixel spacing, or font size when a token exists.** All tokens live in `:root` in `styles.css`.

- Surfaces: `--bg`, `--surface`, `--card`, `--card-2`, `--hover`
- Lines: `--border`, `--divider`
- Text: `--text`, `--text-soft`, `--muted`
- Foreground-on-status: `--text-on-accent` (on solid green), `--text-on-warn` (on yellow), `--text-on-status` (on solid danger / info). Use one of these on any solid brand/status background — never a bare `#fff`.
- Brand/status: `--accent` (+ `-strong`, `-soft`), `--warn` (+ `-soft`), `--danger` (+ `-soft`), `--info` (+ `-soft`), `--success`
- Lot status: `--st-clean`, `--st-dirty`, `--st-pm`, `--st-shut`
- Spacing: `--sp-0` (2px, hairline) · `--sp-1` (4px) … `--sp-7` (48px)
- Touch targets: `--touch` (44px) for primary controls, `--touch-sm` (34px) for the documented small tier — pager, segmented, chip filter, `.bl-btn--sm`. Never invent a new smaller size.
- Type: `--fs-2xs` (10px, dense meta only) · `--fs-xs` … `--fs-2xl` · weights `--fw-normal` … `--fw-black`
- Radii `--r-sm/md/lg/full` · shadows `--sh-sm/md/lg` · `--focus-ring`

Theme: **dark only for v1.** `:root` is dark; the structure is ready for `:root[data-theme="light"]` as a drop-in later — keep every value tokenised so that day is easy.

### Component classes (reuse — see components.html)

Buttons `.bl-btn` + `--primary/--secondary/--ghost/--danger/--destructive/--warn/--link/--icon/--sm/--block` (`--danger` = solid red for prominent destructive actions; `--destructive` = outline red for secondary Delete-next-to-Save) · fields `.bl-field` + `.bl-field-label` · cards `.bl-card` + `.bl-card-head` + `.bl-card-body` · `.bl-kpis`/`.bl-kpi` · `.bl-table` (wrap in `.bl-table-wrap`) · chips `.bl-chip--clean/dirty/pm/shut` · segmented `.bl-seg`/`.bl-seg-btn` · `.bl-empty` · `.bl-toast` (via `BL_TOAST`) · `.bl-msg` (via `BL_UI.setMessage`).

### Casing — buttons + badges are always uppercase

Every `.bl-btn` (all variants) and every badge / pill / chip / tag (`.bl-chip`, `.bl-role-pill`, `.bl-pending-pill`, `.bl-disabled-pill`, `.bl-shift-tag`, `.bl-status`, `.bl-nav-badge`, `.bl-vin-status-pill`, `.bl-vin-flag`, `.bl-vin-cond-chip`) renders **UPPERCASE**, applied via CSS `text-transform: uppercase`. Write the source text in normal case (`"Delete"`, `"driver"`, `"Pending"`) — the CSS handles the transform. Do **not** hand-uppercase strings (`"DELETE"`, `"DRIVER"`) in HTML/JS; that breaks copy tools and screen-reader pronunciation. Add `letter-spacing: .5px` (or `.6px` on buttons) alongside any new uppercase style so glyph spacing stays legible.

## Icons — single-color SVG only

- **No emoji. No multi-color icons.** Every icon is a `<symbol>` in the inline sprite that paints with `currentColor`.
- Reference: `<svg class="bl-icon"><use href="#icon-NAME"/></svg>`. Color it by setting `color` on the SVG (or inheriting it).
- The sprite lives in **both** `index.html` and `components.html` — keep the two copies in sync when you add an icon.
- The Backlot logo is `icon-wheel` (the DriverTrax steering wheel, copied in).
- **Icon-only buttons must carry an `aria-label`.**

## Accessibility

- Prefer real `<button>` for clickable things (nav, actions).
- Icon-only controls need `aria-label`.
- Overlays/modals: `role="dialog"` + `aria-modal="true"` + `aria-label`, and Escape-to-close.
- Focus rings come from `--focus-ring`; don't override `:focus-visible` per component.
- Touch targets: primary controls ≥ `--touch` (44px); dense secondary controls (pager, segmented, chip filter, `.bl-btn--sm`) may use `--touch-sm` (34px). Nothing smaller. Never depend on hover for a primary action (tablet-first).

## Responsive

One shell, two first-class form factors:
- **Desktop / landscape tablet:** left sidebar + topbar + scrollable main.
- **≤900px (portrait tablet):** sidebar becomes a horizontal tab bar; 2-col grids collapse to 1.
- **≤560px (phones, best-effort):** icons-only tab bar, condensed topbar.

## Sanitization & safety

- `esc()` (= `BL_ESC`) every user-provided string before putting it in `innerHTML`.
- Strict CSP in `index.html` — no new external origins without updating it (and bumping `CACHE_VERSION`).
- **The CSP blocks `style="..."` attributes** (`style-src` has no `'unsafe-inline'`). Any `<div style="…">` you write into `index.html` or emit from JS `innerHTML` is silently ignored. Add a modifier class to `styles.css` instead — e.g. `.bl-modal-actions--center` and `.bl-vin-fuel-fill--75` were introduced for exactly this reason. `components.html` isn't served under the CSP, so demo pages there may use inline styles for guide chrome, but do not copy those patterns into the app.

## Service worker

`sw.js` precaches the Backlot shell under `CACHE_VERSION`. **Any change to a precached asset (html/css/js/icons) must bump `CACHE_VERSION`** — otherwise installed PWAs serve the stale file. Bump the suffix to describe the change, e.g. `backlot-v1.2-dashboard`.

## When adding a component

1. Add the styles to `styles.css` using tokens.
2. Add a demo section to `components.html` (and the icon to both sprites if it's an icon).
3. Bump `CACHE_VERSION` in `sw.js`.
4. Keep this guide accurate if you introduce a new convention.
