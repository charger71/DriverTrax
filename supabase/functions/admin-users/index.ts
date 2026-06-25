// DriverTrax admin-users edge function
//
// Manager/admin-only user management. The browser cannot call
// `auth.admin.*` directly (needs service role), so this function wraps it.
//
// Actions (POST body { action, ... }):
//   create         { email, password, profile }      → creates confirmed auth user + updates profile row
//   update_email   { user_id, email }                → changes auth email (auto-confirmed) + profile.email
//   update_password{ user_id, password }             → sets a new password
//
// Auth: caller must send Authorization: Bearer <access_token>. We resolve the
// caller's profile and require role in ('manager','admin'). 'admin' is required
// to touch another admin.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS }
  });
}

async function getCaller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { error: "missing token" };
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: u, error: ue } = await userClient.auth.getUser();
  if (ue || !u?.user) return { error: "invalid token" };
  const { data: prof } = await admin
    .from("profiles")
    .select("id,role")
    .eq("id", u.user.id)
    .maybeSingle();
  if (!prof) return { error: "no profile" };
  return { caller: prof as { id: string; role: string } };
}

async function targetRole(user_id: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("role").eq("id", user_id).maybeSingle();
  return (data?.role as string) || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const { caller, error: authErr } = await getCaller(req);
  if (authErr || !caller) return json({ error: authErr || "unauthorized" }, 401);
  if (caller.role !== "manager" && caller.role !== "admin") {
    return json({ error: "forbidden" }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body?.action;

  try {
    if (action === "create") {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const profile = body.profile || {};
      if (!email || !password) return json({ error: "email and password required" }, 400);
      if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
      if (profile.role === "admin" && caller.role !== "admin") {
        return json({ error: "only an admin can create an admin" }, 403);
      }

      const { data: created, error: ce } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          display_name: profile.display_name || null,
          role: profile.role || "driver",
          home_airport: profile.home_airport || null,
          shuttle_subrole: profile.shuttle_subrole || null
        }
      });
      if (ce || !created?.user) return json({ error: ce?.message || "create failed" }, 400);

      // The on_auth_user_created trigger seeds the profile row. Update it with
      // the manager-supplied fields and pre-approve.
      const { error: pe } = await admin.from("profiles").update({
        display_name: profile.display_name || null,
        email,
        phone: profile.phone || null,
        role: profile.role || "driver",
        home_airport: profile.home_airport || null,
        shuttle_subrole: profile.shuttle_subrole || null,
        callbacks_opt_in: !!profile.callbacks_opt_in,
        approved: true
      }).eq("id", created.user.id);
      if (pe) return json({ error: pe.message, user_id: created.user.id }, 500);

      return json({ ok: true, user_id: created.user.id });
    }

    if (action === "update_email") {
      const user_id = String(body.user_id || "");
      const email = String(body.email || "").trim();
      if (!user_id || !email) return json({ error: "user_id and email required" }, 400);
      const tRole = await targetRole(user_id);
      if (tRole === "admin" && caller.role !== "admin") {
        return json({ error: "only an admin can edit another admin" }, 403);
      }
      const { error: ae } = await admin.auth.admin.updateUserById(user_id, {
        email,
        email_confirm: true
      });
      if (ae) return json({ error: ae.message }, 400);
      const { error: pe } = await admin.from("profiles").update({ email }).eq("id", user_id);
      if (pe) return json({ error: pe.message }, 500);
      return json({ ok: true });
    }

    if (action === "update_password") {
      const user_id = String(body.user_id || "");
      const password = String(body.password || "");
      if (!user_id || !password) return json({ error: "user_id and password required" }, 400);
      if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
      const tRole = await targetRole(user_id);
      if (tRole === "admin" && caller.role !== "admin") {
        return json({ error: "only an admin can edit another admin" }, 403);
      }
      const { error: ae } = await admin.auth.admin.updateUserById(user_id, { password });
      if (ae) return json({ error: ae.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("admin-users error", err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
