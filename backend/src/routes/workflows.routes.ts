import { Router } from "express";
import { getWorkflows, setReviewMode } from "../controllers/workflows.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

export const workflowsRouter = Router();

workflowsRouter.get(
  "/",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getWorkflows,
);

workflowsRouter.put(
  "/:clinicId/review-mode",
  requireAuth,
  requireRole("super_admin", "clinic_admin"),
  setReviewMode,
);
