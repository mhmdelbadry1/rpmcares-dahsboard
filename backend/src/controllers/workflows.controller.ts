import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { findProfileById } from "../models/profile";

// ── Get all clinics with their review mode ────────────────────────────────

export async function getWorkflows(req: Request, res: Response) {
  const profile = await findProfileById(req.auth!.sub);

  let q = supabaseAdmin.from("clinics").select("id, name, review_mode, smartmeter_api_key");
  if (profile?.role !== "super_admin") {
    if (!profile?.clinic_id) return res.json({ clinics: [], statsBySource: {} });
    q = q.eq("id", profile.clinic_id) as any;
  }

  const { data: clinics } = await (q as any).order("name");

  // Monthly stats by source from patient_review_times
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: statsRows } = await supabaseAdmin
    .from("patient_review_times")
    .select("source")
    .gte("clock_start", monthStart.toISOString());

  const statsBySource: Record<string, number> = {};
  for (const row of statsRows ?? []) {
    statsBySource[row.source] = (statsBySource[row.source] ?? 0) + 1;
  }

  return res.json({
    clinics: (clinics ?? []).map((c: any) => ({
      id:           c.id,
      name:         c.name,
      review_mode:  c.review_mode ?? "automatic",
      has_smartmeter: !!c.smartmeter_api_key,
    })),
    statsBySource,
  });
}

// ── Set review mode for a clinic ──────────────────────────────────────────

export async function setReviewMode(req: Request, res: Response) {
  const { clinicId } = req.params;
  const { review_mode } = req.body as { review_mode: "automatic" | "manual" };

  if (review_mode !== "automatic" && review_mode !== "manual") {
    return res.status(400).json({ error: "review_mode must be 'automatic' or 'manual'." });
  }

  const profile = await findProfileById(req.auth!.sub);
  if (profile?.role !== "super_admin" && profile?.clinic_id !== clinicId) {
    return res.status(403).json({ error: "Access denied." });
  }

  await supabaseAdmin.from("clinics").update({ review_mode }).eq("id", clinicId);
  return res.json({ ok: true });
}
