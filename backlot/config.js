// ============================================================
// Backlot — Supabase configuration (own copy, fully isolated)
//
// Backlot is a self-contained PWA. It talks to the SAME Supabase
// backend as the DriverTrax driver app (shared data), but ships
// its own copy of these values so nothing here references a
// driver-app file. The anon key is safe to embed client-side —
// Row Level Security in the database controls access.
// ============================================================
window.BL_SUPABASE_URL = "https://wcetkygfsstqtlmrijjl.supabase.co";
window.BL_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZXRreWdmc3N0cXRsbXJpampsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjM4NTgsImV4cCI6MjA5NjU5OTg1OH0.YL6cyKXzUxTEQfCAIFgyRGS4SRmVJR8blqF8xXmAk1A";

// CARTO now requires a free API key on its basemap tile requests (the dark
// map on the Dashboard and the record detail map both use it) — unkeyed
// requests still load but get an "API KEY REQUIRED" watermark. Get a free
// key (covers 5M tile requests/month) at https://carto.com/basemaps/apikey/
// and paste it below. Safe to embed client-side — it's a rate-limited
// usage key, not a secret. See utils.js's BL_MAP.addCartoDarkTiles.
window.BL_CARTO_API_KEY = "";
