import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import {
  getDevices, getOrders, getCatalog, syncDeviceCatalog,
  placeSmartMeterOrder, placeTenoviOrder,
  getPatientDevices, assignPatientDevice, unassignPatientDevice, detectPatientImeis,
} from "../controllers/devices.controller";

export const devicesRouter = Router();

devicesRouter.get(
  "/",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getDevices,
);

devicesRouter.get(
  "/orders",
  requireAuth,
  requireRole("super_admin", "clinic_admin", "staff"),
  getOrders,
);

devicesRouter.get("/catalog", requireAuth, requireRole("super_admin", "clinic_admin", "staff"), getCatalog);
devicesRouter.post("/catalog/sync", requireAuth, requireRole("super_admin"), syncDeviceCatalog);
devicesRouter.post("/orders/smartmeter", requireAuth, requireRole("super_admin", "clinic_admin"), placeSmartMeterOrder);
devicesRouter.post("/orders/tenovi", requireAuth, requireRole("super_admin", "clinic_admin"), placeTenoviOrder);

// Patient device assignment (SmartMeter IMEI)
devicesRouter.get("/patient/:patientId/devices",       requireAuth, requireRole("super_admin", "clinic_admin", "staff"), getPatientDevices);
devicesRouter.get("/patient/:patientId/detect-imeis",  requireAuth, requireRole("super_admin", "clinic_admin", "staff"), detectPatientImeis);
devicesRouter.post("/patient/:patientId/assign",       requireAuth, requireRole("super_admin", "clinic_admin"), assignPatientDevice);
devicesRouter.delete("/patient/:patientId/unassign",   requireAuth, requireRole("super_admin", "clinic_admin"), unassignPatientDevice);
