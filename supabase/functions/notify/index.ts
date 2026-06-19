// DriverTrax notify edge function
//
// Invoked by a database webhook on INSERT to any of:
//   - public.announcements           → audience = all push subscriptions
//   - public.extra_driver_requests   → audience = subs where role = row.position
//   - public.announcement_replies    → audience = the alert's author
//   - public.extra_driver_responses  → audience = the request's manager (only on yes)
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

type Audience = { role?: string; userId?: string };
type Message = {
  title: string;
  body: string;
  tag: string;
  tab: string;
  audience: Audience;
  actorId?: string | null;
};

async function profileName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const { data } = await sb.from("profiles").select("display_name").eq("id", id).maybeSingle();
  return (data?.display_name as string) || null;
}

async function buildMessage(table: string, row: any): Promise<Message | null> {
  if (table === "announcements") {
    return {
      title: "New alert",
      body: String(row.body || "").slice(0, 180),
      tag: `ann-${row.id}`,
      tab: "announcements",
      audience: {}, // all subscribers
      actorId: row.author_id || null
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
      audience: { role: row.position || "driver" },
      actorId: row.manager_id || null
    };
  }

  if (table === "announcement_replies") {
    // Notify only the original alert's author.
    const { data: parent } = await sb
      .from("announcements")
      .select("author_id,body")
      .eq("id", row.announcement_id)
      .maybeSingle();
    if (!parent?.author_id) return null;
    const who = (await profileName(row.author_id)) || "Someone";
    return {
      title: `${who} replied to your alert`,
      body: String(row.body || "").slice(0, 180),
      tag: `ann-${row.announcement_id}-reply`,
      tab: "announcements",
      audience: { userId: parent.author_id as string },
      actorId: row.author_id || null
    };
  }

  if (table === "extra_driver_responses") {
    // Only notify on accepts; declines are noise for the manager.
    if (row.response !== "yes") return null;
    const { data: parent } = await sb
      .from("extra_driver_requests")
      .select("manager_id,shift_time,shifts")
      .eq("id", row.request_id)
      .maybeSingle();
    if (!parent?.manager_id) return null;
    const who = (await profileName(row.driver_id)) || "Someone";
    const when = parent.shift_time
      ? new Date(parent.shift_time as string).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : "";
    const responseShifts = Array.isArray(row.shifts) && row.shifts.length ? row.shifts.join(", ") : "";
    const tail = [when, responseShifts].filter(Boolean).join(" — ");
    return {
      title: "Coverage accepted",
      body: `${who} accepted${tail ? ` · ${tail}` : ""}`,
      tag: `edr-${row.request_id}-${row.driver_id}`,
      tab: "backlot-announce",
      audience: { userId: parent.manager_id as string },
      actorId: row.driver_id || null
    };
  }

  return null;
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json() as Payload;
    if (payload.type !== "INSERT") return new Response("ignored", { status: 200 });

    const msg = await buildMessage(payload.table, payload.record);
    if (!msg) return new Response("unhandled or filtered", { status: 200 });

    let query = sb.from("push_subscriptions").select("endpoint,p256dh,auth,user_id,role");
    if (msg.audience.userId) query = query.eq("user_id", msg.audience.userId);
    else if (msg.audience.role) query = query.eq("role", msg.audience.role);

    const { data: subs, error } = await query;
    if (error) {
      console.error("subs select failed", error);
      return new Response("subs select failed", { status: 500 });
    }

    const targets = (subs || []).filter(s => !msg.actorId || s.user_id !== msg.actorId);
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
      table: payload.table,
      sent: results.filter(r => r.status === "fulfilled").length,
      failed: results.filter(r => r.status === "rejected").length,
      pruned: dead.length
    }), { headers: { "content-type": "application/json" } });
  } catch (err) {
    console.error("notify error", err);
    return new Response("error", { status: 500 });
  }
});
