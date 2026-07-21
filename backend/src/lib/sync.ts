import { supabaseAdmin } from "./supabase";
import { getTenoviSummary, getTenoviReadingsByFacility, listAllTenoviPatients } from "../services/tenovi";
import { getSmartMeterSummary, listSmartMeterPatients, getSmartMeterReadingsByPatient } from "../services/smartmeter";
import { upsertPatientCycleStats } from "../models/billing";

type ClinicRow = { id: string; name: string; smartmeter_api_key: string | null };

// Strip common legal suffixes so "Awesome Care" matches "Awesome Care Clinics"
// and "Advanced Care and Wellness Center" matches "…Center LLC".
function normalizeFacilityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[,.]?\s*(pllc|llc|inc|pa|pc|md|dba|clinics|clinic)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findClinicId(
  facilityName: string,
  exactMap: Map<string, string>,
  normalizedMap: Map<string, string>,
): string | undefined {
  // 1. Exact (case-insensitive)
  const key = facilityName.toLowerCase().trim();
  if (exactMap.has(key)) return exactMap.get(key);

  // 2. After stripping legal suffixes from both sides
  const normKey = normalizeFacilityName(facilityName);
  if (normalizedMap.has(normKey)) return normalizedMap.get(normKey);

  // 3. Prefix match — one name starts with the other (handles "Awesome Care" ↔ "Awesome Care Clinics")
  for (const [dbKey, id] of exactMap) {
    if (key.startsWith(dbKey) || dbKey.startsWith(key)) return id;
  }

  return undefined;
}

// ── Patient roster sync ────────────────────────────────────────────────────

async function syncPatients(clinics: ClinicRow[]): Promise<void> {
  console.log("[sync:patients] Starting patient roster sync…");

  const exactMap = new Map(clinics.map((c) => [c.name.toLowerCase().trim(), c.id]));
  const normalizedMap = new Map(clinics.map((c) => [normalizeFacilityName(c.name), c.id]));

  const smClinics = clinics.filter(
    (c): c is { id: string; name: string; smartmeter_api_key: string } =>
      typeof c.smartmeter_api_key === "string" && c.smartmeter_api_key.length > 0,
  );

  let skipped = 0;

  const [tenoviResult, smGroupResult] = await Promise.allSettled([
    listAllTenoviPatients(),
    Promise.allSettled(
      smClinics.map(async (c) => ({
        clinicId: c.id,
        patients: await listSmartMeterPatients(c.smartmeter_api_key),
      })),
    ),
  ]);

  if (tenoviResult.status === "rejected")
    console.warn("[sync:patients] Tenovi fetch failed:", tenoviResult.reason);
  if (smGroupResult.status === "rejected")
    console.warn("[sync:patients] SmartMeter fetch failed:", smGroupResult.reason);

  const rows: Record<string, unknown>[] = [];

  // Tenovi status codes (AC/PE/HO/DI/DE) → enrollment_status enum
  const TENOVI_STATUS_MAP: Record<string, string> = {
    AC: "active",
    PE: "pending",
    HO: "inactive",     // Hold → inactive
    DI: "disenrolled",  // Discharged
    DE: "disenrolled",  // Declined
  };

  if (tenoviResult.status === "fulfilled") {
    for (const { facilityName, patients } of tenoviResult.value) {
      const clinicId = findClinicId(facilityName, exactMap, normalizedMap);
      if (!clinicId) {
        if (patients.length > 0) {
          console.warn(`[sync:patients] No DB clinic matched Tenovi facility "${facilityName}" — ${patients.length} patients skipped`);
        }
        skipped += patients.length;
        continue;
      }

      for (const en of patients) {
        const module   = en.patient.devices?.[0]?.module ?? "RPM";
        const diagnoses = en.health_condition ? [en.health_condition] : [];
        const enrollmentStatus = TENOVI_STATUS_MAP[en.status] ?? "inactive";
        const phoneValue = en.patient.phone_number || null;
        const row: Record<string, unknown> = {
          source:              "tenovi",
          external_patient_id: en.patient.id,
          clinic_id:           clinicId,
          full_name:           en.patient.name || "Unknown",
          program:             module === "RTM" ? "RTM" : "RPM",
          diagnoses,
          enrollment_status:   enrollmentStatus,
          consent:             true,
          risk:                "low",
          language:            "EN",
        };
        if (phoneValue) row.phone = phoneValue;
        rows.push(row);
      }
    }
  }

  if (smGroupResult.status === "fulfilled") {
    for (const r of smGroupResult.value) {
      if (r.status === "rejected") {
        console.warn("[sync:patients] SmartMeter clinic failed:", r.reason);
        continue;
      }
      const { clinicId, patients } = r.value;
      for (const p of patients) {
        const diagnoses   = p.primary_diagnosis ? [p.primary_diagnosis] : [];
        const phoneValue  = p.phone || p.mobile_phone || p.cell_phone || null;
        const row: Record<string, unknown> = {
          source:              "smartmeter",
          external_patient_id: String(p.patient_id),
          clinic_id:           clinicId,
          full_name:           [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "Unknown",
          dob:                 p.dob || null,
          sex:                 p.sex || null,
          language:            p.language || "EN",
          insurance_payer:     p.insurance_type || null,
          program:             "RPM",
          diagnoses,
          enrollment_status:   "active",
          consent:             true,
          risk:                "low",
        };
        // Only include phone in the upsert when the API returns one.
        // If null, omit the key entirely so the DB retains whatever it already has.
        if (phoneValue) row.phone = phoneValue;
        rows.push(row);
      }
    }
  }

  if (rows.length === 0) {
    console.log("[sync:patients] No patients to sync.");
    return;
  }

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from("patients")
      .upsert(chunk, { onConflict: "source,external_patient_id" });
    if (error) {
      console.error(`[sync:patients] Chunk ${i} failed:`, error.message);
    } else {
      upserted += chunk.length;
    }
  }

  console.log(`[sync:patients] ${upserted} / ${rows.length} patients upserted. ${skipped} skipped (no matching clinic).`);
}

// ── Reading counts sync (populates patient_cycle_stats for billing engine) ─

export async function syncReadingCounts(clinics: ClinicRow[]): Promise<void> {
  const now     = new Date();
  const y       = now.getFullYear();
  const m       = now.getMonth() + 1; // 1-based
  const lastDay = new Date(y, m, 0).getDate(); // last day of month (local)
  // Build date strings directly — never use toISOString() on a midnight local Date
  // because UTC conversion shifts it to the previous day in UTC+ timezones.
  const cycleStartStr = `${y}-${String(m).padStart(2, "0")}-01`;
  const cycleEndStr   = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // ── SmartMeter clinics ────────────────────────────────────────────────────
  const smClinics = clinics.filter(
    (c): c is { id: string; name: string; smartmeter_api_key: string } =>
      typeof c.smartmeter_api_key === "string" && c.smartmeter_api_key.length > 0,
  );

  for (const clinic of smClinics) {
    try {
      const readingMap = await getSmartMeterReadingsByPatient(clinic.smartmeter_api_key);
      if (readingMap.size === 0) continue;

      const smIds = [...readingMap.keys()].map(String);
      const { data: patients } = await supabaseAdmin
        .from("patients")
        .select("id, external_patient_id")
        .eq("source", "smartmeter")
        .eq("clinic_id", clinic.id)
        .in("external_patient_id", smIds);

      if (!patients || patients.length === 0) continue;

      const statsRows = patients.map((p) => ({
        patient_id:      p.id,
        cycle_start:     cycleStartStr,
        cycle_end:       cycleEndStr,
        reading_count:   readingMap.get(parseInt(p.external_patient_id)) ?? 0,
        monitoring_days: readingMap.get(parseInt(p.external_patient_id)) ?? 0,
        source:          "smartmeter",
        synced_at:       now.toISOString(),
      }));

      await upsertPatientCycleStats(statsRows);
      console.log(`[sync:billing] ${clinic.name}: ${statsRows.length} reading stats updated`);
    } catch (err) {
      console.warn(`[sync:billing] SmartMeter reading sync failed for ${clinic.name}:`, err);
    }
  }

  // ── Tenovi clinics ────────────────────────────────────────────────────────
  try {
    const exactMap      = new Map(clinics.map((c) => [c.name.toLowerCase().trim(), c.id]));
    const normalizedMap = new Map(clinics.map((c) => [normalizeFacilityName(c.name), c.id]));

    const facilityGroups = await getTenoviReadingsByFacility();

    for (const group of facilityGroups) {
      const clinicId = findClinicId(group.facilityName, exactMap, normalizedMap);
      if (!clinicId || group.patients.length === 0) continue;

      const externalIds = group.patients.map((p) => p.externalId);
      const { data: dbPatients } = await supabaseAdmin
        .from("patients")
        .select("id, external_patient_id")
        .eq("source", "tenovi")
        .eq("clinic_id", clinicId)
        .in("external_patient_id", externalIds);

      if (!dbPatients || dbPatients.length === 0) continue;

      const idMap = new Map(dbPatients.map((p) => [p.external_patient_id, p.id]));
      const matched = group.patients.filter((p) => idMap.has(p.externalId));

      const statsRows = matched.map((p) => ({
        patient_id:      idMap.get(p.externalId)!,
        cycle_start:     cycleStartStr,
        cycle_end:       cycleEndStr,
        reading_count:   p.readingCount,
        monitoring_days: p.readingCount,
        source:          "tenovi",
        synced_at:       now.toISOString(),
      }));

      if (statsRows.length === 0) continue;
      await upsertPatientCycleStats(statsRows);

      // Save Tenovi's monthly review time into patient_review_times so billing
      // and report queries pick it up alongside manual time_logs entries.
      const reviewPatientIds = matched
        .filter((p) => p.reviewSeconds > 0)
        .map((p) => idMap.get(p.externalId)!);

      if (reviewPatientIds.length > 0) {
        // Delete stale Tenovi sync records for this cycle before re-inserting
        await supabaseAdmin
          .from("patient_review_times")
          .delete()
          .in("patient_id", reviewPatientIds)
          .eq("source", "tenovi_sync");

        const reviewRows = matched
          .filter((p) => p.reviewSeconds > 0)
          .map((p) => ({
            patient_id:       idMap.get(p.externalId)!,
            clock_start:      `${cycleStartStr}T00:00:00+00:00`,
            duration_seconds: p.reviewSeconds,
            source:           "tenovi_sync",
            synced_at:        now.toISOString(),
          }));

        await supabaseAdmin.from("patient_review_times").insert(reviewRows);
      }

      console.log(`[sync:billing] Tenovi ${group.facilityName}: ${statsRows.length} reading stats, ${reviewPatientIds.length} review times updated`);
    }
  } catch (err) {
    console.warn("[sync:billing] Tenovi reading sync failed:", err);
  }
}

// ── Main sync ──────────────────────────────────────────────────────────────

export async function runSync(): Promise<void> {
  console.log("[sync] Starting background sync…");
  const start = Date.now();

  const { data, error: dbErr } = await supabaseAdmin
    .from("clinics")
    .select("id, name, smartmeter_api_key");

  if (dbErr) {
    console.error("[sync] Failed to load clinics:", dbErr.message);
    return;
  }

  const allClinics = (data as ClinicRow[]) ?? [];
  const smClinics  = allClinics
    .filter((r): r is { id: string; name: string; smartmeter_api_key: string } =>
      typeof r.smartmeter_api_key === "string" && r.smartmeter_api_key.length > 0,
    )
    .map((r) => ({ name: r.name, apiKey: r.smartmeter_api_key }));

  const [tenoviResult, smartmeterResult, patientSyncResult] = await Promise.allSettled([
    getTenoviSummary(),
    getSmartMeterSummary(smClinics),
    syncPatients(allClinics),
  ]);

  if (tenoviResult.status    === "rejected") console.error("[sync] Tenovi dashboard failed:",   tenoviResult.reason);
  if (smartmeterResult.status === "rejected") console.error("[sync] SmartMeter dashboard failed:", smartmeterResult.reason);
  if (patientSyncResult.status === "rejected") console.error("[sync] Patient sync failed:",      patientSyncResult.reason);

  if (tenoviResult.status === "rejected" && smartmeterResult.status === "rejected") {
    console.error("[sync] Both dashboard sources failed — cache unchanged");
    return;
  }

  const tenovi     = tenoviResult.status     === "fulfilled" ? tenoviResult.value     : {};
  const smartmeter = smartmeterResult.status === "fulfilled" ? smartmeterResult.value : {};

  const { error: upsertErr } = await supabaseAdmin
    .from("dashboard_cache")
    .upsert(
      { id: 1, tenovi, smartmeter, synced_at: new Date().toISOString() },
      { onConflict: "id" },
    );

  if (upsertErr) {
    if (upsertErr.code === "42P01") {
      console.error(
        "[sync] dashboard_cache table not found.\n" +
          "       Run: backend/src/migrations/001_dashboard_cache.sql in Supabase SQL Editor",
      );
    } else {
      console.error("[sync] Cache write failed:", upsertErr.message);
    }
  } else {
    console.log(`[sync] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  // Only sync reading counts — billing evaluation is intentionally NOT run
  // automatically here. Billing records must remain stable so the queue
  // doesn't change between page loads. Admins trigger evaluation manually
  // via the "Re-evaluate" button in the billing UI.
  if (patientSyncResult.status === "fulfilled") {
    syncReadingCounts(allClinics).catch((err) =>
      console.warn("[sync:billing] Reading count sync failed:", err),
    );
  }
}
