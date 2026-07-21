import type { Request, Response } from "express";
import {
  listBillingRules, createBillingRule, updateBillingRule, deleteBillingRule,
  listFeeSchedules, upsertFeeSchedule, deleteFeeSchedule,
  listDosOffsets, updateDosOffset,
  listBillingQueue, updateBillingRecord,
  getRevenueBreakdown, getPatientBillingSummary, upsertBillingCycle,
  type BillingQueueFilters,
} from "../models/billing";
import { evaluatePatientBilling, invalidateCache, runBillingEvaluation } from "../services/billing-engine";
import { syncReadingCounts } from "../lib/sync";
import { supabaseAdmin } from "../lib/supabase";

// ── Billing Queue ──────────────────────────────────────────────────────────

export async function getQueue(req: Request, res: Response): Promise<void> {
  const profile = req.profile!;
  const filters: BillingQueueFilters = {
    clinicId:      req.query.clinicId      as string | undefined,
    program:       req.query.program       as string | undefined,
    insuranceType: req.query.insuranceType as string | undefined,
    cptCode:       req.query.cptCode       as string | undefined,
    status:        req.query.status        as string | undefined,
    month:         req.query.month         as string | undefined,
  };
  const { records, totalCount } = await listBillingQueue(profile.role, profile.clinic_id, filters);
  res.json({ records, count: records.length, totalCount });
}

export async function patchRecord(req: Request, res: Response): Promise<void> {
  const { id }     = req.params;
  const profile    = req.profile!;
  const { status, dos, actual_amount, override_reason } = req.body;

  // Only super_admin can finalize (sign/submit/pay) or void records
  const finalStatuses = ["signed", "submitted", "paid", "voided"];
  if (status && finalStatuses.includes(status) && profile.role !== "super_admin") {
    res.status(403).json({ error: "Only super admins can finalize or void billing records." });
    return;
  }

  const patch: Parameters<typeof updateBillingRecord>[1] = {
    ...(status          != null ? { status }          : {}),
    ...(dos             != null ? { dos }              : {}),
    ...(actual_amount   != null ? { actual_amount }    : {}),
    ...(override_reason != null ? { override_reason }  : {}),
    ...(status === "submitted"  ? { submitted_at: new Date().toISOString() } : {}),
    ...(status === "locked"     ? { locked_at:    new Date().toISOString() } : {}),
  };

  const record = await updateBillingRecord(id, patch, override_reason ? profile.id : undefined);
  res.json({ record });
}

// ── Revenue ────────────────────────────────────────────────────────────────

export async function getRevenue(req: Request, res: Response): Promise<void> {
  const profile  = req.profile!;
  const year     = parseInt(req.query.year as string) || new Date().getFullYear();
  const clinicId = req.query.clinicId as string | undefined;
  const breakdown = await getRevenueBreakdown(profile.role, profile.clinic_id, year, clinicId);
  res.json(breakdown);
}

// ── Billing Rules ──────────────────────────────────────────────────────────

export async function getRules(_req: Request, res: Response): Promise<void> {
  const rules = await listBillingRules();
  res.json({ rules });
}

export async function postRule(req: Request, res: Response): Promise<void> {
  const rule = await createBillingRule(req.body);
  invalidateCache();
  res.status(201).json({ rule });
}

export async function patchRule(req: Request, res: Response): Promise<void> {
  const rule = await updateBillingRule(req.params.id, req.body);
  invalidateCache();
  res.json({ rule });
}

export async function deleteRule(req: Request, res: Response): Promise<void> {
  await deleteBillingRule(req.params.id);
  invalidateCache();
  res.json({ ok: true });
}

// ── Fee Schedules ──────────────────────────────────────────────────────────

export async function getFeeSchedules(_req: Request, res: Response): Promise<void> {
  const schedules = await listFeeSchedules();
  res.json({ schedules });
}

export async function putFeeSchedule(req: Request, res: Response): Promise<void> {
  const schedule = await upsertFeeSchedule(req.body);
  invalidateCache();
  res.json({ schedule });
}

export async function deleteFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  await deleteFeeSchedule(req.params.id);
  invalidateCache();
  res.json({ ok: true });
}

// ── DOS Offsets ────────────────────────────────────────────────────────────

export async function getDosOffsets(_req: Request, res: Response): Promise<void> {
  const offsets = await listDosOffsets();
  res.json({ offsets });
}

export async function patchDosOffset(req: Request, res: Response): Promise<void> {
  const offset = await updateDosOffset(req.params.id, req.body);
  invalidateCache();
  res.json({ offset });
}

// ── Per-Patient Billing ────────────────────────────────────────────────────

export async function getPatientBilling(req: Request, res: Response): Promise<void> {
  const summary = await getPatientBillingSummary(req.params.patientId);
  res.json(summary);
}

export async function setPatientCycle(req: Request, res: Response): Promise<void> {
  const { patientId }  = req.params;
  const profile        = req.profile!;
  const { cycle_start, consent_date, shipment_date } = req.body;

  if (!cycle_start) {
    res.status(400).json({ error: "cycle_start is required." });
    return;
  }

  const cycle = await upsertBillingCycle(
    patientId,
    cycle_start,
    { consent_date: consent_date ?? null, shipment_date: shipment_date ?? null },
    profile.id,
  );

  // Non-blocking re-evaluation so the caller doesn't have to wait
  evaluatePatientBilling(patientId).catch((err) =>
    console.warn("[billing] Re-evaluation after cycle update failed:", err),
  );

  res.json({ cycle });
}

// ── Manual evaluation trigger ──────────────────────────────────────────────

export async function triggerEvaluation(req: Request, res: Response): Promise<void> {
  const { patientId } = req.body;
  if (patientId) {
    await evaluatePatientBilling(patientId);
    res.json({ ok: true, scope: "patient", patientId });
  } else {
    // Full pipeline: refresh reading counts first, THEN evaluate billing.
    // This ensures the engine sees current reading data, not stale values.
    async function fullPipeline() {
      const { data: clinics } = await supabaseAdmin
        .from("clinics")
        .select("id, name, smartmeter_api_key");
      await syncReadingCounts((clinics ?? []) as any);
      await runBillingEvaluation();
      console.log("[billing] Manual re-evaluation complete.");
    }
    fullPipeline().catch(console.error);
    res.json({ ok: true, scope: "all", message: "Reading sync + billing evaluation started." });
  }
}
