import twilio from "twilio";
import { env } from "../env";

function getClient() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN)
    throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)");
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

// Generates a short-lived Access Token for the browser Twilio Voice SDK.
// Requires TWILIO_API_KEY + TWILIO_API_SECRET (create under Twilio Console → API keys).
export function generateVoiceToken(identity: string): string {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY || !env.TWILIO_API_SECRET)
    throw new Error("Twilio Voice Token not configured (TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET)");

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_API_KEY,
    env.TWILIO_API_SECRET,
    { identity, ttl: 3600 },
  );

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: env.TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  }));

  return token.toJwt();
}

// Sends an SMS to the patient and returns the Twilio message SID.
export async function sendSms(to: string, body: string): Promise<string> {
  if (!env.TWILIO_FROM_NUMBER)
    throw new Error("TWILIO_FROM_NUMBER not configured");
  const client = getClient();
  const msg = await client.messages.create({ to, from: env.TWILIO_FROM_NUMBER, body });
  return msg.sid;
}

// TwiML response body for outbound browser → patient calls.
// Twilio calls this webhook URL when the browser SDK places a call.
// The `To` parameter is passed by the SDK in the call params.
//
// The browser Call object's own `accept` event fires as soon as Twilio
// bridges media to the BROWSER leg (needed to run this TwiML at all) — that
// happens well before the <Dial> target's phone is actually answered, so it
// cannot be trusted to tell answered from no-answer/voicemail-timeout. The
// action URL below is the authoritative source: Twilio calls it once the
// <Dial> leg ends, with the real DialCallStatus/DialCallDuration — same
// pattern already used for inbound calls (see buildInboundRouteTwiml).
export function buildDialTwiml(to: string, actionUrl: string): string {
  const { VoiceResponse } = twilio.twiml;
  const response = new VoiceResponse();
  const dial = response.dial({
    callerId: env.TWILIO_FROM_NUMBER ?? "",
    record: "record-from-answer",
    recordingStatusCallback: `${env.PUBLIC_URL ?? env.APP_BASE_URL}/api/communications/recording-status`,
    recordingStatusCallbackMethod: "POST",
    action: actionUrl,
    method: "POST",
  } as any);
  dial.number(to);
  return response.toString();
}

// Inbound calls ring per-clinic Client identities, not one shared identity —
// a clinic's staff must never see/hear a ring for another clinic's patient.
// Super admins additionally ring on a separate identity that's dialed
// alongside every clinic's, so they see every call regardless of clinic.
export function inboundIdentityForClinic(clinicId: string): string {
  return `rpmcares_inbound_clinic_${clinicId}`;
}
export const SUPER_ADMIN_INBOUND_IDENTITY = "rpmcares_inbound_superadmin";

// Generates a short-lived Access Token for the inbound listener. `identity`
// is either a clinic-scoped identity (inboundIdentityForClinic) or
// SUPER_ADMIN_INBOUND_IDENTITY — see getInboundToken, which picks it based
// on the requesting staff member's role/clinic.
export function generateInboundToken(identity: string): string {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY || !env.TWILIO_API_SECRET)
    throw new Error("Twilio Voice Token not configured");

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_API_KEY,
    env.TWILIO_API_SECRET,
    { identity, ttl: 3600 },
  );

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: env.TWILIO_TWIML_APP_SID,
    incomingAllow: true,
  }));

  return token.toJwt();
}

// TwiML that routes an inbound PSTN call to registered browser clients.
// The <Dial action> URL fires after the call ends — that handler does the logging.
// Patient info is looked up on the client side from call.parameters.From.
//
// Rings the calling patient's clinic identity AND the super-admin identity
// in parallel <Client> nouns (first to accept wins, same as Twilio's normal
// simultaneous-ring behavior) — so only that clinic's staff, plus super
// admins, ever see this call ring. clinicId is null only in the (shouldn't
// happen) case a patient record has no clinic — falls back to ringing only
// super admins rather than leaking the call to every clinic.
//
// parentCallSid is injected as a <Parameter> so whichever browser tab accepts
// the call knows which parent call it belongs to (the browser's own Client
// leg has a different CallSid) — used to attribute review time to the
// specific staff member who answered.
export function buildInboundRouteTwiml(
  actionUrl: string,
  parentCallSid: string,
  recordingStatusCallbackUrl: string,
  clinicId: string | null,
): string {
  const safeAction = actionUrl.replace(/&/g, "&amp;");
  const safeRecording = recordingStatusCallbackUrl.replace(/&/g, "&amp;");
  const safeSid = parentCallSid.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const identities = [
    ...(clinicId ? [inboundIdentityForClinic(clinicId)] : []),
    SUPER_ADMIN_INBOUND_IDENTITY,
  ];
  const clients = identities.map((identity) => [
    "    <Client>",
    `      <Identity>${identity}</Identity>`,
    `      <Parameter name="ParentCallSid" value="${safeSid}" />`,
    "    </Client>",
  ].join("\n"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Dial timeout="20" action="${safeAction}" method="POST" record="record-from-answer" recordingStatusCallback="${safeRecording}" recordingStatusCallbackMethod="POST">`,
    ...clients,
    "  </Dial>",
    "</Response>",
  ].join("\n");
}

export const twilioConfigured = () =>
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
