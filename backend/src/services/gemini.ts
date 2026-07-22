import { env } from "../env";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-flash-latest";

export function geminiConfigured(): boolean {
  return !!env.GEMINI_API_KEY;
}

// Twilio recording URLs require Basic Auth with the account credentials —
// they are not public even though they look like plain HTTPS links.
async function downloadRecording(recordingUrl: string): Promise<{ base64: string; mimeType: string }> {
  const url = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Twilio recording download → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "audio/mpeg" };
}

export type CallTranscription = { transcript: string; summary: string };

/**
 * Downloads a Twilio call recording and asks Gemini to transcribe + summarize
 * it in one pass. Best-effort — callers should treat failures as "skip this
 * feature for this call", never block call logging on it.
 */
export async function transcribeAndSummarizeCall(recordingUrl: string): Promise<CallTranscription | null> {
  if (!geminiConfigured()) return null;

  const { base64, mimeType } = await downloadRecording(recordingUrl);

  const res = await fetch(
    `${GEMINI_BASE}/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: "This is a recorded phone call between clinical staff and a patient enrolled in a remote patient monitoring program. Transcribe it verbatim, labeling speaker turns as 'Staff:' and 'Patient:' where distinguishable. Then write a concise clinical summary (2-4 sentences) covering what was discussed, any symptoms or concerns raised, and any follow-up or care plan mentioned.",
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              transcript: { type: "STRING" },
              summary:    { type: "STRING" },
            },
            required: ["transcript", "summary"],
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent → ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = await res.json() as any;
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response had no content part");

  const parsed = JSON.parse(text) as CallTranscription;
  return parsed;
}
