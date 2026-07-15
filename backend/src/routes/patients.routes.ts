import { Router } from "express";
import { list, getOne, enroll, remove, getSystemClinics, getReadings, getPatientAlerts, getReviewTime, deleteReviewTime, logManualReview, logProfileView } from "../controllers/patients.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

export const patientsRouter = Router();

// Static routes before /:id
patientsRouter.get(
  "/system-clinics",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  getSystemClinics,
);
patientsRouter.post(
  "/enroll",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  enroll,
);
patientsRouter.get(
  "/",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  list,
);
patientsRouter.get(
  "/:id",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getOne,
);
patientsRouter.delete(
  "/:id",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  remove,
);
patientsRouter.get(
  "/:id/readings",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getReadings,
);
patientsRouter.get(
  "/:id/alerts",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getPatientAlerts,
);
patientsRouter.get(
  "/:id/review-time",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getReviewTime,
);
patientsRouter.delete(
  "/:id/review-time/:entryId",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  deleteReviewTime,
);
patientsRouter.post(
  "/:id/review-time/manual",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  logManualReview,
);
patientsRouter.post(
  "/:id/review-time/profile-view",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  logProfileView,
);
