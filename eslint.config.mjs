// ESLint flat config for the DriverTrax driver app.
//
// The app stays no-build — these files are still loaded by plain <script>
// tags, in the order index.html lists them. ESLint runs in CI only.
//
// Because there are no modules, every cross-file reference is a global. The
// `appGlobals` list below is therefore the app's de-facto public surface: if
// a module reaches for something not in it, `no-undef` fails the build. That
// catches the class of typo the old `node --check` step could not see.
//
// Rules are listed out rather than pulled from `@eslint/js`, deliberately:
// CI runs `npx eslint` with nothing installed in the repo, so a bare import
// here would resolve against the repo and fail. No import means no
// node_modules, which keeps the "no build step" promise intact.

// Browser platform globals this app actually touches.
const browserGlobals = [
  "window", "document", "console", "navigator", "location", "history", "screen",
  "localStorage", "sessionStorage", "indexedDB", "caches", "crypto", "performance",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  "fetch", "Headers", "Request", "Response", "AbortController", "URL", "URLSearchParams",
  "FormData", "FileReader", "File", "Blob", "DataTransfer", "createImageBitmap",
  "Image", "Audio", "AudioContext", "webkitAudioContext", "BarcodeDetector",
  "CustomEvent", "Event", "MessageChannel", "MutationObserver", "IntersectionObserver",
  "Notification", "TextEncoder", "TextDecoder", "atob", "btoa",
  "alert", "confirm", "prompt", "getComputedStyle", "matchMedia",
  "CSS", "HTMLElement", "Element", "Node", "DOMParser", "structuredClone",
  "requestIdleCallback", "ResizeObserver", "AbortSignal", "ImageCapture"
];

// Third-party libraries loaded from CDNs before our own scripts.
const vendorGlobals = ["L", "ZXing", "supabase", "ScanbotSDK"];

// Our own cross-file surface. Each name is defined at the top level of one
// file and consumed from others (or from an inline onclick in index.html).
// Keep this alphabetical within each group so additions are easy to spot.
const appGlobals = [
  // supabase-config.js
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "VAPID_PUBLIC_KEY",
  // window.DT_* namespaces
  "DT_ANN", "DT_AUTH", "DT_COUNTERS", "DT_DAMAGE", "DT_DROPOFFS", "DT_ERR",
  "DT_ESC", "DT_FLEET_COUNTS", "DT_FORMAT", "DT_IDB", "DT_LIFECYCLE",
  "DT_LOCATIONS", "DT_MEDIA", "DT_NOTIFS", "DT_OPTIONS", "DT_PWA",
  "DT_REQUESTS", "DT_SYNC", "DT_TOAST", "DT_UI", "DT_USERS", "dtTimeAgo",
  "DT_BACKLOT", "DT_DETAIL", "DT_MAINT", "DT_VEHICLE_INFO", "DT_VENDORS",
  // app.js — records + rendering
  "getRecords", "setRecords", "invalidateRecordsCache", "getEffectiveRecords",
  "renderRecords", "renderTodayEntries", "renderDashboard", "renderRecordsMap",
  "renderVinTimeline", "resetRecordsPage", "changeRecordsPage", "changeVinTimelinePage",
  // app.js — shared helpers
  "showToast", "showTab", "haptic", "statusClass", "statusLabel", "locationLabel", "fillStatusSelect",
  "estDateStr", "estDayRangeISO", "isoDate", "sanitizeText", "sanitizeSerial",
  "sanitizeNotes", "sanitizeName", "isValidVIN", "decodeVIN", "getProfile",
  "createMap", "destroyMap", "createNumberedMarker", "recordPopupHTML",
  // app.js — UI entry points (also reached from inline onclick in index.html)
  "openDetail", "closeDetail", "openEdit", "closeEdit", "saveEdit", "deleteRecord",
  "deleteTodayRecord", "openScanner", "closeScanner", "openVinKeypad", "closeVinKeypad",
  "closeRecordDetailOverlay", "openMenu", "closeMenu", "saveRecord",
  "viewByDate", "viewByWeek", "clearFilters", "onDateFilterChange", "openVinDetailPanel",
  "openFuzzyRecord",
  // assigned as window.X = ... , so ESLint can't see the declaration
  "closeContactCard", "loadKeyUp", "loadGarage", "loadBcounter"
];

const toGlobals = (names, value = "readonly") =>
  Object.fromEntries(names.map((n) => [n, value]));

// The bug-catching subset of eslint:recommended. Stylistic rules are left
// out on purpose — this is a correctness gate, not a formatter.
const correctnessRules = {
  "no-cond-assign": "error",
  "no-constant-binary-expression": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-dupe-args": "error",
  "no-dupe-else-if": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-fallthrough": "error",
  "no-func-assign": "error",
  "no-global-assign": "error",
  "no-irregular-whitespace": "error",
  "no-obj-calls": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-sparse-arrays": "error",
  "no-unmodified-loop-condition": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-async-promise-executor": "error",
  "no-compare-neg-zero": "error",
  "require-atomic-updates": "off",
  "use-isnan": "error",
  "valid-typeof": "error",
  // builtinGlobals:false — app.js *defines* many of the names listed in
  // appGlobals above; that's the declaration, not a redeclaration.
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-undef": "error"
};

export default [
  {
    ignores: [
      "node_modules/**",
      // Separate dashboard surface with its own conventions; the existing CI
      // syntax check doesn't cover it either. Lint it in its own pass if it
      // ever becomes worth the backlog.
      "backlot/**",
      "elearning/**",
      // Deno, not browser.
      "supabase/**"
    ]
  },
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...toGlobals(browserGlobals),
        ...toGlobals(vendorGlobals),
        ...toGlobals(appGlobals, "writable")
      }
    },
    rules: {
      ...correctnessRules,
      // vars:"local" — top-level declarations in app.js are the app's HTML
      // surface, reached from inline onclick attributes ESLint can't see, so
      // flagging them is pure noise. Every feature module is an IIFE, so its
      // internals are still fully checked, which is where dead code actually
      // collects. Unused args are usually deliberate (event handlers).
      "no-unused-vars": ["error", {
        vars: "local",
        args: "none",
        caughtErrors: "none",
        varsIgnorePattern: "^_"
      }],
      // Empty catch blocks are an established idiom in this codebase for
      // best-effort platform calls; they're commented where non-obvious.
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    // Service worker: different platform, no DOM.
    files: ["sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...toGlobals([
          "self", "caches", "clients", "fetch", "console", "URL", "Request",
          "Response", "Headers", "File", "FormData", "setTimeout", "clearTimeout"
        ])
      }
    },
    rules: { ...correctnessRules, "no-empty": ["error", { allowEmptyCatch: true }] }
  }
];
