// Re-runs the patient sync so any SmartMeter patients whose list API
// returns a mobile_phone/cell_phone get repopulated in the DB.
import { runSync } from '../lib/sync';

console.log('Running sync to restore phone numbers...');
runSync()
  .then(() => {
    console.log('Done. Check DB for phone count.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('Sync failed:', e);
    process.exit(1);
  });
