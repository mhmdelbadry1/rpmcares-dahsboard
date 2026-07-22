import { Router } from "express";
import {
  inviteMember,
  listAuditLog,
  listMembers,
  removeMember,
  resetPassword,
  suspendMember,
  unsuspendMember,
  updateMember,
} from "../controllers/admin.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("super_admin", "clinic_admin"));

adminRouter.get("/members",                    listMembers);
adminRouter.post("/members/invite",            inviteMember);
adminRouter.patch("/members/:id",              updateMember);
adminRouter.delete("/members/:id",             removeMember);
adminRouter.post("/members/:id/reset-password", resetPassword);
adminRouter.post("/members/:id/suspend",       suspendMember);
adminRouter.post("/members/:id/unsuspend",     unsuspendMember);
adminRouter.get("/audit-log",                  listAuditLog);
