import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../env";
import { supabaseAdmin } from "../lib/supabase";
import { findClinicById } from "../models/clinic";
import { createProfile, deleteProfile, findProfileById, listProfiles, updateProfile } from "../models/profile";
import { logAudit } from "../services/audit";

// Supabase AuthApiError properties are non-enumerable → JSON.stringify gives '{}'
// This helper always extracts a human-readable string.
function extractMsg(err: unknown, fallback = "An unexpected error occurred."): string {
  if (!err) return fallback;
  if (typeof err === "string") return err || fallback;
  const e = err as any;
  const msg = e.message ?? e.msg ?? e.error_description ?? e.error ?? e.code ?? "";
  return (typeof msg === "string" && msg.trim()) ? msg.trim() : fallback;
}

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["clinic_admin", "staff", "super_admin"]),
  clinicId: z.string().uuid().nullish(),
});

export async function inviteMember(req: Request, res: Response) {
  const caller = req.profile!;
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "email, name, role and clinicId are required." });
  }
  const { email, name, role, clinicId } = parsed.data;

  if (caller.role === "clinic_admin") {
    if (role !== "staff") {
      return res.status(403).json({ error: "Clinic admins can only invite staff." });
    }
    if (clinicId !== caller.clinic_id) {
      return res.status(403).json({ error: "You can only invite staff into your own clinic." });
    }
  } else if (caller.role !== "super_admin") {
    return res.status(403).json({ error: "Not authorized." });
  }

  // Resolve clinic — required for clinic_admin/staff roles, not allowed for super_admin
  let resolvedClinicId: string | null = null;
  if (role !== "super_admin") {
    if (!clinicId) return res.status(400).json({ error: "clinicId is required for clinic_admin and staff roles." });
    const clinic = await findClinicById(clinicId);
    if (!clinic) return res.status(400).json({ error: "Unknown clinic." });
    resolvedClinicId = clinicId;
  }

  const redirectTo = `${env.APP_BASE_URL}/accept-invite`;

  // ── Step 1: Generate the invite link (single OTP — never call inviteUserByEmail
  //   alongside this, as each call mints a new token and invalidates the previous one) ──
  let userId: string;
  let inviteLink: string;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { redirectTo, data: { role, name, clinic_id: resolvedClinicId } },
    });
    if (error || !data?.user?.id || !data?.properties?.action_link) {
      console.error("[invite] generateLink error:", error);
      return res.status(400).json({ error: extractMsg(error, "Could not create invite link.") });
    }
    userId     = data.user.id;
    inviteLink = data.properties.action_link;
  } catch (err) {
    console.error("[invite] generateLink threw:", err);
    return res.status(502).json({ error: extractMsg(err, "Could not reach Supabase auth.") });
  }

  // ── Step 2: Send invite email via Resend API using the same link ───────────
  // We own the sending so the link in the email == the backup link == same OTP.
  let emailSent = false;
  let emailError: string | undefined;

  if (env.RESEND_API_KEY && env.INVITE_FROM_EMAIL) {
    try {
      const fromName  = env.INVITE_FROM_NAME ?? "RPMCares";
      const htmlBody  = buildInviteEmail({ name, inviteLink, fromName });
      const sendRes   = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from:    `${fromName} <${env.INVITE_FROM_EMAIL}>`,
          to:      [email],
          subject: `You're invited to ${fromName}`,
          html:    htmlBody,
        }),
      });
      if (sendRes.ok) {
        emailSent = true;
      } else {
        const errBody = await sendRes.json().catch(() => ({}));
        emailError = extractMsg(errBody, `Email delivery failed (${sendRes.status})`);
        console.warn("[invite] Resend API error:", errBody);
      }
    } catch (err) {
      emailError = extractMsg(err, "Email delivery failed.");
      console.warn("[invite] Resend fetch threw:", err);
    }
  } else {
    emailError = "Email not configured — share the link manually.";
  }

  // ── Step 3: Upsert the profile row ────────────────────────────────────────
  try {
    const { error: upsertErr } = await supabaseAdmin.from("profiles").upsert(
      { id: userId, email, role, name, clinic_id: resolvedClinicId, invited_by: caller.id },
      { onConflict: "id" },
    );
    if (upsertErr) console.error("[invite] Profile upsert error:", upsertErr);
  } catch (err) {
    console.error("[invite] Profile upsert threw:", err);
  }

  logAudit(caller, "member_invited", `Invited ${email} as ${role}`, resolvedClinicId)
    .catch((e) => console.warn("[audit] member_invited failed:", e));

  return res.status(201).json({ ok: true, emailSent, emailError, inviteLink, email });
}

export async function listMembers(req: Request, res: Response) {
  const caller = req.profile!;
  let profiles;

  if (caller.role === "super_admin") {
    const clinicName = req.query.clinicName as string | undefined;
    let clinicId: string | undefined;
    if (clinicName) {
      const { data } = await supabaseAdmin
        .from("clinics")
        .select("id")
        .eq("name", clinicName)
        .maybeSingle();
      clinicId = data?.id;
    }
    profiles = await listProfiles({ roles: ["super_admin", "clinic_admin", "staff"], clinicId });
  } else if (caller.role === "clinic_admin") {
    profiles = await listProfiles({
      roles: ["clinic_admin", "staff"],
      clinicId: caller.clinic_id ?? undefined,
    });
  } else {
    return res.status(403).json({ error: "Not authorized." });
  }

  // Merge ban status from Supabase Auth
  try {
    const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (authData?.users) {
      const banMap = new Map(
        authData.users.map((u) => [u.id, u.banned_until ?? null]),
      );
      const members = profiles.map((p) => ({
        ...p,
        banned_until: banMap.get(p.id) ?? null,
      }));
      return res.json({ members });
    }
  } catch { /* fall through to plain profiles */ }

  return res.json({ members: profiles.map((p) => ({ ...p, banned_until: null })) });
}

export async function removeMember(req: Request, res: Response) {
  const caller = req.profile!;
  const targetId = req.params.id;

  const target = await findProfileById(targetId);
  if (!target) return res.status(404).json({ error: "Member not found." });

  if (caller.role === "clinic_admin") {
    if (target.role !== "staff" || target.clinic_id !== caller.clinic_id) {
      return res.status(403).json({ error: "You can only remove staff in your own clinic." });
    }
  } else if (caller.role === "super_admin") {
    if (target.role === "super_admin") {
      return res.status(403).json({ error: "Super admin accounts can't be removed here." });
    }
  } else {
    return res.status(403).json({ error: "Not authorized." });
  }

  // Delete the auth user first (this may cascade-delete the profile if FK is set up that way)
  const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(targetId);
  if (authErr) return res.status(400).json({ error: extractMsg(authErr, "Could not delete user.") });

  // Always explicitly delete the profile row to handle cases without CASCADE
  try {
    await deleteProfile(targetId);
  } catch {
    // Non-fatal — the auth user is gone, so the account is effectively removed
  }

  logAudit(caller, "member_removed", `Removed ${target.email} (${target.role})`, target.clinic_id)
    .catch((e) => console.warn("[audit] member_removed failed:", e));

  return res.json({ ok: true });
}

// ── Update member (super_admin only) ──────────────────────────────────────────

const updateSchema = z.object({
  name:      z.string().min(1).optional(),
  role:      z.enum(["clinic_admin", "staff"]).optional(),
  clinic_id: z.string().uuid().optional(),
});

export async function updateMember(req: Request, res: Response) {
  const caller = req.profile!;
  if (caller.role !== "super_admin") {
    return res.status(403).json({ error: "Only super admins can edit member profiles." });
  }

  const targetId = req.params.id;
  const target = await findProfileById(targetId);
  if (!target) return res.status(404).json({ error: "Member not found." });
  if (target.role === "super_admin") {
    return res.status(403).json({ error: "Cannot edit another super admin." });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid update fields." });
  }
  const patch = parsed.data;

  if (patch.clinic_id) {
    const clinic = await findClinicById(patch.clinic_id);
    if (!clinic) return res.status(400).json({ error: "Unknown clinic." });
  }

  const updated = await updateProfile(targetId, patch);

  // Keep auth user metadata in sync
  await supabaseAdmin.auth.admin.updateUserById(targetId, {
    user_metadata: {
      name:      patch.name      ?? target.name,
      role:      patch.role      ?? target.role,
      clinic_id: patch.clinic_id ?? target.clinic_id,
    },
  });

  const changes = Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join(", ");
  logAudit(caller, "member_updated", `Updated ${target.email} (${changes})`, updated.clinic_id)
    .catch((e) => console.warn("[audit] member_updated failed:", e));

  return res.json({ member: updated });
}

// ── Password reset link (super_admin + clinic_admin for their staff) ─────────

export async function resetPassword(req: Request, res: Response) {
  const caller = req.profile!;
  const targetId = req.params.id;

  const target = await findProfileById(targetId);
  if (!target) return res.status(404).json({ error: "Member not found." });

  if (caller.role === "clinic_admin") {
    if (target.role !== "staff" || target.clinic_id !== caller.clinic_id) {
      return res.status(403).json({ error: "Access denied." });
    }
  } else if (caller.role !== "super_admin") {
    return res.status(403).json({ error: "Not authorized." });
  }

  // Generate a secure password-reset link (does not send email by itself — link returned to admin)
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: target.email,
    options: { redirectTo: `${env.APP_BASE_URL}/reset-password` },
  });

  if (error || !data?.properties?.action_link) {
    console.error("[reset-password] Supabase error:", error);
    return res.status(400).json({ error: extractMsg(error, "Could not generate reset link.") });
  }

  logAudit(caller, "password_reset_requested", `Requested password reset for ${target.email}`, target.clinic_id)
    .catch((e) => console.warn("[audit] password_reset_requested failed:", e));

  return res.json({ ok: true, resetLink: data.properties.action_link, email: target.email });
}

// ── Suspend / Unsuspend (super_admin only) ────────────────────────────────────

export async function suspendMember(req: Request, res: Response) {
  const caller = req.profile!;
  if (caller.role !== "super_admin") {
    return res.status(403).json({ error: "Only super admins can suspend accounts." });
  }

  const target = await findProfileById(req.params.id);
  if (!target) return res.status(404).json({ error: "Member not found." });
  if (target.role === "super_admin") {
    return res.status(403).json({ error: "Cannot suspend another super admin." });
  }

  // Ban for 876,600 hours (~100 years) = effectively permanent until manually lifted
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    ban_duration: "876600h",
  });
  if (error) return res.status(400).json({ error: extractMsg(error, "Could not suspend user.") });

  logAudit(caller, "member_suspended", `Suspended ${target.email}`, target.clinic_id)
    .catch((e) => console.warn("[audit] member_suspended failed:", e));

  return res.json({ ok: true });
}

export async function unsuspendMember(req: Request, res: Response) {
  const caller = req.profile!;
  if (caller.role !== "super_admin") {
    return res.status(403).json({ error: "Only super admins can unsuspend accounts." });
  }

  const target = await findProfileById(req.params.id);
  if (!target) return res.status(404).json({ error: "Member not found." });

  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    ban_duration: "none",
  });
  if (error) return res.status(400).json({ error: extractMsg(error, "Could not unsuspend user.") });

  logAudit(caller, "member_unsuspended", `Unsuspended ${target.email}`, target.clinic_id)
    .catch((e) => console.warn("[audit] member_unsuspended failed:", e));

  return res.json({ ok: true });
}

// ── Audit log ─────────────────────────────────────────────────────────────────
// GET /api/admin/audit-log
// Non-super_admins are scoped to their own clinic, matching the same
// pattern used for communications/billing elsewhere in the app.

export async function listAuditLog(req: Request, res: Response) {
  const caller = req.profile!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);

  let q = supabaseAdmin
    .from("audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (caller.role !== "super_admin") {
    if (!caller.clinic_id) return res.json({ events: [] });
    q = q.eq("clinic_id", caller.clinic_id);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ events: data });
}

// ── Email template ─────────────────────────────────────────────────────────────

function buildInviteEmail({
  name, inviteLink, fromName,
}: { name: string; inviteLink: string; fromName: string }): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#19D400;padding:28px 32px">
            <p style="margin:0;font-size:22px;font-weight:800;color:#052B00;letter-spacing:-0.5px">${fromName}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827">You're invited!</p>
            <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6">
              Hi ${name}, you've been invited to join <strong>${fromName}</strong> as a care team member.
              Click the button below to set up your account.
            </p>
            <a href="${inviteLink}"
               style="display:inline-block;background:#19D400;color:#052B00;font-size:15px;font-weight:700;
                      text-decoration:none;padding:14px 28px;border-radius:999px">
              Accept invitation
            </a>
            <p style="margin:24px 0 8px;font-size:12.5px;color:#6B7280">
              Or copy this link into your browser:
            </p>
            <p style="margin:0;font-size:11px;color:#9CA3AF;word-break:break-all">${inviteLink}</p>
            <hr style="margin:28px 0;border:none;border-top:1px solid #E5E7EB">
            <p style="margin:0;font-size:12px;color:#9CA3AF">
              This link is valid for 24 hours. If you didn't expect this invitation, you can ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
