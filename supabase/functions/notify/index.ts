// DriverTrax notify edge function
//
// Invoked by a database webhook on INSERT to either:
//   - public.announcements           → audience = all push subscriptions
//   - public.extra_driver_requests   → audience = subs where role = row.position
//
// Webhook payload shape (Supabase database webhooks):
//   { type: "INSERT", table: "...", record: {...}, schema: "public", old_record: null }
//
// Required secrets (set via `supabase secrets set`):
//   VAPID_PUBLIC_KEY   — same value as window.VAPID_PUBLIC_KEY in the client
//   VAPID_PRIVATE_KEY  — keep private
//   VAPID_SUBJECT      — e.g. "mailto:dhansen@area71.com"
//
// The function runs with the service role key automatically; we use it to
// read push_subscriptions across users (RLS would otherwise block).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

type Payload = {
  type: string;
  table: string;
  record: Record<string, unknown>;
  schema: string;
};

function buildMessage(table: string, row: any) {
  if (table === "announcements") {
    return {
      title: "New alert",
      body: String(row.body || "").slice(0, 180),
      tag: `ann-${row.id}`,
      tab: "announcements",
      audienceRole: null // all subscribers
    };
  }
  if (table === "extra_driver_requests") {
    const when = row.shift_time
      ? new Date(row.shift_time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : "";
    const shifts = Array.isArray(row.shifts) && row.shifts.length ? ` (${row.shifts.join(", ")})` : "";
    const need = row.needed_count ? `${row.needed_count} needed` : "Coverage needed";
    return {
      title: "Coverage request",
      body: [when && `${when}${shifts}`, need, row.note].filter(Boolean).join(" — "),
      tag: `edr-${row.id}`,
      tab: "announcements",
      audienceRole: row.position || "driver"
    };
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json() as Payload;
    if (payload.type !== "INSERT") return new Response("ignored", { status: 200 });

    const msg = buildMessage(payload.table, payload.record);
    if (!msg) return new Response("unhandled table", { status: 200 });

    let query = sb.from("push_subscriptions").select("endpoint,p256dh,auth,user_id,role");
    if (msg.audienceRole) query = query.eq("role", msg.audienceRole);
    // Skip notifying the actor (e.g., manager who posted the alert)
    const actorId = (payload.record as any).author_id || (payload.record as any).manager_id;

    const { data: subs, error } = await query;
    if (error) {
      console.error("subs select failed", error);
      return new Response("subs select failed", { status: 500 });
    }

    const targets = (subs || []).filter(s => !actorId || s.user_id !== actorId);
    const body = JSON.stringify({
      title: msg.title,
      body: msg.body,
      tag: msg.tag,
      tab: msg.tab
    });

    const results = await Promise.allSettled(targets.map(s =>
      webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      }, body)
    ));

    // Clean up expired endpoints (404/410)
    const dead: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const code = (r.reason as any)?.statusCode;
        if (code === 404 || code === 410) dead.push(targets[i].endpoint);
      }
    });
    if (dead.length) {
      await sb.from("push_subscriptions").delete().in("endpoint", dead);
    }

    return new Response(JSON.stringify({
      sent: results.filter(r => r.status === "fulfilled").length,
      failed: results.filter(r => r.status === "rejected").length,
      pruned: dead.length
    }), { headers: { "content-type": "application/json" } });
  } catch (err) {
    console.error("notify error", err);
    return new Response("error", { status: 500 });
  }
});
