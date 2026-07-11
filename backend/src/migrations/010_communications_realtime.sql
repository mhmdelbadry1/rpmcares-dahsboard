-- Add communications_log to Supabase Realtime publication so postgres_changes
-- events are broadcast to subscribed clients.
ALTER PUBLICATION supabase_realtime ADD TABLE public.communications_log;

-- Allow SELECT for the anon role so the Realtime subscription (which uses the
-- anon key) can receive row-level events.  The backend API still enforces auth
-- at the Express layer; this only grants read access to the Realtime channel.
CREATE POLICY "comm_log_select_anon"
  ON public.communications_log
  FOR SELECT
  TO anon, authenticated
  USING (true);
