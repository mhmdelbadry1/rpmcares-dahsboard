import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import { getPatientReport, getClinicReport, getMonthlyReport } from "../controllers/reports.controller";

export const reportsRouter = Router();

reportsRouter.get(
  "/patient/:patientId",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getPatientReport,
);

reportsRouter.get(
  "/clinic/:clinicId",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  getClinicReport,
);

reportsRouter.get(
  "/monthly",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  getMonthlyReport,
);
