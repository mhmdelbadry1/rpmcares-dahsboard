/**
 * Integration test: verifies that a staff or clinic_admin user only receives
 * data for their own clinic from GET /api/dashboard/summary.
 *
 * Usage:
 *   npx tsx tests/dashboard-isolation.ts
 *
 * Required env vars (add to backend/.env or pass inline):
 *   TEST_API_URL          — default: http://localhost:4000
 *   TEST_STAFF_EMAIL      — email of a staff or clinic_admin account
 *   TEST_STAFF_PASSWORD   — that account's password
 *   TEST_STAFF_CLINIC_NAME — (optional) exact clinic name to assert on
 *
 *   TEST_ADMIN_EMAIL      — (optional) super_admin email for the cross-check
 *   TEST_ADMIN_PASSWORD   — (optional) super_admin password
 */

import "dotenv/config";

const BASE = process.env.TEST_API_URL ?? "http://localhost:4000";

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

type LoginPayload = { token: string; user: { role: string; clinicId: string | null } };

async function login(email: string, password: string): Promise<LoginPayload> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${(body as { error?: string }).error ?? "unknown"}`);
  }
  return res.json() as Promise<LoginPayload>;
}

async function getDashboard(token: string) {
  const res = await fetch(`${BASE}/api/dashboard/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Dashboard call failed (${res.status}): ${(body as { error?: string }).error ?? "unknown"}`);
  }
  return res.json() as Promise<{ smartmeter: { clinicBreakdown: { name: string }[] } }>;
}

// ── tests ────────────────────────────────────────────────────────────────────

async function testUnauthenticated() {
  console.log("\n[1] Unauthenticated request is rejected");
  const res = await fetch(`${BASE}/api/dashboard/summary`);
  if (res.status === 401) {
    pass("Returns 401 without a token");
  } else {
    fail("Should have returned 401", `Got ${res.status}`);
  }
}

async function testStaffIsolation(email: string, password: string, expectedClinicName?: string) {
  console.log(`\n[2] Staff/clinic_admin only sees their own clinic`);

  const { token, user } = await login(email, password);
  console.log(`    Logged in as ${user.role}, clinic_id: ${user.clinicId ?? "none"}`);

  if (user.role === "super_admin") {
    fail("This account is super_admin — use a staff or clinic_admin account for this test");
    return;
  }

  const data = await getDashboard(token);
  const breakdown = data.smartmeter?.clinicBreakdown ?? [];
  console.log(`    clinicBreakdown has ${breakdown.length} entry/entries`);

  if (breakdown.length === 0) {
    pass("No cross-clinic data returned (clinic may not have a SmartMeter key configured)");
    console.log("    Set TEST_STAFF_CLINIC_NAME and ensure the clinic has a smartmeter_api_key to fully verify.");
    return;
  }

  if (breakdown.length > 1) {
    fail(
      `Isolation failure: ${breakdown.length} clinics returned for a non-admin user`,
      breakdown.map((c) => `  · ${c.name}`).join("\n    "),
    );
    return;
  }

  pass("Exactly one clinic returned for staff user");

  if (expectedClinicName) {
    if (breakdown[0].name === expectedClinicName) {
      pass(`Returned clinic matches expected: "${expectedClinicName}"`);
    } else {
      fail(
        `Wrong clinic returned`,
        `Expected "${expectedClinicName}", got "${breakdown[0].name}"`,
      );
    }
  }
}

async function testSuperAdminSeesAll(email: string, password: string) {
  console.log(`\n[3] Super admin sees all clinics`);

  const { token, user } = await login(email, password);
  if (user.role !== "super_admin") {
    console.log(`    Skipped — account is ${user.role}, not super_admin`);
    return;
  }

  const data = await getDashboard(token);
  const count = data.smartmeter?.clinicBreakdown?.length ?? 0;

  if (count > 0) {
    pass(`Super admin receives ${count} clinic(s) in breakdown`);
  } else {
    console.log("    Super admin got 0 clinics — may be correct if no clinics have SmartMeter keys.");
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const staffEmail = process.env.TEST_STAFF_EMAIL;
  const staffPassword = process.env.TEST_STAFF_PASSWORD;

  if (!staffEmail || !staffPassword) {
    console.error("Required: TEST_STAFF_EMAIL and TEST_STAFF_PASSWORD");
    process.exit(1);
  }

  console.log(`Running dashboard isolation tests against ${BASE}\n`);

  await testUnauthenticated();
  await testStaffIsolation(staffEmail, staffPassword, process.env.TEST_STAFF_CLINIC_NAME);

  const adminEmail = process.env.TEST_ADMIN_EMAIL;
  const adminPassword = process.env.TEST_ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    await testSuperAdminSeesAll(adminEmail, adminPassword);
  } else {
    console.log("\n[3] Super admin visibility check — skipped (set TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD to enable)");
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
