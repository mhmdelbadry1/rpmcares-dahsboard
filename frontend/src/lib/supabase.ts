import { createClient } from '@supabase/supabase-js';

const url  = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// Anon key — used only for Realtime subscriptions (read-only push events).
// All CRUD goes through the Express backend with proper auth.
export const supabase = createClient(url, anon, {
  realtime: { params: { eventsPerSecond: 10 } },
  auth: { persistSession: false, autoRefreshToken: false },
});
