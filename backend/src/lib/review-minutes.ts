import { supabaseAdmin } from "./supabase";

async function fetchAllRows(
  table: "time_logs" | "patient_review_times",
  batch: string[],
  dateCol: string,
  rangeMin: string,
  rangeMax: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin
      .from(table)
      .select(`patient_id, duration_seconds, ${dateCol}`)
      .in("patient_id", batch)
      .gte(dateCol, rangeMin)
      .lte(dateCol, `${rangeMax}T23:59:59`)
      .range(from, from + 999);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

/**
 * Returns a map of patient_id → [{date: 'YYYY-MM-DD', secs: number}]
 * combining time_logs (manual staff) and patient_review_times (SmartMeter/Tenovi).
 * Batches patient IDs to stay within Supabase URL limits, and paginates each
 * batch to bypass the 1000-row PostgREST cap.
 */
export async function fetchReviewMinutesMap(
  patientIds: string[],
  rangeMin: string,  // 'YYYY-MM-DD'
  rangeMax: string,  // 'YYYY-MM-DD'
): Promise<Map<string, Array<{ date: string; secs: number }>>> {
  const map = new Map<string, Array<{ date: string; secs: number }>>();
  if (patientIds.length === 0) return map;

  const BATCH = 100; // smaller batch so each paginated query stays fast

  for (let i = 0; i < patientIds.length; i += BATCH) {
    const batch = patientIds.slice(i, i + BATCH);

    const [tlRows, rtRows] = await Promise.all([
      fetchAllRows("time_logs",            batch, "logged_at",   rangeMin, rangeMax),
      fetchAllRows("patient_review_times", batch, "clock_start", rangeMin, rangeMax),
    ]);

    for (const row of tlRows) {
      const date = (row.logged_at as string).slice(0, 10);
      if (!map.has(row.patient_id)) map.set(row.patient_id, []);
      map.get(row.patient_id)!.push({ date, secs: row.duration_seconds ?? 0 });
    }
    for (const row of rtRows) {
      const date = (row.clock_start as string).slice(0, 10);
      if (!map.has(row.patient_id)) map.set(row.patient_id, []);
      map.get(row.patient_id)!.push({ date, secs: row.duration_seconds ?? 0 });
    }
  }

  return map;
}

export function minutesFromMap(
  map: Map<string, Array<{ date: string; secs: number }>>,
  patientId: string,
  cycleStart: string,
  cycleEnd: string,
): number {
  const entries = map.get(patientId) ?? [];
  const totalSecs = entries
    .filter(e => e.date >= cycleStart && e.date <= cycleEnd)
    .reduce((s, e) => s + e.secs, 0);
  return Math.floor(totalSecs / 60);
}
