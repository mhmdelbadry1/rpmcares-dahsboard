import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { createClinic, deleteClinic, findClinicById, listClinics, updateClinic } from "../models/clinic";
import { getSmartMeterSummary } from "../services/smartmeter";
import { logAudit } from "../services/audit";

const createClinicSchema = z.object({ name: z.string().min(1) });

export async function getClinics(req: Request, res: Response) {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, clinic_id")
    .eq("id", (req as any).auth!.sub)
    .maybeSingle();

  // Non-super-admins see only their own clinic
  if (profile && profile.role !== "super_admin") {
    if (!profile.clinic_id) return res.json({ clinics: [] });
    const clinic = await findClinicById(profile.clinic_id);
    return res.json({ clinics: clinic ? [clinic] : [] });
  }

  const clinics = await listClinics();
  return res.json({ clinics });
}

export async function postClinic(req: Request, res: Response) {
  const parsed = createClinicSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A clinic name is required." });
  const clinic = await createClinic(parsed.data.name);

  logAudit(req.profile!, "clinic_created", `Created clinic "${clinic.name}"`, clinic.id)
    .catch((e) => console.warn("[audit] clinic_created failed:", e));

  return res.status(201).json({ clinic });
}

const patchClinicSchema = z.object({
  smartmeter_api_key: z.string().min(1).optional(),
  specialty: z.string().optional(),
  location: z.string().optional(),
});

export async function patchClinicHandler(req: Request, res: Response) {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Clinic ID is required." });
  const parsed = patchClinicSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid patch fields." });
  if (Object.keys(parsed.data).length === 0)
    return res.status(400).json({ error: "No fields to update." });
  const clinic = await updateClinic(id, parsed.data);

  // Never write the actual API key value into the audit log — just note which fields changed.
  const fields = Object.keys(parsed.data).map((k) => k === "smartmeter_api_key" ? "SmartMeter API key" : k);
  logAudit(req.profile!, "clinic_updated", `Updated ${clinic.name} (${fields.join(", ")})`, id)
    .catch((e) => console.warn("[audit] clinic_updated failed:", e));

  return res.json({ clinic });
}

export async function deleteClinicHandler(req: Request, res: Response) {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Clinic ID is required." });
  const clinic = await findClinicById(id);
  await deleteClinic(id);

  logAudit(req.profile!, "clinic_deleted", `Deleted clinic "${clinic?.name ?? id}"`, null)
    .catch((e) => console.warn("[audit] clinic_deleted failed:", e));

  return res.status(204).send();
}

export async function getClinicBreakdown(_req: Request, res: Response) {
  const { data: rows } = await supabaseAdmin
    .from("clinics")
    .select("name, smartmeter_api_key")
    .not("smartmeter_api_key", "is", null);

  const clinics = (rows ?? [])
    .filter((r: { smartmeter_api_key: string | null }) => typeof r.smartmeter_api_key === "string")
    .map((r: { name: string; smartmeter_api_key: string }) => ({ name: r.name, apiKey: r.smartmeter_api_key }));

  const summary = await getSmartMeterSummary(clinics);
  return res.json({ breakdown: summary.clinicBreakdown });
}
