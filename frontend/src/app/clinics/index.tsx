import {
  Building2, Plus, X, UserPlus, MapPin, Stethoscope,
  ShieldCheck, Trash2, Mail, ChevronRight, ChevronLeft, Key, CheckCircle2, FileText,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { ProgressBar } from '@/components/ui/progress-bar';
import { useAuth } from '@/contexts/auth-context';
import { ROLE_META } from '@/contexts/role-context';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, type Clinic, type Member, type ClinicBreakdownItem, type ClinicReport } from '@/lib/api';

// ── types ─────────────────────────────────────────────────────────────────
type EnrichedClinic = Clinic & {
  stats: ClinicBreakdownItem | null;
  providerCount: number;
};

// ── helpers ───────────────────────────────────────────────────────────────
function initials(name: string) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function prevMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── Clinic Card ───────────────────────────────────────────────────────────
function ClinicCard({ clinic, onPress }: { clinic: EnrichedClinic; onPress: () => void }) {
  const colors = useTheme();
  const s = clinic.stats;
  const compliance = s?.complianceRate ?? null;

  const toneColor =
    compliance === null ? colors.textSecondary
    : compliance >= 80   ? colors.success
    : compliance >= 60   ? colors.warning
    :                      colors.critical;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.88 : 1 }]}>
      <Card style={styles.clinicCard}>
        {/* Header */}
        <View style={styles.cardHeader}>
          <View style={[styles.cardIcon, { backgroundColor: colors.primary + '18' }]}>
            <Building2 size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.clinicName, { color: colors.text }]} numberOfLines={2}>
              {clinic.name}
            </Text>
            {(clinic.specialty || clinic.location) && (
              <View style={styles.metaRow}>
                {clinic.specialty && (
                  <View style={styles.metaChip}>
                    <Stethoscope size={10} color={colors.textSecondary} />
                    <Text style={[styles.metaText, { color: colors.textSecondary }]}>{clinic.specialty}</Text>
                  </View>
                )}
                {clinic.location && (
                  <View style={styles.metaChip}>
                    <MapPin size={10} color={colors.textSecondary} />
                    <Text style={[styles.metaText, { color: colors.textSecondary }]}>{clinic.location}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <ChevronRight size={16} color={colors.textSecondary} />
        </View>

        {/* Compliance bar */}
        {s && (
          <View style={styles.complianceRow}>
            <View style={styles.complianceLabelRow}>
              <ShieldCheck size={12} color={toneColor} />
              <Text style={[styles.complianceLabel, { color: toneColor }]}>
                {compliance}% compliance
              </Text>
            </View>
            <ProgressBar value={compliance ?? 0} color={toneColor} />
          </View>
        )}

        {/* Stats grid */}
        <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
          <StatCell label="Patients"  value={s ? s.totalPatients.toLocaleString() : '—'} color={colors.primary} />
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <StatCell label="Providers" value={clinic.providerCount.toString()} color={colors.success} />
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <StatCell
            label="Alerts"
            value={s ? s.unreadAlerts.toLocaleString() : '—'}
            color={s && s.unreadAlerts > 50 ? colors.critical : s && s.unreadAlerts > 10 ? colors.warning : colors.text}
          />
        </View>
      </Card>
    </Pressable>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  const colors = useTheme();
  return (
    <View style={styles.statCell}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────
export default function ClinicsScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const isSuperAdmin = session?.user.role === 'super_admin';

  const [clinics, setClinics]       = useState<Clinic[]>([]);
  const [members, setMembers]       = useState<Member[]>([]);
  const [breakdown, setBreakdown]   = useState<ClinicBreakdownItem[]>([]);
  const [loadingBase, setLoadingBase]   = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [error, setError]           = useState('');

  const [addOpen, setAddOpen]       = useState(false);
  const [selected, setSelected]     = useState<EnrichedClinic | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteClinicId, setInviteClinicId] = useState<string | null>(null);

  // Load clinics + members
  const loadBase = useCallback(async () => {
    if (!session) return;
    setLoadingBase(true);
    setError('');
    try {
      const [clinicsRes, membersRes] = await Promise.all([
        api.listClinics(session.token),
        api.listMembers(session.token),
      ]);
      setClinics(clinicsRes.clinics);
      setMembers(membersRes.members);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load clinics.');
    } finally {
      setLoadingBase(false);
    }
  }, [session]);

  // Load SmartMeter per-clinic breakdown (slower ~10s)
  const loadStats = useCallback(async () => {
    if (!session) return;
    setLoadingStats(true);
    try {
      const res = await api.getClinicBreakdown(session.token);
      setBreakdown(res.breakdown);
    } catch (_) {
      // Stats are optional — base data still shows without them
    } finally {
      setLoadingStats(false);
    }
  }, [session]);

  useEffect(() => {
    loadBase();
    loadStats();
  }, [loadBase, loadStats]);

  // Merge clinic + SmartMeter stats + provider count
  const enriched: EnrichedClinic[] = clinics.map((c) => ({
    ...c,
    stats: breakdown.find((b) => b.name === c.name) ?? null,
    providerCount: members.filter((m) => m.clinic_id === c.id).length,
  }));

  const openInvite = (clinicId: string) => {
    setInviteClinicId(clinicId);
    setInviteOpen(true);
    setSelected(null);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }} contentContainerStyle={styles.content}>
      <PageHeader
        eyebrow="Network"
        title="Clinics"
        description={`${clinics.length} clinics onboarded${loadingStats ? ' · loading live stats…' : ''}`}
        actions={
          isSuperAdmin ? (
            <Pressable onPress={() => setAddOpen(true)} style={[styles.addBtn, { backgroundColor: colors.primary }]}>
              <Plus size={15} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add clinic</Text>
            </Pressable>
          ) : undefined
        }
      />

      {error ? (
        <Card>
          <Text style={{ color: colors.critical, fontSize: 12.5, fontWeight: '600' }}>{error}</Text>
        </Card>
      ) : loadingBase ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : enriched.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32, gap: 8 }}>
          <Building2 size={26} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
            No clinics yet. Add one to get started.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {loadingStats && (
            <View style={styles.statsLoadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.statsLoadingText, { color: colors.textSecondary }]}>
                Fetching live stats from all clinics…
              </Text>
            </View>
          )}
          {enriched.map((clinic) => (
            <ClinicCard key={clinic.id} clinic={clinic} onPress={() => setSelected(clinic)} />
          ))}
        </View>
      )}

      {/* ── Modals ── */}
      <AddClinicModal
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); loadBase(); }}
      />

      <ClinicDetailSheet
        clinic={selected}
        members={members.filter((m) => m.clinic_id === selected?.id)}
        onClose={() => setSelected(null)}
        onInvite={() => selected && openInvite(selected.id)}
        onMemberRemoved={() => { setSelected(null); loadBase(); }}
        onDeleted={() => { setSelected(null); loadBase(); }}
        onUpdated={() => loadBase()}
        isSuperAdmin={isSuperAdmin}
        session={session}
      />

      <InviteModal
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => { setInviteOpen(false); loadBase(); }}
        clinics={clinics}
        preselectedClinicId={inviteClinicId}
        isSuperAdmin={isSuperAdmin}
        callerClinicId={session?.user.clinicId ?? null}
      />
    </ScrollView>
  );
}

// ── Clinic Detail Bottom Sheet ────────────────────────────────────────────
function ClinicDetailSheet({
  clinic, members, onClose, onInvite, onMemberRemoved, onDeleted, onUpdated, isSuperAdmin, session,
}: {
  clinic: EnrichedClinic | null;
  members: Member[];
  onClose: () => void;
  onInvite: () => void;
  onMemberRemoved: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
  isSuperAdmin: boolean;
  session: { token: string } | null;
}) {
  const colors = useTheme();

  // ── Team tab state ─────────────────────────────────────────────────────
  const [apiKey, setApiKey]   = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keySaved, setKeySaved]   = useState(false);

  // ── Report tab state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab]         = useState<'team' | 'report'>('team');
  const [reportMonth, setReportMonth]     = useState(currentMonth());
  const [clinicReport, setClinicReport]   = useState<ClinicReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError]     = useState<string | null>(null);
  const [exporting, setExporting]         = useState(false);

  // Reset on clinic change
  useEffect(() => {
    if (clinic) {
      setApiKey('');
      setKeySaved(false);
      setActiveTab('team');
      setClinicReport(null);
      setReportMonth(currentMonth());
    }
  }, [clinic?.id]);

  // Load report whenever tab or month changes
  useEffect(() => {
    if (!clinic || !session || activeTab !== 'report') return;
    setReportLoading(true);
    setReportError(null);
    api.getClinicReport(session.token, clinic.id, reportMonth)
      .then(setClinicReport)
      .catch((e: any) => setReportError(e?.message ?? 'Failed to load report'))
      .finally(() => setReportLoading(false));
  }, [clinic?.id, session, activeTab, reportMonth]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleSaveKey = async () => {
    if (!session || !clinic || !apiKey.trim()) return;
    setSavingKey(true);
    try {
      await api.patchClinic(session.token, clinic.id, { smartmeter_api_key: apiKey.trim() });
      setApiKey('');
      setKeySaved(true);
      onUpdated();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'Could not save API key.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemove = (member: Member) => {
    if (!session) return;
    Alert.alert(
      'Remove account',
      `Remove ${member.name}? They'll lose access immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            try {
              await api.removeMember(session.token, member.id);
              onMemberRemoved();
            } catch (err) {
              Alert.alert('Error', err instanceof ApiError ? err.message : 'Could not remove.');
            }
          },
        },
      ],
    );
  };

  const handleDeleteClinic = () => {
    if (!session || !clinic) return;
    Alert.alert(
      'Delete clinic',
      `Permanently delete "${clinic.name}"? This cannot be undone. All associated data will be removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteClinic(session.token, clinic.id);
              onDeleted();
            } catch (err) {
              Alert.alert('Error', err instanceof ApiError ? err.message : 'Could not delete clinic.');
            }
          },
        },
      ],
    );
  };

  // ── PDF builder (B&W) ─────────────────────────────────────────────────
  const buildClinicHtml = (r: ClinicReport): string => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const patientRows = r.patients.map((p) => `
      <tr>
        <td>${esc(p.full_name)}<br><span style="font-size:9px">${esc(p.mrn ?? '—')}</span></td>
        <td>${esc(p.program ?? '—')}</td>
        <td>${esc(p.insurance_payer ?? '—')}</td>
        <td>${esc(p.icd10_codes.join(', ') || '—')}</td>
        <td style="text-align:center">${p.totalReadings}</td>
        <td style="text-align:center">${p.totalMinutes} min</td>
        <td>${esc(p.cptCodes.join(', ') || '—')}</td>
        <td style="text-align:right">$${p.totalProjected.toFixed(2)}</td>
      </tr>`).join('');

    const byCptRows = Object.entries(r.totals.byCpt).map(([code, v]) =>
      `<tr><td>${esc(code)}</td><td style="text-align:center">${v.count}</td><td style="text-align:right">$${v.amount.toFixed(2)}</td></tr>`
    ).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      *{box-sizing:border-box}
      body{font-family:Courier,monospace;font-size:11px;color:#000;margin:0;padding:20px;background:#fff}
      table{width:100%;border-collapse:collapse;font-size:10px;margin-top:8px}
      th{border-bottom:2px solid #000;text-align:left;padding:4px 6px;font-size:10px;font-weight:bold}
      td{border-bottom:1px solid #ccc;padding:4px 6px;vertical-align:top}
      @media print{@page{margin:1cm;size:A4 landscape}body{padding:6px}}
    </style></head><body>
    <div style="text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px">
      <div style="font-size:15px;font-weight:bold">RPMCARES — CLINIC REPORT</div>
      <div>${esc(r.clinic.name)}${r.clinic.specialty ? ` · ${esc(r.clinic.specialty)}` : ''}${r.clinic.location ? ` · ${esc(r.clinic.location)}` : ''}</div>
      <div>Period: ${esc(r.period.label)} &nbsp;|&nbsp; Generated: ${new Date(r.generatedAt).toLocaleString('en-US')}</div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;border:1px solid #000;padding:8px;margin-bottom:12px;text-align:center">
      <div><div style="font-size:16px;font-weight:bold">${r.totals.patients}</div><div>Patients</div></div>
      <div><div style="font-size:16px;font-weight:bold">${r.totals.totalReadings}</div><div>Readings</div></div>
      <div><div style="font-size:16px;font-weight:bold">${r.totals.totalMinutes} min</div><div>Review Time</div></div>
      <div><div style="font-size:16px;font-weight:bold">${r.totals.thresholdMet}</div><div>Threshold Met</div></div>
      <div><div style="font-size:16px;font-weight:bold">$${r.totals.totalProjected.toFixed(2)}</div><div>Projected</div></div>
    </div>

    <b>CPT Summary</b>
    <table style="width:auto;margin-bottom:16px">
      <thead><tr><th>CPT Code</th><th>Patients</th><th>Projected</th></tr></thead>
      <tbody>${byCptRows}</tbody>
    </table>

    <b>Patient Details</b>
    <table>
      <thead><tr>
        <th>Patient (MRN)</th><th>Program</th><th>Insurance</th><th>ICD-10</th>
        <th>Readings</th><th>Review</th><th>CPT Codes</th><th>Projected</th>
      </tr></thead>
      <tbody>${patientRows}</tbody>
    </table>

    <div style="margin-top:12px;border-top:1px solid #000;padding-top:8px;font-size:10px;text-align:center">
      For billing review only — not a clinical record.
    </div>
    </body></html>`;
  };

  const exportPdf = async () => {
    if (!clinicReport) return;
    setExporting(true);
    try {
      const Print   = await import('expo-print');
      const Sharing = await import('expo-sharing');
      const html    = buildClinicHtml(clinicReport);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: `${clinicReport.clinic.name} — ${clinicReport.period.label}`,
          UTI:         'com.adobe.pdf',
        });
      }
    } catch (e: any) {
      console.warn('[clinic-report] PDF export failed:', e.message);
    } finally {
      setExporting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Modal visible={!!clinic} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>

          {/* Header */}
          <View style={styles.sheetHead}>
            <View style={[styles.sheetIcon, { backgroundColor: colors.primary + '18' }]}>
              <Building2 size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: colors.text }]} numberOfLines={2}>
                {clinic?.name}
              </Text>
              {(clinic?.specialty || clinic?.location) && (
                <Text style={[styles.sheetSub, { color: colors.textSecondary }]}>
                  {[clinic.specialty, clinic.location].filter(Boolean).join(' · ')}
                </Text>
              )}
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <X size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          {/* Stats row */}
          {clinic?.stats && (
            <View style={[styles.sheetStats, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
              {[
                ['Patients',   clinic.stats.totalPatients.toLocaleString()],
                ['Compliance', `${clinic.stats.complianceRate}%`],
                ['Alerts',     clinic.stats.unreadAlerts.toLocaleString()],
                ['Providers',  clinic.providerCount.toString()],
              ].map(([label, value]) => (
                <View key={label} style={styles.sheetStatCell}>
                  <Text style={[styles.sheetStatValue, { color: colors.text }]}>{value}</Text>
                  <Text style={[styles.sheetStatLabel, { color: colors.textSecondary }]}>{label}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Tab bar */}
          <View style={[styles.tabBar, { borderColor: colors.border }]}>
            {(['team', 'report'] as const).map((t) => {
              const active = activeTab === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setActiveTab(t)}
                  style={[styles.tabBtn, active && { borderBottomColor: colors.primary }]}
                >
                  <Text style={[styles.tabLabel, { color: active ? colors.primary : colors.textSecondary }]}>
                    {t === 'team' ? 'Team' : 'Report'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* ── Team tab ── */}
          {activeTab === 'team' && (
            <>
              {isSuperAdmin && (
                <View style={[styles.apiKeySection, { borderColor: colors.border, backgroundColor: colors.surface2 }]}>
                  <View style={styles.apiKeyHeader}>
                    <Key size={14} color={colors.primary} />
                    <Text style={[styles.apiKeyTitle, { color: colors.text }]}>SmartMeter API Key</Text>
                    {(clinic?.hasSmartMeterKey || keySaved) && (
                      <View style={[styles.keyBadge, { backgroundColor: colors.success + '20' }]}>
                        <CheckCircle2 size={11} color={colors.success} />
                        <Text style={[styles.keyBadgeText, { color: colors.success }]}>Connected</Text>
                      </View>
                    )}
                  </View>
                  <TextInput
                    value={apiKey}
                    onChangeText={setApiKey}
                    placeholder={clinic?.hasSmartMeterKey ? 'Enter new key to replace…' : 'Paste SmartMeter API key…'}
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={false}
                    style={[styles.apiKeyInput, { borderColor: colors.border, color: colors.text }]}
                  />
                  <Pressable
                    onPress={handleSaveKey}
                    disabled={savingKey || !apiKey.trim()}
                    style={[styles.apiKeySave, { backgroundColor: colors.primary, opacity: (savingKey || !apiKey.trim()) ? 0.45 : 1 }]}>
                    <Text style={styles.apiKeySaveText}>{savingKey ? 'Saving…' : 'Save key'}</Text>
                  </Pressable>
                </View>
              )}

              <View style={styles.membersHead}>
                <Text style={[styles.membersTitle, { color: colors.text }]}>
                  Team ({members.length})
                </Text>
                <Pressable onPress={onInvite} style={[styles.inviteSmall, { backgroundColor: colors.primary }]}>
                  <UserPlus size={13} color="#fff" />
                  <Text style={styles.inviteSmallText}>Invite</Text>
                </Pressable>
              </View>

              <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
                {members.length === 0 ? (
                  <View style={[styles.emptyMembers, { backgroundColor: colors.surface2 }]}>
                    <Mail size={20} color={colors.textSecondary} />
                    <Text style={[styles.emptyMembersText, { color: colors.textSecondary }]}>
                      No team members yet — tap Invite to add someone.
                    </Text>
                  </View>
                ) : (
                  members.map((m) => (
                    <View key={m.id} style={[styles.memberRow, { borderBottomColor: colors.border }]}>
                      <View style={[styles.avatar, { backgroundColor: colors.primary + '18' }]}>
                        <Text style={[styles.avatarText, { color: colors.primary }]}>{initials(m.name)}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>{m.name}</Text>
                        <Text style={[styles.memberEmail, { color: colors.textSecondary }]} numberOfLines={1}>{m.email}</Text>
                        <StatusPill tone={m.role === 'clinic_admin' ? 'info' : 'muted'}>
                          {ROLE_META[m.role].label}
                        </StatusPill>
                      </View>
                      <Pressable onPress={() => handleRemove(m)} hitSlop={10}>
                        <Trash2 size={16} color={colors.critical} />
                      </Pressable>
                    </View>
                  ))
                )}
              </ScrollView>

              {isSuperAdmin && (
                <Pressable
                  onPress={handleDeleteClinic}
                  style={[styles.deleteClinicBtn, { borderColor: colors.critical + '40', backgroundColor: colors.critical + '08' }]}>
                  <Trash2 size={15} color={colors.critical} />
                  <Text style={[styles.deleteClinicText, { color: colors.critical }]}>Delete clinic permanently</Text>
                </Pressable>
              )}
            </>
          )}

          {/* ── Report tab ── */}
          {activeTab === 'report' && (
            <>
              {/* Month navigator */}
              <View style={styles.monthNav}>
                <Pressable onPress={() => setReportMonth(prevMonth(reportMonth))} hitSlop={10}>
                  <ChevronLeft size={18} color={colors.primary} />
                </Pressable>
                <Text style={[styles.monthLabel, { color: colors.text }]}>{monthLabel(reportMonth)}</Text>
                <Pressable
                  onPress={() => setReportMonth(nextMonth(reportMonth))}
                  disabled={reportMonth >= currentMonth()}
                  hitSlop={10}
                >
                  <ChevronRight size={18} color={reportMonth >= currentMonth() ? colors.textSecondary : colors.primary} />
                </Pressable>
              </View>

              {reportLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
              ) : reportError ? (
                <Text style={{ color: colors.critical, fontSize: 12, marginTop: 12 }}>{reportError}</Text>
              ) : clinicReport ? (
                <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>

                  {/* Summary strip */}
                  <View style={[styles.reportStrip, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
                    {[
                      ['Patients',       String(clinicReport.totals.patients)],
                      ['Readings',       String(clinicReport.totals.totalReadings)],
                      ['Review',         `${clinicReport.totals.totalMinutes} min`],
                      ['Threshold Met',  String(clinicReport.totals.thresholdMet)],
                      ['Projected',      `$${clinicReport.totals.totalProjected.toFixed(0)}`],
                    ].map(([l, v]) => (
                      <View key={l} style={styles.reportStripCell}>
                        <Text style={[styles.reportStripVal, { color: colors.text }]}>{v}</Text>
                        <Text style={[styles.reportStripLbl, { color: colors.textSecondary }]}>{l}</Text>
                      </View>
                    ))}
                  </View>

                  {/* CPT breakdown */}
                  {Object.keys(clinicReport.totals.byCpt).length > 0 && (
                    <View style={{ marginBottom: 12 }}>
                      <Text style={[styles.sectionTitle, { color: colors.text }]}>CPT Summary</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {Object.entries(clinicReport.totals.byCpt).map(([code, v]) => (
                          <View key={code} style={[styles.cptChip, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
                            <Text style={[styles.cptChipCode, { color: colors.text }]}>{code}</Text>
                            <Text style={[styles.cptChipMeta, { color: colors.textSecondary }]}>
                              {v.count} pts · ${v.amount.toFixed(0)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}

                  {/* Patient list */}
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    Patients ({clinicReport.patients.length})
                  </Text>
                  {clinicReport.patients.length === 0 ? (
                    <Text style={{ color: colors.textSecondary, fontSize: 12, fontStyle: 'italic', marginTop: 8 }}>
                      No active patients for this period.
                    </Text>
                  ) : (
                    clinicReport.patients.map((p) => {
                      const threshMet = p.byProgram.some((b) => b.thresholdMet);
                      return (
                        <View
                          key={p.patient_id}
                          style={[styles.reportPatRow, { borderColor: colors.border }]}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.reportPatName, { color: colors.text }]} numberOfLines={1}>
                              {p.full_name}
                            </Text>
                            <Text style={[styles.reportPatMeta, { color: colors.textSecondary }]}>
                              {p.program ?? '—'}{p.mrn ? ` · ${p.mrn}` : ''}{p.insurance_payer ? ` · ${p.insurance_payer}` : ''}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 2 }}>
                            <Text style={[styles.reportPatStat, { color: colors.text }]}>
                              {p.totalReadings} rdgs · {p.totalMinutes} min
                            </Text>
                            <Text style={[styles.reportPatStat, { color: colors.textSecondary }]}>
                              {p.cptCodes.join(', ') || '—'}
                            </Text>
                            <View style={[
                              styles.threshBadge,
                              { backgroundColor: threshMet ? colors.success + '18' : colors.warning + '18' }
                            ]}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: threshMet ? colors.success : colors.warning }}>
                                {threshMet ? 'MET' : 'NOT MET'}
                              </Text>
                            </View>
                          </View>
                        </View>
                      );
                    })
                  )}
                </ScrollView>
              ) : null}

              {/* Export button */}
              <Pressable
                onPress={exportPdf}
                disabled={exporting || !clinicReport}
                style={[styles.exportBtn, { backgroundColor: colors.primary, opacity: (exporting || !clinicReport) ? 0.5 : 1 }]}
              >
                <FileText size={14} color="#fff" />
                <Text style={styles.exportBtnText}>{exporting ? 'Generating…' : 'Export Report PDF'}</Text>
              </Pressable>
            </>
          )}

        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Add Clinic Modal ──────────────────────────────────────────────────────
function AddClinicModal({ visible, onClose, onAdded }: { visible: boolean; onClose: () => void; onAdded: () => void }) {
  const colors = useTheme();
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (visible) { setName(''); setError(''); } }, [visible]);

  const handleSubmit = async () => {
    if (!session) return;
    if (!name.trim()) { setError('Clinic name is required.'); return; }
    setSubmitting(true); setError('');
    try { await api.createClinic(session.token, name.trim()); onAdded(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not add the clinic.'); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Add clinic</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Clinic name</Text>
          <TextInput
            value={name} onChangeText={setName} placeholder="Riverside Family Medicine"
            placeholderTextColor={colors.textSecondary}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
          />
          {error ? <Text style={{ color: colors.critical, fontSize: 12.5, fontWeight: '600', marginTop: 12 }}>{error}</Text> : null}
          <Pressable onPress={handleSubmit} disabled={submitting}
            style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}>
            <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '700' }}>
              {submitting ? 'Adding…' : 'Add clinic'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Invite Modal ──────────────────────────────────────────────────────────
function InviteModal({
  visible, onClose, onInvited, clinics, preselectedClinicId, isSuperAdmin, callerClinicId,
}: {
  visible: boolean; onClose: () => void; onInvited: () => void;
  clinics: Clinic[]; preselectedClinicId: string | null;
  isSuperAdmin: boolean; callerClinicId: string | null;
}) {
  const colors = useTheme();
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'clinic_admin' | 'staff'>('staff');
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible) {
      setName(''); setEmail(''); setRole('staff'); setError('');
      setClinicId(preselectedClinicId ?? (isSuperAdmin ? null : callerClinicId));
    }
  }, [visible, preselectedClinicId, isSuperAdmin, callerClinicId]);

  const handleSubmit = async () => {
    if (!session) return;
    if (!name.trim() || !email.trim() || !clinicId) {
      setError('Name, email and clinic are all required.'); return;
    }
    setSubmitting(true); setError('');
    try { await api.inviteMember(session.token, { name: name.trim(), email: email.trim(), role, clinicId }); onInvited(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send invite.'); }
    finally { setSubmitting(false); }
  };

  const selectedClinicName = clinics.find((c) => c.id === clinicId)?.name;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Invite to RPMCares</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>
          {selectedClinicName && (
            <View style={[styles.clinicPill, { backgroundColor: colors.primary + '18' }]}>
              <Building2 size={12} color={colors.primary} />
              <Text style={[styles.clinicPillText, { color: colors.primary }]}>{selectedClinicName}</Text>
            </View>
          )}
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Full name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Jordan Lee"
            placeholderTextColor={colors.textSecondary}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]} />
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Email</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="jordan@clinic.com"
            placeholderTextColor={colors.textSecondary} autoCapitalize="none" keyboardType="email-address"
            style={[styles.input, { borderColor: colors.border, color: colors.text }]} />
          {isSuperAdmin && (
            <>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Role</Text>
              <View style={styles.segmentRow}>
                {(['clinic_admin', 'staff'] as const).map((r) => (
                  <Pressable key={r} onPress={() => setRole(r)}
                    style={[styles.segment, { borderColor: colors.border, backgroundColor: role === r ? colors.primary : colors.card }]}>
                    <Text style={{ color: role === r ? '#fff' : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                      {ROLE_META[r].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {!preselectedClinicId && (
                <>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>Clinic</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    {clinics.map((c) => (
                      <Pressable key={c.id} onPress={() => setClinicId(c.id)}
                        style={[styles.segment, { borderColor: colors.border, backgroundColor: clinicId === c.id ? colors.primary : colors.card }]}>
                        <Text style={{ color: clinicId === c.id ? '#fff' : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                          {c.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              )}
            </>
          )}
          {error ? <Text style={{ color: colors.critical, fontSize: 12.5, fontWeight: '600', marginTop: 12 }}>{error}</Text> : null}
          <Pressable onPress={handleSubmit} disabled={submitting}
            style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}>
            <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '700' }}>
              {submitting ? 'Sending…' : 'Send invite'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 0 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },

  statsLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  statsLoadingText: { fontSize: 12 },

  // Clinic card
  clinicCard: { padding: 0, overflow: 'hidden', marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, paddingBottom: 10 },
  cardIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  clinicName: { fontSize: 14.5, fontWeight: '800', lineHeight: 20 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 11 },
  complianceRow: { paddingHorizontal: 14, paddingBottom: 12, gap: 6 },
  complianceLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  complianceLabel: { fontSize: 11.5, fontWeight: '700' },
  statsRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  statCell: { flex: 1, alignItems: 'center' },
  statDivider: { width: StyleSheet.hairlineWidth, marginVertical: 4 },
  statValue: { fontSize: 17, fontWeight: '800' },
  statLabel: { fontSize: 10.5, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4 },

  // Bottom sheets
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingBottom: 36 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 10 },
  sheetIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  sheetTitle: { fontSize: 16, fontWeight: '800', flex: 1 },
  sheetSub: { fontSize: 12, marginTop: 2 },

  // Clinic detail stats
  sheetStats: { flexDirection: 'row', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, marginBottom: 16, overflow: 'hidden' },
  sheetStatCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  sheetStatValue: { fontSize: 15, fontWeight: '800' },
  sheetStatLabel: { fontSize: 10, marginTop: 2, textTransform: 'uppercase' },

  // Members
  membersHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  membersTitle: { fontSize: 14, fontWeight: '700' },
  inviteSmall: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  inviteSmallText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  emptyMembers: { borderRadius: 12, padding: 20, alignItems: 'center', gap: 8 },
  emptyMembersText: { fontSize: 12.5, textAlign: 'center' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 13, fontWeight: '800' },
  memberName: { fontSize: 13.5, fontWeight: '700' },
  memberEmail: { fontSize: 11, marginTop: 1, marginBottom: 5 },

  // Invite modal
  clinicPill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 4 },
  clinicPillText: { fontSize: 12, fontWeight: '700' },
  fieldLabel: { fontSize: 12.5, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  input: { height: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, fontSize: 14.5 },
  segmentRow: { flexDirection: 'row', gap: 8 },
  segment: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  submitBtn: { height: 46, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  deleteClinicBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  deleteClinicText: { fontSize: 13.5, fontWeight: '700' },

  // API key section
  apiKeySection: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 16, gap: 10 },
  apiKeyHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  apiKeyTitle: { fontSize: 13, fontWeight: '700', flex: 1 },
  keyBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  keyBadgeText: { fontSize: 10.5, fontWeight: '700' },
  apiKeyInput: { height: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingHorizontal: 11, fontSize: 13.5 },
  apiKeySave: { height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  apiKeySaveText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Tab bar
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 14 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabLabel: { fontSize: 13, fontWeight: '700' },

  // Report tab
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  monthLabel: { fontSize: 14, fontWeight: '700' },

  reportStrip: { flexDirection: 'row', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 14, overflow: 'hidden' },
  reportStripCell: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  reportStripVal: { fontSize: 13, fontWeight: '800' },
  reportStripLbl: { fontSize: 9, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.3 },

  sectionTitle: { fontSize: 12.5, fontWeight: '700', marginBottom: 4 },

  cptChip: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6 },
  cptChipCode: { fontSize: 12, fontWeight: '800' },
  cptChipMeta: { fontSize: 10, marginTop: 1 },

  reportPatRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  reportPatName: { fontSize: 13, fontWeight: '700' },
  reportPatMeta: { fontSize: 10.5, marginTop: 2 },
  reportPatStat: { fontSize: 11 },
  threshBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginTop: 2 },

  exportBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, borderRadius: 999, marginTop: 14 },
  exportBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
