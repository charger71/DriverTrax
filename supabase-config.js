// DriverTrax Supabase configuration
// The anon key is safe to embed client-side — Row Level Security policies
// in the database control what each signed-in user can actually read/write.
window.SUPABASE_URL = "https://wcetkygfsstqtlmrijjl.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZXRreWdmc3N0cXRsbXJpampsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjM4NTgsImV4cCI6MjA5NjU5OTg1OH0.YL6cyKXzUxTEQfCAIFgyRGS4SRmVJR8blqF8xXmAk1A";

// VAPID public key for Web Push. Generate with `npx web-push generate-vapid-keys`,
// paste the public key here, store the private key as a Supabase secret named
// VAPID_PRIVATE_KEY for the `notify` edge function.
window.VAPID_PUBLIC_KEY = "BE_23HT1re_zNtT8dfsc1Sz4gRx3OtR6KiN1PpHYzvVtD8OE2B92uP7KP5NX16oH7hB6KxN-WVzSfis4PFwj5Y8";