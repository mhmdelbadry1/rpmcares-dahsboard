import { supabaseAdmin } from "../lib/supabase";

export type AuditActor = { id: string; name: string; email: string };

// Best-effort — an audit-log write failing should never break the action
// it's recording (e.g. don't fail an invite because the audit insert did).
export async function logAudit(
  actor: AuditActor,
  action: string,
  detail: string,
  clinicId: string | null = null,
): Promise<void> {
  const { error } = await supabaseAdmin.from("audit_log").insert({
    actor_id:    actor.id,
    actor_name:  actor.name,
    actor_email: actor.email,
    clinic_id:   clinicId,
    action,
    detail,
  });
  if (error) console.warn("[audit] insert failed:", error.message);
}
