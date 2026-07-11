import {
  AlertCircle, CheckCheck, ChevronDown, Clock,
  Mic, MicOff, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff,
  Search, Send, X, MessageSquare,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView,
  Modal, Platform, Pressable, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/contexts/auth-context';
import { useUnread } from '@/contexts/unread-context';
import { api, type CommLog, type Patient } from '@/lib/api';
import { supabase } from '@/lib/supabase';

// Twilio Voice SDK (web only) — stored as a Promise so initDevice can await it.
// The events polyfill in metro.config.js makes this importable in the browser bundle.
const twilioDevicePromise: Promise<any> =
  Platform.OS === 'web'
    ? import('@twilio/voice-sdk').then((m) => m.Device).catch((e) => { console.error('[twilio-sdk] import failed:', e); return null; })
    : Promise.resolve(null);

const PAGE_SIZE = 50;

// ── Helpers ─────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f97316','#6366f1'];
function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function fmtTime(iso: string) {
  const d = new Date(iso), diff = Date.now() - d.getTime(), mins = Math.floor(diff / 60_000);
  if (mins < 2)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (hrs < 168) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDuration(secs: number | null) {
  if (!secs) return '';
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}
type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ended';

type DateSep   = { _dateSep: true; label: string; id: string };
type ListItem  = RichLog | DateSep;

function fmtDateLabel(iso: string): string {
  const d         = new Date(iso);
  const now       = new Date();
  const todayMs   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dMs       = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays  = Math.round((todayMs - dMs) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function insertDateSeps(logs: RichLog[]): ListItem[] {
  if (logs.length === 0) return [];
  // logs are newest-first (inverted FlatList — index 0 = bottom of screen)
  // A DateSep inserted AFTER a day's messages appears ABOVE that group on screen.
  const result: ListItem[] = [];
  let currentDay   = '';
  let currentLabel = '';
  for (const log of logs) {
    const d   = new Date(log.occurred_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (key !== currentDay) {
      if (currentDay !== '') {
        // Finished the previous day — insert its separator above it
        result.push({ _dateSep: true, label: currentLabel, id: `_sep_${currentDay}` });
      }
      currentDay   = key;
      currentLabel = fmtDateLabel(log.occurred_at);
    }
    result.push(log);
  }
  // Separator for the oldest day (very top of screen)
  if (currentDay) {
    result.push({ _dateSep: true, label: currentLabel, id: `_sep_${currentDay}_top` });
  }
  return result;
}

// ── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(name), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: size * 0.36, fontWeight: '700' }}>{initials(name)}</Text>
    </View>
  );
}

type RichLog = CommLog & { _optimistic?: boolean; _failed?: boolean };

// ── Message bubble ────────────────────────────────────────────────────────────

function Bubble({
  log, onRetry, onCopy, copiedId,
}: {
  log: RichLog;
  onRetry?: (log: RichLog) => void;
  onCopy?: (id: string, text: string) => void;
  copiedId?: string | null;
}) {
  const isCall = log.comm_type === 'call';
  const out    = log.direction === 'outbound';
  const missed = !out && log.duration_seconds == null; // null = missed; 0 = answered (very short)

  if (isCall) {
    const CallIcon  = missed ? PhoneMissed : PhoneCall;
    const iconClr   = missed ? '#ef4444' : (out ? '#22c55e' : '#94a3b8');
    const iconBg    = missed ? '#fee2e233' : (out ? '#22c55e22' : '#64748b22');
    const labelClr  = missed ? '#dc2626' : (out ? '#15803d' : '#64748b');
    const label     = missed
      ? 'Missed call'
      : `${out ? 'Outbound' : 'Inbound'} call${log.duration_seconds ? ` · ${fmtDuration(log.duration_seconds)}` : ' · No answer'}`;
    return (
      <View style={[bub.callRow, out ? bub.callOut : bub.callIn]}>
        <View style={[bub.callIcon, { backgroundColor: iconBg }]}>
          <CallIcon size={14} color={iconClr} />
        </View>
        <View>
          {out && log.staff_name && (
            <Text style={bub.senderName}>{log.staff_name}</Text>
          )}
          <Text style={[bub.callLabel, { color: labelClr }]}>{label}</Text>
          <Text style={bub.callTime}>{fmtTime(log.occurred_at)}</Text>
        </View>
      </View>
    );
  }

  // Status row under outbound SMS
  const statusRow = out ? (
    log._failed ? (
      <Pressable style={bub.statusRow} onPress={() => onRetry?.(log)}>
        <AlertCircle size={12} color="#ef4444" />
        <Text style={bub.statusFailed}>Failed · Tap to retry</Text>
      </Pressable>
    ) : log._optimistic ? (
      <View style={bub.statusRow}>
        <Clock size={11} color="#94a3b8" />
        <Text style={bub.statusSending}>Sending…</Text>
      </View>
    ) : (
      <View style={bub.statusRow}>
        <CheckCheck size={12} color="#22c55e" />
        <Text style={bub.statusSent}>Sent · {fmtTime(log.occurred_at)}</Text>
      </View>
    )
  ) : null;

  const isCopied = copiedId === log.id;

  return (
    <Pressable
      style={[bub.row, out ? bub.rowOut : bub.rowIn]}
      onLongPress={() => onCopy?.(log.id, log.summary ?? '')}
      delayLongPress={450}
    >
      <View style={[
        bub.bubble,
        out ? bub.bubbleOut : bub.bubbleIn,
        log._optimistic && bub.bubbleOptimistic,
        log._failed && bub.bubbleFailed,
      ]}>
        <Text style={[bub.text, out ? bub.textOut : bub.textIn]}>{log.summary ?? '—'}</Text>
        {isCopied && <Text style={bub.copiedLabel}>Copied</Text>}
      </View>
      {out && log.staff_name && !log._optimistic && !log._failed && (
        <Text style={bub.senderName}>{log.staff_name}</Text>
      )}
      {statusRow ?? (!out && <Text style={bub.time}>{fmtTime(log.occurred_at)}</Text>)}
    </Pressable>
  );
}

const bub = StyleSheet.create({
  row:              { marginBottom: 8, paddingHorizontal: 16 },
  rowOut:           { alignItems: 'flex-end' },
  rowIn:            { alignItems: 'flex-start' },
  bubble:           { maxWidth: '72%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleOut:        { backgroundColor: '#2563eb', borderBottomRightRadius: 4 },
  bubbleIn:         { backgroundColor: '#f1f5f9', borderBottomLeftRadius: 4 },
  bubbleOptimistic: { opacity: 0.6 },
  bubbleFailed:     { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fca5a5' },
  text:             { fontSize: 14.5, lineHeight: 20 },
  textOut:          { color: '#fff' },
  textIn:           { color: '#0f172a' },
  time:             { fontSize: 11, color: '#94a3b8', marginTop: 3, paddingHorizontal: 4 },
  // Status rows
  statusRow:        { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, paddingHorizontal: 4 },
  statusSending:    { fontSize: 11, color: '#94a3b8' },
  statusSent:       { fontSize: 11, color: '#22c55e' },
  statusFailed:     { fontSize: 11, color: '#ef4444', fontWeight: '500' },
  copiedLabel:      { fontSize: 10, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  senderName:       { fontSize: 10.5, color: '#94a3b8', marginTop: 2, paddingHorizontal: 4 },
  // Call rows
  callRow:          { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, paddingHorizontal: 16 },
  callOut:          { justifyContent: 'flex-end' },
  callIn:           { justifyContent: 'flex-start' },
  callIcon:         { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  callLabel:        { fontSize: 13, fontWeight: '500' },
  callTime:         { fontSize: 11, color: '#94a3b8', marginTop: 1 },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function CommunicationsScreen() {
  const { session } = useAuth();
  const token       = session?.token ?? null;
  const params      = useLocalSearchParams<{ patientId?: string; action?: string }>();
  const { counts: unreadCounts, markRead, refresh: refreshUnread } = useUnread();

  // ── Patient sidebar state ─────────────────────────────────────────────────
  const [patients, setPatients]       = useState<Patient[]>([]);
  const [ptTotal, setPtTotal]         = useState(0);
  const [ptPage, setPtPage]           = useState(0);
  const [ptLoading, setPtLoading]     = useState(false);   // initial skeleton
  const [ptLoadingMore, setPtLoadingMore] = useState(false); // footer spinner
  const [search, setSearch]           = useState('');
  const searchRef                     = useRef('');
  const [selected, setSelected]       = useState<Patient | null>(null);
  const [commFilter, setCommFilter]   = useState<'all' | 'unread' | 'calls' | 'sms'>('all');
  const [sortMode, setSortMode]       = useState<'recent' | 'name' | 'unread'>('recent');

  // Full patient list for filter/sort — loaded in background after initial page
  const [allPatients, setAllPatients] = useState<Patient[]>([]);
  const [allLoaded, setAllLoaded]     = useState(false);

  // ── Chat state ────────────────────────────────────────────────────────────
  const [logs, setLogs]               = useState<CommLog[]>([]);
  const [logsInitLoading, setLogsInitLoading] = useState(false); // only on patient switch

  // ── Outbound call state ───────────────────────────────────────────────────
  const [callState, setCallState]     = useState<CallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [muted, setMuted]             = useState(false);
  const [dotCount, setDotCount]       = useState(1);
  const deviceRef   = useRef<any>(null);
  const callRef     = useRef<any>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const callDurRef  = useRef(0);

  // ── Inbound call state ────────────────────────────────────────────────────
  type IncomingInfo = { patientName: string | null; patientId: string | null; phone: string | null };
  const inboundDevRef      = useRef<any>(null);
  const inboundCallRef     = useRef<any>(null);
  const inboundTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const inboundDurRef      = useRef(0);
  const [incomingInfo, setIncomingInfo]     = useState<IncomingInfo | null>(null);
  const [inboundState, setInboundState]     = useState<'idle' | 'ringing' | 'active'>('idle');
  const [inboundDuration, setInboundDuration] = useState(0);
  const [inboundMuted, setInboundMuted]     = useState(false);

  // ── SMS compose ───────────────────────────────────────────────────────────
  const [smsText, setSmsText]         = useState('');
  const [smsSending, setSmsSending]   = useState(false);

  // ── Chat thread UI ────────────────────────────────────────────────────────
  const chatListRef  = useRef<FlatList>(null);
  const [atBottom, setAtBottom]       = useState(true);
  const [copiedId, setCopiedId]       = useState<string | null>(null);

  // ── In-app error banner (replaces native alert) ───────────────────────────
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const errorTimerRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setErrorMsg(msg);
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 5000);
  }, []);

  // ── Load patients (page 0) ────────────────────────────────────────────────
  const loadPage = useCallback(async (page: number, q: string, replace: boolean) => {
    if (!token) return;
    if (page === 0) setPtLoading(true); else setPtLoadingMore(true);
    try {
      const { patients: data, total } = await api.listPatients(token, {
        search: q || undefined, limit: PAGE_SIZE, page,
      });
      setPtTotal(total);
      setPatients(prev => replace ? data : [...prev, ...data]);
      setPtPage(page);
    } finally {
      setPtLoading(false);
      setPtLoadingMore(false);
    }
  }, [token]);

  // Initial load
  useEffect(() => {
    loadPage(0, '', true);
  }, [loadPage]);

  // Search (debounced, resets list)
  useEffect(() => {
    searchRef.current = search;
    const t = setTimeout(() => {
      if (searchRef.current === search) loadPage(0, search, true);
    }, 300);
    return () => clearTimeout(t);
  }, [search, loadPage]);

  const loadMore = useCallback(() => {
    if (ptLoadingMore || patients.length >= ptTotal) return;
    loadPage(ptPage + 1, search, false);
  }, [ptLoadingMore, patients.length, ptTotal, ptPage, search, loadPage]);

  // Background-load ALL patients so filter + sort work across the full list,
  // not just the 50-item paginated visible slice.
  useEffect(() => {
    if (!token) return;
    api.listPatients(token, { limit: 5000 })
      .then(({ patients: all }) => { setAllPatients(all); setAllLoaded(true); })
      .catch(() => {});
  }, [token]);

  // ── Load logs — preserves optimistic/failed bubbles during background refresh
  const loadLogs = useCallback((patientId: string, showSpinner: boolean) => {
    if (!token) return;
    if (showSpinner) setLogsInitLoading(true);
    api.listCommunications(token, { patientId })
      .then(({ logs: data }) => {
        const confirmedIds = new Set(data.map(l => l.id));
        setLogs(prev => {
          // Keep optimistic/failed bubbles that aren't yet in DB
          const pending = prev.filter(
            l => ((l as RichLog)._optimistic || (l as RichLog)._failed) && !confirmedIds.has(l.id),
          );
          return [...pending, ...data];
        });
      })
      .catch(() => {})
      .finally(() => setLogsInitLoading(false));
  }, [token]);

  // ── Poll logs every 30 s as Realtime fallback ────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const t = setInterval(() => loadLogs(selected.id, false), 30_000);
    return () => clearInterval(t);
  }, [selected?.id, loadLogs]);

  // ── Supabase Realtime — instant push for any INSERT on communications_log ──
  // Subscribes per selected patient; no polling needed at all.
  useEffect(() => {
    if (!selected) return;

    const channel = supabase
      .channel(`comm:${selected.id}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'communications_log',
          filter: `patient_id=eq.${selected.id}`,
        },
        (payload) => {
          const incoming = payload.new as CommLog;
          setLogs(prev => {
            // Skip if already in the list (e.g. our own optimistic bubble was just replaced)
            if (prev.some(l => l.id === incoming.id)) return prev;
            // Keep any pending optimistic/failed bubbles at the top
            const pending = prev.filter(l => (l as RichLog)._optimistic || (l as RichLog)._failed);
            const rest    = prev.filter(l => !(l as RichLog)._optimistic && !(l as RichLog)._failed);
            return [...pending, incoming, ...rest];
          });
          markRead(selected.id);
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [selected?.id, markRead, refreshUnread]);

  // ── Select patient ────────────────────────────────────────────────────────
  const selectPatient = useCallback((patient: Patient) => {
    if (selected?.id === patient.id) return;
    setSelected(patient);
    setLogs([]);
    loadLogs(patient.id, true);
    markRead(patient.id);
  }, [selected, loadLogs, markRead]);

  // ── Route param auto-select ───────────────────────────────────────────────
  useEffect(() => {
    if (!params.patientId || !token) return;
    api.getPatient(token, params.patientId)
      .then(({ patient }) => {
        selectPatient(patient);
        if (params.action === 'call') setTimeout(() => startCall(), 800);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.patientId, params.action, token]);

  // ── Twilio device ─────────────────────────────────────────────────────────
  // Returns true on success, throws on failure so startCall can handle it once.
  const initDevice = useCallback(async (): Promise<boolean> => {
    if (deviceRef.current) return true;
    if (!token) return false;
    const TwilioDevice = await twilioDevicePromise;
    if (!TwilioDevice) throw new Error('Twilio Voice SDK failed to load. Try refreshing the page.');
    const { token: vt } = await api.getVoiceToken(token);
    const dev = new TwilioDevice(vt, { logLevel: 1 });
    // Outbound-only — do NOT call register() which requires incomingAllow:true.
    // Attach an error listener so async device errors don't become uncaught throws.
    dev.on('error', (err: any) => {
      console.error('[voice] device error:', err?.message ?? err);
      showError(err?.message ?? 'Voice device error. Try refreshing the page.');
    });
    deviceRef.current = dev;
    return true;
  }, [token, showError]);

  useEffect(() => {
    // Pre-warm the device on mount — errors are silently ignored here;
    // startCall will surface them with a proper message if it fails.
    if (Platform.OS === 'web') initDevice().catch(() => {});
    return () => { deviceRef.current?.destroy(); if (timerRef.current) clearInterval(timerRef.current); };
  }, [initDevice]);

  // ── Inbound device ────────────────────────────────────────────────────────
  // Registers a shared "rpmcares_inbound" browser client so all open tabs
  // ring when a patient calls. Uses window.CustomEvent to bridge from the
  // Twilio SDK callback into React — avoiding stale-closure issues from
  // Expo fast-refresh. Cancellation flag ensures StrictMode double-invoke is safe.
  useEffect(() => {
    if (!token || Platform.OS !== 'web') return;
    let cancelled = false;
    let localDev: any = null;

    (async () => {
      const TwilioDevice = await twilioDevicePromise;
      if (!TwilioDevice || cancelled) return;

      let ivt: string;
      try {
        const result = await api.getInboundToken(token);
        ivt = result.token;
      } catch (err) {
        console.error('[inbound-device] token fetch failed:', err);
        return;
      }
      if (cancelled) return;

      const dev = new TwilioDevice(ivt, { logLevel: 1 });
      localDev = dev;

      dev.on('error', (err: any) => console.error('[inbound-device] error:', err?.message ?? err));

      // Dispatch a window-level event so the React handler always uses
      // the latest closure — immune to fast-refresh stale captures.
      dev.on('incoming', (call: any) => {
        console.error('🚨 [inbound-device] INCOMING from:', call?.parameters?.From);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('rpmcares-incoming', { detail: { call } }));
        }
      });

      // Refresh token before it expires (Twilio fires this ~30 s before expiry).
      dev.on('tokenWillExpire', async () => {
        console.log('[inbound-device] token expiring — refreshing…');
        try {
          const result = await api.getInboundToken(token);
          dev.updateToken(result.token);
          console.log('[inbound-device] token refreshed');
        } catch (err) {
          console.error('[inbound-device] token refresh failed:', err);
        }
      });

      try {
        await dev.register();
      } catch (err) {
        console.error('[inbound-device] register failed:', err);
        dev.destroy();
        return;
      }

      if (cancelled) { dev.unregister?.(); dev.destroy(); return; }
      inboundDevRef.current = dev;
      console.log('[inbound-device] registered as rpmcares_inbound — ready to receive calls');
    })();

    return () => {
      cancelled = true;
      const devToDestroy = localDev ?? inboundDevRef.current;
      devToDestroy?.unregister?.();
      devToDestroy?.destroy?.();
      inboundDevRef.current = null;
      if (inboundTimerRef.current) clearInterval(inboundTimerRef.current);
    };
  }, [token]);

  // React-side handler for incoming calls — always has fresh closure via
  // window event, so allPatients lookup and state setters are never stale.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: Event) => {
      const call = (e as CustomEvent).detail?.call;
      if (!call) return;
      console.error('🚨 [communications] rpmcares-incoming window event — showing modal');
      const phone  = call?.parameters?.From ?? null;
      const digits = phone?.replace?.(/\D/g, '') ?? '';
      const patient = allPatients.find(
        p => p.phone && p.phone.replace(/\D/g, '').slice(-10) === digits.slice(-10),
      ) ?? null;
      inboundCallRef.current = call;
      setIncomingInfo({ patientName: patient?.full_name ?? null, patientId: patient?.id ?? null, phone });
      setInboundState('ringing');
      call?.on?.('cancel', () => {
        inboundCallRef.current = null;
        setIncomingInfo(null);
        setInboundState('idle');
      });
    };
    window.addEventListener('rpmcares-incoming', handler);
    return () => window.removeEventListener('rpmcares-incoming', handler);
  }, [allPatients]);

  const acceptInbound = useCallback(() => {
    const call = inboundCallRef.current;
    if (!call) return;
    call.accept();
    setInboundState('active');
    inboundDurRef.current = 0;
    setInboundDuration(0);
    setInboundMuted(false);
    inboundTimerRef.current = setInterval(() => {
      inboundDurRef.current += 1;
      setInboundDuration(inboundDurRef.current);
    }, 1000);
    call.on('disconnect', () => {
      if (inboundTimerRef.current) clearInterval(inboundTimerRef.current);
      inboundCallRef.current = null;
      setIncomingInfo(null);
      setInboundState('idle');
      setInboundDuration(0);
      setInboundMuted(false);
      inboundDurRef.current = 0;
      refreshUnread();
    });
  }, [refreshUnread]);

  const rejectInbound = useCallback(() => {
    inboundCallRef.current?.reject();
    inboundCallRef.current = null;
    setIncomingInfo(null);
    setInboundState('idle');
  }, []);

  const hangUpInbound = useCallback(() => {
    inboundCallRef.current?.disconnect();
  }, []);

  const toggleInboundMute = useCallback(() => {
    const call = inboundCallRef.current;
    if (!call) return;
    const next = !inboundMuted;
    call.mute(next);
    setInboundMuted(next);
  }, [inboundMuted]);

  // Animate "Ringing..." dots while in ringing state
  useEffect(() => {
    if (callState !== 'ringing') { setDotCount(1); return; }
    const t = setInterval(() => setDotCount(d => d === 3 ? 1 : d + 1), 600);
    return () => clearInterval(t);
  }, [callState]);

  // ── Call ──────────────────────────────────────────────────────────────────
  const startCall = useCallback(async () => {
    if (!selected?.phone || !token) return;
    if (!deviceRef.current) {
      try {
        await initDevice();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[voice] initDevice failed:', msg);
        showError(msg);
        return;
      }
    }
    setCallState('connecting'); setCallDuration(0); callDurRef.current = 0;
    try {
      const call = await deviceRef.current.connect({ params: { To: selected.phone } });
      callRef.current = call;

      // CallSid is only guaranteed after Twilio accepts the call — capture it then.
      let capturedSid: string | undefined;
      call.on('ringing', () => setCallState('ringing'));
      call.on('accept', (acceptedCall: any) => {
        capturedSid = acceptedCall?.parameters?.CallSid ?? call.parameters?.CallSid;
        setCallState('active');
        timerRef.current = setInterval(() => { callDurRef.current += 1; setCallDuration(callDurRef.current); }, 1000);
      });

      // Logs the call then resets UI. Called by both disconnect and cancel.
      const logAndReset = async () => {
        setCallState('ended');
        if (timerRef.current) clearInterval(timerRef.current);
        const dur = callDurRef.current;
        // For cancelled calls (never accepted), try to get SID from the call object directly
        const sid = capturedSid ?? call.parameters?.CallSid;
        await api.createCommunication(token, {
          patient_id: selected.id, comm_type: 'call', direction: 'outbound',
          duration_seconds: dur || null,
          summary: `Outbound call${dur ? ` · ${fmtDuration(dur)}` : ' · No answer'}`,
          twilio_sid: sid || undefined,
        }).catch(() => {});
        loadLogs(selected.id, false);
        refreshUnread();
        setTimeout(() => setCallState('idle'), 2000);
      };

      // disconnect = normal hang-up after connection; cancel = hung up before answer
      call.on('disconnect', logAndReset);
      call.on('cancel',     logAndReset);
      call.on('error', (err: any) => {
        setCallState('idle');
        if (timerRef.current) clearInterval(timerRef.current);
        showError(err?.message ?? 'Call failed. Check your Twilio geo-permissions.');
      });
    } catch (err) {
      setCallState('idle');
      const msg = err instanceof Error ? err.message : String(err);
      showError(`Could not start call: ${msg}`);
    }
  }, [selected, token, initDevice, loadLogs, refreshUnread, showError]);

  const hangUp     = useCallback(() => callRef.current?.disconnect(), []);
  const toggleMute = useCallback(() => {
    if (!callRef.current) return;
    const next = !muted; callRef.current.mute(next); setMuted(next);
  }, [muted]);

  // ── SMS — optimistic send ─────────────────────────────────────────────────
  const doSend = useCallback(async (body: string, tempId: string) => {
    if (!selected?.phone || !token) return;
    try {
      const { log: realLog } = await api.sendSms(token, { patient_id: selected.id, to: selected.phone!, body });
      if (realLog) {
        setLogs(prev => {
          // Strip any premature Realtime copy (fires before API response sometimes),
          // then swap the optimistic bubble in-place to preserve ordering.
          const without = prev.filter(l => l.id !== realLog.id);
          return without.map(l => l.id === tempId ? realLog : l);
        });
      }
      // If log is null (DB insert failed on backend), keep _optimistic:true so the
      // merge never drops the bubble — the 8s poll will recover it if it lands later.
      refreshUnread();
      loadLogs(selected.id, false);
    } catch {
      setLogs(prev => prev.map(l =>
        l.id === tempId ? { ...l, _optimistic: false, _failed: true } as RichLog : l,
      ));
    }
  }, [selected, token, loadLogs, refreshUnread]);

  const sendSms = useCallback(async () => {
    if (!selected?.phone || !smsText.trim() || !token || smsSending) return;
    const body = smsText.trim();
    setSmsText('');
    setSmsSending(true);

    const tempId = `_tmp_${Date.now()}`;
    setLogs(prev => [{
      id: tempId, patient_id: selected.id, staff_id: null, staff_name: null,
      comm_type: 'sms', direction: 'outbound', duration_seconds: null,
      summary: body, occurred_at: new Date().toISOString(), created_at: new Date().toISOString(),
      _optimistic: true, _failed: false,
    } as RichLog, ...prev]);

    setSmsSending(false);
    doSend(body, tempId);
  }, [selected, smsText, token, smsSending, doSend]);

  const retrySms = useCallback((log: RichLog) => {
    const body = log.summary ?? '';
    if (!body) return;
    // Reset to optimistic state
    setLogs(prev => prev.map(l =>
      l.id === log.id ? { ...l, _optimistic: true, _failed: false } as RichLog : l,
    ));
    doSend(body, log.id);
  }, [doSend]);

  // ── Copy on long-press ────────────────────────────────────────────────────
  const handleCopy = useCallback((logId: string, text: string) => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedId(logId);
    setTimeout(() => setCopiedId(prev => (prev === logId ? null : prev)), 2000);
  }, []);

  // ── Mark all as read ──────────────────────────────────────────────────────
  const markAllReadFn = useCallback(async () => {
    if (!token) return;
    const source = allLoaded ? allPatients : patients;
    const unread = source.filter(p => (unreadCounts[p.id]?.unread ?? 0) > 0);
    await Promise.all(unread.map(p => api.markCommRead(token, p.id).catch(() => {})));
    refreshUnread();
  }, [allPatients, allLoaded, patients, unreadCounts, token, refreshUnread]);

  // ── Filtered + sorted patient list ────────────────────────────────────────
  const displayedPatients = useMemo(() => {
    // Use the full list once background-loaded; fall back to paginated slice before that.
    const source = allLoaded ? allPatients : patients;

    // Search: client-filter the full list, then append any server results that
    // aren't already in it (covers patients added after the background load).
    let list: Patient[];
    if (allLoaded && search) {
      const q = search.toLowerCase();
      const clientMatches = source.filter(
        p => p.full_name.toLowerCase().includes(q) || (p.phone ?? '').includes(q),
      );
      const knownIds = new Set(source.map(p => p.id));
      const serverOnly = patients.filter(
        p => !knownIds.has(p.id) &&
             (p.full_name.toLowerCase().includes(q) || (p.phone ?? '').includes(q)),
      );
      list = [...clientMatches, ...serverOnly];
    } else {
      list = source;
    }

    // Comm-type filter
    if (commFilter === 'unread') {
      list = list.filter(p => (unreadCounts[p.id]?.unread ?? 0) > 0);
    } else if (commFilter === 'calls') {
      list = list.filter(p => unreadCounts[p.id]?.hasCall);
    } else if (commFilter === 'sms') {
      list = list.filter(p => unreadCounts[p.id]?.hasSms);
    }

    // Sort
    if (sortMode === 'name') {
      list = [...list].sort((a, b) => a.full_name.localeCompare(b.full_name));
    } else if (sortMode === 'unread') {
      list = [...list].sort((a, b) => (unreadCounts[b.id]?.unread ?? 0) - (unreadCounts[a.id]?.unread ?? 0));
    } else {
      // Recent: patients with no communications sink to the bottom
      list = [...list].sort((a, b) => {
        const la = unreadCounts[a.id]?.lastAt, lb = unreadCounts[b.id]?.lastAt;
        if (!la && !lb) return 0;
        if (!la) return 1;
        if (!lb) return -1;
        return new Date(lb).getTime() - new Date(la).getTime();
      });
    }
    return list;
  }, [patients, allPatients, allLoaded, commFilter, sortMode, search, unreadCounts]);

  // Date-separated message list (memoized) — dedup by id first so no duplicate
  // can ever reach the FlatList, regardless of which async path produced it.
  const listData = useMemo(() => {
    const seen = new Set<string>();
    const unique = (logs as RichLog[]).filter(l => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });
    return insertDateSeps(unique);
  }, [logs]);

  // ── Patient row ───────────────────────────────────────────────────────────
  const renderPatient = useCallback(({ item }: { item: Patient }) => {
    const isActive  = selected?.id === item.id;
    const summary   = unreadCounts[item.id];
    const unread    = summary?.unread ?? 0;
    const hasUnread = unread > 0 && !isActive;
    const lastText  = summary?.lastSummary
      ? (summary.lastCommType === 'call' ? `📞 ${summary.lastSummary}` : summary.lastSummary)
      : (item.phone ?? 'No phone');
    const lastTime  = summary?.lastAt ? fmtTime(summary.lastAt) : null;
    const isTenovi  = item.source === 'tenovi';

    return (
      <Pressable style={[s.patRow, isActive && s.patRowActive]} onPress={() => selectPatient(item)}>
        <View style={{ position: 'relative' }}>
          <Avatar name={item.full_name} size={44} />
          {hasUnread && <View style={s.avatarDot} />}
        </View>
        <View style={s.patMeta}>
          <View style={s.patTopRow}>
            <Text style={[s.patName, isActive && s.patNameActive, hasUnread && s.patNameBold]} numberOfLines={1}>
              {item.full_name}
            </Text>
            {lastTime
              ? <Text style={[s.patTime, isActive && s.patTimeActive]}>{lastTime}</Text>
              : <View style={[s.sourceBadge, isTenovi ? s.sourceBadgeTenovi : s.sourceBadgeSM]}>
                  <Text style={s.sourceBadgeText}>{isTenovi ? 'Tenovi' : 'SmartMeter'}</Text>
                </View>
            }
          </View>
          <View style={s.patBotRow}>
            <Text style={[s.patSub, isActive && s.patSubActive, hasUnread && s.patSubDark]} numberOfLines={1}>
              {lastText}
            </Text>
            {hasUnread
              ? <View style={s.unreadBadge}><Text style={s.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text></View>
              : lastTime && <View style={[s.sourceBadge, isTenovi ? s.sourceBadgeTenovi : s.sourceBadgeSM]}>
                  <Text style={s.sourceBadgeText}>{isTenovi ? 'Tenovi' : 'SmartMeter'}</Text>
                </View>
            }
          </View>
        </View>
      </Pressable>
    );
  }, [selected, unreadCounts, selectPatient]);

  const ptListFooter = ptLoadingMore
    ? <ActivityIndicator color="#3b82f6" style={{ paddingVertical: 12 }} />
    : patients.length > 0 && patients.length >= ptTotal
      ? <Text style={s.ptListEnd}>{ptTotal} patients</Text>
      : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>

      {/* ─── Sidebar ────────────────────────────────────────────────────── */}
      <View style={s.sidebar}>
        {/* Search + controls */}
        <View style={s.sidebarTop}>
          <View style={s.searchBox}>
            <Search size={13} color="#6b7280" />
            <TextInput
              style={s.searchInput}
              placeholder="Search patients…"
              placeholderTextColor="#9ca3af"
              value={search}
              onChangeText={setSearch}
            />
            {!!search && (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <X size={13} color="#9ca3af" />
              </Pressable>
            )}
          </View>
          {!search && ptTotal > 0 && (
            <Text style={s.ptCount}>{ptTotal.toLocaleString()} patients</Text>
          )}
        </View>

        {/* Filter pills */}
        <View style={s.filterRow}>
          {(['all', 'unread', 'calls', 'sms'] as const).map(f => (
            <Pressable key={f} style={[s.filterPill, commFilter === f && s.filterPillActive]} onPress={() => setCommFilter(f)}>
              <Text style={[s.filterPillText, commFilter === f && s.filterPillTextActive]}>
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : f === 'calls' ? 'Calls' : 'SMS'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Sort + mark all read */}
        <View style={s.sortRow}>
          {(['recent', 'name', 'unread'] as const).map(m => (
            <Pressable key={m} style={[s.sortBtn, sortMode === m && s.sortBtnActive]} onPress={() => setSortMode(m)}>
              <Text style={[s.sortBtnText, sortMode === m && s.sortBtnTextActive]}>
                {m === 'recent' ? 'Recent' : m === 'name' ? 'Name' : 'Unread'}
              </Text>
            </Pressable>
          ))}
          {Object.values(unreadCounts).some(c => (c.unread ?? 0) > 0) && (
            <Pressable style={s.markAllBtn} onPress={markAllReadFn}>
              <CheckCheck size={11} color="#3b82f6" />
              <Text style={s.markAllBtnText}>All read</Text>
            </Pressable>
          )}
        </View>

        {ptLoading ? (
          // Skeleton shimmer rows
          <View style={{ paddingTop: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <View key={i} style={s.skeleton}>
                <View style={s.skeletonAvatar} />
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={[s.skeletonLine, { width: `${55 + (i % 4) * 10}%` }]} />
                  <View style={[s.skeletonLine, { width: `${40 + (i % 3) * 8}%`, opacity: 0.5 }]} />
                </View>
              </View>
            ))}
          </View>
        ) : (
          <FlatList
            data={displayedPatients}
            keyExtractor={p => p.id}
            renderItem={renderPatient}
            onEndReached={!allLoaded ? loadMore : undefined}
            onEndReachedThreshold={0.3}
            ListFooterComponent={!allLoaded ? ptListFooter : null}
            ListEmptyComponent={
              <Text style={s.sidebarEmpty}>
                {commFilter !== 'all' ? `No ${commFilter} conversations` : search ? 'No patients found' : 'No patients'}
              </Text>
            }
            removeClippedSubviews
            maxToRenderPerBatch={20}
            windowSize={10}
          />
        )}
      </View>

      {/* ─── Conversation panel ─────────────────────────────────────────── */}
      {!selected ? (
        <View style={s.emptyState}>
          <View style={s.emptyIcon}>
            <MessageSquare size={32} color="#94a3b8" />
          </View>
          <Text style={s.emptyTitle}>No conversation selected</Text>
          <Text style={s.emptyDesc}>Choose a patient from the sidebar to view their messages and calls.</Text>
        </View>
      ) : (
        <KeyboardAvoidingView style={s.convo} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

          {/* Convo header */}
          <View style={s.convoHeader}>
            <View style={s.convoHeaderLeft}>
              <Avatar name={selected.full_name} size={38} />
              <View style={{ marginLeft: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.convoName}>{selected.full_name}</Text>
                  <View style={[s.sourceBadge, selected.source === 'tenovi' ? s.sourceBadgeTenovi : s.sourceBadgeSM]}>
                    <Text style={s.sourceBadgeText}>{selected.source === 'tenovi' ? 'Tenovi' : 'SmartMeter'}</Text>
                  </View>
                </View>
                <Text style={s.convoPhone}>{selected.phone ?? 'No phone on file'}</Text>
              </View>
            </View>
            {selected.phone && Platform.OS === 'web' && (
              <Pressable
                style={[s.callBtn,
                  callState === 'ringing' && s.callBtnRinging,
                  (callState === 'active' || callState === 'connecting') && s.callBtnRed,
                ]}
                onPress={['active', 'connecting', 'ringing'].includes(callState) ? hangUp : startCall}
              >
                {callState === 'connecting'
                  ? <ActivityIndicator size="small" color="#fff" />
                  : callState === 'ringing'  ? <Phone size={15} color="#fff" />
                  : callState === 'active'   ? <PhoneOff size={15} color="#fff" />
                  : <Phone size={15} color="#fff" />
                }
                <Text style={s.callBtnText}>
                  {callState === 'idle'       ? 'Call'
                    : callState === 'connecting' ? 'Connecting…'
                    : callState === 'ringing'    ? `Ringing${'.'.repeat(dotCount)}`
                    : callState === 'active'     ? fmtDuration(callDuration)
                    : 'Ended'}
                </Text>
              </Pressable>
            )}
          </View>

          {/* Error banner */}
          {errorMsg && (
            <Pressable style={s.errorBar} onPress={() => setErrorMsg(null)}>
              <AlertCircle size={15} color="#fff" />
              <Text style={s.errorBarText}>{errorMsg}</Text>
              <X size={14} color="#fff" style={{ marginLeft: 'auto' }} />
            </Pressable>
          )}

          {/* Live call banner */}
          {['active', 'connecting', 'ringing'].includes(callState) && (
            <View style={[s.callBar, callState === 'ringing' && s.callBarRinging]}>
              <View style={[s.callPulse, callState === 'ringing' && s.callPulseRinging]} />
              <Text style={s.callBarText}>
                {callState === 'connecting' ? 'Connecting…'
                  : callState === 'ringing' ? `Ringing${'.'.repeat(dotCount)}`
                  : `On call · ${fmtDuration(callDuration)}`}
              </Text>
              <Pressable style={[s.callBarBtn, muted && s.callBarBtnLit]} onPress={toggleMute}>
                {muted ? <MicOff size={14} color="#fff" /> : <Mic size={14} color="#fff" />}
              </Pressable>
              <Pressable style={[s.callBarBtn, s.callBarBtnRed]} onPress={hangUp}>
                <PhoneOff size={14} color="#fff" />
              </Pressable>
            </View>
          )}

          {/* Messages — inverted FlatList (newest at bottom, auto-scrolls) */}
          <View style={s.messageArea}>
            {logsInitLoading ? (
              <ActivityIndicator color="#3b82f6" style={{ marginTop: 40 }} />
            ) : logs.length === 0 ? (
              <View style={s.noMessages}>
                <Text style={s.noMessagesTitle}>No messages yet</Text>
                <Text style={s.noMessagesSub}>
                  {selected.phone ? 'Type below to send a message or tap Call.' : 'No phone number on file.'}
                </Text>
              </View>
            ) : (
              <FlatList
                ref={chatListRef}
                data={listData}
                keyExtractor={item => ('_dateSep' in item ? item.id : (item as RichLog).id)}
                renderItem={({ item }) => {
                  if ('_dateSep' in item) {
                    return <Text style={s.dateSep}>{item.label}</Text>;
                  }
                  return (
                    <Bubble
                      log={item as RichLog}
                      onRetry={retrySms}
                      onCopy={handleCopy}
                      copiedId={copiedId}
                    />
                  );
                }}
                inverted
                contentContainerStyle={{ paddingVertical: 12 }}
                keyboardShouldPersistTaps="handled"
                removeClippedSubviews
                onScroll={({ nativeEvent }) => setAtBottom(nativeEvent.contentOffset.y < 60)}
                scrollEventThrottle={80}
              />
            )}
            {/* Scroll-to-bottom button */}
            {!atBottom && logs.length > 0 && (
              <Pressable
                style={s.scrollToBottomBtn}
                onPress={() => chatListRef.current?.scrollToOffset({ offset: 0, animated: true })}
              >
                <ChevronDown size={18} color="#fff" />
              </Pressable>
            )}
          </View>

          {/* Compose bar */}
          {selected.phone && (
            <View style={s.composeBar}>
              <TextInput
                style={s.composeInput}
                placeholder="iMessage"
                placeholderTextColor="#9ca3af"
                value={smsText}
                onChangeText={setSmsText}
                multiline
                maxLength={1600}
              />
              <Pressable
                style={[s.sendBtn, (!smsText.trim() || smsSending) && s.sendBtnOff]}
                onPress={sendSms}
                disabled={!smsText.trim() || smsSending}
              >
                <Send size={15} color="#fff" />
              </Pressable>
            </View>
          )}
        </KeyboardAvoidingView>
      )}

      {/* FaceTime call overlay — outbound */}
      <Modal visible={callState === 'active'} transparent animationType="fade">
        <View style={s.ftOverlay}>
          <View style={s.ftCard}>
            <Avatar name={selected?.full_name ?? ''} size={80} />
            <Text style={s.ftName}>{selected?.full_name}</Text>
            <Text style={s.ftTimer}>{fmtDuration(callDuration)}</Text>
            <View style={s.ftActions}>
              <Pressable style={s.ftBtnWrap} onPress={toggleMute}>
                <View style={[s.ftBtn, muted && s.ftBtnLit]}>
                  {muted ? <MicOff size={22} color="#fff" /> : <Mic size={22} color="#fff" />}
                </View>
                <Text style={s.ftBtnLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
              </Pressable>
              <Pressable style={s.ftBtnWrap} onPress={hangUp}>
                <View style={[s.ftBtn, s.ftBtnRed]}>
                  <PhoneOff size={22} color="#fff" />
                </View>
                <Text style={s.ftBtnLabel}>End</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Incoming call modal — inbound patient calls */}
      <Modal visible={inboundState !== 'idle'} transparent animationType="fade">
        <View style={s.ftOverlay}>
          <View style={s.ftCard}>
            {inboundState === 'ringing' ? (
              <>
                <View style={s.inboundRingWrap}>
                  <View style={s.inboundRingOuter}>
                    <View style={s.inboundRingInner}>
                      <PhoneIncoming size={32} color="#22c55e" />
                    </View>
                  </View>
                </View>
                <Text style={[s.ftName, { marginTop: 8 }]}>
                  {incomingInfo?.patientName ?? incomingInfo?.phone ?? 'Unknown caller'}
                </Text>
                <Text style={s.inboundLabel}>Incoming call</Text>
                <View style={s.ftActions}>
                  <Pressable style={s.ftBtnWrap} onPress={rejectInbound}>
                    <View style={[s.ftBtn, s.ftBtnRed]}>
                      <PhoneOff size={22} color="#fff" />
                    </View>
                    <Text style={s.ftBtnLabel}>Decline</Text>
                  </Pressable>
                  <Pressable style={s.ftBtnWrap} onPress={acceptInbound}>
                    <View style={[s.ftBtn, s.ftBtnGreen]}>
                      <Phone size={22} color="#fff" />
                    </View>
                    <Text style={s.ftBtnLabel}>Accept</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Avatar name={incomingInfo?.patientName ?? '?'} size={80} />
                <Text style={s.ftName}>{incomingInfo?.patientName ?? incomingInfo?.phone ?? 'Patient'}</Text>
                <Text style={s.ftTimer}>{fmtDuration(inboundDuration)}</Text>
                <View style={s.ftActions}>
                  <Pressable style={s.ftBtnWrap} onPress={toggleInboundMute}>
                    <View style={[s.ftBtn, inboundMuted && s.ftBtnLit]}>
                      {inboundMuted ? <MicOff size={22} color="#fff" /> : <Mic size={22} color="#fff" />}
                    </View>
                    <Text style={s.ftBtnLabel}>{inboundMuted ? 'Unmute' : 'Mute'}</Text>
                  </Pressable>
                  <Pressable style={s.ftBtnWrap} onPress={hangUpInbound}>
                    <View style={[s.ftBtn, s.ftBtnRed]}>
                      <PhoneOff size={22} color="#fff" />
                    </View>
                    <Text style={s.ftBtnLabel}>End</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:            { flex: 1, flexDirection: 'row', backgroundColor: '#f8fafc' },

  // Sidebar
  sidebar:         { width: 300, backgroundColor: '#fff', borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  sidebarTop:      { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  searchBox:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 6 },
  searchInput:     { flex: 1, fontSize: 13.5, color: '#0f172a' },
  ptCount:         { fontSize: 10.5, color: '#94a3b8', marginTop: 6, textAlign: 'right' },

  // Skeleton
  skeleton:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, gap: 10 },
  skeletonAvatar:  { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0' },
  skeletonLine:    { height: 10, backgroundColor: '#e2e8f0', borderRadius: 5 },

  // Patient rows
  patRow:          { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#f1f5f9' },
  patRowActive:    { backgroundColor: '#eff6ff' },
  patMeta:         { flex: 1, minWidth: 0 },
  patTopRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  patBotRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  patName:         { fontSize: 13.5, fontWeight: '500', color: '#0f172a', flex: 1, marginRight: 4 },
  patNameActive:   { color: '#1d4ed8' },
  patNameBold:     { fontWeight: '700' },
  patTime:         { fontSize: 11, color: '#94a3b8', flexShrink: 0 },
  patTimeActive:   { color: '#3b82f6' },
  patSub:          { fontSize: 12, color: '#94a3b8', flex: 1, marginRight: 4 },
  patSubActive:    { color: '#3b82f6' },
  patSubDark:      { color: '#475569' },
  avatarDot:       { position: 'absolute', top: 0, right: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: '#2563eb', borderWidth: 2, borderColor: '#fff' },
  unreadBadge:       { backgroundColor: '#2563eb', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, flexShrink: 0 },
  unreadBadgeText:   { color: '#fff', fontSize: 10, fontWeight: '700' },
  sourceBadge:       { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, flexShrink: 0 },
  sourceBadgeTenovi: { backgroundColor: '#ede9fe' },
  sourceBadgeSM:     { backgroundColor: '#e0f2fe' },
  sourceBadgeText:   { fontSize: 9, fontWeight: '700', letterSpacing: 0.3, color: '#475569', textTransform: 'uppercase' },
  sidebarEmpty:      { textAlign: 'center', color: '#94a3b8', fontSize: 13, marginTop: 32 },
  ptListEnd:       { textAlign: 'center', color: '#cbd5e1', fontSize: 11, paddingVertical: 14 },

  // Empty state
  emptyState:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyIcon:       { width: 72, height: 72, borderRadius: 36, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle:      { fontSize: 17, fontWeight: '600', color: '#334155' },
  emptyDesc:       { fontSize: 13.5, color: '#94a3b8', textAlign: 'center', maxWidth: 300, lineHeight: 20 },

  // Sidebar filter / sort
  filterRow:         { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#f1f5f9' },
  filterPill:        { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: '#f1f5f9' },
  filterPillActive:  { backgroundColor: '#eff6ff' },
  filterPillText:    { fontSize: 12, color: '#64748b', fontWeight: '500' },
  filterPillTextActive: { color: '#2563eb' },
  sortRow:           { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 10, paddingBottom: 6, paddingTop: 4 },
  sortBtn:           { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  sortBtnActive:     { backgroundColor: '#eff6ff' },
  sortBtnText:       { fontSize: 11.5, color: '#94a3b8', fontWeight: '500' },
  sortBtnTextActive: { color: '#2563eb' },
  markAllBtn:        { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8, backgroundColor: '#eff6ff' },
  markAllBtnText:    { fontSize: 11, color: '#3b82f6', fontWeight: '600' },

  // Header call button variants
  callBtnRinging:    { backgroundColor: '#d97706' },

  // Conversation
  convo:           { flex: 1, flexDirection: 'column', backgroundColor: '#fff' },
  convoHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  convoHeaderLeft: { flexDirection: 'row', alignItems: 'center' },
  convoName:       { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  convoPhone:      { fontSize: 12.5, color: '#64748b', marginTop: 1 },
  callBtn:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, gap: 6, backgroundColor: '#22c55e' },
  callBtnRed:      { backgroundColor: '#dc2626' },
  callBtnText:     { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Call banner
  errorBar:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#dc2626', paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  errorBarText:      { flex: 1, color: '#fff', fontSize: 13, fontWeight: '500' },
  callBar:           { flexDirection: 'row', alignItems: 'center', backgroundColor: '#15803d', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  callBarRinging:    { backgroundColor: '#b45309' },
  callPulse:         { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ade80' },
  callPulseRinging:  { backgroundColor: '#fcd34d' },
  callBarText:       { flex: 1, color: '#fff', fontSize: 13, fontWeight: '500' },
  callBarBtn:        { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  callBarBtnLit:     { backgroundColor: 'rgba(255,255,255,0.35)' },
  callBarBtnRed:     { backgroundColor: '#ef4444' },

  // Messages
  messageArea:        { flex: 1, backgroundColor: '#f8fafc' },
  noMessages:         { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 6 },
  noMessagesTitle:    { fontSize: 15, fontWeight: '500', color: '#64748b' },
  noMessagesSub:      { fontSize: 13, color: '#94a3b8' },
  dateSep:            { textAlign: 'center', fontSize: 11.5, color: '#94a3b8', marginVertical: 10, fontWeight: '500' },
  scrollToBottomBtn:  { position: 'absolute', bottom: 14, right: 14, width: 34, height: 34, borderRadius: 17, backgroundColor: '#475569', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 4, zIndex: 10 },

  // Compose
  composeBar:      { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0', gap: 10, backgroundColor: '#fff' },
  composeInput:    { flex: 1, backgroundColor: '#f1f5f9', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14.5, color: '#0f172a', maxHeight: 120 },
  sendBtn:         { width: 38, height: 38, borderRadius: 19, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  sendBtnOff:      { opacity: 0.35 },

  // FaceTime / call overlay
  ftOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center' },
  ftCard:           { backgroundColor: '#1e293b', borderRadius: 28, padding: 40, alignItems: 'center', gap: 14, minWidth: 280 },
  ftName:           { fontSize: 22, fontWeight: '700', color: '#f8fafc', marginTop: 4 },
  ftTimer:          { fontSize: 15, color: '#94a3b8', fontVariant: ['tabular-nums'] },
  ftActions:        { flexDirection: 'row', gap: 32, marginTop: 16 },
  ftBtnWrap:        { alignItems: 'center', gap: 8 },
  ftBtn:            { width: 64, height: 64, borderRadius: 32, backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' },
  ftBtnLit:         { backgroundColor: '#475569' },
  ftBtnRed:         { backgroundColor: '#dc2626' },
  ftBtnGreen:       { backgroundColor: '#16a34a' },
  ftBtnLabel:       { fontSize: 12, color: '#94a3b8' },

  // Inbound ring animation
  inboundRingWrap:  { marginBottom: 4 },
  inboundRingOuter: { width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(34,197,94,0.15)', alignItems: 'center', justifyContent: 'center' },
  inboundRingInner: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(34,197,94,0.25)', alignItems: 'center', justifyContent: 'center' },
  inboundLabel:     { fontSize: 14, color: '#94a3b8', fontWeight: '500' },
});
