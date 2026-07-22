import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Activity, AlertTriangle, Bell, Calendar, CheckCircle2, ChevronLeft, ChevronRight,
  ClipboardList, Copy, Download, FileText, HeartPulse, Link2, Link2Off, MessageSquare, Phone, Play,
  Plus, RefreshCw, Sparkles, Square, Thermometer, Timer, TrendingDown, TrendingUp,
  UserPlus, Weight, X, Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import {
  api,
  type AlertEvent, type AlertStatus, type DetectedImei, type Member, type PatientDevice,
  type Patient, type PatientReading, type ReviewTimeEntry, type CareNote,
  type ReadingType, type SmartMeterDetail, type SmartMeterAddress,
  type PatientReport, type CarePlan, type BillingCycleReport, type ExportedBillingReport,
} from '@/lib/api';
import { openReportForDownload } from '@/lib/pdf-utils';

// ── Helpers ────────────────────────────────────────────────────────────────

function ageFromDob(dob: string | null): string {
  if (!dob) return '—';
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return `${age} yrs`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtAddress(addr: SmartMeterAddress | null | undefined): string | null {
  if (!addr) return null;
  const parts = [addr.address1, addr.address2, addr.city, addr.state, addr.zip, addr.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function enrollTone(s: string): 'success' | 'warning' | 'muted' | 'critical' {
  if (s === 'active')  return 'success';
  if (s === 'pending') return 'warning';
  if (s === 'hold')    return 'muted';
  return 'critical';
}

function riskTone(r: string): 'success' | 'info' | 'warning' | 'critical' {
  if (r === 'low')    return 'success';
  if (r === 'medium') return 'info';
  if (r === 'high')   return 'warning';
  return 'critical';
}

function alertStatusTone(s: string): 'success' | 'warning' | 'muted' | 'info' {
  if (s === 'resolved')  return 'success';
  if (s === 'escalated') return 'warning';
  if (s === 'assigned')  return 'info';
  return 'muted';
}

const READING_TYPE_ICONS: Record<ReadingType, LucideIcon> = {
  blood_pressure: HeartPulse,
  glucose:        Activity,
  weight:         Weight,
  spo2:           Activity,
  heart_rate:     HeartPulse,
  temperature:    Thermometer,
  unknown:        Activity,
};

const READING_COLORS: Record<ReadingType, string> = {
  blood_pressure: '#DC2626',
  glucose:        '#D97706',
  weight:         '#7C3AED',
  spo2:           '#0284C7',
  heart_rate:     '#DC2626',
  temperature:    '#D97706',
  unknown:        '#6B7280',
};

const TABS = ['Info', 'Readings', 'Alerts', 'Devices', 'Notes', 'Review Time', 'Report', 'Exported Billing'] as const;
type Tab = typeof TABS[number];

// ── Sub-components ─────────────────────────────────────────────────────────

function InfoRow({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View style={s.infoItem}>
      <Text style={[s.infoLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[s.infoValue, { color: colors.text }]} numberOfLines={2}>{value || '—'}</Text>
    </View>
  );
}

function EditableInfoRow({
  label, value, fieldKey, onEdit, colors,
}: {
  label: string; value: string | null; fieldKey: string;
  onEdit: (key: string, label: string, current: string) => void; colors: any;
}) {
  return (
    <View style={s.infoItem}>
      <Text style={[s.infoLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Pressable onPress={() => onEdit(fieldKey, label, value ?? '')} hitSlop={8}>
        {value
          ? <Text style={[s.infoValue, { color: colors.text }]} numberOfLines={2}>{value}</Text>
          : <Text style={[s.infoValue, { color: colors.primary, fontWeight: '600' }]}>Add</Text>
        }
      </Pressable>
    </View>
  );
}

function SectionLabel({ text, colors }: { text: string; colors: any }) {
  return (
    <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{text.toUpperCase()}</Text>
  );
}

// ── Reading sparkline (simple bar chart) ───────────────────────────────────

function ReadingSparkline({ readings, color }: { readings: PatientReading[]; color: string }) {
  const vals = readings.map((r) => r.value ?? 0).filter((v) => v > 0);
  if (vals.length < 2) return null;
  const max = Math.max(...vals);
  const last8 = readings.slice(0, 8).reverse();

  return (
    <View style={spark.wrap}>
      {last8.map((r, i) => {
        const h = Math.max(4, ((r.value ?? 0) / max) * 44);
        return (
          <View key={r.id + i} style={spark.col}>
            <View style={[spark.bar, { height: h, backgroundColor: color + (r.flagged ? 'ff' : '80') }]} />
          </View>
        );
      })}
    </View>
  );
}
const spark = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 44, marginTop: 8 },
  col:  { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar:  { width: '100%', borderRadius: 3, minHeight: 4 },
});

// ── Reading card ───────────────────────────────────────────────────────────

function ReadingCard({ reading, colors }: { reading: PatientReading; colors: any }) {
  const Icon  = READING_TYPE_ICONS[reading.type];
  const color = READING_COLORS[reading.type];

  return (
    <View style={[rc.root, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <View style={[rc.stripe, { backgroundColor: reading.flagged ? '#DC2626' : color }]} />
      <View style={rc.body}>
        <View style={rc.topRow}>
          <View style={[rc.iconWrap, { backgroundColor: color + '15' }]}>
            <Icon size={14} color={color} strokeWidth={1.75} />
          </View>
          <Text style={[rc.label, { color: colors.textSecondary }]}>{reading.label}</Text>
          {reading.flagged && (
            <View style={rc.flagBadge}>
              <Zap size={9} color="#DC2626" />
              <Text style={rc.flagText}>Flagged</Text>
            </View>
          )}
          <Text style={[rc.time, { color: colors.textSecondary }]}>{timeAgo(reading.timestamp)}</Text>
        </View>
        <Text style={[rc.value, { color: reading.flagged ? '#DC2626' : colors.text }]}>
          {reading.displayValue}
        </Text>
        {reading.type === 'blood_pressure' && reading.systolic && reading.diastolic && (
          <View style={rc.bpRow}>
            <Text style={[rc.bpItem, { color: colors.textSecondary }]}>
              Systolic {reading.systolic}
            </Text>
            <Text style={[rc.bpItem, { color: colors.textSecondary }]}>
              Diastolic {reading.diastolic}
            </Text>
            {reading.pulse && (
              <Text style={[rc.bpItem, { color: colors.textSecondary }]}>
                Pulse {reading.pulse} bpm
              </Text>
            )}
          </View>
        )}
        <Text style={[rc.dateText, { color: colors.textSecondary }]}>
          {fmtDateTime(reading.timestamp)}
          {reading.deviceId ? ` · ${reading.deviceId}` : ''}
          {' · '}{reading.source === 'tenovi' ? 'Tenovi' : 'SmartMeter'}
        </Text>
      </View>
    </View>
  );
}
const rc = StyleSheet.create({
  root:    { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden', marginBottom: 8 },
  stripe:  { width: 4 },
  body:    { flex: 1, padding: 12, gap: 4 },
  topRow:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconWrap:{ width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  label:   { flex: 1, fontSize: 11, fontWeight: '600' },
  flagBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#DC262615', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  flagText:{ fontSize: 9, fontWeight: '800', color: '#DC2626' },
  time:    { fontSize: 10.5 },
  value:   { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  bpRow:   { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  bpItem:  { fontSize: 11 },
  dateText:{ fontSize: 10.5 },
});

// ── Date Range Picker ──────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_NAMES = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function toISO(d: Date) { return d.toISOString().slice(0, 10); }
function fmtRangeLabel(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function DateRangePicker({
  from, to, onApply, colors,
}: { from: string; to: string; onApply: (f: string, t: string) => void; colors: any }) {
  const today = new Date();
  const [visible, setVisible] = useState(false);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [tempFrom, setTempFrom] = useState(from);
  const [tempTo, setTempTo]     = useState(to);
  const [step, setStep]         = useState<'from' | 'to'>('from');

  function open() {
    setTempFrom(from); setTempTo(to); setStep('from');
    setYear(today.getFullYear()); setMonth(today.getMonth());
    setVisible(true);
  }
  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  function dayISO(day: number) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function tapDay(day: number) {
    const iso = dayISO(day);
    if (step === 'from' || iso < tempFrom) {
      setTempFrom(iso); setTempTo(''); setStep('to');
    } else {
      setTempTo(iso); setStep('from');
    }
  }

  function applyPreset(days: number) {
    const t = toISO(today);
    const f = toISO(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)));
    setTempFrom(f); setTempTo(t); setStep('from');
  }

  function apply() {
    const f = tempFrom;
    const t = tempTo || tempFrom;
    onApply(f, t);
    setVisible(false);
  }

  const todayISO = toISO(today);

  return (
    <>
      <Pressable onPress={open} style={[dp.trigger, { borderColor: colors.primary + '60', backgroundColor: colors.card }]}>
        <Calendar size={13} color={colors.primary} strokeWidth={2} />
        <Text style={[dp.triggerText, { color: colors.text }]}>
          {fmtRangeLabel(from)} → {fmtRangeLabel(to)}
        </Text>
        <ChevronRight size={13} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable style={dp.overlay} onPress={() => setVisible(false)}>
          <Pressable style={[dp.modal, { backgroundColor: colors.card }]} onPress={() => {}}>

            {/* Selected range display */}
            <View style={dp.rangeRow}>
              <View style={[dp.rangeBox, step === 'from' && { borderColor: colors.primary }]}>
                <Text style={[dp.rangeLabel, { color: colors.textSecondary }]}>FROM</Text>
                <Text style={[dp.rangeVal, { color: colors.text }]}>
                  {tempFrom ? fmtRangeLabel(tempFrom) : '—'}
                </Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 14, marginTop: 10 }}>→</Text>
              <View style={[dp.rangeBox, step === 'to' && { borderColor: colors.primary }]}>
                <Text style={[dp.rangeLabel, { color: colors.textSecondary }]}>TO</Text>
                <Text style={[dp.rangeVal, { color: colors.text }]}>
                  {tempTo ? fmtRangeLabel(tempTo) : '—'}
                </Text>
              </View>
            </View>

            {/* Quick presets */}
            <View style={dp.presetRow}>
              {([7, 30, 90] as const).map((d) => (
                <Pressable key={d} onPress={() => applyPreset(d)}
                  style={[dp.preset, { borderColor: colors.border, backgroundColor: colors.surface ?? colors.background }]}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>{d}d</Text>
                </Pressable>
              ))}
            </View>

            {/* Month navigation */}
            <View style={dp.monthNav}>
              <Pressable onPress={prevMonth} hitSlop={12}><ChevronLeft size={18} color={colors.text} /></Pressable>
              <Text style={[dp.monthTitle, { color: colors.text }]}>{MONTH_NAMES[month]} {year}</Text>
              <Pressable onPress={nextMonth} hitSlop={12}><ChevronRight size={18} color={colors.text} /></Pressable>
            </View>

            {/* Day headers */}
            <View style={dp.dayHeader}>
              {DAY_NAMES.map(d => (
                <Text key={d} style={[dp.dayName, { color: colors.textSecondary }]}>{d}</Text>
              ))}
            </View>

            {/* Calendar grid */}
            <View style={dp.grid}>
              {cells.map((day, i) => {
                if (!day) return <View key={`e-${i}`} style={dp.cell} />;
                const iso   = dayISO(day);
                const isFrom  = iso === tempFrom;
                const isTo    = iso === (tempTo || tempFrom);
                const inRange = tempFrom && tempTo && iso > tempFrom && iso < tempTo;
                const isFuture = iso > todayISO;
                return (
                  <Pressable
                    key={iso}
                    onPress={() => !isFuture && tapDay(day)}
                    style={[
                      dp.cell,
                      inRange && { backgroundColor: colors.primary + '22' },
                      (isFrom || isTo) && { backgroundColor: colors.primary, borderRadius: 999 },
                    ]}
                  >
                    <Text style={{
                      fontSize: 13, fontWeight: isFrom || isTo ? '800' : '500',
                      color: isFrom || isTo ? '#052B00' : isFuture ? colors.textSecondary + '50' : colors.text,
                    }}>
                      {day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Apply */}
            <Pressable
              onPress={apply}
              disabled={!tempFrom}
              style={[dp.applyBtn, { backgroundColor: tempFrom ? colors.primary : colors.border }]}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#052B00' }}>Apply</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const dp = StyleSheet.create({
  trigger:    { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 14 },
  triggerText:{ fontSize: 12.5, fontWeight: '600' },
  overlay:    { flex: 1, backgroundColor: '#00000065', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modal:      { width: '100%', maxWidth: 340, borderRadius: 20, padding: 20, gap: 14 },
  rangeRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rangeBox:   { flex: 1, borderWidth: 1.5, borderColor: 'transparent', borderRadius: 10, padding: 10, alignItems: 'center', gap: 2 },
  rangeLabel: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.8 },
  rangeVal:   { fontSize: 12, fontWeight: '800', textAlign: 'center' },
  presetRow:  { flexDirection: 'row', gap: 6 },
  preset:     { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  monthNav:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthTitle: { fontSize: 14, fontWeight: '700' },
  dayHeader:  { flexDirection: 'row' },
  dayName:    { flexBasis: '14.28%', textAlign: 'center', fontSize: 10, fontWeight: '600', paddingVertical: 4 },
  grid:       { flexDirection: 'row', flexWrap: 'wrap' },
  cell:       { flexBasis: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  applyBtn:   { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
});

// ── Readings Tab ───────────────────────────────────────────────────────────

function ReadingsTab({
  patientId, source, colors,
}: { patientId: string; source: 'smartmeter' | 'tenovi'; colors: any }) {
  const { session } = useAuth();
  const _today = new Date();
  const _todayISO = toISO(_today);
  const _defaultFrom = toISO(new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - 29));
  const [dateFrom, setDateFrom] = useState(_defaultFrom);
  const [dateTo,   setDateTo]   = useState(_todayISO);
  const [readings, setReadings] = useState<PatientReading[] | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [typeFilter, setTypeFilter] = useState<ReadingType | 'all'>('all');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.getPatientReadings(session.token, patientId, dateFrom, dateTo);
      setReadings(res.readings);
    } catch {
      setError('Could not load readings.');
    } finally {
      setLoading(false);
    }
  }, [session, patientId, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const types: ReadingType[] = useMemo(() => {
    if (!readings) return [];
    return [...new Set(readings.map((r) => r.type))].filter((t) => t !== 'unknown');
  }, [readings]);

  const filtered = useMemo(() =>
    readings
      ? typeFilter === 'all' ? readings : readings.filter((r) => r.type === typeFilter)
      : [],
    [readings, typeFilter],
  );

  // Latest reading per type for summary cards
  const summaryByType = useMemo(() => {
    const map = new Map<ReadingType, PatientReading>();
    if (!readings) return map;
    for (const r of readings) {
      if (!map.has(r.type)) map.set(r.type, r);
    }
    return map;
  }, [readings]);

  // Trend: compare latest vs previous same-type reading
  function trend(type: ReadingType): 'up' | 'down' | 'flat' {
    if (!readings) return 'flat';
    const same = readings.filter((r) => r.type === type && r.value != null);
    if (same.length < 2) return 'flat';
    const diff = (same[0].value ?? 0) - (same[1].value ?? 0);
    if (diff > 2) return 'up';
    if (diff < -2) return 'down';
    return 'flat';
  }

  const flaggedCount = filtered.filter((r) => r.flagged).length;

  return (
    <View>
      {/* Date range picker */}
      <DateRangePicker
        from={dateFrom}
        to={dateTo}
        onApply={(f, t) => { setDateFrom(f); setDateTo(t); setTypeFilter('all'); }}
        colors={colors}
      />

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : error ? (
        <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
          <Text style={{ color: colors.destructive, fontSize: 13 }}>{error}</Text>
        </Card>
      ) : !readings || readings.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
          <HeartPulse size={28} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
            No readings from {fmtRangeLabel(dateFrom)} to {fmtRangeLabel(dateTo)}.
          </Text>
        </Card>
      ) : (
        <>
          {/* Summary tiles per reading type */}
          {types.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4, marginBottom: 12 }}>
              {types.map((type) => {
                const r = summaryByType.get(type)!;
                const color = READING_COLORS[type];
                const Icon = READING_TYPE_ICONS[type];
                const t = trend(type);
                const typeReadings = readings.filter((x) => x.type === type);
                return (
                  <Pressable
                    key={type}
                    onPress={() => setTypeFilter(typeFilter === type ? 'all' : type)}
                    style={[rt.sumTile, {
                      backgroundColor: typeFilter === type ? color + '12' : colors.card,
                      borderColor: typeFilter === type ? color : colors.border,
                    }]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={[rt.sumIcon, { backgroundColor: color + '15' }]}>
                        <Icon size={13} color={color} strokeWidth={1.75} />
                      </View>
                      <Text style={[rt.sumLabel, { color: colors.textSecondary }]}>{r.label}</Text>
                    </View>
                    <Text style={[rt.sumValue, { color: color }]}>{r.displayValue}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      {t === 'up'   && <TrendingUp size={11} color="#DC2626" />}
                      {t === 'down' && <TrendingDown size={11} color="#059669" />}
                      <Text style={{ fontSize: 10, color: colors.textSecondary }}>
                        {typeReadings.length} readings
                      </Text>
                    </View>
                    <ReadingSparkline readings={typeReadings} color={color} />
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {/* Type filter chips */}
          {types.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginBottom: 12 }}>
              <Pressable
                onPress={() => setTypeFilter('all')}
                style={[rt.typeChip, { borderColor: typeFilter === 'all' ? colors.primary : colors.border, backgroundColor: typeFilter === 'all' ? colors.primary + '14' : 'transparent' }]}
              >
                <Text style={{ fontSize: 11.5, fontWeight: '600', color: typeFilter === 'all' ? colors.primary : colors.textSecondary }}>
                  All ({readings.length})
                </Text>
              </Pressable>
              {types.map((type) => (
                <Pressable
                  key={type}
                  onPress={() => setTypeFilter(typeFilter === type ? 'all' : type)}
                  style={[rt.typeChip, {
                    borderColor: typeFilter === type ? READING_COLORS[type] : colors.border,
                    backgroundColor: typeFilter === type ? READING_COLORS[type] + '14' : 'transparent',
                  }]}
                >
                  <Text style={{ fontSize: 11.5, fontWeight: '600', color: typeFilter === type ? READING_COLORS[type] : colors.textSecondary }}>
                    {summaryByType.get(type)?.label} ({readings.filter((r) => r.type === type).length})
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {/* Flagged alert */}
          {flaggedCount > 0 && (
            <View style={[rt.flagBanner, { backgroundColor: '#DC262612', borderColor: '#DC262640' }]}>
              <AlertTriangle size={14} color="#DC2626" />
              <Text style={{ color: '#DC2626', fontSize: 12.5, fontWeight: '700' }}>
                {flaggedCount} flagged reading{flaggedCount > 1 ? 's' : ''} in this period
              </Text>
            </View>
          )}

          {/* Readings list */}
          {filtered.map((r) => <ReadingCard key={r.id} reading={r} colors={colors} />)}
        </>
      )}
    </View>
  );
}
const rt = StyleSheet.create({
  sumTile:  { width: 160, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  sumIcon:  { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sumLabel: { fontSize: 10.5, fontWeight: '600' },
  sumValue: { fontSize: 18, fontWeight: '800', letterSpacing: -0.5 },
  typeChip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 6 },
  flagBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, marginBottom: 10 },
});

// ── Alerts Tab ─────────────────────────────────────────────────────────────

const ALERT_STATUS_FILTERS = ['all', 'open', 'escalated', 'resolved'] as const;

function AlertsTab({ patientId, colors }: { patientId: string; colors: any }) {
  const { session } = useAuth();
  const isSuperAdmin = session?.user.role === 'super_admin';

  const _today = new Date();
  const _todayISO    = toISO(_today);
  const _defaultFrom = toISO(new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - 89));

  const [dateFrom,      setDateFrom]      = useState(_defaultFrom);
  const [dateTo,        setDateTo]        = useState(_todayISO);
  const [allAlerts,     setAllAlerts]     = useState<AlertEvent[] | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [statusFilter,  setStatusFilter]  = useState<AlertStatus | 'all'>('all');
  const [busyIds,       setBusyIds]       = useState<Set<string>>(new Set());
  const [members,       setMembers]       = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [assignTarget,  setAssignTarget]  = useState<AlertEvent | null>(null);

  const loadAlerts = useCallback(() => {
    if (!session) return;
    setLoading(true);
    api.getPatientAlerts(session.token, patientId, dateFrom, dateTo)
      .then((r) => setAllAlerts(r.alerts))
      .catch(() => setAllAlerts([]))
      .finally(() => setLoading(false));
  }, [session, patientId, dateFrom, dateTo]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  useEffect(() => {
    if (!session || isSuperAdmin) return;
    api.listMembers(session.token).then((r) => setMembers(r.members)).catch(() => {});
  }, [session, isSuperAdmin]);

  const counts = {
    all:       allAlerts?.length ?? 0,
    open:      allAlerts?.filter((a) => a.status === 'open').length      ?? 0,
    escalated: allAlerts?.filter((a) => a.status === 'escalated').length ?? 0,
    resolved:  allAlerts?.filter((a) => a.status === 'resolved').length  ?? 0,
  };

  const displayed = allAlerts
    ? statusFilter === 'all' ? allAlerts : allAlerts.filter((a) => a.status === statusFilter)
    : null;

  async function doUpdate(id: string, patch: { status?: AlertStatus; assignedTo?: string | null }) {
    if (!session) return;
    setBusyIds((s) => new Set(s).add(id));
    try {
      const { alert: updated } = await api.updateAlert(session.token, id, patch);
      setAllAlerts((prev) => prev?.map((a) => a.id === id ? updated : a) ?? null);
    } catch {}
    finally { setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; }); }
  }

  async function openAssign(alert: AlertEvent) {
    setAssignTarget(alert);
    if (isSuperAdmin) {
      setMembersLoading(true);
      setMembers([]);
      try {
        const res = await api.listMembers(session!.token, { clinicName: alert.clinic_name });
        setMembers(res.members);
      } catch { setMembers([]); }
      finally { setMembersLoading(false); }
    }
  }

  if (loading) return <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />;

  if (!allAlerts || allAlerts.length === 0) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <CheckCircle2 size={28} color={colors.textSecondary} />
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>No alerts for this patient.</Text>
      </Card>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {/* Date range picker */}
      <DateRangePicker
        from={dateFrom}
        to={dateTo}
        onApply={(f, t) => { setDateFrom(f); setDateTo(t); setStatusFilter('all'); }}
        colors={colors}
      />

      {/* Status filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 4 }}>
        {ALERT_STATUS_FILTERS.map((s) => {
          const active = statusFilter === s;
          const count  = counts[s];
          return (
            <Pressable
              key={s}
              onPress={() => setStatusFilter(s)}
              style={[at.chip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary : colors.card }]}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#052B00' : colors.textSecondary }}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Text>
              {count > 0 && (
                <View style={[at.chipBadge, { backgroundColor: active ? 'rgba(255,255,255,0.28)' : colors.primary + '20' }]}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: active ? '#fff' : colors.primary }}>{count}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Alert list */}
      {displayed?.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>No {statusFilter} alerts.</Text>
        </Card>
      ) : displayed?.map((a) => {
        const isCritical  = a.tier === 'CRITICAL';
        const isResolved  = a.status === 'resolved';
        const isEscalated = a.status === 'escalated';
        const tierColor   = isCritical ? '#DC2626' : '#D97706';
        const tierBg      = tierColor + '18';
        const stripeColor = isResolved ? '#16a34a' : isEscalated ? '#D97706' : tierColor;
        const busy        = busyIds.has(a.id);

        return (
          <View key={a.id} style={[at.card, { backgroundColor: colors.card, borderColor: colors.border }, isResolved && { opacity: 0.72 }]}>
            <View style={[at.stripe, { backgroundColor: stripeColor }]} />
            <View style={at.body}>
              {/* Top row: tier badge + status */}
              <View style={at.topRow}>
                <View style={[at.tierBadge, { backgroundColor: tierBg }]}>
                  {isCritical ? <Zap size={10} color={tierColor} /> : <AlertTriangle size={10} color={tierColor} />}
                  <Text style={[at.tierText, { color: tierColor }]}>{a.tier}</Text>
                </View>
                <StatusPill tone={alertStatusTone(a.status)}>
                  {a.status.charAt(0).toUpperCase() + a.status.slice(1)}
                </StatusPill>
              </View>

              {/* Alert type + reading */}
              <Text style={[at.alertType, { color: colors.text }]}>{a.alert_type}</Text>

              <View style={at.readingRow}>
                <View style={[at.readingBox, { backgroundColor: tierBg, borderColor: tierColor + '40' }]}>
                  <Text style={[at.readingUnit, { color: colors.textSecondary }]}>{a.alert_type}</Text>
                  <Text style={[at.readingValue, { color: tierColor }]}>
                    {a.value} <Text style={{ fontSize: 13, fontWeight: '500' }}>{a.unit}</Text>
                  </Text>
                  <Text style={[at.threshold, { color: colors.textSecondary }]}>threshold {a.threshold} {a.unit}</Text>
                </View>
                <View style={at.metaCol}>
                  <Text style={[at.metaLabel, { color: colors.textSecondary }]}>Detected</Text>
                  <Text style={[at.metaValue, { color: colors.text }]}>{timeAgo(a.reading_time ?? a.created_at)}</Text>
                  {a.assignee && (
                    <>
                      <Text style={[at.metaLabel, { color: colors.textSecondary, marginTop: 8 }]}>Assigned to</Text>
                      <Text style={[at.metaValue, { color: colors.text }]} numberOfLines={1}>{a.assignee.name}</Text>
                    </>
                  )}
                  {isResolved && a.resolved_at && (
                    <>
                      <Text style={[at.metaLabel, { color: colors.textSecondary, marginTop: 8 }]}>Resolved</Text>
                      <Text style={[at.metaValue, { color: '#16a34a' }]}>{timeAgo(a.resolved_at)}</Text>
                    </>
                  )}
                </View>
              </View>

              {/* Resolved banner */}
              {isResolved && (
                <View style={at.resolvedBanner}>
                  <CheckCircle2 size={13} color="#16a34a" />
                  <Text style={at.resolvedText}>Resolved{a.resolved_at ? ` · ${timeAgo(a.resolved_at)}` : ''}</Text>
                </View>
              )}

              {/* Action buttons */}
              {!isResolved && (
                <View style={at.actionRow}>
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <>
                      {a.status === 'open' && (
                        <Pressable onPress={() => openAssign(a)} style={[at.actionBtn, { borderColor: colors.border }]}>
                          <UserPlus size={12} color={colors.primary} />
                          <Text style={{ fontSize: 11.5, fontWeight: '700', color: colors.primary }}>Assign</Text>
                        </Pressable>
                      )}
                      {!isEscalated && (
                        <Pressable onPress={() => doUpdate(a.id, { status: 'escalated' })} style={[at.actionBtn, { borderColor: colors.border }]}>
                          <AlertTriangle size={12} color="#D97706" />
                          <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#D97706' }}>Escalate</Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => doUpdate(a.id, { status: 'resolved' })} style={[at.actionBtn, { borderColor: colors.border, backgroundColor: '#16a34a15' }]}>
                        <CheckCircle2 size={12} color="#16a34a" />
                        <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#16a34a' }}>Resolve</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              )}
            </View>
          </View>
        );
      })}

      {/* Assign modal */}
      <Modal visible={assignTarget !== null} transparent animationType="slide" onRequestClose={() => setAssignTarget(null)}>
        <Pressable style={at.backdrop} onPress={() => setAssignTarget(null)}>
          <Pressable style={[at.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={at.sheetHead}>
              <Text style={[at.sheetTitle, { color: colors.text }]}>Assign alert</Text>
              <Pressable onPress={() => setAssignTarget(null)} hitSlop={10}>
                <X size={18} color={colors.textSecondary} />
              </Pressable>
            </View>
            {assignTarget && (
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }} numberOfLines={2}>
                {assignTarget.alert_type} · {assignTarget.value} {assignTarget.unit}
              </Text>
            )}
            <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
              <Pressable
                onPress={() => { if (assignTarget) { doUpdate(assignTarget.id, { status: 'assigned', assignedTo: session?.user.id }); setAssignTarget(null); } }}
                style={[at.memberRow, { borderColor: colors.border }]}
              >
                <View style={[at.memberAvatar, { backgroundColor: colors.primary + '20' }]}>
                  <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>ME</Text>
                </View>
                <Text style={{ fontSize: 13.5, fontWeight: '700', color: colors.primary }}>Assign to myself</Text>
              </Pressable>
              {membersLoading ? (
                <ActivityIndicator color={colors.primary} style={{ paddingVertical: 20 }} />
              ) : members.filter((m) => m.id !== session?.user.id).map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => { doUpdate(assignTarget!.id, { status: 'assigned', assignedTo: m.id }); setAssignTarget(null); }}
                  style={[at.memberRow, { borderColor: colors.border }]}
                >
                  <View style={[at.memberAvatar, { backgroundColor: colors.primary + '15' }]}>
                    <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '700' }}>
                      {m.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{m.name}</Text>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>{m.role.replace('_', ' ')}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const at = StyleSheet.create({
  chip:          { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  chipBadge:     { minWidth: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  card:          { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  stripe:        { width: 4 },
  body:          { flex: 1, padding: 13, gap: 6 },
  topRow:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tierBadge:     { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  tierText:      { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.4 },
  alertType:     { fontSize: 14, fontWeight: '800', marginTop: 2 },
  readingRow:    { flexDirection: 'row', gap: 10, marginTop: 6 },
  readingBox:    { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 2 },
  readingUnit:   { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  readingValue:  { fontSize: 20, fontWeight: '800' },
  threshold:     { fontSize: 10.5, marginTop: 2 },
  metaCol:       { width: 100, gap: 2 },
  metaLabel:     { fontSize: 9.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  metaValue:     { fontSize: 12, fontWeight: '700' },
  resolvedBanner:{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#16a34a18', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginTop: 2 },
  resolvedText:  { color: '#16a34a', fontSize: 11.5, fontWeight: '700' },
  actionRow:     { flexDirection: 'row', gap: 7, marginTop: 8, flexWrap: 'wrap' },
  actionBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  backdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet:         { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingBottom: 36 },
  sheetHead:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle:    { fontSize: 16, fontWeight: '800' },
  memberRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  memberAvatar:  { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});

// ── Review Time Tab ────────────────────────────────────────────────────────

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const hh = h > 0 ? `${h < 10 ? '0' : ''}${h}:` : '';
  return `${hh}${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function fmtReviewDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const SOURCE_META: Record<string, { label: string; color: string }> = {
  smartmeter_sync: { label: 'SmartMeter', color: '#0284C7' },
  manual:          { label: 'Manual',     color: '#7C3AED' },
  profile_view:    { label: 'Profile View', color: '#059669' },
  n8n_agent:       { label: 'Agent',      color: '#D97706' },
  call:            { label: 'Call',       color: '#0EA5E9' },
};

function SourceBadge({ source, callDirection }: { source: string; callDirection?: string | null }) {
  const meta = SOURCE_META[source] ?? { label: source, color: '#6B7280' };
  const label = source === 'call' && callDirection
    ? `${meta.label} · ${callDirection === 'inbound' ? 'Inbound' : 'Outbound'}`
    : meta.label;
  return (
    <View style={[rv.sourceBadge, { backgroundColor: meta.color + '18' }]}>
      <Text style={[rv.sourceText, { color: meta.color }]}>{label}</Text>
    </View>
  );
}

// ── Manual review modal ────────────────────────────────────────────────────

type LogMode = 'timer' | 'direct';

function ManualReviewModal({
  visible, onClose, onSave, colors,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (durationSeconds: number, note: string, patientInteraction: boolean) => Promise<void>;
  colors: any;
}) {
  const [mode, setMode] = useState<LogMode>('timer');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [directMins, setDirectMins] = useState('');
  const [note, setNote] = useState('');
  const [patientInteraction, setPatientInteraction] = useState(false);
  const [saving, setSaving] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset state each time modal opens
  useEffect(() => {
    if (visible) {
      setMode('timer');
      setRunning(false);
      setElapsed(0);
      setDirectMins('');
      setNote('');
      setPatientInteraction(false);
      setSaving(false);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [visible]);

  function startTimer() {
    setElapsed(0);
    setRunning(true);
    intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }

  function stopTimer() {
    setRunning(false);
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }

  async function handleSave() {
    let secs = 0;
    if (mode === 'timer') {
      secs = elapsed;
      if (running) stopTimer();
    } else {
      secs = Math.round(parseFloat(directMins || '0') * 60);
    }
    if (secs < 1) return;
    setSaving(true);
    try {
      await onSave(secs, note, patientInteraction);
      onClose();
    } finally { setSaving(false); }
  }

  // Closing the sheet while the live timer has accumulated time (running or
  // stopped-but-unsaved) must not silently discard it — auto-save it first,
  // same as the passive profile-view timer does on navigating away.
  async function handleClose() {
    if (mode === 'timer' && elapsed >= 1) {
      if (running) stopTimer();
      setSaving(true);
      try {
        await onSave(elapsed, note, patientInteraction);
      } finally { setSaving(false); }
    }
    onClose();
  }

  const canSave = mode === 'timer' ? elapsed >= 1 : parseFloat(directMins || '0') > 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={rv.backdrop} onPress={handleClose}>
        <Pressable style={[rv.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Header */}
          <View style={rv.sheetHead}>
            <Text style={[rv.sheetTitle, { color: colors.text }]}>Log Review Time</Text>
            <Pressable onPress={handleClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>

          {/* Mode switcher */}
          <View style={[rv.modeSwitcher, { borderColor: colors.border }]}>
            {(['timer', 'direct'] as LogMode[]).map((m) => (
              <Pressable
                key={m}
                onPress={() => { setMode(m); if (running) stopTimer(); }}
                style={[rv.modeBtn, mode === m && { backgroundColor: colors.primary }]}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: mode === m ? '#052B00' : colors.textSecondary }}>
                  {m === 'timer' ? 'Live Timer' : 'Enter Minutes'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Timer mode */}
          {mode === 'timer' && (
            <View style={{ alignItems: 'center', gap: 14, paddingVertical: 10 }}>
              <Text style={[rv.timerDisplay, { color: running ? colors.primary : colors.text }]}>
                {fmtDuration(elapsed)}
              </Text>
              <Pressable
                onPress={running ? stopTimer : startTimer}
                style={[rv.timerBtn, { backgroundColor: running ? '#DC2626' : colors.primary }]}
              >
                {running
                  ? <><Square size={14} color="#fff" fill="#fff" /><Text style={rv.timerBtnText}>Stop</Text></>
                  : <><Play size={14} color="#052B00" fill="#052B00" /><Text style={[rv.timerBtnText, { color: '#052B00' }]}>Start</Text></>
                }
              </Pressable>
              {elapsed >= 1 && (
                <Text style={{ fontSize: 11, color: colors.textSecondary }}>Closing this panel saves the timer</Text>
              )}
            </View>
          )}

          {/* Direct minutes mode */}
          {mode === 'direct' && (
            <View style={{ paddingVertical: 10, gap: 8 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>Minutes</Text>
              <TextInput
                value={directMins}
                onChangeText={setDirectMins}
                keyboardType="decimal-pad"
                placeholder="e.g. 2.5"
                placeholderTextColor={colors.textSecondary}
                style={[rv.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
            </View>
          )}

          {/* Note */}
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>Note (optional)</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Care management note…"
              placeholderTextColor={colors.textSecondary}
              multiline
              numberOfLines={2}
              style={[rv.input, rv.noteInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />
          </View>

          {/* Patient interaction toggle */}
          <Pressable
            onPress={() => setPatientInteraction((p) => !p)}
            style={[rv.toggleRow, { borderColor: colors.border }]}
          >
            <View style={[rv.toggleBox, { borderColor: colors.primary, backgroundColor: patientInteraction ? colors.primary : 'transparent' }]}>
              {patientInteraction && <Text style={{ color: '#052B00', fontSize: 10, fontWeight: '800' }}>✓</Text>}
            </View>
            <Text style={{ fontSize: 13, color: colors.text }}>Patient interaction occurred</Text>
          </Pressable>

          {/* Save button */}
          <Pressable
            onPress={handleSave}
            disabled={!canSave || saving}
            style={[rv.saveBtn, { backgroundColor: canSave && !saving ? colors.primary : colors.border }]}
          >
            {saving
              ? <ActivityIndicator size="small" color="#052B00" />
              : <Text style={{ color: '#052B00', fontWeight: '800', fontSize: 14 }}>Save Review Time</Text>
            }
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Notes Tab ──────────────────────────────────────────────────────────────

function NotesTab({ patientId, colors }: { patientId: string; colors: any }) {
  const { session } = useAuth();
  const [notes, setNotes]     = useState<CareNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listNotes(session.token, { patientId })
      .then((r) => { if (!cancelled) setNotes(r.notes); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load notes'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session, patientId]);

  if (loading) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>Loading notes…</Text>
      </Card>
    );
  }

  if (error) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <AlertTriangle size={22} color="#DC2626" />
        <Text style={[rv.emptyTitle, { color: colors.text }]}>Could not load notes</Text>
        <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>{error}</Text>
      </Card>
    );
  }

  if (notes.length === 0) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <FileText size={26} color={colors.textSecondary} />
        <Text style={[rv.emptyTitle, { color: colors.text }]}>No Notes Yet</Text>
        <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>
          AI call summaries and clinical notes will appear here.
        </Text>
      </Card>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {notes.map((note) => {
        const content = note.content as { summary?: string; call_direction?: string };
        return (
          <Card key={note.id} style={{ gap: 8, borderColor: colors.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {note.ai_generated && (
                <View style={[nv.badge, { backgroundColor: '#0EA5E918' }]}>
                  <Sparkles size={10} color="#0EA5E9" />
                  <Text style={[nv.badgeText, { color: '#0EA5E9' }]}>AI Generated</Text>
                </View>
              )}
              {note.note_type === 'call_summary' && content.call_direction && (
                <View style={[nv.badge, { backgroundColor: '#7C3AED18' }]}>
                  <Text style={[nv.badgeText, { color: '#7C3AED' }]}>
                    {content.call_direction === 'inbound' ? 'Inbound Call' : 'Outbound Call'}
                  </Text>
                </View>
              )}
              <Text style={[nv.date, { color: colors.textSecondary }]}>
                {fmtReviewDate(note.created_at)}
              </Text>
            </View>
            <Text style={[nv.body, { color: colors.text }]}>
              {content.summary ?? 'No summary available.'}
            </Text>
            <Text style={[nv.author, { color: colors.textSecondary }]}>
              {note.author_name ? `Logged by ${note.author_name}` : ''}
            </Text>
          </Card>
        );
      })}
    </View>
  );
}

const nv = StyleSheet.create({
  badge:     { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  date:      { fontSize: 11, marginLeft: 'auto' },
  body:      { fontSize: 13.5, lineHeight: 19 },
  author:    { fontSize: 11.5, fontStyle: 'italic' },
});

function ReviewTimeTab({
  patientId, colors, onNewEntry, onViewNote,
}: {
  patientId: string; colors: any;
  onNewEntry?: (entry: ReviewTimeEntry) => void;
  onViewNote?: (commLogId: string) => void;
}) {
  const { session } = useAuth();
  const role = session?.user.role;
  const canDelete = role === 'super_admin' || role === 'clinic_admin' || role === 'staff';
  const canLog    = role === 'super_admin' || role === 'clinic_admin' || role === 'staff';

  const [entries, setEntries] = useState<ReviewTimeEntry[]>([]);
  const [notedCommLogIds, setNotedCommLogIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showLogModal, setShowLogModal] = useState(false);

  const loadEntries = useCallback(() => {
    if (!session) return;
    setLoading(true);
    setError(null);
    api.getPatientReviewTime(session.token, patientId)
      .then((r) => setEntries(r.reviewTimes))
      .catch((e) => setError(e?.message ?? 'Failed to load review time'))
      .finally(() => setLoading(false));
    // Best-effort — a review-time entry just renders without a "View Note"
    // link if this fails, no need to block the tab on it.
    api.listNotes(session.token, { patientId })
      .then((r) => setNotedCommLogIds(new Set(r.notes.map((n) => n.comm_log_id).filter((id): id is string => !!id))))
      .catch(() => {});
  }, [session, patientId]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  async function handleDelete(entryId: string) {
    if (!session) return;
    setDeletingId(entryId);
    try {
      const result = await api.deletePatientReviewTime(session.token, patientId, entryId);
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      if (result.tenoviNote) {
        setInfoMsg(result.tenoviNote);
        setTimeout(() => setInfoMsg(null), 6000);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete entry');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleLogSave(durationSeconds: number, note: string, patientInteraction: boolean) {
    if (!session) return;
    const { entry } = await api.logManualReview(session.token, patientId, {
      duration_seconds: durationSeconds,
      note:             note || undefined,
      patient_interaction: patientInteraction,
    });
    setEntries((prev) => [entry, ...prev]);
    if (onNewEntry) onNewEntry(entry);
  }

  if (loading) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>Loading review sessions…</Text>
      </Card>
    );
  }

  if (error) {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
        <AlertTriangle size={22} color="#DC2626" />
        <Text style={[rv.emptyTitle, { color: colors.text }]}>Could not load review time</Text>
        <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>{error}</Text>
      </Card>
    );
  }

  const totalSeconds = entries.reduce((s, e) => s + (e.duration_seconds ?? 0), 0);

  return (
    <View style={{ gap: 10 }}>
      {!!infoMsg && (
        <View style={[rv.infoBanner, { backgroundColor: colors.primary + '14', borderColor: colors.primary + '33' }]}>
          <Text style={[rv.infoBannerText, { color: colors.text }]}>{infoMsg}</Text>
        </View>
      )}
      {/* Log button */}
      {canLog && (
        <Pressable
          onPress={() => setShowLogModal(true)}
          style={[rv.logBtn, { backgroundColor: colors.primary }]}
        >
          <Timer size={14} color="#052B00" />
          <Text style={{ color: '#052B00', fontWeight: '800', fontSize: 13 }}>Log Review Time</Text>
        </Pressable>
      )}

      {entries.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
          <Timer size={26} color={colors.textSecondary} />
          <Text style={[rv.emptyTitle, { color: colors.text }]}>No Review Time Logged</Text>
          <Text style={[rv.emptyBody, { color: colors.textSecondary }]}>
            Use the button above to log a review session, or wait for the monitoring agent.
          </Text>
        </Card>
      ) : (
        <>
          {/* Summary banner */}
          <Card style={[rv.summaryRow, { borderColor: colors.border }]}>
            <View style={rv.summaryItem}>
              <Text style={[rv.summaryNum, { color: colors.text }]}>{entries.length}</Text>
              <Text style={[rv.summaryLabel, { color: colors.textSecondary }]}>Sessions</Text>
            </View>
            <View style={[rv.divider, { backgroundColor: colors.border }]} />
            <View style={rv.summaryItem}>
              <Text style={[rv.summaryNum, { color: colors.text }]}>{fmtDuration(totalSeconds)}</Text>
              <Text style={[rv.summaryLabel, { color: colors.textSecondary }]}>Total Time</Text>
            </View>
          </Card>

          {/* Header row */}
          <View style={[rv.headerRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[rv.headerCell, rv.colDate,     { color: colors.textSecondary }]}>DATE</Text>
            <Text style={[rv.headerCell, rv.colDuration, { color: colors.textSecondary }]}>DURATION</Text>
            <Text style={[rv.headerCell, rv.colBy,       { color: colors.textSecondary }]}>LOGGED BY</Text>
            {canDelete && <View style={rv.colAction} />}
          </View>

          {/* Rows */}
          {entries.map((entry) => (
            <View
              key={entry.id}
              style={[rv.rowWrap, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={rv.row}>
                <View style={rv.colDate}>
                  <Text style={[rv.cellDate, { color: colors.text }]}>
                    {fmtReviewDate(entry.clock_start)}
                  </Text>
                  <SourceBadge source={entry.source ?? 'smartmeter_sync'} callDirection={entry.call_direction} />
                  {entry.patient_interaction && (
                    <View style={rv.interactionBadge}>
                      <Text style={rv.interactionText}>Patient Contact</Text>
                    </View>
                  )}
                </View>
                <View style={rv.colDuration}>
                  <Text style={[rv.cellDuration, { color: colors.primary }]}>
                    {fmtDuration(entry.duration_seconds ?? 0)}
                  </Text>
                </View>
                <View style={rv.colBy}>
                  <Text style={[rv.cellBy, { color: colors.text }]} numberOfLines={2}>
                    {entry.logged_by ?? '—'}
                  </Text>
                </View>
                {canDelete && (
                  <Pressable
                    onPress={() => handleDelete(entry.id)}
                    disabled={deletingId === entry.id}
                    style={rv.colAction}
                  >
                    {deletingId === entry.id
                      ? <ActivityIndicator size="small" color="#DC2626" />
                      : <X size={14} color="#DC2626" />
                    }
                  </Pressable>
                )}
              </View>
              {!!entry.note && (
                <View style={[rv.noteWrap, { borderTopColor: colors.border }]}>
                  <Text style={[rv.noteText, { color: colors.textSecondary }]}>
                    {entry.note}
                  </Text>
                  {!!entry.comm_log_id && notedCommLogIds.has(entry.comm_log_id) && (
                    <Pressable onPress={() => onViewNote?.(entry.comm_log_id!)} style={rv.viewNoteBtn}>
                      <FileText size={11} color={colors.primary} />
                      <Text style={[rv.viewNoteText, { color: colors.primary }]}>View note</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          ))}
        </>
      )}

      <ManualReviewModal
        visible={showLogModal}
        onClose={() => setShowLogModal(false)}
        onSave={handleLogSave}
        colors={colors}
      />
    </View>
  );
}

const rv = StyleSheet.create({
  emptyTitle:     { fontSize: 14, fontWeight: '700' },
  emptyBody:      { fontSize: 12.5, textAlign: 'center', maxWidth: 260 },
  summaryRow:     { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 },
  summaryItem:    { alignItems: 'center', gap: 2 },
  summaryNum:     { fontSize: 18, fontWeight: '800' },
  summaryLabel:   { fontSize: 11, fontWeight: '600' },
  divider:        { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  headerRow:      { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 7, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  headerCell:     { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  rowWrap:        { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  row:            { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, alignItems: 'flex-start' },
  noteWrap:       { paddingHorizontal: 12, paddingBottom: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  noteText:       { fontSize: 12, lineHeight: 17 },
  viewNoteBtn:    { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  viewNoteText:   { fontSize: 11.5, fontWeight: '700' },
  colDate:        { flex: 2.2, gap: 3 },
  colDuration:    { flex: 1.2, alignItems: 'center', textAlign: 'center' },
  colBy:          { flex: 1.6 },
  cellDate:       { fontSize: 12, fontWeight: '500' },
  interactionBadge: { backgroundColor: '#0284C715', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  interactionText:  { fontSize: 9, fontWeight: '700', color: '#0284C7' },
  cellDuration:   { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  cellBy:         { fontSize: 12 },
  colAction:      { width: 28, alignItems: 'center', justifyContent: 'center', paddingTop: 2 },
  sourceBadge:    { borderRadius: 999, paddingHorizontal: 5, paddingVertical: 2, alignSelf: 'flex-start' },
  sourceText:     { fontSize: 9, fontWeight: '700' },
  logBtn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 11, borderRadius: 12 },
  infoBanner:     { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
  infoBannerText: { fontSize: 12, lineHeight: 17 },
  // Modal styles
  backdrop:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet:          { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingBottom: 36, gap: 14 },
  sheetHead:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle:     { fontSize: 16, fontWeight: '800' },
  modeSwitcher:   { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  modeBtn:        { flex: 1, paddingVertical: 9, alignItems: 'center' },
  timerDisplay:   { fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -1 },
  timerBtn:       { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 },
  timerBtnText:   { color: '#fff', fontSize: 15, fontWeight: '700' },
  input:          { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  noteInput:      { minHeight: 60, textAlignVertical: 'top' },
  toggleRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12 },
  toggleBox:      { width: 18, height: 18, borderWidth: 2, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  saveBtn:        { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
});

// ── Report Tab ─────────────────────────────────────────────────────────────

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── Exported Billing Tab ───────────────────────────────────────────────────

function ExportedBillingTab({ patient, token, colors }: { patient: Patient; token: string; colors: any }) {
  const [reports, setReports]     = useState<ExportedBillingReport[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null); // cycle_start being exported

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.getExportedBillingReports(token, patient.id);
      setReports(data.reports);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load exported reports');
    } finally { setLoading(false); }
  }, [token, patient.id]);

  useEffect(() => { load(); }, [load]);

  const buildBillingHtml = (r: PatientReport, cycleStart: string, cycleEnd: string): string => {
    const p = r.patient;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const billingRows = r.billingRecords.map((rec) =>
      `<tr style="background:${r.billingRecords.indexOf(rec) % 2 === 0 ? '#fff' : '#f9f9f9'}">
        <td style="padding:5px 8px;border-bottom:1px solid #ddd">${esc(rec.cpt_code)}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #ddd">${esc(rec.program ?? '—')}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #ddd">${esc(rec.dos ?? '—')}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right">${rec.units ?? 1}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right">${rec.projected_amount != null ? `$${Number(rec.projected_amount).toFixed(2)}` : '—'}</td>
      </tr>`
    ).join('');

    const totalProjected = r.billingRecords.reduce((s, rec) => s + (Number(rec.projected_amount) || 0), 0);
    const cats = r.categories;
    const totalMinutes = cats.reduce((s, c) => s + c.totalMinutes, 0);
    const totalReadings = cats.reduce((s, c) => Math.max(s, c.readingCount), 0);
    const cptList = [...new Set(r.billingRecords.map((rec) => rec.cpt_code))].join(', ');

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#000;background:#fff;padding:20px}
      h1{font-size:16px;font-weight:700;margin-bottom:2px}
      .subtitle{font-size:10px;color:#555;margin-bottom:14px}
      .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;margin-bottom:14px;font-size:11px}
      .meta-label{color:#555}
      .meta-value{font-weight:600}
      .summary-box{display:flex;gap:16px;border:1px solid #000;padding:10px;margin-bottom:14px}
      .sum-item{flex:1;text-align:center}
      .sum-val{font-size:15px;font-weight:800}
      .sum-lbl{font-size:9px;color:#555;margin-top:2px}
      table{width:100%;border-collapse:collapse;font-size:11px}
      thead th{background:#000;color:#fff;padding:6px 8px;text-align:left;font-size:11px}
      thead th:last-child,thead th:nth-child(4){text-align:right}
      .footer{border-top:1px solid #000;padding-top:8px;font-size:9px;text-align:center;color:#555;margin-top:16px}
      @media print{body{padding:8px}@page{size:A4 portrait;margin:1.2cm}}
    </style></head><body>
    <div style="border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px">
      <h1>RPMCARES — PATIENT BILLING EXPORT</h1>
      <div class="subtitle">Cycle Report · Auto-generated at cycle end · For billing review only</div>
    </div>
    <div class="meta-grid">
      <div><span class="meta-label">Patient: </span><span class="meta-value">${esc(p.full_name)}</span></div>
      <div><span class="meta-label">MRN: </span><span class="meta-value">${esc(p.mrn ?? '—')}</span></div>
      <div><span class="meta-label">DOB: </span><span class="meta-value">${esc(p.dob ?? '—')}</span></div>
      <div><span class="meta-label">Program: </span><span class="meta-value">${esc(p.program ?? '—')}</span></div>
      <div><span class="meta-label">Insurance: </span><span class="meta-value">${esc(p.insurance_payer ?? '—')}</span></div>
      <div><span class="meta-label">Clinic: </span><span class="meta-value">${esc(r.clinic.name ?? '—')}</span></div>
      <div><span class="meta-label">Billing Cycle: </span><span class="meta-value">${esc(cycleStart)} → ${esc(cycleEnd)}</span></div>
      <div><span class="meta-label">Generated: </span><span class="meta-value">${new Date().toLocaleString('en-US')}</span></div>
    </div>
    <div class="summary-box">
      <div class="sum-item"><div class="sum-val">${totalMinutes}</div><div class="sum-lbl">TOTAL MIN</div></div>
      <div class="sum-item"><div class="sum-val">${totalReadings}</div><div class="sum-lbl">READINGS</div></div>
      <div class="sum-item"><div class="sum-val">${r.billingRecords.length}</div><div class="sum-lbl">CPT CODES</div></div>
      <div class="sum-item"><div class="sum-val">$${totalProjected.toFixed(2)}</div><div class="sum-lbl">PROJECTED</div></div>
    </div>
    ${r.billingRecords.length > 0 ? `
    <table>
      <thead><tr>
        <th>CPT Code</th><th>Program</th><th>DOS</th><th style="text-align:right">Units</th><th style="text-align:right">Projected</th>
      </tr></thead>
      <tbody>${billingRows}</tbody>
      <tfoot><tr>
        <td colspan="4" style="padding:6px 8px;font-weight:700;border-top:2px solid #000">Total Projected</td>
        <td style="padding:6px 8px;font-weight:700;border-top:2px solid #000;text-align:right">$${totalProjected.toFixed(2)}</td>
      </tr></tfoot>
    </table>` : '<p style="color:#555;font-style:italic;font-size:11px">No billing records for this cycle.</p>'}
    <div class="footer">CONFIDENTIAL — For internal billing review only. Not a clinical record.</div>
    </body></html>`;
  };

  const generatePdf = async (rep: ExportedBillingReport) => {
    setExporting(rep.cycle_start);
    try {
      const data = await api.getPatientReportByCycle(token, patient.id, rep.cycle_start);
      const html = buildBillingHtml(data, rep.cycle_start, rep.cycle_end);
      if (typeof window !== 'undefined') {
        openReportForDownload(html);
      } else {
        const Print = await import('expo-print');
        const Sharing = await import('expo-sharing');
        const { uri } = await Print.printToFileAsync({ html, base64: false });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `${patient.full_name} Billing ${rep.cycle_start}`, UTI: 'com.adobe.pdf' });
        }
      }
    } catch (e: any) {
      console.warn('[exported-billing] PDF failed:', e.message);
    } finally { setExporting(null); }
  };

  if (loading) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 40 }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 8, fontSize: 13 }}>Loading exported reports…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <Card style={{ gap: 8, alignItems: 'center', paddingVertical: 24 }}>
        <Text style={{ color: colors.critical, fontSize: 13 }}>{error}</Text>
        <Pressable onPress={load} style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.primary, borderRadius: 8 }}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Retry</Text>
        </Pressable>
      </Card>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>Exported Billing Reports</Text>
          <Pressable onPress={load} style={{ padding: 6 }}>
            <RefreshCw size={14} color={colors.primary} />
          </Pressable>
        </View>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
          One report is auto-generated for each completed billing cycle. Tap a row to regenerate the PDF.
        </Text>
      </Card>

      {reports.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
          <FileText size={32} color={colors.textSecondary} strokeWidth={1.25} />
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 10, textAlign: 'center' }}>
            No exported billing reports yet.{'\n'}Reports are created automatically when a billing cycle ends.
          </Text>
        </Card>
      ) : (
        reports.map((rep) => {
          const isExporting = exporting === rep.cycle_start;
          return (
            <Card key={rep.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>
                    Cycle {rep.cycle_start} → {rep.cycle_end}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                    Exported {fmtDateTime(rep.generated_at)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => generatePdf(rep)}
                  disabled={isExporting}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    backgroundColor: colors.surface, borderColor: colors.primary, borderWidth: 1,
                    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
                    opacity: isExporting ? 0.5 : 1,
                  }}
                >
                  <Download size={12} color={colors.primary} />
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>
                    {isExporting ? 'Generating…' : 'PDF'}
                  </Text>
                </Pressable>
              </View>
            </Card>
          );
        })
      )}
    </View>
  );
}

// ── Report Tab ─────────────────────────────────────────────────────────────

function ReportTab({ patient, token, colors }: { patient: Patient; token: string; colors: any }) {
  const [month, setMonth]             = useState(currentMonth());
  const [report, setReport]           = useState<PatientReport | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [planEdit, setPlanEdit]       = useState('');
  const [editingPlan, setEditingPlan] = useState(false);
  const [savingPlan, setSavingPlan]   = useState(false);
  const [planError, setPlanError]     = useState<string | null>(null);
  const [exporting, setExporting]     = useState(false);

  const planText = (c: CarePlan['content'] | null | undefined): string => {
    if (!c) return '';
    if (typeof c === 'string') return c;
    return (c as any).text ?? JSON.stringify(c);
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.getPatientReport(token, patient.id, month);
      setReport(data);
      setPlanEdit(planText(data.carePlan?.content));
    } catch (e: any) {
      setError(e.message ?? 'Failed to load report');
    } finally { setLoading(false); }
  }, [token, patient.id, month]);

  useEffect(() => { load(); }, [load]);

  const savePlan = async () => {
    setSavingPlan(true); setPlanError(null);
    try {
      if (report?.carePlan?.id) {
        await api.updateNote(token, report.carePlan.id, { content: planEdit });
      } else {
        await api.createNote(token, {
          patient_id: patient.id,
          clinic_id:  patient.clinic_id,
          note_type:  'care_plan',
          content:    planEdit,
          cpt_codes:  [],
        });
      }
      setEditingPlan(false);
      load();
    } catch (e: any) {
      setPlanError(e.message ?? 'Save failed');
    } finally { setSavingPlan(false); }
  };

  // ── HTML builder — formal B&W, only programs with activity ──────────────
  const buildHtml = (r: PatientReport): string => {
    const p   = r.patient;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const noteText = (raw: any): string =>
      typeof raw === 'string' ? raw : (raw as any)?.text ?? JSON.stringify(raw ?? '');

    // Only include programs that have at least some time, readings, notes, or billing records
    const activeCats = r.categories.filter(
      (cat) => cat.totalMinutes > 0 || cat.readingCount > 0 || cat.notesCount > 0 || cat.billingRecords.length > 0,
    );

    const catRows = activeCats.map((cat, idx) => {
      const notesHtml = cat.notes.length === 0
        ? '<tr><td colspan="4" style="padding:8px;color:#555;font-style:italic;font-size:11px">(no documentation this period)</td></tr>'
        : cat.notes.map((n) => {
            const txt = noteText(n.content);
            return `<tr style="background:${cat.notes.indexOf(n) % 2 === 0 ? '#fff' : '#f9f9f9'}">
              <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;white-space:nowrap">${esc(n.dos ?? '—')}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px">${esc(n.status.toUpperCase())}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px">${esc(n.author_name ?? '—')}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;white-space:pre-wrap">${esc(txt.slice(0, 400))}${txt.length > 400 ? '…' : ''}</td>
            </tr>`;
          }).join('');

      const billingHtml = cat.billingRecords.length > 0
        ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc">
            <div style="font-size:10px;font-weight:700;color:#555;margin-bottom:4px;letter-spacing:.5px">BILLING RECORDS</div>
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead><tr>
                <th style="text-align:left;background:#000;color:#fff;padding:4px 8px">CPT</th>
                <th style="text-align:left;background:#000;color:#fff;padding:4px 8px">DOS</th>
                <th style="text-align:right;background:#000;color:#fff;padding:4px 8px">Units</th>
                <th style="text-align:right;background:#000;color:#fff;padding:4px 8px">Projected</th>
              </tr></thead>
              <tbody>${cat.billingRecords.map((rec, i) =>
                `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
                  <td style="padding:4px 8px;border-bottom:1px solid #eee;font-weight:700">${esc(rec.cpt_code)}</td>
                  <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(rec.dos ?? '—')}</td>
                  <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${rec.units ?? 1}</td>
                  <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${rec.projected_amount != null ? `$${Number(rec.projected_amount).toFixed(2)}` : '—'}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : '';

      return `<div style="margin-bottom:14px;border:1px solid #000;break-inside:avoid">
        <div style="background:#000;color:#fff;padding:7px 12px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;font-weight:700">${esc(cat.label)}</span>
          <span style="font-size:11px;font-weight:700">${cat.thresholdMet ? `MET ✓  ≥${cat.thresholdMinutes} min` : `NOT MET  ≥${cat.thresholdMinutes} min`}</span>
        </div>
        <div style="padding:8px 12px;background:#f5f5f5;border-bottom:1px solid #ccc;display:flex;gap:24px;font-size:11px">
          <span><b>Total time:</b> ${cat.totalMinutes} min</span>
          <span><b>Review time:</b> ${cat.reviewMinutes} min</span>
          <span><b>Readings:</b> ${cat.readingCount}</span>
          <span><b>Notes:</b> ${cat.notesCount}</span>
        </div>
        ${cat.notes.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr>
            <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">DATE</th>
            <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">STATUS</th>
            <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">AUTHOR</th>
            <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">NOTE</th>
          </tr></thead>
          <tbody>${notesHtml}</tbody>
        </table>` : `<div style="padding:8px 12px"><p style="color:#555;font-style:italic;font-size:11px;margin:0">(no documentation this period)</p></div>`}
        <div style="padding:0 12px 10px">${billingHtml}</div>
      </div>`;
    }).join('');

    const cyclesHtml = r.billingCycles.length > 0
      ? `<div style="margin-bottom:14px;border:1px solid #000;break-inside:avoid">
          <div style="background:#000;color:#fff;padding:7px 12px;font-size:12px;font-weight:700">Billing Cycles</div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr>
              <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">CYCLE START</th>
              <th style="text-align:left;background:#444;color:#fff;padding:4px 8px;font-size:10px">CPT CODES</th>
              <th style="text-align:right;background:#444;color:#fff;padding:4px 8px;font-size:10px">PROJECTED</th>
            </tr></thead>
            <tbody>${r.billingCycles.map((cy, i) => `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
              <td style="padding:5px 8px;border-bottom:1px solid #eee">${esc(cy.cycle_start)}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #eee">${esc(cy.records.map((rec: any) => rec.cpt_code).join(', ') || '—')}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:right">$${cy.totalProjected.toFixed(2)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '';

    const carePlanHtml = r.carePlan
      ? `<div style="margin-bottom:14px;border:1px solid #000;break-inside:avoid">
          <div style="background:#000;color:#fff;padding:7px 12px;font-size:12px;font-weight:700">Patient Care Plan</div>
          <div style="padding:10px 12px">
            <p style="font-size:12px;line-height:1.7;white-space:pre-wrap;margin:0">${esc(planText(r.carePlan.content))}</p>
            ${r.carePlan.signed_at ? `<p style="font-size:10px;color:#555;margin:6px 0 0">Signed ${new Date(r.carePlan.signed_at).toLocaleDateString('en-US')}${r.carePlan.author_name ? ` — ${esc(r.carePlan.author_name)}` : ''}</p>` : ''}
          </div>
        </div>` : '';

    const metaRows = [
      ['Patient',        `${p.full_name}  (${p.mrn ?? patient.id})`],
      ['DOB',            p.dob ?? '—'],
      ['Program',        p.program ?? '—'],
      ['Diagnoses',      p.diagnoses.join(', ') || '—'],
      ['ICD-10',         p.icd10_codes.join(', ') || '—'],
      ['Insurance Type', p.insurance_type ?? '—'],
      ['Insurance',      p.insurance_payer ?? '—'],
      ['Provider',       r.provider ?? '—'],
      ['Clinic',         r.clinic.name ?? '—'],
      ['Period',         r.period.label],
      ['Generated',      new Date(r.generatedAt).toLocaleString('en-US')],
      ...(r.readingCount != null
        ? [['Total Readings', `${r.readingCount}${r.monitoringDays != null ? `  (${r.monitoringDays} monitoring days)` : ''}`]]
        : []),
    ].map(([l, v], i) =>
      `<tr style="background:${i % 2 === 0 ? '#fff' : '#f5f5f5'}">
        <td style="padding:4px 12px 4px 8px;font-size:11px;color:#555;font-weight:700;white-space:nowrap;border-bottom:1px solid #eee">${esc(String(l))}</td>
        <td style="padding:4px 8px;font-size:11px;border-bottom:1px solid #eee">${esc(String(v))}</td>
      </tr>`
    ).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#000;background:#fff;padding:20px}
      @media print{body{padding:8px}@page{size:A4 portrait;margin:1.2cm}}
    </style></head><body>
    <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:14px">
      <div style="font-size:17px;font-weight:800;letter-spacing:-.3px">RPMCARES — CARE MANAGEMENT NOTES EXPORT</div>
      <div style="font-size:10px;color:#555;margin-top:3px">For billing review only — not a clinical record</div>
    </div>
    <div style="margin-bottom:14px;border:1px solid #000">
      <div style="background:#000;color:#fff;padding:6px 12px;font-size:11px;font-weight:700;letter-spacing:.5px">PATIENT INFORMATION</div>
      <table style="width:100%;border-collapse:collapse"><tbody>${metaRows}</tbody></table>
    </div>
    ${activeCats.length === 0 ? '<p style="color:#555;font-style:italic;font-size:12px">No program activity recorded for this period.</p>' : catRows}
    ${cyclesHtml}
    ${carePlanHtml}
    <div style="border-top:1px solid #000;padding-top:8px;font-size:9px;text-align:center;color:#555;margin-top:8px">
      CONFIDENTIAL — For internal billing review only. Not a clinical record.
    </div>
    </body></html>`;
  };

  const exportPdf = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const html = buildHtml(report);
      if (typeof window !== 'undefined') {
        openReportForDownload(html);
        return;
      }
      const Print = await import('expo-print');
      const Sharing = await import('expo-sharing');
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: `${report.patient.full_name} — ${report.period.label}`,
          UTI: 'com.adobe.pdf',
        });
      }
    } catch (e: any) {
      console.warn('[report] PDF export failed:', e.message);
    } finally { setExporting(false); }
  };

  if (loading) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 40 }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 8, fontSize: 13 }}>Loading report…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <Card style={{ gap: 8, alignItems: 'center', paddingVertical: 24 }}>
        <Text style={{ color: colors.critical, fontSize: 13 }}>{error}</Text>
        <Pressable onPress={load} style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.primary, borderRadius: 8 }}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Retry</Text>
        </Pressable>
      </Card>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {/* Month navigator */}
      <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
        <Pressable onPress={() => setMonth(prevMonth(month))} style={{ padding: 6 }}>
          <ChevronLeft size={18} color={colors.primary} />
        </Pressable>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{monthLabel(month)}</Text>
        <Pressable
          onPress={() => setMonth(nextMonth(month))}
          disabled={month >= currentMonth()}
          style={{ padding: 6, opacity: month >= currentMonth() ? 0.3 : 1 }}
        >
          <ChevronRight size={18} color={colors.primary} />
        </Pressable>
      </Card>

      {report && (
        <>
          {/* Patient header card */}
          <Card style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>Clinical Summary</Text>
              {/* Export PDF button */}
              <Pressable
                onPress={exportPdf}
                disabled={exporting}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, opacity: exporting ? 0.6 : 1 }}
              >
                <FileText size={13} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                  {exporting ? 'Generating…' : 'Export Note'}
                </Text>
              </Pressable>
            </View>
            <View style={{ gap: 3, marginTop: 4 }}>
              {[
                ['Patient',   `${report.patient.full_name}  (${report.patient.mrn ?? patient.id})`],
                ['DOB',       report.patient.dob ?? '—'],
                ['Program',   report.patient.program ?? '—'],
                ['Diagnoses', report.patient.diagnoses.join(', ') || '—'],
                ['ICD-10',    report.patient.icd10_codes.join(', ') || '—'],
                ['Insurance', report.patient.insurance_type ?? report.patient.insurance_payer ?? '—'],
                ['Provider',  report.provider ?? '—'],
                ['Clinic',    report.clinic.name ?? '—'],
                ['Period',    report.period.label],
              ].map(([label, value]) => (
                <View key={label} style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 12, width: 70 }}>{label}</Text>
                  <Text style={{ color: colors.text, fontSize: 12, flex: 1, fontWeight: '500' }}>{value}</Text>
                </View>
              ))}
            </View>
            {/* Total readings summary */}
            {report.readingCount != null && (
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>
                  Readings this period: <Text style={{ color: colors.primary }}>{report.readingCount}</Text>
                </Text>
                {report.monitoringDays != null && (
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    Monitoring days: {report.monitoringDays}
                  </Text>
                )}
              </View>
            )}
          </Card>

          {/* Billing categories */}
          {report.categories.map((cat) => (
            <Card key={cat.program} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{cat.label}</Text>
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: cat.thresholdMet ? colors.success + '22' : colors.warning + '22' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: cat.thresholdMet ? colors.success : colors.warning }}>
                    {cat.thresholdMet ? `≥${cat.thresholdMinutes} min MET` : `≥${cat.thresholdMinutes} min NOT MET`}
                  </Text>
                </View>
              </View>

              {/* Time tiles — Total / Review / Readings */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[
                  ['Total', `${cat.totalMinutes} min`],
                  ['Review', `${cat.reviewMinutes} min`],
                  ['Readings', String(cat.readingCount)],
                ].map(([l, v]) => (
                  <View key={l} style={{ alignItems: 'center', flex: 1, backgroundColor: colors.background, borderRadius: 8, paddingVertical: 8 }}>
                    <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>{v}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 10 }}>{l}</Text>
                  </View>
                ))}
              </View>

              {/* Counts row */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Text style={{ color: colors.textSecondary, fontSize: 11 }}>Notes: {cat.notesCount}</Text>
              </View>

              {cat.notes.length === 0 ? (
                <Text style={{ color: colors.textSecondary, fontSize: 12, fontStyle: 'italic' }}>No documentation this period</Text>
              ) : (
                cat.notes.map((n) => {
                  const rawContent = n.content ?? '';
                  const text = typeof rawContent === 'string' ? rawContent : (rawContent as any).text ?? '';
                  return (
                    <View key={n.id} style={{ borderLeftWidth: 3, borderLeftColor: colors.primary, paddingLeft: 10, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{n.dos ?? '—'}</Text>
                        <View style={{ backgroundColor: colors.primary + '22', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                          <Text style={{ color: colors.primary, fontSize: 10, fontWeight: '700' }}>{n.status.toUpperCase()}</Text>
                        </View>
                        {n.author_name && <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{n.author_name}</Text>}
                      </View>
                      <Text style={{ color: colors.text, fontSize: 12 }} numberOfLines={4}>{text}</Text>
                      {n.cpt_codes.length > 0 && (
                        <Text style={{ color: colors.textSecondary, fontSize: 10 }}>CPT: {n.cpt_codes.join(', ')}</Text>
                      )}
                    </View>
                  );
                })
              )}

              {cat.billingRecords.length > 0 && (
                <View style={{ gap: 3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 6 }}>
                  {cat.billingRecords.map((r) => (
                    <View key={r.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 12 }}>{r.cpt_code}</Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{r.status}</Text>
                      <Text style={{ color: colors.text, fontSize: 12 }}>
                        {r.projected_amount != null ? `$${Number(r.projected_amount).toFixed(2)}` : '—'}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </Card>
          ))}

          {/* Billing Cycles */}
          {report.billingCycles.length > 0 && (
            <Card style={{ gap: 8 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Billing Cycles</Text>
              {report.billingCycles.map((cy) => {
                const statusColor = cy.status === 'paid' ? '#059669'
                  : cy.status === 'submitted' ? '#2563eb'
                  : cy.status === 'signed' ? '#7c3aed'
                  : colors.textSecondary;
                return (
                  <View key={cy.id} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>{cy.cycle_start}</Text>
                      <Text style={{ color: statusColor, fontWeight: '700', fontSize: 11, textTransform: 'uppercase' }}>{cy.status}</Text>
                    </View>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      CPT: {cy.records.map((r: any) => r.cpt_code).join(', ') || '—'}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>Projected: ${cy.totalProjected.toFixed(2)}</Text>
                  </View>
                );
              })}
            </Card>
          )}

          {/* Billing Pricing Summary */}
          {report.billingRecords.length > 0 && (() => {
            const totalProjected = report.billingRecords.reduce((s, r) => s + (Number(r.projected_amount) || 0), 0);
            return (
              <Card style={{ gap: 8 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Billing Pricing</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1, backgroundColor: colors.background, borderRadius: 8, padding: 10, alignItems: 'center' }}>
                    <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 16 }}>${totalProjected.toFixed(2)}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 10, marginTop: 2 }}>Total Projected</Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: colors.background, borderRadius: 8, padding: 10, alignItems: 'center' }}>
                    <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{report.billingRecords.length}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 10, marginTop: 2 }}>CPT Codes</Text>
                  </View>
                </View>
                {report.billingRecords.map((rec) => (
                  <View key={rec.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                    <View style={{ gap: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{rec.cpt_code}</Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{rec.program} · DOS {rec.dos ?? '—'}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 1 }}>
                      <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>
                        {rec.projected_amount != null ? `$${Number(rec.projected_amount).toFixed(2)}` : '—'}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 10 }}>{rec.insurance_type ?? '—'}</Text>
                    </View>
                  </View>
                ))}
              </Card>
            );
          })()}

          {/* Care Plan */}
          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Patient Care Plan</Text>
              {!editingPlan && (
                <Pressable onPress={() => setEditingPlan(true)} style={{ backgroundColor: colors.primary + '18', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>
                    {report.carePlan ? 'Edit' : 'Add Plan'}
                  </Text>
                </Pressable>
              )}
            </View>

            {editingPlan ? (
              <>
                <TextInput
                  value={planEdit}
                  onChangeText={setPlanEdit}
                  multiline
                  numberOfLines={8}
                  placeholder="Enter patient care plan, goals, interventions…"
                  placeholderTextColor={colors.textSecondary}
                  style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, color: colors.text, fontSize: 13, minHeight: 140, textAlignVertical: 'top', backgroundColor: colors.background }}
                />
                {planError && <Text style={{ color: colors.critical, fontSize: 12 }}>{planError}</Text>}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={() => { setEditingPlan(false); setPlanEdit(planText(report.carePlan?.content)); }}
                    style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}>
                    <Text style={{ color: colors.textSecondary, fontWeight: '700', fontSize: 13 }}>Cancel</Text>
                  </Pressable>
                  <Pressable onPress={savePlan} disabled={savingPlan}
                    style={{ flex: 2, backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 10, alignItems: 'center', opacity: savingPlan ? 0.6 : 1 }}>
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{savingPlan ? 'Saving…' : 'Save Plan'}</Text>
                  </Pressable>
                </View>
              </>
            ) : report.carePlan ? (
              <>
                <Text style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>{planText(report.carePlan.content)}</Text>
                {report.carePlan.signed_at && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                    Signed {new Date(report.carePlan.signed_at).toLocaleDateString('en-US')}
                    {report.carePlan.author_name ? ` — ${report.carePlan.author_name}` : ''}
                  </Text>
                )}
              </>
            ) : (
              <Text style={{ color: colors.textSecondary, fontSize: 12, fontStyle: 'italic' }}>
                No care plan on file. Tap "Add Plan" to document patient goals and interventions.
              </Text>
            )}
          </Card>
        </>
      )}
    </View>
  );
}

// ── Devices Tab ────────────────────────────────────────────────────────────

const VENDOR_OPTIONS = ['SmartMeter', 'Tenovi'] as const;

function DevicesTab({ patient, colors, token }: { patient: Patient; colors: any; token: string }) {
  const [devices, setDevices]             = useState<PatientDevice[]>([]);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  // Detect (from SmartMeter orders)
  const [detected, setDetected]           = useState<DetectedImei[]>([]);
  const [detecting, setDetecting]         = useState(false);
  const [detectError, setDetectError]     = useState<string | null>(null);
  const [detectRan, setDetectRan]         = useState(false);

  // Assign form
  const [showAssign, setShowAssign]       = useState(false);
  const [imeiInput, setImeiInput]         = useState('');
  const [nameInput, setNameInput]         = useState('');
  const [modelInput, setModelInput]       = useState('');
  const [vendorInput, setVendorInput]     = useState<'SmartMeter' | 'Tenovi'>(
    patient.source === 'tenovi' ? 'Tenovi' : 'SmartMeter',
  );
  const [assigning, setAssigning]         = useState(false);
  const [assignError, setAssignError]     = useState<string | null>(null);
  const [quickAdding, setQuickAdding]     = useState<string | null>(null); // imei being quick-added

  // Remove
  const [unassigning, setUnassigning]     = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PatientDevice | null>(null);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { devices: data } = await api.getPatientDevices(token, patient.id);
      setDevices(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, [token, patient.id]);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const runDetect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const { detected: data } = await api.detectPatientImeis(token, patient.id);
      setDetected(data);
      setDetectRan(true);
    } catch (e: any) {
      setDetectError(e?.message ?? 'Detection failed');
    } finally {
      setDetecting(false);
    }
  };

  const openAssign = (prefill?: DetectedImei) => {
    setImeiInput(prefill?.imei ?? '');
    setNameInput(prefill?.deviceName ?? '');
    setModelInput(prefill?.deviceModel ?? '');
    setVendorInput(patient.source === 'tenovi' ? 'Tenovi' : 'SmartMeter');
    setAssignError(null);
    setShowAssign(true);
  };

  const quickAdd = async (d: DetectedImei) => {
    setQuickAdding(d.imei);
    try {
      await api.assignPatientDevice(token, patient.id, {
        imei:        d.imei,
        deviceName:  d.deviceName  ?? undefined,
        deviceModel: d.deviceModel ?? undefined,
        vendor:      'SmartMeter',
      });
      // Remove from detected list, reload assigned
      setDetected((prev) => prev.filter((x) => x.imei !== d.imei));
      await loadDevices();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to assign device');
    } finally {
      setQuickAdding(null);
    }
  };

  const doAssign = async () => {
    if (!imeiInput.trim()) return;
    setAssigning(true);
    setAssignError(null);
    try {
      await api.assignPatientDevice(token, patient.id, {
        imei:        imeiInput.trim(),
        deviceName:  nameInput.trim() || undefined,
        deviceModel: modelInput.trim() || undefined,
        vendor:      vendorInput,
      });
      setShowAssign(false);
      setDetected((prev) => prev.filter((x) => x.imei !== imeiInput.trim()));
      await loadDevices();
    } catch (e: any) {
      setAssignError(e?.message ?? 'Failed to assign device');
    } finally {
      setAssigning(false);
    }
  };

  const doUnassign = async (device: PatientDevice) => {
    setUnassigning(device.imei);
    setConfirmRemove(null);
    try {
      await api.unassignPatientDevice(token, patient.id, device.imei);
      await loadDevices();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to remove device');
    } finally {
      setUnassigning(null);
    }
  };

  return (
    <>
      {/* Program enrollment card */}
      <Card style={{ gap: 10 }}>
        <SectionLabel text="Program Enrollment" colors={colors} />
        <View style={[dv.row, { borderColor: colors.border }]}>
          <View style={[dv.iconWrap, { backgroundColor: colors.primary + '15' }]}>
            <HeartPulse size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[dv.name, { color: colors.text }]}>
              {patient.source === 'tenovi' ? 'Tenovi' : 'SmartMeter'} — {patient.program} Program
            </Text>
            <Text style={[dv.sub, { color: colors.textSecondary }]}>
              Monitoring platform · Patient ID {patient.external_patient_id}
            </Text>
          </View>
          <StatusPill tone={patient.enrollment_status === 'active' ? 'success' : 'muted'}>
            {patient.enrollment_status}
          </StatusPill>
        </View>
        {patient.enrolled_at && (
          <View style={{ marginTop: 4 }}>
            <InfoRow label="Enrolled" value={fmtDate(patient.enrolled_at)} colors={colors} />
            {patient.disenrolled_at && (
              <InfoRow label="Disenrolled" value={fmtDate(patient.disenrolled_at)} colors={colors} />
            )}
          </View>
        )}
      </Card>

      {/* Assigned devices */}
      <Card style={{ gap: 12 }}>
        <View style={dv.sectionHead}>
          <SectionLabel text="Assigned Devices" colors={colors} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {patient.source === 'smartmeter' && (
              <Pressable
                onPress={runDetect}
                disabled={detecting}
                style={[dv.detectBtn, { borderColor: colors.primary + '50', backgroundColor: colors.primary + '10' }]}>
                {detecting
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <RefreshCw size={12} color={colors.primary} />
                }
                <Text style={[dv.detectBtnText, { color: colors.primary }]}>
                  {detecting ? 'Scanning…' : 'Detect from Orders'}
                </Text>
              </Pressable>
            )}
            <Pressable onPress={() => openAssign()} style={[dv.assignBtn, { backgroundColor: colors.primary }]}>
              <Plus size={13} color="#fff" />
              <Text style={dv.assignBtnText}>Assign Device</Text>
            </Pressable>
          </View>
        </View>

        {/* Detected from SmartMeter orders */}
        {detected.length > 0 && (
          <View style={[dv.detectedBox, { borderColor: colors.primary + '30', backgroundColor: colors.primary + '06' }]}>
            <Text style={[dv.detectedTitle, { color: colors.primary }]}>
              Found in SmartMeter orders — tap + to assign
            </Text>
            {detected.map((d) => {
              const busy = quickAdding === d.imei;
              return (
                <View key={d.imei} style={[dv.detectedRow, { borderColor: colors.primary + '20' }]}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[dv.imeiText, { color: colors.text }]}>{d.imei}</Text>
                    {(d.deviceName ?? d.deviceModel) && (
                      <Text style={[dv.sub, { color: colors.textSecondary }]}>
                        {d.deviceName ?? d.deviceModel}
                      </Text>
                    )}
                    <Text style={[dv.sub, { color: colors.textSecondary }]}>
                      Order {d.orderNumber}{d.orderedAt ? ` · ${fmtDate(d.orderedAt)}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => quickAdd(d)}
                    disabled={busy}
                    style={[dv.quickAddBtn, { backgroundColor: colors.primary }]}>
                    {busy
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Plus size={14} color="#fff" />
                    }
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        {detectRan && detected.length === 0 && !detecting && (
          <Text style={[dv.hint, { color: colors.textSecondary }]}>
            No unassigned devices found in the last 180 days of orders.
          </Text>
        )}
        {detectError && (
          <Text style={[dv.hint, { color: colors.critical }]}>{detectError}</Text>
        )}

        {loading ? (
          <View style={dv.center}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[dv.hint, { color: colors.textSecondary }]}>Loading assigned devices…</Text>
          </View>
        ) : error ? (
          <View style={dv.center}>
            <Text style={[dv.hint, { color: colors.critical }]}>{error}</Text>
            <Pressable onPress={loadDevices} style={[dv.retryBtn, { borderColor: colors.border }]}>
              <Text style={[dv.retryBtnText, { color: colors.primary }]}>Retry</Text>
            </Pressable>
          </View>
        ) : devices.length === 0 ? (
          <View style={dv.center}>
            <Link2Off size={24} color={colors.textSecondary} strokeWidth={1.5} />
            <Text style={[dv.hint, { color: colors.textSecondary }]}>No physical devices tracked yet</Text>
            <Text style={[dv.hint2, { color: colors.textSecondary }]}>
              {patient.source === 'smartmeter'
                ? 'No readings found for this patient yet. Once readings arrive the device will appear automatically.'
                : 'Tap "Assign Device" and enter the IMEI from the device packaging.'}
            </Text>
          </View>
        ) : (
          devices.map((device) => {
            const busy = unassigning === device.imei;
            return (
              <View key={device.id} style={[dv.deviceRow, { borderColor: colors.border }]}>
                <View style={[dv.deviceIcon, { backgroundColor: colors.success + '15' }]}>
                  <Link2 size={16} color={colors.success} />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[dv.name, { color: colors.text }]}>
                    {device.device_name ?? device.device_model ?? `${device.vendor} Device`}
                  </Text>
                  {device.notes === 'IMEI_UNKNOWN' ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={[dv.imeiText, { color: colors.warning }]}>IMEI: Not recorded</Text>
                    </View>
                  ) : (
                    <Text style={[dv.imeiText, { color: colors.text }]}>IMEI: {device.imei}</Text>
                  )}
                  {device.device_model && (
                    <Text style={[dv.sub, { color: colors.textSecondary }]}>Model: {device.device_model}</Text>
                  )}
                  <Text style={[dv.sub, { color: colors.textSecondary }]}>
                    {device.vendor} · Assigned {fmtDate(device.assigned_at)}
                  </Text>
                  {device.notes === 'IMEI_UNKNOWN' && (
                    <Text style={[dv.sub, { color: colors.warning }]}>
                      To reassign: remove here, then assign to new patient by IMEI
                    </Text>
                  )}
                </View>
                <Pressable
                  onPress={() => setConfirmRemove(device)}
                  disabled={busy}
                  style={[dv.removeBtn, { borderColor: colors.critical + '40' }]}>
                  {busy
                    ? <ActivityIndicator size="small" color={colors.critical} />
                    : <><Link2Off size={12} color={colors.critical} /><Text style={[dv.removeBtnText, { color: colors.critical }]}>Remove</Text></>
                  }
                </Pressable>
              </View>
            );
          })
        )}

        <View style={[dv.infoBox, { backgroundColor: colors.warning + '10', borderColor: colors.warning + '30' }]}>
          <Text style={[dv.infoText, { color: colors.textSecondary }]}>
            To reassign a returned device: remove it from this patient first, then assign it to the new patient using the same IMEI.
          </Text>
        </View>
      </Card>

      {/* Assign device sheet */}
      <Modal visible={showAssign} transparent animationType="slide" onRequestClose={() => setShowAssign(false)}>
        <Pressable style={dv.backdrop} onPress={() => setShowAssign(false)}>
          <Pressable style={[dv.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={dv.sheetHead}>
              <Text style={[dv.sheetTitle, { color: colors.text }]}>Assign Device</Text>
              <Pressable onPress={() => setShowAssign(false)} style={[dv.closeBtn, { backgroundColor: colors.muted }]}>
                <X size={16} color={colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={[dv.sheetSub, { color: colors.textSecondary }]}>
              Enter the IMEI from the device or its packaging.
            </Text>

            <Text style={[dv.label, { color: colors.textSecondary }]}>
              IMEI Number <Text style={{ color: colors.critical }}>*</Text>
            </Text>
            <TextInput
              value={imeiInput} onChangeText={setImeiInput}
              placeholder="e.g. 356938035643809"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric" autoFocus
              style={[dv.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
            />

            <Text style={[dv.label, { color: colors.textSecondary }]}>Device Name (optional)</Text>
            <TextInput
              value={nameInput} onChangeText={setNameInput}
              placeholder="e.g. iBP Blood Pressure Monitor"
              placeholderTextColor={colors.textSecondary}
              style={[dv.inputSm, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
            />

            <Text style={[dv.label, { color: colors.textSecondary }]}>Model (optional)</Text>
            <TextInput
              value={modelInput} onChangeText={setModelInput}
              placeholder="e.g. iBP-105"
              placeholderTextColor={colors.textSecondary}
              style={[dv.inputSm, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
            />

            <Text style={[dv.label, { color: colors.textSecondary }]}>Vendor</Text>
            <View style={dv.vendorRow}>
              {VENDOR_OPTIONS.map((v) => (
                <Pressable
                  key={v}
                  onPress={() => setVendorInput(v)}
                  style={[dv.vendorOpt, {
                    backgroundColor: vendorInput === v ? colors.primary : colors.background,
                    borderColor: vendorInput === v ? colors.primary : colors.border,
                  }]}>
                  <Text style={{ color: vendorInput === v ? '#fff' : colors.textSecondary, fontSize: 13, fontWeight: '600' }}>{v}</Text>
                </Pressable>
              ))}
            </View>

            {assignError && <Text style={[dv.errorText, { color: colors.critical }]}>{assignError}</Text>}

            <Pressable
              onPress={doAssign}
              disabled={assigning || !imeiInput.trim()}
              style={[dv.submitBtn, { backgroundColor: assigning || !imeiInput.trim() ? colors.muted : colors.primary }]}>
              {assigning
                ? <ActivityIndicator size="small" color="#fff" />
                : <><Link2 size={14} color="#fff" /><Text style={dv.submitBtnText}>Assign to Patient</Text></>
              }
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Confirm remove modal */}
      <Modal visible={confirmRemove !== null} transparent animationType="fade" onRequestClose={() => setConfirmRemove(null)}>
        <Pressable style={dv.backdrop} onPress={() => setConfirmRemove(null)}>
          <Pressable style={[dv.confirmSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[dv.sheetTitle, { color: colors.text }]}>Remove Device?</Text>
            <Text style={[dv.sheetSub, { color: colors.textSecondary, marginTop: 8 }]}>
              This will unassign{' '}
              <Text style={{ fontWeight: '700', color: colors.text }}>
                {confirmRemove?.device_name ?? confirmRemove?.device_model ?? 'this device'}
              </Text>
              {` (IMEI: ${confirmRemove?.imei})`} from {patient.full_name}.
            </Text>
            <Text style={[dv.sheetSub, { color: colors.textSecondary, marginTop: 6 }]}>
              You can then assign it to another patient using the same IMEI.
            </Text>
            <View style={dv.confirmBtns}>
              <Pressable onPress={() => setConfirmRemove(null)} style={[dv.cancelBtn, { borderColor: colors.border }]}>
                <Text style={[dv.cancelBtnText, { color: colors.text }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => confirmRemove && doUnassign(confirmRemove)}
                style={[dv.confirmRemoveBtn, { backgroundColor: colors.critical }]}>
                <Link2Off size={14} color="#fff" />
                <Text style={dv.submitBtnText}>Remove Device</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const dv = StyleSheet.create({
  row:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  iconWrap:   { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  name:       { fontSize: 13.5, fontWeight: '700' },
  sub:        { fontSize: 11.5, marginTop: 2 },
  imeiText:   { fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },

  sectionHead:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assignBtn:      { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  assignBtnText:  { color: '#fff', fontSize: 12, fontWeight: '700' },
  detectBtn:      { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  detectBtnText:  { fontSize: 11, fontWeight: '700' },

  detectedBox:   { borderRadius: 10, borderWidth: 1, padding: 10, gap: 8 },
  detectedTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  detectedRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  quickAddBtn:   { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  center:       { alignItems: 'center', paddingVertical: 24, gap: 8 },
  hint:         { fontSize: 13, textAlign: 'center' },
  hint2:        { fontSize: 11.5, textAlign: 'center' },
  retryBtn:     { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  retryBtnText: { fontSize: 12, fontWeight: '600' },

  deviceRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  deviceIcon:    { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  removeBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, borderWidth: 1 },
  removeBtnText: { fontSize: 11, fontWeight: '600' },

  infoBox:  { borderRadius: 8, borderWidth: 1, padding: 10, marginTop: 4 },
  infoText: { fontSize: 11.5, lineHeight: 17 },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet:    {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
    padding: 20, gap: 10,
  },
  confirmSheet: {
    borderRadius: 16, borderWidth: 1,
    margin: 24, padding: 20,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  sheetHead:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  sheetSub:   { fontSize: 13, lineHeight: 20 },
  closeBtn:   { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },

  label:    { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
  input:    { height: 44, borderRadius: 9, borderWidth: 1, paddingHorizontal: 12, fontSize: 15, fontFamily: 'monospace' },
  inputSm:  { height: 40, borderRadius: 9, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  vendorRow:{ flexDirection: 'row', gap: 8 },
  vendorOpt:{ flex: 1, paddingVertical: 9, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  errorText:{ fontSize: 12 },
  submitBtn:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 13, borderRadius: 10, marginTop: 4 },
  submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  confirmBtns:      { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn:        { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center' },
  cancelBtnText:    { fontSize: 14, fontWeight: '600' },
  confirmRemoveBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10 },
});

// ── Main patient profile ───────────────────────────────────────────────────

export default function PatientDetail() {
  const { patientId, tab: initialTab } = useLocalSearchParams<{ patientId: string; tab?: string }>();
  const colors = useTheme();
  const { session } = useAuth();
  const router = useRouter();
  const [tab, setTab]         = useState<Tab>(TABS.includes(initialTab as Tab) ? initialTab as Tab : 'Info');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [smDetail, setSmDetail] = useState<SmartMeterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profileExtras, setProfileExtras] = useState<Record<string, string>>({});
  const [editField, setEditField] = useState<{ key: string; label: string; current: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [clinicReviewMode, setClinicReviewMode] = useState<'automatic' | 'manual' | null>(null);
  const [liveSeconds, setLiveSeconds] = useState(0);
  const [timerCancelled, setTimerCancelled] = useState(false);

  const clinicReviewModeRef = useRef<'automatic' | 'manual' | null>(null);
  const timerCancelledRef   = useRef(false);
  const profileViewStart    = useRef<number | null>(null);
  const timerInterval       = useRef<ReturnType<typeof setInterval> | null>(null);
  const pauseStartRef       = useRef<number | null>(null);

  useEffect(() => { clinicReviewModeRef.current = clinicReviewMode; }, [clinicReviewMode]);

  // Pause elapsed counting during pull-to-refresh; on resume shift start forward so elapsed is preserved
  useEffect(() => {
    if (refreshing) {
      pauseStartRef.current = Date.now();
    } else if (pauseStartRef.current !== null && profileViewStart.current !== null) {
      profileViewStart.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = null;
    }
  }, [refreshing]);

  // ── Profile-view timer ────────────────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      timerCancelledRef.current = false;
      setTimerCancelled(false);
      profileViewStart.current = Date.now();
      setLiveSeconds(0);
      timerInterval.current = setInterval(() => {
        if (profileViewStart.current && !pauseStartRef.current) {
          setLiveSeconds(Math.floor((Date.now() - profileViewStart.current) / 1000));
        }
      }, 1000);

      return () => {
        if (timerInterval.current) { clearInterval(timerInterval.current); timerInterval.current = null; }
        const elapsed = Math.floor((Date.now() - (profileViewStart.current ?? Date.now())) / 1000);
        profileViewStart.current = null;
        setLiveSeconds(0);
        if (elapsed >= 30 && session && patientId && clinicReviewModeRef.current === 'automatic' && !timerCancelledRef.current) {
          api.logProfileView(session.token, patientId, { duration_seconds: elapsed }).catch(() => {});
        }
      };
    }, [session, patientId]),
  );

  function cancelTimer() {
    timerCancelledRef.current = true;
    setTimerCancelled(true);
    if (timerInterval.current) { clearInterval(timerInterval.current); timerInterval.current = null; }
  }

  function openEdit(key: string, label: string, current: string) {
    setEditField({ key, label, current });
    setEditValue(current);
  }

  async function saveEdit() {
    if (!editField || !session || !patientId) return;
    setSaving(true);
    try {
      const result = await api.updatePatientProfile(session.token, patientId, { [editField.key]: editValue.trim() || null });
      setPatient(result.patient);
      setProfileExtras(result.patient.profile_extras ?? {});
      setEditField(null);
    } catch { /* silent */ }
    finally { setSaving(false); }
  }

  const loadPatient = useCallback(async (isRefresh = false) => {
    if (!session || !patientId) return;
    if (isRefresh) setRefreshing(true);
    try {
      const r = await api.getPatient(session.token, patientId);
      setPatient(r.patient);
      setSmDetail(r.smDetail ?? null);
      setProfileExtras(r.patient.profile_extras ?? {});
    } catch { setPatient(null); }
    finally { setLoading(false); setRefreshing(false); }
  }, [session, patientId]);

  useEffect(() => { loadPatient(); }, [loadPatient]);

  // Load the clinic's review mode once the patient is known
  useEffect(() => {
    if (!patient || !session) return;
    api.getWorkflows(session.token)
      .then((r) => {
        const match = r.clinics.find((c) => c.id === patient!.clinic_id);
        // fall back to first clinic if clinic_id not on patient type
        setClinicReviewMode(match?.review_mode ?? r.clinics[0]?.review_mode ?? 'manual');
      })
      .catch(() => setClinicReviewMode('manual'));
  }, [patient?.id, session]);

  if (loading) {
    return (
      <View style={[s.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (!patient) {
    return (
      <View style={[s.center, { backgroundColor: colors.background }]}>
        <Text style={[s.notFound, { color: colors.text }]}>Patient not found</Text>
      </View>
    );
  }

  const nameParts = patient.full_name.trim().split(' ');
  const initials = ((nameParts[0]?.[0] ?? '') + (nameParts[nameParts.length - 1]?.[0] ?? '')).toUpperCase();

  // Helper: smDetail field → profileExtras key → fallback
  const ex = (key: string) => profileExtras[key] ?? null;
  const resolve = (smVal: string | null | undefined, key: string, fallback?: string | null): string | null =>
    (smVal ?? ex(key) ?? fallback ?? null) || null;

  // Prefer live SmartMeter detail over cached DB fields
  const dob     = smDetail?.dob     ?? patient.dob;
  const gender  = smDetail?.gender  ?? (patient.sex === 'M' ? 'Male' : patient.sex === 'F' ? 'Female' : null);
  const language = smDetail?.language ?? patient.language;
  const cellPhone = smDetail?.cell_phone ?? patient.phone;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadPatient(true)} tintColor={colors.primary} />}
    >
      <Stack.Screen options={{ title: patient.full_name, headerBackTitle: 'Patients' }} />

      {/* ── Auto-timer banner ───────────────────────────────────────────── */}
      {clinicReviewMode === 'automatic' && !timerCancelled && (
        <View style={[s.timerBanner, { backgroundColor: '#05966912', borderColor: '#05966930' }]}>
          <Timer size={13} color="#059669" strokeWidth={2} />
          <Text style={[s.timerBannerText, { color: '#059669' }]}>
            {refreshing
              ? 'Review timer paused…'
              : `Review timer: ${String(Math.floor(liveSeconds / 60)).padStart(2, '0')}:${String(liveSeconds % 60).padStart(2, '0')}`}
          </Text>
          {!refreshing && (
            <Text style={{ fontSize: 10.5, color: '#059669', opacity: 0.65, marginLeft: 'auto', marginRight: 4 }}>
              saves on exit
            </Text>
          )}
          <Pressable onPress={cancelTimer} hitSlop={10}>
            <X size={14} color="#059669" strokeWidth={2.5} />
          </Pressable>
        </View>
      )}

      {/* ── Hero card ───────────────────────────────────────────────────── */}
      <Card style={s.heroCard}>
        <View style={s.heroTop}>
          <View style={[s.avatar, { backgroundColor: colors.primary + '1a' }]}>
            <Text style={[s.avatarText, { color: colors.primary }]}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.name, { color: colors.text }]}>{patient.full_name}</Text>
            {(dob || gender) ? (
              <Text style={[s.heroDemog, { color: colors.textSecondary }]}>
                {[dob ? ageFromDob(dob) : null, gender].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
            <View style={s.badgeRow}>
              <StatusPill tone={enrollTone(patient.enrollment_status)}>
                {patient.enrollment_status}
              </StatusPill>
              <StatusPill tone="muted">{patient.program}</StatusPill>
              <StatusPill tone={riskTone(patient.risk)}>{patient.risk} risk</StatusPill>
              <StatusPill tone={patient.source === 'tenovi' ? 'info' : patient.source === 'local' ? 'success' : 'muted'}>
                {patient.source === 'tenovi' ? 'Tenovi' : patient.source === 'local' ? 'Local' : 'SmartMeter'}
              </StatusPill>
            </View>
          </View>
        </View>

        {/* Quick metrics row */}
        <View style={[s.quickMetrics, { borderTopColor: colors.border }]}>
          {[
            { label: 'Clinic',   value: patient.clinic_name ?? '—' },
            { label: 'MRN',      value: patient.mrn ?? '—' },
            { label: 'Language', value: patient.language },
            { label: 'Enrolled', value: fmtDate(patient.enrolled_at) },
            ...(patient.current_cycle
              ? [{ label: 'Cycle', value: `${patient.current_cycle.cycle_start} → ${patient.current_cycle.cycle_end}` }]
              : []),
          ].map(({ label, value }) => (
            <View key={label} style={s.metricItem}>
              <Text style={[s.metricLabel, { color: colors.textSecondary }]}>{label}</Text>
              <Text style={[s.metricValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
            </View>
          ))}
        </View>

        {/* Diagnoses */}
        {patient.diagnoses.length > 0 && (
          <View style={s.chipsRow}>
            {patient.diagnoses.map((d, i) => (
              <View key={i} style={[s.chip, { backgroundColor: colors.accent }]}>
                <Text style={[s.chipText, { color: colors.text }]}>{d}</Text>
              </View>
            ))}
            {patient.icd10_codes.map((c, i) => (
              <View key={`icd-${i}`} style={[s.chip, { backgroundColor: colors.border }]}>
                <Text style={[s.chipText, { color: colors.textSecondary }]}>{c}</Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* ── Quick actions ────────────────────────────────────────────────── */}
      <Card>
        <SectionLabel text="Quick Actions" colors={colors} />
        <View style={s.actionsGrid}>
          {([
            {
              icon: Phone, label: 'Call',
              onPress: () => router.push({ pathname: '/communications', params: { patientId, action: 'call' } }),
            },
            {
              icon: MessageSquare, label: 'SMS',
              onPress: () => router.push({ pathname: '/communications', params: { patientId, action: 'sms' } }),
            },
            { icon: FileText,      label: 'Note',     onPress: undefined },
            { icon: AlertTriangle, label: 'Escalate', onPress: undefined },
            { icon: ClipboardList, label: 'Task',     onPress: undefined },
          ] as { icon: LucideIcon; label: string; onPress: (() => void) | undefined }[]).map(({ icon: Icon, label, onPress }) => (
            <Pressable key={label} style={[s.actionBtn, { borderColor: colors.border }]} onPress={onPress}>
              <Icon size={16} color={colors.primary} strokeWidth={1.75} />
              <Text style={[s.actionLabel, { color: colors.text }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      {/* ── AI summary ───────────────────────────────────────────────────── */}
      <Card style={[s.aiCard, { backgroundColor: colors.primary + '0c', borderColor: colors.primary + '30' }]}>
        <View style={s.aiHead}>
          <Sparkles size={14} color={colors.primary} />
          <Text style={[s.aiEyebrow, { color: colors.primary }]}>AI PATIENT SUMMARY</Text>
        </View>
        <Text style={[s.aiBody, { color: colors.text }]}>
          {nameParts[0]} is a {dob ? `${ageFromDob(dob)} ` : ''}{gender ? gender.toLowerCase() : 'patient'} enrolled in {patient.program}
          {patient.diagnoses.length > 0 ? ` for ${patient.diagnoses.slice(0, 2).join(', ')}` : ''}.
          {' '}Enrollment status is {patient.enrollment_status}; risk classified as {patient.risk}.
          Monitored via {patient.source === 'tenovi' ? 'Tenovi RPM' : 'SmartMeter'}.
          {patient.insurance_payer ? ` Insurance: ${patient.insurance_payer}.` : ''}
        </Text>
      </Card>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tabsRow}
        style={{ marginBottom: 2 }}
      >
        {TABS.map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[s.tabPill, {
              backgroundColor: tab === t ? colors.primary : colors.card,
              borderColor: tab === t ? colors.primary : colors.border,
            }]}
          >
            {t === 'Readings'    && <HeartPulse size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            {t === 'Alerts'     && <Bell size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            {t === 'Devices'    && <Activity size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            {t === 'Notes'      && <FileText size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            {t === 'Review Time'      && <Timer size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            {t === 'Exported Billing' && <Download size={12} color={tab === t ? '#052B00' : colors.textSecondary} />}
            <Text style={[s.tabText, { color: tab === t ? '#052B00' : colors.textSecondary }]}>{t}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      {tab === 'Info' && (
        <View style={{ gap: 12 }}>
          {/* General */}
          <Card style={{ gap: 14 }}>
            <SectionLabel text="General" colors={colors} />
            <View style={s.infoGrid}>
              <EditableInfoRow label="First Name"    fieldKey="first_name"   value={resolve(smDetail?.first_name, 'first_name')}   onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Middle Name"   fieldKey="middle_name"  value={resolve(smDetail?.middle_name, 'middle_name')}  onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Last Name"     fieldKey="last_name"    value={resolve(smDetail?.last_name, 'last_name')}      onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Suffix"        fieldKey="suffix"       value={resolve(smDetail?.suffix, 'suffix')}            onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Gender"        fieldKey="gender"       value={resolve(smDetail?.gender, 'gender', gender)}    onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Race"          fieldKey="race"         value={resolve(smDetail?.race, 'race')}                onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Date of Birth" fieldKey="dob"          value={resolve(smDetail?.dob, 'dob', patient.dob)}    onEdit={openEdit} colors={colors} />
              <InfoRow label="Age" value={ageFromDob(resolve(smDetail?.dob, 'dob', patient.dob))} colors={colors} />
              <EditableInfoRow label="Language"      fieldKey="language"     value={resolve(smDetail?.language, 'language', patient.language)} onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Time Zone"     fieldKey="time_zone"    value={resolve(smDetail?.time_zone, 'time_zone')}     onEdit={openEdit} colors={colors} />
            </View>
          </Card>

          {/* Contact */}
          <Card style={{ gap: 14 }}>
            <SectionLabel text="Contact" colors={colors} />
            <View style={s.infoGrid}>
              <EditableInfoRow label="Cell Phone"     fieldKey="cell_phone"      value={resolve(smDetail?.cell_phone, 'cell_phone', patient.phone)}          onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Home Phone"     fieldKey="home_phone"      value={resolve(smDetail?.home_phone, 'home_phone')}                          onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Email"          fieldKey="email"           value={resolve(smDetail?.email, 'email')}                                    onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Msg Delivery"   fieldKey="msg_delivery"    value={resolve(smDetail?.message_delivery_preference, 'msg_delivery')}       onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Preferred Phone" fieldKey="preferred_phone" value={resolve(smDetail?.preferred_phone, 'preferred_phone')}               onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Preferred Time"  fieldKey="preferred_time"  value={resolve(smDetail?.preferred_time_of_day, 'preferred_time')}          onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Preferred Day"   fieldKey="preferred_day"   value={resolve(smDetail?.preferred_day_of_week, 'preferred_day')}           onEdit={openEdit} colors={colors} />
            </View>
          </Card>

          {/* Address */}
          <Card style={{ gap: 14 }}>
            <SectionLabel text="Address" colors={colors} />
            <View style={{ gap: 12 }}>
              <View>
                <Text style={[s.infoLabel, { color: colors.textSecondary, marginBottom: 4 }]}>SHIPPING</Text>
                {(() => {
                  const val = fmtAddress(smDetail?.shipping_address) ?? ex('shipping_address');
                  return val
                    ? <Text style={[s.infoValue, { color: colors.text }]}>{val}</Text>
                    : <Pressable onPress={() => openEdit('shipping_address', 'Shipping Address', '')} hitSlop={8}>
                        <Text style={[s.infoValue, { color: colors.primary, fontWeight: '600' }]}>Add</Text>
                      </Pressable>;
                })()}
              </View>
              <View>
                <Text style={[s.infoLabel, { color: colors.textSecondary, marginBottom: 4 }]}>PHYSICAL</Text>
                {(() => {
                  const val = fmtAddress(smDetail?.physical_address) ?? ex('physical_address');
                  return val
                    ? <Text style={[s.infoValue, { color: colors.text }]}>{val}</Text>
                    : <Pressable onPress={() => openEdit('physical_address', 'Physical Address', '')} hitSlop={8}>
                        <Text style={[s.infoValue, { color: colors.primary, fontWeight: '600' }]}>Add</Text>
                      </Pressable>;
                })()}
              </View>
            </View>
          </Card>

          {/* Enrollment */}
          <Card style={{ gap: 14 }}>
            <SectionLabel text="Enrollment" colors={colors} />
            <View style={s.infoGrid}>
              <InfoRow label="Status"     value={patient.enrollment_status}      colors={colors} />
              <InfoRow label="Program"    value={patient.program}                colors={colors} />
              <InfoRow label="Risk"       value={patient.risk}                   colors={colors} />
              <InfoRow label="Clinic"     value={patient.clinic_name ?? '—'}     colors={colors} />
              <InfoRow label="MRN"        value={patient.mrn ?? '—'}             colors={colors} />
              <InfoRow label="Ext. ID"    value={patient.external_patient_id}    colors={colors} />
              <InfoRow label="Enrolled"   value={fmtDate(patient.enrolled_at)}   colors={colors} />
              {patient.disenrolled_at && (
                <InfoRow label="Disenrolled" value={fmtDate(patient.disenrolled_at)} colors={colors} />
              )}
            </View>
          </Card>

          {/* Insurance */}
          <Card style={{ gap: 14 }}>
            <SectionLabel text="Insurance" colors={colors} />
            <View style={s.infoGrid}>
              <EditableInfoRow label="Payer" fieldKey="insurance_payer" value={patient.insurance_payer ?? ex('insurance_payer')} onEdit={openEdit} colors={colors} />
              <EditableInfoRow label="Class" fieldKey="insurance_class" value={patient.insurance_class ?? ex('insurance_class')} onEdit={openEdit} colors={colors} />
            </View>
          </Card>

          {/* Diagnoses */}
          {(patient.diagnoses.length > 0 || patient.icd10_codes.length > 0) && (
            <Card style={{ gap: 14 }}>
              <SectionLabel text="Diagnoses" colors={colors} />
              <View style={s.chipsRow}>
                {patient.diagnoses.map((d, i) => (
                  <View key={i} style={[s.chip, { backgroundColor: colors.accent }]}>
                    <Text style={[s.chipText, { color: colors.text }]}>{d}</Text>
                  </View>
                ))}
              </View>
              {patient.icd10_codes.length > 0 && (
                <View style={s.chipsRow}>
                  {patient.icd10_codes.map((c, i) => (
                    <View key={i} style={[s.chip, { backgroundColor: colors.border }]}>
                      <Text style={[s.chipText, { color: colors.textSecondary }]}>{c}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Card>
          )}

          {/* Field Edit Modal */}
          <Modal visible={!!editField} transparent animationType="fade" onRequestClose={() => setEditField(null)}>
            <View style={{ flex: 1, backgroundColor: '#00000060', justifyContent: 'center', padding: 24 }}>
              <View style={[{ borderRadius: 16, padding: 20, gap: 14 }, { backgroundColor: colors.card }]}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.5 }}>
                  {(editField?.label ?? '').toUpperCase()}
                </Text>
                <TextInput
                  value={editValue}
                  onChangeText={setEditValue}
                  placeholder={`Enter ${editField?.label ?? ''}`}
                  placeholderTextColor={colors.textSecondary + '80'}
                  style={[{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  autoFocus
                  multiline={editField?.key === 'shipping_address' || editField?.key === 'physical_address'}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    onPress={() => setEditField(null)}
                    style={[{ flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center', borderColor: colors.border }]}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={saveEdit}
                    disabled={saving}
                    style={[{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: saving ? colors.primary + '80' : colors.primary }]}>
                    {saving
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={{ fontSize: 14, fontWeight: '700', color: '#052B00' }}>Save</Text>
                    }
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      )}

      {tab === 'Readings' && (
        <ReadingsTab
          patientId={patient.id}
          source={patient.source}
          colors={colors}
        />
      )}

      {tab === 'Alerts' && (
        <AlertsTab patientId={patient.id} colors={colors} />
      )}

      {tab === 'Devices' && (
        <DevicesTab patient={patient} colors={colors} token={session?.token ?? ''} />
      )}

      {tab === 'Notes' && (
        <NotesTab patientId={patient.id} colors={colors} />
      )}

      {tab === 'Review Time' && (
        <ReviewTimeTab patientId={patient.id} colors={colors} onViewNote={() => setTab('Notes')} />
      )}

      {tab === 'Report' && (
        <ReportTab patient={patient} token={session?.token ?? ''} colors={colors} />
      )}

      {tab === 'Exported Billing' && (
        <ExportedBillingTab patient={patient} token={session?.token ?? ''} colors={colors} />
      )}
    </ScrollView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  content:         { padding: 16, gap: 12, paddingBottom: 60 },
  center:          { flex: 1, alignItems: 'center', justifyContent: 'center' },
  notFound:        { fontSize: 16, fontWeight: '700' },
  timerBanner:     { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: -4 },
  timerBannerText: { fontSize: 12.5, fontWeight: '700' },

  // Hero
  heroCard: { gap: 0 },
  heroTop:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  avatar:   { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { fontSize: 20, fontWeight: '800' },
  name:     { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  heroDemog:{ fontSize: 12, marginTop: 3 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  quickMetrics: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, gap: 10 },
  metricItem: { width: '47%' },
  metricLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  metricValue: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip:     { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 11, fontWeight: '600' },

  // Actions
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  actionBtn:   { width: '30.5%', alignItems: 'center', gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingVertical: 12 },
  actionLabel: { fontSize: 10.5, fontWeight: '600' },

  // AI
  aiCard:    {},
  aiHead:    { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  aiEyebrow: { fontSize: 10.5, fontWeight: '700', letterSpacing: 1.2 },
  aiBody:    { fontSize: 12.5, lineHeight: 19 },

  // Tabs
  tabsRow:   { gap: 6, paddingVertical: 2 },
  tabPill:   { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
  tabText:   { fontSize: 12.5, fontWeight: '700' },

  // Info grid
  infoGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  infoItem:  { width: '47%' },
  infoLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, marginBottom: 2 },
  infoValue: { fontSize: 13, fontWeight: '500' },
  divider:   { height: StyleSheet.hairlineWidth, marginVertical: 4 },

  // Section
  sectionLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
});
