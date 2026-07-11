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
export function buildDialTwiml(to: string): string {
  const { VoiceResponse } = twilio.twiml;
  const response = new VoiceResponse();
  const dial = response.dial({
    callerId: env.TWILIO_FROM_NUMBER ?? "",
    record: "record-from-answer",
    recordingStatusCallback: `${env.PUBLIC_URL ?? env.APP_BASE_URL}/api/communications/recording-status`,
    recordingStatusCallbackMethod: "POST",
  } as any);
  dial.number(to);
  return response.toString();
}

// Generates a short-lived Access Token for the shared inbound listener.
// All staff browsers register under the same identity ("rpmcares_inbound") so
// when TwiML dials that identity, every open tab rings simultaneously.
export function generateInboundToken(): string {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY || !env.TWILIO_API_SECRET)
    throw new Error("Twilio Voice Token not configured");

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_API_KEY,
    env.TWILIO_API_SECRET,
    { identity: "rpmcares_inbound", ttl: 3600 },
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
export function buildInboundRouteTwiml(actionUrl: string): string {
  const safeUrl = actionUrl.replace(/&/g, "&amp;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Dial timeout="20" action="${safeUrl}" method="POST">`,
    "    <Client>",
    "      <Identity>rpmcares_inbound</Identity>",
    "    </Client>",
    "  </Dial>",
    "</Response>",
  ].join("\n");
}

export const twilioConfigured = () =>
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
