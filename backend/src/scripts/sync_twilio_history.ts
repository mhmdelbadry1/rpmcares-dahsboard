/**
 * One-time (and re-runnable) import of full Twilio SMS history.
 * Usage:
 *   npm run sync:twilio                # all history
 *   npm run sync:twilio -- --days 30   # last 30 days only
 */
import "dotenv/config";
import { syncTwilioMessages } from "../services/twilio-sync";

const args    = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const days    = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) : null;
const since   = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;

const label = since ? `last ${days} days` : "all time";
console.log(`[twilio-sync] Fetching SMS history (${label})…`);

syncTwilioMessages(since)
  .then(({ inserted, skipped, errors }) => {
    console.log(`[twilio-sync] Done — ${inserted} inserted, ${skipped} skipped (no patient match), ${errors} errors`);
    if (errors > 0) {
      console.warn(
        "\n⚠️  Some inserts failed. If you see 'no unique or exclusion constraint', run this in Supabase SQL Editor:\n\n" +
        "   ALTER TABLE communications_log ADD COLUMN IF NOT EXISTS twilio_sid TEXT;\n" +
        "   CREATE UNIQUE INDEX IF NOT EXISTS comm_log_twilio_sid_idx\n" +
        "     ON communications_log (twilio_sid) WHERE twilio_sid IS NOT NULL;\n",
      );
    }
    process.exit(0);
  })
  .catch(e => { console.error(e); process.exit(1); });
