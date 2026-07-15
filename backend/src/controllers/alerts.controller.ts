import type { Request, Response } from "express";
import { findClinicById } from "../models/clinic";
import { listAlerts, patchAlert, type AlertStatus } from "../models/alert-event";
import { findProfileById } from "../models/profile";
import { supabaseAdmin } from "../lib/supabase";

export async function list(req: Request, res: Response) {
  const profile = await findProfileById(req.auth!.sub);
  const { status } = req.query as Record<string, string>;

  let clinicFilter: string | undefined = req.query.clinic as string | undefined;

  // Non-super-admins are locked to their assigned clinic only
  if (profile && profile.role !== "super_admin") {
    if (!profile.clinic_id) return res.json({ alerts: [] });
    const clinic = await findClinicById(profile.clinic_id);
    if (!clinic) return res.json({ alerts: [] });
    clinicFilter = clinic.name;
  }

  const { data, error } = await listAlerts({ clinicName: clinicFilter, status });
  if (error) return res.status(500).json({ error: error.message });

  const alerts = data ?? [];
  if (alerts.length === 0) return res.json({ alerts });

  // Enrich each alert with our internal patient UUID so the frontend can
  // navigate directly to the patient profile. Two lookup strategies:
  //   1. patient_id → patients.external_patient_id  (SmartMeter numeric ID)
  //   2. patient_name → patients.full_name           (fallback)
  const extIds   = [...new Set(alerts.map((a) => a.patient_id).filter(Boolean))];
  const names    = [...new Set(alerts.map((a) => a.patient_name).filter(Boolean))];

  const [byExtId, byName] = await Promise.all([
    extIds.length
      ? supabaseAdmin.from("patients").select("id, external_patient_id").in("external_patient_id", extIds)
      : { data: [] },
    names.length
      ? supabaseAdmin.from("patients").select("id, full_name").in("full_name", names)
      : { data: [] },
  ]);

  const uuidByExtId = new Map((byExtId.data ?? []).map((p: any) => [p.external_patient_id, p.id]));
  const uuidByName  = new Map((byName.data  ?? []).map((p: any) => [p.full_name, p.id]));

  const enriched = alerts.map((a) => ({
    ...a,
    patient_uuid: uuidByExtId.get(a.patient_id) ?? uuidByName.get(a.patient_name) ?? null,
  }));

  return res.json({ alerts: enriched });
}

export async function update(req: Request, res: Response) {
  const { id } = req.params;
  const { status, assignedTo } = req.body as { status?: AlertStatus; assignedTo?: string | null };

  const patch: Parameters<typeof patchAlert>[1] = {};
  if (status) patch.status = status;
  if (assignedTo !== undefined) patch.assigned_to = assignedTo ?? null;
  if (status === "resolved") patch.resolved_at = new Date().toISOString();

  const { data, error } = await patchAlert(id, patch);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ alert: data });
}
