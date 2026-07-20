import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import {
  getTenoviClientDevices, getTenoviBulkOrders,
  getTenoviDeviceTypes, createTenoviFulfillmentOrder,
  type TenoviFulfillmentBody,
} from "../services/tenovi";
import {
  getSmartMeterOrders, getSmartMeterSkus, createSmartMeterOrder,
  getSmartMeterActiveDevices, getSmartMeterDevicesForPatient,
  getSmartMeterReadingTypesForPatient,
  getSmartMeterPatientDevices, assignSmartMeterDevice, unassignSmartMeterDevice,
  type SmartMeterSku,
} from "../services/smartmeter";

// ── Unified types ──────────────────────────────────────────────────────────

export type UnifiedDevice = {
  id: string;
  serial: string;
  type: string;
  vendor: "SmartMeter" | "Tenovi";
  module: "RPM" | "RTM";
  status: string;
  patientName: string | null;
  patientExternalId: string | null;
  facilityName: string | null;
  lastMeasurement: string | null;
  connected: boolean | null;
  shippedDate: string | null;
};

export type UnifiedOrder = {
  id: string;
  orderNumber: string;
  source: "SmartMeter" | "Tenovi";
  status: string;
  statusRaw: string;
  patientName: string | null;
  clinicName: string | null;
  devices: string[];
  carrier: string | null;
  tracking: string | null;
  trackingLink: string | null;
  createdAt: string | null;
  shippedOn: string | null;
  deliveredOn: string | null;
  fulfilled: boolean;
};

// ── Device type normalisation ──────────────────────────────────────────────

function normalizeTenoviDeviceType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("bpm") || n.includes("blood pressure") || n.includes("bp monitor")) return "BP Monitor";
  if (n.includes("glucometer") || n.includes("glucose"))  return "Glucometer";
  if (n.includes("scale") || n.includes("weight"))        return "Scale";
  if (n.includes("pulse ox") || n.includes("spo2"))       return "Pulse Ox";
  if (n.includes("pillbox") || n.includes("patchcap") || n.includes("patch")) return "RTM Pillbox";
  if (n.includes("gateway"))                               return "Gateway";
  return name;
}

function normalizeSmDeviceType(model: string, lineName: string): string {
  const m = (model + " " + lineName).toLowerCase();
  if (m.includes("ibp") || m.includes("blood pressure")) return "BP Monitor";
  if (m.includes("iglucose") || m.includes("glucose"))   return "Glucometer";
  if (m.includes("scale") || m.includes("weight"))       return "Scale";
  if (m.includes("pulse") || m.includes("spo2"))         return "Pulse Ox";
  if (m.includes("gateway"))                             return "Gateway";
  if (m.includes("thermometer") || m.includes("temp"))   return "Thermometer";
  return model || "Device";
}

function readingTypeToDeviceType(readingType: string): string {
  const t = (readingType ?? "").toLowerCase();
  if (t.includes("bp") || t.includes("blood_pressure") || t.includes("blood pressure")) return "BP Monitor";
  if (t.includes("glucose") || t.includes("bg"))           return "Glucometer";
  if (t.includes("weight") || t.includes("scale"))         return "Scale";
  if (t.includes("spo2") || t.includes("pulse_ox") || t.includes("oxygen")) return "Pulse Ox";
  if (t.includes("temp"))                                   return "Thermometer";
  return readingType || "Device";
}

// ── Order status normalisation ─────────────────────────────────────────────

const TENOVI_BULK_STATUS: Record<string, string> = {
  DR: "Draft", RQ: "Requested", PE: "Pending",   CR: "Created",
  OH: "On Hold", RS: "Processing", SH: "Shipped", DE: "Delivered",
  DI: "Dispatched", UP: "Updated", CN: "Confirmed",
  RE: "Returned", RK: "Rerouted", CA: "Cancelled",
};

function normalizeTenoviStatus(raw: string): string {
  return TENOVI_BULK_STATUS[raw] ?? raw;
}

function mapSmOrderStatus(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("ship") || s.includes("transit"))  return "Shipped";
  if (s.includes("deliver"))                         return "Delivered";
  if (s.includes("active") || s.includes("complet")) return "Active";
  if (s.includes("cancel"))                          return "Cancelled";
  if (s.includes("pending") || s.includes("new"))   return "Pending";
  return raw ?? "Unknown";
}

// ── In-memory cache (avoids re-hitting external APIs on every page load) ──

let _devicesCache: { data: UnifiedDevice[]; expiry: number } | null = null;
let _ordersCache:  { data: UnifiedOrder[];  expiry: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Controllers ────────────────────────────────────────────────────────────

export async function getDevices(_req: Request, res: Response): Promise<void> {
  if (_devicesCache && Date.now() < _devicesCache.expiry) {
    res.json({ devices: _devicesCache.data, count: _devicesCache.data.length, cached: true });
    return;
  }

  const { data: clinics } = await supabaseAdmin.from("clinics").select("id, name, smartmeter_api_key");
  const allClinics = (clinics ?? []) as Array<{ id: string; name: string; smartmeter_api_key: string | null }>;
  const smClinics  = allClinics.filter((c) => c.smartmeter_api_key);

  // Build a map of SmartMeter patient_id → { name, clinicName } from our own DB
  // so we can label devices without extra API calls per patient.
  const { data: ourPatients } = await supabaseAdmin
    .from("patients")
    .select("external_patient_id, full_name, clinics(name)")
    .eq("source", "smartmeter");

  const smPatientMap = new Map<string, { name: string; clinicName: string | null }>();
  for (const p of (ourPatients ?? []) as any[]) {
    const clinicName = Array.isArray(p.clinics) ? (p.clinics[0]?.name ?? null) : (p.clinics?.name ?? null);
    smPatientMap.set(String(p.external_patient_id), { name: p.full_name, clinicName });
  }

  const [tenoviResult, patientDevicesResult, ...smActiveResults] = await Promise.allSettled([
    getTenoviClientDevices(),
    supabaseAdmin
      .from("patient_devices")
      .select("id, imei, device_name, device_model, vendor, assigned_at, patient_id, patients(full_name, clinics(name))")
      .is("unassigned_at", null),
    // Primary SM source: derive devices from readings (carries device_id per reading)
    ...smClinics.map((c) =>
      getSmartMeterActiveDevices(c.smartmeter_api_key!).then((active) => ({
        clinicId:   c.id,
        clinicName: c.name,
        active,
      })),
    ),
  ]);

  const devices: UnifiedDevice[] = [];
  const seenSerials = new Set<string>();

  // ── Tenovi ────────────────────────────────────────────────────────────────
  if (tenoviResult.status === "fulfilled") {
    for (const d of tenoviResult.value) {
      seenSerials.add(d.device.hardware_uuid);
      devices.push({
        id:                 d.id,
        serial:             d.device.hardware_uuid,
        type:               normalizeTenoviDeviceType(d.device.name),
        vendor:             "Tenovi",
        module:             d.module === "RTM" ? "RTM" : "RPM",
        status:             d.connected ? "connected" : "disconnected",
        patientName:        d.patient?.name ?? null,
        patientExternalId:  d.patient?.external_id ?? null,
        facilityName:       d.patient?.facility_name ?? null,
        lastMeasurement:    d.last_measurement ?? null,
        connected:          d.connected,
        shippedDate:        null,
      });
    }
  } else {
    console.warn("[devices] Tenovi fetch failed:", tenoviResult.reason);
  }

  // ── SmartMeter: readings-derived active devices (primary source) ──────────
  for (const result of smActiveResults) {
    if (result.status !== "fulfilled") {
      console.warn("[devices] SM readings fetch failed:", result.reason);
      continue;
    }
    const { clinicName, active } = result.value;
    for (const d of active) {
      if (seenSerials.has(d.deviceId)) continue;
      seenSerials.add(d.deviceId);
      const patient = smPatientMap.get(String(d.patientId));
      devices.push({
        id:                `sm-rdg-${d.deviceId}`,
        serial:            d.deviceId,
        type:              readingTypeToDeviceType(d.readingType),
        vendor:            "SmartMeter",
        module:            "RPM",
        status:            "active",
        patientName:       patient?.name ?? null,
        patientExternalId: String(d.patientId),
        facilityName:      patient?.clinicName ?? clinicName,
        lastMeasurement:   d.lastReading || null,
        connected:         null,
        shippedDate:       null,
      });
    }
  }

  // ── SmartMeter: patient_devices table (manually assigned, fills gaps) ─────
  if (patientDevicesResult.status === "fulfilled") {
    for (const row of (patientDevicesResult.value.data ?? []) as any[]) {
      if (row.vendor !== "SmartMeter") continue;
      if (seenSerials.has(row.imei)) continue;
      seenSerials.add(row.imei);
      const pat    = Array.isArray(row.patients) ? row.patients[0] : row.patients;
      const clinic = pat ? (Array.isArray(pat.clinics) ? pat.clinics[0] : pat.clinics) : null;
      devices.push({
        id:                `sm-pd-${row.id}`,
        serial:            row.imei as string,
        type:              normalizeSmDeviceType(row.device_model ?? "", row.device_name ?? ""),
        vendor:            "SmartMeter",
        module:            "RPM",
        status:            "active",
        patientName:       pat?.full_name ?? null,
        patientExternalId: row.patient_id ?? null,
        facilityName:      clinic?.name ?? null,
        lastMeasurement:   null,
        connected:         null,
        shippedDate:       row.assigned_at ?? null,
      });
    }
  } else {
    console.warn("[devices] patient_devices fetch failed:", (patientDevicesResult as PromiseRejectedResult).reason);
  }

  _devicesCache = { data: devices, expiry: Date.now() + CACHE_TTL_MS };
  res.json({ devices, count: devices.length, cached: false });
}

export async function getOrders(_req: Request, res: Response): Promise<void> {
  if (_ordersCache && Date.now() < _ordersCache.expiry) {
    res.json({ orders: _ordersCache.data, count: _ordersCache.data.length, cached: true });
    return;
  }

  const { data: clinics } = await supabaseAdmin.from("clinics").select("id, name, smartmeter_api_key");
  const allClinics = (clinics ?? []) as Array<{ id: string; name: string; smartmeter_api_key: string | null }>;
  const smClinics  = allClinics.filter((c) => c.smartmeter_api_key);

  const [tenoviResult, ...smResults] = await Promise.allSettled([
    getTenoviBulkOrders(),
    ...smClinics.map((c) =>
      getSmartMeterOrders(c.smartmeter_api_key!, 30).then((orders) => ({
        clinicId: c.id,
        clinicName: c.name,
        orders,
      })),
    ),
  ]);

  const orders: UnifiedOrder[] = [];

  // Tenovi bulk orders (HWI API)
  if (tenoviResult.status === "fulfilled") {
    for (const o of tenoviResult.value) {
      const deviceList = (o.contents ?? []).flatMap((c) =>
        Array.from({ length: c.quantity }, () => c.name),
      );
      orders.push({
        id:           o.id,
        orderNumber:  o.order_number,
        source:       "Tenovi",
        status:       normalizeTenoviStatus(o.shipping_status),
        statusRaw:    o.shipping_status,
        patientName:  o.shipping_name ?? null,
        clinicName:   null,
        devices:      deviceList,
        carrier:      null,
        tracking:     null,
        trackingLink: o.shipping_tracking_link ?? null,
        createdAt:    o.created ?? null,
        shippedOn:    o.shipped_on ?? null,
        deliveredOn:  o.delivered_on ?? null,
        fulfilled:    o.fulfilled,
      });
    }
  } else {
    console.warn("[orders] Tenovi bulk-orders fetch failed:", tenoviResult.reason);
  }

  // SmartMeter orders
  for (const result of smResults) {
    if (result.status !== "fulfilled") {
      console.warn("[orders] SmartMeter orders fetch failed:", result.reason);
      continue;
    }
    const { clinicName, orders: smOrders } = result.value;
    for (const o of smOrders) {
      const lines = o.lines ?? [];
      const deviceList = lines
        .map((l) => l.line_name ?? l.device_model ?? l.sku ?? "")
        .filter(Boolean);
      const tracking = lines.find((l) => l.tracking_number)?.tracking_number ?? null;
      orders.push({
        id:           String(o.id),
        orderNumber:  o.order_number,
        source:       "SmartMeter",
        status:       mapSmOrderStatus(o.status),
        statusRaw:    o.status ?? "",
        patientName:  o.customer_name ?? null,
        clinicName,
        devices:      deviceList,
        carrier:      o.carrier ?? null,
        tracking,
        trackingLink: null,
        createdAt:    o.date_created ?? null,
        shippedOn:    o.date_shipped ?? null,
        deliveredOn:  null,
        fulfilled:    !!(o.date_shipped),
      });
    }
  }

  // Newest first
  orders.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  _ordersCache = { data: orders, expiry: Date.now() + CACHE_TTL_MS };
  res.json({ orders, count: orders.length, cached: false });
}

export function invalidateDevicesCache(): void {
  _devicesCache = null;
  _ordersCache  = null;
}

// ── Device catalog ─────────────────────────────────────────────────────────

export type CatalogItem = {
  id: string;
  vendor: "SmartMeter" | "Tenovi";
  name: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  upFrontCost: string | null;
  shippingCost: string | null;
  monthlyCost: string | null;
  inStock: boolean;
  maxQty: number;
  deviceModels: string[];
  category: string;
};

type CatalogResp = { items: CatalogItem[]; smClinics: Array<{ id: string; name: string }> };
let _catalogCache: { data: CatalogResp; expiry: number } | null = null;

/** Reads the device catalog from the device_catalog table in Supabase. */
export async function getCatalog(_req: Request, res: Response): Promise<void> {
  if (_catalogCache && Date.now() < _catalogCache.expiry) {
    res.json(_catalogCache.data);
    return;
  }

  const [catalogResult, clinicsResult] = await Promise.allSettled([
    supabaseAdmin.from("device_catalog").select("*").order("vendor").order("name"),
    supabaseAdmin.from("clinics").select("id, name, smartmeter_api_key"),
  ]);

  if (catalogResult.status === "rejected") {
    console.error("[catalog] DB query failed:", catalogResult.reason);
    res.status(502).json({ error: "Failed to load device catalog from database." });
    return;
  }

  const rows = (catalogResult.value.data ?? []) as Array<{
    id: string; vendor: string; name: string; sku: string; description: string;
    image_url: string | null; up_front_cost: string | null; shipping_cost: string | null;
    monthly_cost: string | null; in_stock: boolean; max_qty: number;
    device_models: string[]; category: string;
  }>;

  const allClinics = clinicsResult.status === "fulfilled"
    ? ((clinicsResult.value.data ?? []) as Array<{ id: string; name: string; smartmeter_api_key: string | null }>)
    : [];
  const smClinics = allClinics.filter((c) => c.smartmeter_api_key);

  const items: CatalogItem[] = rows.map((row) => ({
    id:           row.id,
    vendor:       row.vendor as "SmartMeter" | "Tenovi",
    name:         row.name,
    sku:          row.sku,
    description:  row.description ?? "",
    imageUrl:     row.image_url ?? null,
    upFrontCost:  row.up_front_cost ?? null,
    shippingCost: row.shipping_cost ?? null,
    monthlyCost:  row.monthly_cost ?? null,
    inStock:      row.in_stock ?? true,
    maxQty:       row.max_qty ?? 10,
    deviceModels: row.device_models ?? [],
    category:     row.category ?? "",
  }));

  const data: CatalogResp = {
    items,
    smClinics: smClinics.map((c) => ({ id: c.id, name: c.name })),
  };
  _catalogCache = { data, expiry: Date.now() + CACHE_TTL_MS };
  res.json(data);
}

/**
 * Pulls device types from Tenovi and all SmartMeter clinic keys, deduplicates
 * by id, and upserts into device_catalog. Preserves any manually-set image_url
 * on rows that already exist in the DB.
 */
export async function syncDeviceCatalog(_req: Request, res: Response): Promise<void> {
  const { data: clinics } = await supabaseAdmin
    .from("clinics")
    .select("id, name, smartmeter_api_key");
  const allClinics = (clinics ?? []) as Array<{ id: string; name: string; smartmeter_api_key: string | null }>;
  const smClinics  = allClinics.filter((c) => c.smartmeter_api_key);

  // Fetch from all SM clinic keys in parallel; deduplicate by sku
  const smSkuResults = await Promise.allSettled(
    smClinics.map((c) => getSmartMeterSkus(c.smartmeter_api_key!)),
  );
  const seenSkus = new Set<string>();
  const mergedSmSkus: SmartMeterSku[] = [];
  for (const r of smSkuResults) {
    if (r.status === "fulfilled") {
      for (const sku of r.value) {
        if (!seenSkus.has(sku.sku)) {
          seenSkus.add(sku.sku);
          (mergedSmSkus as typeof r.value).push(sku);
        }
      }
    } else {
      console.warn("[sync] SmartMeter SKUs failed for a clinic:", r.reason);
    }
  }

  const [tenoviResult] = await Promise.allSettled([getTenoviDeviceTypes()]);

  // Fetch existing rows so we can preserve manually-set image_urls
  const { data: existingRows } = await supabaseAdmin
    .from("device_catalog")
    .select("id, image_url");
  const existingImageMap = new Map<string, string | null>(
    (existingRows ?? []).map((r: { id: string; image_url: string | null }) => [r.id, r.image_url]),
  );

  const now = new Date().toISOString();
  const rows: Array<{
    id: string; vendor: string; name: string; sku: string; description: string;
    image_url: string | null; up_front_cost: string | null; shipping_cost: string | null;
    monthly_cost: string | null; in_stock: boolean; max_qty: number;
    device_models: string[]; category: string; updated_at: string;
  }> = [];

  if (tenoviResult.status === "fulfilled") {
    for (const d of tenoviResult.value) {
      const existingImg = existingImageMap.get(d.id);
      rows.push({
        id:            d.id,
        vendor:        "Tenovi",
        name:          d.name,
        sku:           d.client_sku ?? d.name,
        description:   d.metrics.map((m) => m.primary_display_name).filter(Boolean).join(", ") || d.name,
        image_url:     existingImg !== undefined ? existingImg : (d.image ?? null),
        up_front_cost: d.up_front_cost ?? null,
        shipping_cost: d.shipping_cost ?? null,
        monthly_cost:  d.monthly_cost ?? null,
        in_stock:      d.in_stock,
        max_qty:       10,
        device_models: [],
        category:      "Tenovi",
        updated_at:    now,
      });
    }
  } else {
    console.warn("[sync] Tenovi device types failed:", tenoviResult.reason);
  }

  for (const s of mergedSmSkus) {
    if (!s.includes_device) continue;
    const id         = `sm-${s.sku}`;
    const existingImg = existingImageMap.get(id) ?? null;
    const categoryArr = Array.isArray(s.category) ? s.category : [];
    const primaryCat  = categoryArr.find((c) => c.is_primary) ?? categoryArr[0];
    rows.push({
      id,
      vendor:        "SmartMeter",
      name:          s.description || s.sku,
      sku:           s.sku,
      description:   Array.isArray(s.device_model) ? s.device_model.join(", ") : (s.description ?? ""),
      image_url:     existingImg,
      up_front_cost: null,
      shipping_cost: null,
      monthly_cost:  null,
      in_stock:      true,
      max_qty:       (s.max_order_quantity > 0) ? s.max_order_quantity : 10,
      device_models: Array.isArray(s.device_model) ? s.device_model : [],
      category:      primaryCat?.category_name ?? "SmartMeter",
      updated_at:    now,
    });
  }

  if (rows.length === 0) {
    res.status(502).json({ error: "No devices returned from either API." });
    return;
  }

  const { error } = await supabaseAdmin
    .from("device_catalog")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    console.error("[sync] upsert failed:", error);
    res.status(502).json({ error: error.message });
    return;
  }

  _catalogCache = null;
  res.json({
    synced:      rows.length,
    tenovi:      tenoviResult.status,
    smartmeter:  smSkuResults.every((r) => r.status === "fulfilled") ? "fulfilled" : "partial",
    sm_clinics:  smClinics.length,
  });
}

// ── Place SmartMeter order ─────────────────────────────────────────────────

export async function placeSmartMeterOrder(req: Request, res: Response): Promise<void> {
  const { clinicId, order, lines } = req.body as {
    clinicId: string;
    order: { order_number: string; customer_name: string; address1: string; address2?: string; city: string; state: string; zipcode: string; country?: string; shipping_method: string; po_number?: string };
    lines: Array<{ sku: string; quantity: number }>;
  };

  if (!clinicId || !order || !lines?.length) {
    res.status(400).json({ error: "clinicId, order, and lines are required." });
    return;
  }

  const { data: clinic } = await supabaseAdmin
    .from("clinics")
    .select("smartmeter_api_key")
    .eq("id", clinicId)
    .single();

  if (!(clinic as any)?.smartmeter_api_key) {
    res.status(422).json({ error: "Clinic does not have SmartMeter integration." });
    return;
  }

  try {
    const result = await createSmartMeterOrder((clinic as any).smartmeter_api_key, { order, lines });
    _ordersCache = null;
    res.json({ success: true, order: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
}

// ── Patient device assignment (Supabase-backed, IMEI-based) ───────────────
//
// SmartMeter's partner API does not expose a device-assignment endpoint —
// that feature only exists in their portal UI. We therefore track all
// IMEI assignments in the `patient_devices` Supabase table. This also
// enables the feature for Tenovi patients.

/** GET /api/devices/patient/:patientId/devices */
export async function getPatientDevices(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };

  // Lazy-sync SmartMeter readings into patient_devices so historical
  // assignments are visible without manual entry.
  const { data: patient } = await supabaseAdmin
    .from("patients")
    .select("source, external_patient_id, clinic_id, clinics(smartmeter_api_key)")
    .eq("id", patientId)
    .single();

  if ((patient as any)?.source === "smartmeter" && (patient as any)?.external_patient_id) {
    const clinicRow = Array.isArray((patient as any).clinics)
      ? (patient as any).clinics[0]
      : (patient as any).clinics;
    const apiKey: string | undefined = clinicRow?.smartmeter_api_key;

    if (apiKey) {
      const smPatientId = (patient as any).external_patient_id as string;

      // Step 1: Load currently active imeis once (shared by both sync paths)
      const { data: activeRows } = await supabaseAdmin
        .from("patient_devices")
        .select("imei")
        .eq("patient_id", patientId)
        .is("unassigned_at", null);
      const activeImeis = new Set((activeRows ?? []).map((r: any) => r.imei as string));

      // Step 2: Primary source — GET /api/patients/{id} returns the device list directly.
      // This avoids the /api/readings 500 error and gives accurate real IMEIs.
      const smDevices = await getSmartMeterPatientDevices(apiKey, smPatientId);
      for (const d of smDevices) {
        if (activeImeis.has(d.device_id)) continue;
        const { error: insertErr } = await supabaseAdmin.from("patient_devices").insert({
          patient_id:   patientId,
          imei:         d.device_id,
          device_name:  d.device_type ?? d.device_model ?? "SmartMeter Device",
          device_model: d.device_model ?? null,
          vendor:       "SmartMeter",
          notes:        "Auto-synced from SmartMeter",
          assigned_at:  d.date_added || new Date().toISOString(),
        });
        if (!insertErr) activeImeis.add(d.device_id);
        else console.warn("[devices] SM device sync insert failed:", insertErr.message);
      }

      // Step 3: Fallback — patient detail returned no devices, try orders for IMEI.
      if (smDevices.length === 0) {
        try {
          const fromOrders = await getSmartMeterDevicesForPatient(apiKey, smPatientId, 365);
          for (const d of fromOrders) {
            if (activeImeis.has(d.imei)) continue;
            const { error: insertErr } = await supabaseAdmin.from("patient_devices").insert({
              patient_id:   patientId,
              imei:         d.imei,
              device_name:  d.deviceName ?? d.deviceModel ?? "SmartMeter Device",
              device_model: d.deviceModel ?? null,
              vendor:       "SmartMeter",
              notes:        "Auto-synced from orders",
              assigned_at:  d.orderedAt || new Date().toISOString(),
            });
            if (!insertErr) activeImeis.add(d.imei);
            else console.warn("[devices] orders auto-sync insert failed:", insertErr.message);
          }
        } catch (e) {
          console.warn("[devices] orders fallback failed:", e);
        }
      }

      // Step 4: Final fallback — patient has readings but no device listed anywhere.
      // Create synthetic entries per reading type so the device is always visible.
      const stillNone = (
        await supabaseAdmin.from("patient_devices").select("id", { count: "exact" })
          .eq("patient_id", patientId).is("unassigned_at", null)
      ).count === 0;

      if (stillNone) {
        try {
          const readingTypes = await getSmartMeterReadingTypesForPatient(apiKey, smPatientId, 365);
          for (const rt of readingTypes) {
            const syntheticImei = `SM-${smPatientId}-${rt.readingType}`;
            if (activeImeis.has(syntheticImei)) continue;
            const { error: insertErr } = await supabaseAdmin.from("patient_devices").insert({
              patient_id:   patientId,
              imei:         syntheticImei,
              device_name:  readingTypeToDeviceType(rt.readingType),
              device_model: null,
              vendor:       "SmartMeter",
              notes:        "IMEI_UNKNOWN",
              assigned_at:  rt.lastReading || new Date().toISOString(),
            });
            if (!insertErr) activeImeis.add(syntheticImei);
            else console.warn("[devices] synthetic insert failed:", insertErr.message);
          }
        } catch (e) {
          console.warn("[devices] synthetic fallback failed:", e);
        }
      }
    }
  }

  const { data, error } = await supabaseAdmin
    .from("patient_devices")
    .select("*")
    .eq("patient_id", patientId)
    .is("unassigned_at", null)
    .order("assigned_at", { ascending: false });

  if (error) {
    res.status(502).json({ error: error.message });
    return;
  }
  res.json({ devices: data ?? [] });
}

/** POST /api/devices/patient/:patientId/assign  body: { imei, deviceName?, deviceModel?, vendor?, notes? } */
export async function assignPatientDevice(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };
  const { imei, deviceName, deviceModel, vendor, notes } = req.body as {
    imei?: string;
    deviceName?: string;
    deviceModel?: string;
    vendor?: string;
    notes?: string;
  };

  if (!imei?.trim()) {
    res.status(400).json({ error: "imei is required." });
    return;
  }

  // Verify patient exists
  const { data: patient } = await supabaseAdmin
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .single();
  if (!patient) {
    res.status(404).json({ error: "Patient not found." });
    return;
  }

  // If this IMEI is currently assigned to another patient, surface a clear error
  const { data: conflict } = await supabaseAdmin
    .from("patient_devices")
    .select("patient_id")
    .eq("imei", imei.trim())
    .is("unassigned_at", null)
    .neq("patient_id", patientId)
    .maybeSingle();

  if (conflict) {
    res.status(409).json({
      error: "This IMEI is already assigned to another patient. Remove it from the current patient first.",
    });
    return;
  }

  const userId = (req as any).user?.id ?? null;
  const { data: row, error } = await supabaseAdmin
    .from("patient_devices")
    .insert({
      patient_id:          patientId,
      imei:                imei.trim(),
      device_name:         deviceName?.trim() ?? null,
      device_model:        deviceModel?.trim() ?? null,
      vendor:              vendor?.trim() ?? "SmartMeter",
      notes:               notes?.trim() ?? null,
      assigned_by_user_id: userId,
    })
    .select()
    .single();

  if (error) {
    res.status(502).json({ error: error.message });
    return;
  }

  // Mirror the assignment in SmartMeter (best-effort, doesn't fail the request)
  const { data: patientFull } = await supabaseAdmin
    .from("patients")
    .select("source, external_patient_id, clinic_id, clinics(smartmeter_api_key)")
    .eq("id", patientId)
    .single();
  if ((patientFull as any)?.source === "smartmeter" && (patientFull as any)?.external_patient_id) {
    const clinicRow = Array.isArray((patientFull as any).clinics)
      ? (patientFull as any).clinics[0] : (patientFull as any).clinics;
    const apiKey: string | undefined = clinicRow?.smartmeter_api_key;
    if (apiKey) {
      await assignSmartMeterDevice(apiKey, (patientFull as any).external_patient_id, imei.trim());
    }
  }

  res.json({ success: true, device: row });
}

/**
 * GET /api/devices/patient/:patientId/detect-imeis
 * Scans the last 180 days of SmartMeter orders for this patient's customer_id
 * and returns IMEIs that are not already actively assigned in patient_devices.
 */
export async function detectPatientImeis(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };

  const { data: patient } = await supabaseAdmin
    .from("patients")
    .select("clinic_id, external_patient_id, source")
    .eq("id", patientId)
    .single();

  if (!patient || (patient as any).source !== "smartmeter") {
    res.json({ detected: [] });
    return;
  }

  const smPatientId = (patient as any).external_patient_id as string;

  const { data: clinic } = await supabaseAdmin
    .from("clinics")
    .select("smartmeter_api_key")
    .eq("id", (patient as any).clinic_id)
    .single();

  const apiKey = (clinic as any)?.smartmeter_api_key as string | undefined;
  if (!apiKey) {
    res.json({ detected: [] });
    return;
  }

  // Fetch already-assigned IMEIs so we can filter them out
  const { data: activeRows } = await supabaseAdmin
    .from("patient_devices")
    .select("imei")
    .eq("patient_id", patientId)
    .is("unassigned_at", null);
  const activeImeis = new Set((activeRows ?? []).map((r: any) => r.imei as string));

  try {
    const all = await getSmartMeterDevicesForPatient(apiKey, smPatientId, 180);
    const detected = all.filter((d) => !activeImeis.has(d.imei));
    res.json({ detected });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
}

/** DELETE /api/devices/patient/:patientId/unassign  body: { imei: string } */
export async function unassignPatientDevice(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };
  const { imei } = req.body as { imei?: string };

  if (!imei?.trim()) {
    res.status(400).json({ error: "imei is required." });
    return;
  }

  const { error } = await supabaseAdmin
    .from("patient_devices")
    .update({ unassigned_at: new Date().toISOString() })
    .eq("patient_id", patientId)
    .eq("imei", imei.trim())
    .is("unassigned_at", null);

  if (error) {
    res.status(502).json({ error: error.message });
    return;
  }

  // Mirror the removal in SmartMeter (best-effort, skip synthetic IMEIs)
  const isSynthetic = /^SM-\d+-/.test(imei.trim());
  if (!isSynthetic) {
    const { data: patientFull } = await supabaseAdmin
      .from("patients")
      .select("source, external_patient_id, clinic_id, clinics(smartmeter_api_key)")
      .eq("id", patientId)
      .single();
    if ((patientFull as any)?.source === "smartmeter" && (patientFull as any)?.external_patient_id) {
      const clinicRow = Array.isArray((patientFull as any).clinics)
        ? (patientFull as any).clinics[0] : (patientFull as any).clinics;
      const apiKey: string | undefined = clinicRow?.smartmeter_api_key;
      if (apiKey) {
        await unassignSmartMeterDevice(apiKey, (patientFull as any).external_patient_id, imei.trim());
      }
    }
  }

  res.json({ success: true });
}

// ── Place Tenovi fulfillment order ─────────────────────────────────────────

export async function placeTenoviOrder(req: Request, res: Response): Promise<void> {
  const body = req.body as TenoviFulfillmentBody;

  if (!body?.device?.name) {
    res.status(400).json({ error: "device.name is required." });
    return;
  }

  try {
    const result = await createTenoviFulfillmentOrder(body);
    _ordersCache = null;
    res.json({ success: true, device: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
}
