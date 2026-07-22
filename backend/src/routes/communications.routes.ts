import { Router } from "express";
import {
  listCommunications,
  createCommunication,
  getVoiceToken,
  getInboundToken,
  sendSmsHandler,
  twimlVoiceWebhook,
  inboundSmsWebhook,
  recordingStatusCallback,
  dialStatusCallback,
  outboundDialStatusCallback,
  voiceFallbackWebhook,
  markRead,
  getUnreadCounts,
  callAccepted,
} from "../controllers/communications.controller";
import { requireAuth, requireRole } from "../middleware/auth.middleware";

export const communicationsRouter = Router();

const staff = requireRole("super_admin", "clinic_admin", "staff");

communicationsRouter.get("/",       requireAuth, staff, listCommunications);
communicationsRouter.post("/",      requireAuth, staff, createCommunication);
communicationsRouter.get("/token",          requireAuth, staff, getVoiceToken);
communicationsRouter.get("/inbound-token",  requireAuth, staff, getInboundToken);
communicationsRouter.post("/sms",       requireAuth, staff, sendSmsHandler);
communicationsRouter.post("/mark-read", requireAuth, staff, markRead);
communicationsRouter.post("/call-accepted", requireAuth, staff, callAccepted);
communicationsRouter.get("/unread",     requireAuth, staff, getUnreadCounts);
// Public — Twilio calls these webhooks with no auth header
communicationsRouter.post("/twiml",              twimlVoiceWebhook);
communicationsRouter.post("/inbound-sms",        inboundSmsWebhook);
communicationsRouter.post("/recording-status",   recordingStatusCallback);
communicationsRouter.post("/dial-status",        dialStatusCallback);
communicationsRouter.post("/outbound-dial-status", outboundDialStatusCallback);
communicationsRouter.post("/voice-fallback",        voiceFallbackWebhook);
