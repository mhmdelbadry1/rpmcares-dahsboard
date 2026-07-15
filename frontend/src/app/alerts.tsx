import {
  AlertTriangle, Bell, CheckCircle2, ChevronDown, RefreshCw, UserPlus, X, Zap,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Modal, Pressable,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { useRouter } from 'expo-router';
import { api, ApiError, type AlertEvent, type AlertStatus, type Clinic, type Member } from '@/lib/api';

const STATUS_FILTERS: { label: string; value: AlertStatus | 'all' }[] = [
  { label: 'All',       value: 'all'       },
  { label: 'Open',      value: 'open'      },
  { label: 'Assigned',  value: 'assigned'  },
  { label: 'Escalated', value: 'escalated' },
  { label: 'Resolved',  value: 'resolved'  },
];

function timeAgo(iso: string | null): string {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Success toast ─────────────────────────────────────────────────────────────

function SuccessToast({ message, visible }: { message: string; visible: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1800),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, message]);
  return (
    <Animated.View style={[toast.wrap, { opacity }]} pointerEvents="none">
      <CheckCircle2 size={15} color="#fff" />
      <Text style={toast.text}>{message}</Text>
    </Animated.View>
  );
}
const toast = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: 80, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#16a34a', borderRadius: 999,
    paddingHorizontal: 18, paddingVertical: 10,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, elevation: 6, zIndex: 99,
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '700' },
});

// ── Clinic picker modal ───────────────────────────────────────────────────────

function ClinicPicker({
  visible, clinics, selected, onSelect, onClose,
}: {
  visible: boolean; clinics: Clinic[]; selected: string;
  onSelect: (name: string) => void; onClose: () => void;
}) {
  const colors = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Filter by clinic</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: 6, paddingTop: 10 }}>
            {/* All clinics option */}
            <Pressable
              onPress={() => { onSelect(''); onClose(); }}
              style={[styles.clinicRow, { borderColor: colors.border }, selected === '' && { backgroundColor: colors.primary + '12', borderColor: colors.primary }]}
            >
              <Text style={[styles.clinicRowText, { color: selected === '' ? colors.primary : colors.text }]}>
                All clinics
              </Text>
              {selected === '' && <CheckCircle2 size={16} color={colors.primary} />}
            </Pressable>
            {clinics.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => { onSelect(c.name); onClose(); }}
                style={[styles.clinicRow, { borderColor: colors.border }, selected === c.name && { backgroundColor: colors.primary + '12', borderColor: colors.primary }]}
              >
                <Text style={[styles.clinicRowText, { color: selected === c.name ? colors.primary : colors.text }]} numberOfLines={1}>
                  {c.name}
                </Text>
                {selected === c.name && <CheckCircle2 size={16} color={colors.primary} />}
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function AlertsScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const isSuperAdmin = session?.user.role === 'super_admin';

  // All alerts loaded from API — filtering done client-side for stable counts
  const [allAlerts, setAllAlerts]       = useState<AlertEvent[] | null>(null);
  const [clinics, setClinics]           = useState<Clinic[]>([]);
  const [members, setMembers]           = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AlertStatus | 'all'>('all');
  const [clinicFilter, setClinicFilter] = useState('');        // clinic name, '' = all
  const [showClinicPicker, setShowClinicPicker] = useState(false);
  const [loadError, setLoadError]       = useState('');
  const [loading, setLoading]           = useState(true);
  const [assignTarget, setAssignTarget] = useState<AlertEvent | null>(null);
  const [busyIds, setBusyIds]           = useState<Set<string>>(new Set());
  const [toastMsg, setToastMsg]         = useState('');
  const [toastKey, setToastKey]         = useState(0);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastKey((k) => k + 1);
  };

  // Load clinics once (super_admin only)
  useEffect(() => {
    if (!isSuperAdmin || !session) return;
    api.listClinics(session.token)
      .then((r) => setClinics(r.clinics))
      .catch(() => {});
  }, [isSuperAdmin, session]);

  // Load ALL statuses at once — filter client-side so counts never flicker
  const load = useCallback(async () => {
    if (!session) return;
    setLoadError('');
    setLoading(true);
    try {
      const params: { clinic?: string } = {};
      if (clinicFilter) params.clinic = clinicFilter;
      const res = await api.listAlerts(session.token, params);
      setAllAlerts(res.alerts);
      if (!isSuperAdmin) {
        const membersRes = await api.listMembers(session.token);
        setMembers(membersRes.members);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load alerts.');
    } finally {
      setLoading(false);
    }
  }, [session, clinicFilter, isSuperAdmin]);

  useEffect(() => { load(); }, [load]);

  // Client-side filter — instant, no API call
  const displayedAlerts = allAlerts
    ? statusFilter === 'all'
      ? allAlerts
      : allAlerts.filter((a) => a.status === statusFilter)
    : null;

  // Stable counts — derived from the full loaded set
  const counts = {
    all:       allAlerts?.length ?? 0,
    open:      allAlerts?.filter((a) => a.status === 'open').length      ?? 0,
    assigned:  allAlerts?.filter((a) => a.status === 'assigned').length  ?? 0,
    escalated: allAlerts?.filter((a) => a.status === 'escalated').length ?? 0,
    resolved:  allAlerts?.filter((a) => a.status === 'resolved').length  ?? 0,
  };

  const doUpdate = async (
    id: string,
    patch: { status?: AlertStatus; assignedTo?: string | null },
  ) => {
    if (!session) return;
    setBusyIds((s) => new Set(s).add(id));
    try {
      const { alert: updated } = await api.updateAlert(session.token, id, patch);
      setAllAlerts((prev) => prev?.map((a) => (a.id === id ? updated : a)) ?? null);
    } catch (err) {
      showToast('Failed to update alert');
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const handleResolve = async (a: AlertEvent) => {
    await doUpdate(a.id, { status: 'resolved' });
    showToast('Alert resolved');
  };

  const handleEscalate = async (a: AlertEvent) => {
    await doUpdate(a.id, { status: 'escalated' });
    showToast('Alert escalated to provider');
  };

  const openAssignModal = useCallback(async (alert: AlertEvent) => {
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
  }, [session, isSuperAdmin]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={styles.content}>
        <PageHeader
          eyebrow="Triage"
          title="Alerts & Triage"
          description={
            allAlerts
              ? `${counts.open} open · ${counts.escalated} escalated · ${counts.resolved} resolved`
              : 'Live anomaly queue from the monitoring workflow.'
          }
          actions={
            <Pressable onPress={load} style={[styles.refreshBtn, { borderColor: colors.border }]}>
              <RefreshCw size={15} color={colors.textSecondary} />
            </Pressable>
          }
        />

        {/* ── Clinic filter (super_admin only) ─────────────────────────── */}
        {isSuperAdmin && (
          <Pressable
            onPress={() => setShowClinicPicker(true)}
            style={[styles.clinicFilterBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
          >
            <Text style={[styles.clinicFilterLabel, { color: colors.textSecondary }]}>Clinic</Text>
            <Text
              style={[styles.clinicFilterValue, { color: clinicFilter ? colors.text : colors.textSecondary }]}
              numberOfLines={1}
            >
              {clinicFilter || 'All clinics'}
            </Text>
            <ChevronDown size={14} color={colors.textSecondary} />
          </Pressable>
        )}

        {/* ── Status filter chips ──────────────────────────────────────── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterRow}
          contentContainerStyle={{ gap: 8 }}
        >
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.value;
            const count  = counts[f.value as keyof typeof counts];
            return (
              <Pressable
                key={f.value}
                onPress={() => setStatusFilter(f.value)}
                style={[
                  styles.filterChip,
                  {
                    borderColor: active ? colors.primary : colors.border,
                    backgroundColor: active ? colors.primary : colors.card,
                  },
                ]}
              >
                <Text style={{ color: active ? '#fff' : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                  {f.label}
                </Text>
                {count > 0 && (
                  <View style={[
                    styles.chipBadge,
                    { backgroundColor: active ? 'rgba(255,255,255,0.28)' : colors.primary + '20' },
                  ]}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: active ? '#fff' : colors.primary }}>
                      {count}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* ── Escalated banner ─────────────────────────────────────────── */}
        {statusFilter === 'all' && counts.escalated > 0 && (
          <Pressable
            onPress={() => setStatusFilter('escalated')}
            style={[styles.escalatedBanner, { backgroundColor: '#d97706' + '15', borderColor: '#d9770640' }]}
          >
            <AlertTriangle size={14} color="#d97706" />
            <Text style={{ color: '#d97706', fontSize: 12.5, fontWeight: '700', flex: 1 }}>
              {counts.escalated} escalated alert{counts.escalated > 1 ? 's' : ''} awaiting provider review
            </Text>
            <Text style={{ color: '#d97706', fontSize: 11 }}>View →</Text>
          </Pressable>
        )}

        {/* ── List ─────────────────────────────────────────────────────── */}
        {loadError ? (
          <Card>
            <Text style={{ color: colors.destructive, fontSize: 12.5, fontWeight: '600' }}>{loadError}</Text>
          </Card>
        ) : loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
        ) : displayedAlerts === null || displayedAlerts.length === 0 ? (
          <Card style={{ alignItems: 'center', paddingVertical: 40, gap: 10 }}>
            {statusFilter === 'resolved'
              ? <CheckCircle2 size={28} color={colors.textSecondary} />
              : <Bell size={28} color={colors.textSecondary} />}
            <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
              {statusFilter === 'resolved'
                ? 'No resolved alerts yet.'
                : statusFilter === 'escalated'
                ? 'No escalated alerts.'
                : statusFilter === 'all'
                ? 'No alerts yet.'
                : `No ${statusFilter} alerts.`}
            </Text>
          </Card>
        ) : (
          <View style={{ gap: 10 }}>
            {displayedAlerts.map((a) => (
              <AlertCard
                key={a.id}
                alert={a}
                busy={busyIds.has(a.id)}
                onAssign={() => openAssignModal(a)}
                onEscalate={() => handleEscalate(a)}
                onResolve={() => handleResolve(a)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <SuccessToast key={toastKey} message={toastMsg} visible={toastMsg !== ''} />

      <ClinicPicker
        visible={showClinicPicker}
        clinics={clinics}
        selected={clinicFilter}
        onSelect={setClinicFilter}
        onClose={() => setShowClinicPicker(false)}
      />

      <AssignModal
        visible={assignTarget !== null}
        alert={assignTarget}
        members={members}
        membersLoading={membersLoading}
        currentUserId={session?.user.id ?? ''}
        onClose={() => setAssignTarget(null)}
        onAssigned={(memberId) => {
          if (assignTarget) {
            doUpdate(assignTarget.id, { status: 'assigned', assignedTo: memberId });
            showToast('Alert assigned');
          }
          setAssignTarget(null);
        }}
      />
    </View>
  );
}

// ── Alert card ────────────────────────────────────────────────────────────────

function AlertCard({ alert: a, busy, onAssign, onEscalate, onResolve }: {
  alert: AlertEvent; busy: boolean;
  onAssign: () => void; onEscalate: () => void; onResolve: () => void;
}) {
  const colors = useTheme();
  const router  = useRouter();
  const isCritical  = a.tier === 'CRITICAL';
  const isResolved  = a.status === 'resolved';
  const isEscalated = a.status === 'escalated';
  const tierColor   = isCritical ? colors.destructive : '#d97706';
  const tierBg      = isCritical ? colors.destructive + '18' : '#d9770618';
  const stripeColor = isResolved ? '#16a34a' : isEscalated ? '#d97706' : tierColor;

  const statusTone = (): 'success' | 'warning' | 'muted' | 'info' => {
    if (isResolved)              return 'success';
    if (isEscalated)             return 'warning';
    if (a.status === 'assigned') return 'info';
    return 'muted';
  };

  function goToPatient() {
    if (a.patient_uuid) {
      router.push({ pathname: `/patients/${a.patient_uuid}` as any, params: { tab: 'Alerts' } });
    }
  }

  return (
    <Card style={[styles.alertCard, isResolved && styles.resolvedCard]}>
      <View style={[styles.tierStripe, { backgroundColor: stripeColor }]} />
      <View style={styles.alertBody}>
        <View style={styles.alertTopRow}>
          <View style={[styles.tierBadge, { backgroundColor: tierBg }]}>
            {isCritical
              ? <Zap size={11} color={tierColor} />
              : <AlertTriangle size={11} color={tierColor} />}
            <Text style={[styles.tierText, { color: tierColor }]}>
              {isCritical ? 'CRITICAL' : 'NON-CRITICAL'}
            </Text>
          </View>
          <StatusPill tone={statusTone() as any}>
            {a.status.charAt(0).toUpperCase() + a.status.slice(1)}
          </StatusPill>
        </View>

        <Pressable onPress={goToPatient} disabled={!a.patient_uuid} style={{ alignSelf: 'flex-start' }}>
          <Text style={[styles.patientName, { color: a.patient_uuid ? colors.primary : colors.text }]} numberOfLines={1}>
            {a.patient_name}
          </Text>
        </Pressable>
        <Text style={[styles.clinicLabel, { color: colors.textSecondary }]} numberOfLines={1}>{a.clinic_name}</Text>

        <View style={styles.readingRow}>
          <View style={[styles.readingBox, { backgroundColor: tierBg, borderColor: tierColor + '40' }]}>
            <Text style={[styles.alertTypeLabel, { color: colors.textSecondary }]}>{a.alert_type}</Text>
            <Text style={[styles.readingValue, { color: tierColor }]}>
              {a.value} <Text style={styles.readingUnit}>{a.unit}</Text>
            </Text>
            <Text style={[styles.thresholdText, { color: colors.textSecondary }]}>
              threshold {a.threshold} {a.unit}
            </Text>
          </View>
          <View style={styles.metaCol}>
            <Text style={[styles.metaLabel, { color: colors.textSecondary }]}>Detected</Text>
            <Text style={[styles.metaValue, { color: colors.text }]}>{timeAgo(a.reading_time)}</Text>
            {a.assignee && (
              <>
                <Text style={[styles.metaLabel, { color: colors.textSecondary, marginTop: 8 }]}>Assigned to</Text>
                <Text style={[styles.metaValue, { color: colors.text }]} numberOfLines={1}>{a.assignee.name}</Text>
              </>
            )}
            {isResolved && a.resolved_at && (
              <>
                <Text style={[styles.metaLabel, { color: colors.textSecondary, marginTop: 8 }]}>Resolved</Text>
                <Text style={[styles.metaValue, { color: '#16a34a' }]}>{timeAgo(a.resolved_at)}</Text>
              </>
            )}
            {isEscalated && (
              <>
                <Text style={[styles.metaLabel, { color: colors.textSecondary, marginTop: 8 }]}>Status</Text>
                <Text style={[styles.metaValue, { color: '#d97706' }]}>Awaiting provider</Text>
              </>
            )}
          </View>
        </View>

        {isResolved && (
          <View style={styles.resolvedBanner}>
            <CheckCircle2 size={14} color="#16a34a" />
            <Text style={styles.resolvedBannerText}>
              Resolved{a.resolved_at ? ` · ${timeAgo(a.resolved_at)}` : ''}
            </Text>
          </View>
        )}

        {!isResolved && (
          <View style={styles.actionRow}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 4 }} />
            ) : (
              <>
                {a.status === 'open' && (
                  <ActionButton icon={<UserPlus size={13} color={colors.primary} />} label="Assign"
                    onPress={onAssign} borderColor={colors.border} textColor={colors.primary} />
                )}
                {!isEscalated && (
                  <ActionButton icon={<AlertTriangle size={13} color="#d97706" />} label="Escalate"
                    onPress={onEscalate} borderColor={colors.border} textColor="#d97706" />
                )}
                <ActionButton icon={<CheckCircle2 size={13} color="#16a34a" />} label="Resolve"
                  onPress={onResolve} borderColor={colors.border} textColor="#16a34a" filled />
              </>
            )}
          </View>
        )}
      </View>
    </Card>
  );
}

function ActionButton({ icon, label, onPress, borderColor, textColor, filled }: {
  icon: React.ReactNode; label: string; onPress: () => void;
  borderColor: string; textColor: string; filled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.actionBtn, { borderColor }, filled && { backgroundColor: textColor + '15' }]}
    >
      {icon}
      <Text style={{ color: textColor, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

// ── Assign modal ──────────────────────────────────────────────────────────────

function AssignModal({ visible, alert: a, members, membersLoading, currentUserId, onClose, onAssigned }: {
  visible: boolean; alert: AlertEvent | null; members: Member[];
  membersLoading: boolean; currentUserId: string;
  onClose: () => void; onAssigned: (id: string) => void;
}) {
  const colors = useTheme();
  if (!a) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <View>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>Assign alert</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>{a.clinic_name}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>
          <Text style={[styles.sheetSub, { color: colors.textSecondary }]} numberOfLines={2}>
            {a.patient_name} · {a.alert_type} ({a.value} {a.unit})
          </Text>
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
            <Pressable
              onPress={() => onAssigned(currentUserId)}
              style={[styles.memberRow, { borderColor: colors.border }]}
            >
              <View style={[styles.memberAvatar, { backgroundColor: colors.primary + '20' }]}>
                <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>ME</Text>
              </View>
              <Text style={[styles.memberName, { color: colors.primary }]}>Assign to myself</Text>
            </Pressable>
            {membersLoading ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: 20 }} />
            ) : members.length === 0 ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12.5, textAlign: 'center', paddingVertical: 16 }}>
                No other members in this clinic.
              </Text>
            ) : (
              members.map((m) => (
                <Pressable key={m.id} onPress={() => onAssigned(m.id)}
                  style={[styles.memberRow, { borderColor: colors.border }]}>
                  <View style={[styles.memberAvatar, { backgroundColor: colors.primary + '15' }]}>
                    <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '700' }}>
                      {m.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.memberName, { color: colors.text }]}>{m.name}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{m.role.replace('_', ' ')}</Text>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 80, gap: 0 },
  refreshBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },

  clinicFilterBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 11, marginBottom: 10,
  },
  clinicFilterLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  clinicFilterValue: { flex: 1, fontSize: 13.5, fontWeight: '600' },

  filterRow: { marginBottom: 12 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipBadge: { minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },

  escalatedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginBottom: 10 },

  alertCard: { padding: 0, overflow: 'hidden', flexDirection: 'row' },
  resolvedCard: { opacity: 0.7 },
  tierStripe: { width: 4 },
  alertBody: { flex: 1, padding: 14, gap: 6 },
  alertTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tierBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  tierText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4 },
  patientName: { fontSize: 15, fontWeight: '800', marginTop: 4 },
  clinicLabel: { fontSize: 11.5, marginTop: 1 },
  readingRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  readingBox: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 2 },
  alertTypeLabel: { fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  readingValue: { fontSize: 22, fontWeight: '800' },
  readingUnit: { fontSize: 13, fontWeight: '500' },
  thresholdText: { fontSize: 10.5, marginTop: 2 },
  metaCol: { width: 110, gap: 2 },
  metaLabel: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  metaValue: { fontSize: 12.5, fontWeight: '700' },
  resolvedBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#16a34a18', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, marginTop: 4 },
  resolvedBannerText: { color: '#16a34a', fontSize: 12, fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingBottom: 36 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 16, fontWeight: '800' },
  sheetSub: { fontSize: 12, marginTop: 4 },
  clinicRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  clinicRowText: { fontSize: 13.5, fontWeight: '600', flex: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  memberAvatar: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  memberName: { fontSize: 13.5, fontWeight: '700' },
});
