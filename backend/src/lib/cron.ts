import cron from "node-cron";
import { runSync } from "./sync";
import { syncTwilioMessages } from "../services/twilio-sync";

export function startCron(): void {
  // ── Patient/reading sync (Tenovi + SmartMeter) ─────────────────────────
  runSync().catch((err) => console.error("[cron] Initial sync error:", err));
  cron.schedule("*/30 * * * *", () => {
    runSync().catch((err) => console.error("[cron] Scheduled sync error:", err));
  });

  // ── Twilio SMS history sync ────────────────────────────────────────────
  // On boot: catch up on anything sent while the server was off (last 7 days).
  const SEVEN_DAYS = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  syncTwilioMessages(SEVEN_DAYS)
    .then(({ inserted, skipped }) =>
      console.log(`[cron] Twilio boot-sync: ${inserted} new messages, ${skipped} skipped`),
    )
    .catch((err) => console.error("[cron] Twilio boot-sync error:", err));

  // Every 10 minutes: pull any messages from the last 30 min (inbound/outbound).
  cron.schedule("*/10 * * * *", () => {
    const since = new Date(Date.now() - 30 * 60 * 1000);
    syncTwilioMessages(since)
      .then(({ inserted }) => { if (inserted > 0) console.log(`[cron] Twilio sync: ${inserted} new`); })
      .catch((err) => console.error("[cron] Twilio sync error:", err));
  });

  console.log("[cron] Schedulers started — device sync every 30m, Twilio sync every 10m");
}
