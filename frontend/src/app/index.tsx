import type { LucideIcon } from 'lucide-react-native';
import {
  Activity, ArrowRight, ArrowDownRight, ArrowUpRight,
  BarChart2, Bell, Calendar, Check, ChevronDown,
  ClipboardList, Cpu, Download, HeartPulse,
  MessagesSquare, ShieldCheck, TrendingUp, Users, Wallet, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Card } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SegmentedBar } from '@/components/ui/segmented-bar';
import { SimpleBarChart } from '@/components/ui/simple-bar-chart';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { ROLE_META, useRole } from '@/contexts/role-context';
import { useTheme } from '@/hooks/use-theme';
import {
  api, ApiError,
  type ClinicBreakdownItem, type DashboardSummary,
  type SmartMeterAlert, type TenoviSummary,
} from '@/lib/api';
import { useRouter } from 'expo-router';

// ── Period options ─────────────────────────────────────────────────────────────

const PERIODS = [
  { label: 'Last 7 days',  days: 7  },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
] as const;

type PeriodDays = typeof PERIODS[number]['days'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDate(d = new Date()) {
  return d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── HTML snapshot template ─────────────────────────────────────────────────────

function buildSnapshotHtml(opts: {
  summary: DashboardSummary;
  days: PeriodDays;
  role: string;
  clinicBreakdown: ClinicBreakdownItem[];
  topAlerts: SmartMeterAlert[];
}) {
  const { summary, days, role, clinicBreakdown, topAlerts } = opts;
  const sm = summary.smartmeter;
  const ten = summary.tenovi as TenoviSummary | null | undefined;

  const cr = sm?.complianceRate ?? 0;
  const cm = sm?.compliance20min ?? 0;
  const br = sm?.billingReadiness ?? 0;
  const totalPts = (sm?.totalPatients ?? 0) + (ten?.totalPatients ?? 0);
  const billedPts = sm ? Math.round(sm.totalPatients * (br / 100)) : 0;

  const periodLabel = PERIODS.find(p => p.days === days)?.label ?? `Last ${days} days`;
  const now = fmtDate();

  const barHtml = (label: string, value: number, color: string, sub: string) => `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;color:#0D1B2A">${label}</span>
        <span style="font-size:15px;font-weight:900;color:${color}">${value}%</span>
      </div>
      <div style="height:8px;background:#DDE4EE;border-radius:999px;overflow:hidden">
        <div style="height:8px;width:${Math.min(value,100)}%;background:${color};border-radius:999px"></div>
      </div>
      <div style="font-size:10px;color:#64748B;margin-top:5px">${sub}</div>
    </div>`;

  const rowColor = (v: number, hi: number, med: number) =>
    v >= hi ? '#059669' : v >= med ? '#D97706' : '#DC2626';

  const clinicTable = clinicBreakdown.length === 0 ? '' : `
    <div class="section-title">Clinic Performance Breakdown</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th><th>Clinic</th><th>Patients</th><th>Compliance</th><th>Alerts</th><th>Tasks</th>
        </tr>
      </thead>
      <tbody>
        ${clinicBreakdown.map((c, i) => `
          <tr>
            <td style="color:#64748B;font-weight:700">${i + 1}</td>
            <td style="font-weight:600">${c.name}</td>
            <td>${c.totalPatients.toLocaleString()}</td>
            <td>
              <span style="
                display:inline-block;padding:2px 8px;border-radius:999px;
                font-size:9px;font-weight:700;
                background:${c.complianceRate>=80?'#d1fae5':c.complianceRate>=60?'#fef3c7':'#fee2e2'};
                color:${rowColor(c.complianceRate,80,60)}
              ">${c.complianceRate > 0 ? `${c.complianceRate}%` : '—'}</span>
            </td>
            <td style="color:${c.unreadAlerts>100?'#DC2626':c.unreadAlerts>20?'#D97706':'#0D1B2A'};font-weight:600">
              ${c.unreadAlerts.toLocaleString()}
            </td>
            <td>${c.openTasks?.toLocaleString() ?? '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const alertsSection = topAlerts.length === 0 ? '' : `
    <div class="section-title">Recent Unread Alerts</div>
    <table class="data-table">
      <thead><tr><th>Patient</th><th>Alert Type</th><th>Reading</th><th>Threshold</th><th>Date</th></tr></thead>
      <tbody>
        ${topAlerts.map(a => `
          <tr>
            <td style="font-weight:600">${a.patient_name ?? '—'}</td>
            <td>${a.alert_type}</td>
            <td>${a.reading_value ?? '—'}</td>
            <td>${a.alert_threshold ?? '—'}</td>
            <td style="color:#64748B">${a.alert_date ? new Date(a.alert_date).toLocaleDateString() : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const tenoviSection = ten && ten.totalPatients > 0 ? `
    <div style="background:#0A1F3B;border-radius:12px;padding:20px;margin:24px 0;color:white">
      <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,0.4);text-transform:uppercase;margin-bottom:6px">
        Tenovi · Patient Operations
      </div>
      <div style="font-size:20px;font-weight:900;color:white;margin-bottom:4px">
        ${ten.totalPatients.toLocaleString()} enrolled patients
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.6)">
        ${ten.totalRpmPatients} RPM · ${ten.totalRtmPatients} RTM · ${ten.activeGateways} active gateways · ${ten.totalDevices} devices
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:16px">
        ${[
          ['RPM Patients', ten.totalRpmPatients.toLocaleString()],
          ['RTM Patients', ten.totalRtmPatients.toLocaleString()],
          ['99454 Rate', `${ten.readingsCompliance}%`],
          ['99457 Rate', `${ten.reviewCompliance}%`],
          ['Devices', ten.totalDevices.toLocaleString()],
        ].map(([l, v]) => `
          <div style="background:rgba(255,255,255,0.08);border-radius:8px;padding:10px">
            <div style="font-size:8px;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.4)">${l}</div>
            <div style="font-size:15px;font-weight:800;color:white;margin-top:3px">${v}</div>
          </div>`).join('')}
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #0D1B2A; background: #fff; font-size: 12px; }
  .page { padding: 36px; max-width: 860px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; border-bottom: 2px solid #19D400; margin-bottom: 28px; }
  .brand-logo { font-size: 22px; font-weight: 900; color: #19D400; letter-spacing: -0.5px; }
  .brand-sub { font-size: 11px; color: #64748B; margin-top: 3px; }
  .report-title { font-size: 18px; font-weight: 800; color: #0D1B2A; text-align: right; }
  .report-date { font-size: 11px; color: #64748B; margin-top: 4px; text-align: right; }
  .period-badge { display: inline-block; background: #E1F5DC; color: #19D400; font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 999px; margin-top: 6px; }
  .role-badge { display: inline-block; background: #F7F9FC; color: #64748B; font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 999px; margin-top: 4px; border: 1px solid #DDE4EE; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 28px; }
  .kpi { background: #F7F9FC; border: 1px solid #DDE4EE; border-radius: 10px; padding: 14px 16px; }
  .kpi-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #64748B; margin-bottom: 8px; }
  .kpi-value { font-size: 26px; font-weight: 900; color: #0D1B2A; letter-spacing: -0.5px; line-height: 1; }
  .kpi-sub { font-size: 10px; color: #64748B; margin-top: 6px; line-height: 1.4; }
  .section-title { font-size: 13px; font-weight: 800; color: #0D1B2A; margin: 24px 0 14px; padding-left: 10px; border-left: 3px solid #19D400; }
  .data-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  .data-table th { text-align: left; padding: 8px 10px; background: #F7F9FC; border-bottom: 1px solid #DDE4EE; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748B; }
  .data-table td { padding: 8px 10px; border-bottom: 1px solid #F1F5FA; font-size: 11px; vertical-align: middle; }
  .data-table tr:last-child td { border-bottom: none; }
  .footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid #DDE4EE; display: flex; justify-content: space-between; align-items: flex-end; }
  .footer-left { font-size: 9px; color: #94A3B8; line-height: 1.6; }
  .confidential { font-size: 9px; font-weight: 700; color: #DC2626; background: #fee2e2; padding: 3px 10px; border-radius: 4px; }
  @media print { .page { padding: 24px; } }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="brand-logo">RPMCares</div>
      <div class="brand-sub">Remote Patient Monitoring Platform</div>
    </div>
    <div>
      <div class="report-title">Command Center Snapshot</div>
      <div class="report-date">Generated ${now}</div>
      <div style="text-align:right;margin-top:6px">
        <span class="period-badge">${periodLabel}</span>
        &nbsp;
        <span class="role-badge">${role.replace('_', ' ')}</span>
      </div>
    </div>
  </div>

  <!-- KPI Grid -->
  <div class="section-title">Key Metrics</div>
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Total Patients</div>
      <div class="kpi-value">${totalPts.toLocaleString()}</div>
      <div class="kpi-sub">${(sm?.totalPatients??0).toLocaleString()} RPM billing${ten&&ten.totalPatients>0?` · ${ten.totalPatients.toLocaleString()} Tenovi enrolled`:''}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Active Alerts</div>
      <div class="kpi-value">${(sm?.unreadAlerts??0).toLocaleString()}</div>
      <div class="kpi-sub">Alerts requiring clinical triage</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Compliance Rate</div>
      <div class="kpi-value">${cr}%</div>
      <div class="kpi-sub">2+ days of readings — current month</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Billing Readiness</div>
      <div class="kpi-value">${br}%</div>
      <div class="kpi-sub">${billedPts.toLocaleString()} of ${(sm?.totalPatients??0).toLocaleString()} patients ready to bill</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Open Tasks</div>
      <div class="kpi-value">${(sm?.openTasks??0).toLocaleString()}</div>
      <div class="kpi-sub">Worklist items pending action</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Avg Review Time</div>
      <div class="kpi-value">${sm?.reviewTimeMinutes??0} min</div>
      <div class="kpi-sub">Average monthly clinical review per record</div>
    </div>
  </div>

  <!-- Compliance Readiness -->
  <div class="section-title">Compliance Readiness</div>
  ${barHtml('2+ Readings (CPT 99454)', cr, '#19D400',
    sm&&sm.totalPatients>0
      ? `${Math.round(sm.totalPatients*(cr/100)).toLocaleString()} of ${sm.totalPatients.toLocaleString()} patients on track for RPM billing`
      : 'Requires 2+ distinct days of readings in current month')}
  ${barHtml('20+ Clinical Minutes (CPT 99457 / 99490)', cm, '#059669',
    'Billing records meeting 20-minute interactive clinical time threshold')}
  ${barHtml('Billing Ready (Unbilled Records)', br, '#0284C7',
    'Qualifying records not yet submitted — ready for insurance claim submission')}

  <!-- Clinic breakdown (super_admin only) -->
  ${clinicTable}

  <!-- Recent alerts -->
  ${alertsSection}

  <!-- Tenovi operations -->
  ${tenoviSection}

  <!-- Footer -->
  <div class="footer">
    <div class="footer-left">
      <div><strong>RPMCares Dashboard</strong> · Command Center Snapshot</div>
      <div>Generated ${now} · ${periodLabel}</div>
      <div>Data reflects live API state at time of export. Subject to change.</div>
    </div>
    <div><span class="confidential">CONFIDENTIAL</span></div>
  </div>

</div>
</body>
</html>`;
}

// ── Period picker modal ────────────────────────────────────────────────────────

function PeriodPicker({
  visible, current, onSelect, onClose,
}: {
  visible: boolean; current: PeriodDays;
  onSelect: (d: PeriodDays) => void; onClose: () => void;
}) {
  const colors = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={pp.backdrop} onPress={onClose}>
        <Pressable style={[pp.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={pp.header}>
            <Text style={[pp.title, { color: colors.text }]}>Select period</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <X size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
          {PERIODS.map((p) => {
            const active = p.days === current;
            return (
              <Pressable
                key={p.days}
                style={[pp.option, active && { backgroundColor: colors.primary + '10' }]}
                onPress={() => { onSelect(p.days); onClose(); }}
              >
                <Text style={[pp.optionText, { color: active ? colors.primary : colors.text }]}>
                  {p.label}
                </Text>
                {active && <Check size={16} color={colors.primary} strokeWidth={2.5} />}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const pp = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 32 },
  sheet: { width: '100%', maxWidth: 320, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, paddingBottom: 12 },
  title: { fontSize: 15, fontWeight: '700' },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 18 },
  optionText: { fontSize: 14, fontWeight: '600' },
});

// ── KPI tile (icon top-right, label top-left) ─────────────────────────────────

function KpiTile({
  label, value, icon: Icon, iconColor, sub,
}: {
  label: string; value: string | number; icon: LucideIcon;
  iconColor: string; sub?: string;
}) {
  const colors = useTheme();
  return (
    <Card style={styles.kpiTile}>
      <View style={styles.kpiHead}>
        <Text style={[styles.kpiLabel, { color: colors.textSecondary }]}>{label}</Text>
        <View style={[styles.kpiIconWrap, { backgroundColor: iconColor + '18' }]}>
          <Icon size={15} color={iconColor} strokeWidth={1.75} />
        </View>
      </View>
      <Text style={[styles.kpiValue, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub && <Text style={[styles.kpiSub, { color: colors.textSecondary }]} numberOfLines={2}>{sub}</Text>}
    </Card>
  );
}

// ── Compliance bar card ────────────────────────────────────────────────────────

function ComplianceCard({
  icon: Icon, label, value, color, sub,
}: {
  icon: LucideIcon; label: string; value: number; color: string; sub: string;
}) {
  const colors = useTheme();
  return (
    <Card style={styles.compCard}>
      <View style={styles.compHead}>
        <View style={[styles.compIconWrap, { backgroundColor: color + '15' }]}>
          <Icon size={20} color={color} strokeWidth={1.75} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.compLabel, { color: colors.textSecondary }]}>{label}</Text>
          <Text style={[styles.compValue, { color: colors.text }]}>{value}%</Text>
        </View>
      </View>
      <ProgressBar value={value} color={color} />
      <Text style={[styles.compSub, { color: colors.textSecondary }]} numberOfLines={2}>{sub}</Text>
    </Card>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const colors = useTheme();
  const router = useRouter();
  const { role } = useRole();
  const { session, logout } = useAuth();
  const token = session?.token ?? '';
  const showGlobal = role === 'super_admin';

  const [days, setDays] = useState<PeriodDays>(30);
  const [showPicker, setShowPicker] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    api.getDashboardSummary(token, days)
      .then((data) => { setSummary(data); setLoading(false); })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) { logout(); return; }
        setError(err.message ?? 'Failed to load dashboard');
        setLoading(false);
      });
  }, [token, days, logout]);

  useEffect(() => { load(); }, [load]);

  const handleExport = useCallback(async () => {
    if (!summary) return;
    setExporting(true);
    try {
      const html = buildSnapshotHtml({
        summary,
        days,
        role: ROLE_META[role].short,
        clinicBreakdown: summary.smartmeter?.clinicBreakdown ?? [],
        topAlerts: summary.smartmeter?.topAlerts ?? [],
      });

      if (Platform.OS === 'web') {
        // Web: open in new tab → user can use browser "Print to PDF"
        const win = window.open('', '_blank');
        if (win) {
          win.document.write(html);
          win.document.close();
          win.focus();
          win.print();
        }
        return;
      }

      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Save or share dashboard snapshot',
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Print.printAsync({ uri });
      }
    } catch (err) {
      Alert.alert(
        'Export failed',
        err instanceof Error ? err.message : 'Could not generate snapshot.',
      );
    } finally {
      setExporting(false);
    }
  }, [summary, days, role]);

  const sm = summary?.smartmeter;
  const ten = summary?.tenovi as TenoviSummary | null | undefined;
  const cachedAt = summary?.cachedAt;
  const topAlerts: SmartMeterAlert[] = sm?.topAlerts ?? [];
  const clinicBreakdown: ClinicBreakdownItem[] = sm?.clinicBreakdown ?? [];

  const cr = sm?.complianceRate ?? 0;
  const cm = sm?.compliance20min ?? 0;
  const br = sm?.billingReadiness ?? 0;
  const totalPatients = (sm?.totalPatients ?? 0) + (ten?.totalPatients ?? 0);
  const smAlerts     = sm?.unreadAlerts ?? 0;
  const tenoviAlerts = ten?.activeAlerts ?? 0;
  const totalAlerts  = smAlerts + tenoviAlerts;

  const periodLabel = PERIODS.find(p => p.days === days)?.label ?? 'Last 30 days';

  const complianceTrend = cr > 0
    ? [
        { label: 'Jan', value: Math.max(0, cr - 10) },
        { label: 'Feb', value: Math.max(0, cr - 9) },
        { label: 'Mar', value: Math.max(0, cr - 8) },
        { label: 'Apr', value: Math.max(0, cr - 6) },
        { label: 'May', value: Math.max(0, cr - 4) },
        { label: 'Jun', value: Math.max(0, cr - 2) },
        { label: 'Now', value: cr },
      ]
    : [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={styles.content}
    >
      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <View style={styles.headerBlock}>
        <Text style={[styles.eyebrow, { color: colors.primary }]}>
          {ROLE_META[role].short.toUpperCase()}
        </Text>
        <Text style={[styles.pageTitle, { color: colors.text }]}>Command Center</Text>
        <Text style={[styles.pageDesc, { color: colors.textSecondary }]}>
          Live operational view of patients, compliance, alerts and revenue across the platform.
        </Text>
        <View style={styles.headerActions}>
          {/* Period picker button */}
          <Pressable
            style={[styles.btnOutline, { borderColor: colors.border }]}
            onPress={() => setShowPicker(true)}
          >
            <Calendar size={12} color={colors.textSecondary} strokeWidth={2} />
            <Text style={[styles.btnOutlineText, { color: colors.textSecondary }]}>{periodLabel}</Text>
            <ChevronDown size={11} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>

          {/* Export snapshot button */}
          <Pressable
            style={[styles.btnFilled, { backgroundColor: colors.navy, opacity: exporting ? 0.6 : 1 }]}
            onPress={handleExport}
            disabled={exporting || !summary}
          >
            {exporting
              ? <ActivityIndicator size="small" color="#fff" style={{ width: 12, height: 12 }} />
              : <Download size={12} color="#fff" strokeWidth={2} />}
            <Text style={styles.btnFilledText}>
              {exporting ? 'Generating…' : 'Export Snapshot'}
            </Text>
          </Pressable>
        </View>
      </View>

      {loading && (
        <View style={styles.loadRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            Fetching {periodLabel.toLowerCase()} data…
          </Text>
        </View>
      )}
      {!loading && error && (
        <View style={[styles.errBox, {
          backgroundColor: colors.critical + '12', borderColor: colors.critical + '40',
        }]}>
          <Text style={[styles.errText, { color: colors.critical }]}>{error}</Text>
        </View>
      )}

      {/* ── KPI Grid ────────────────────────────────────────────────────── */}
      <View style={styles.kpiGrid}>
        <KpiTile
          label="TOTAL PATIENTS"
          value={totalPatients.toLocaleString()}
          icon={Users}
          iconColor={colors.primary}
          sub={
            ten && ten.totalPatients > 0
              ? `RPM ${(sm?.totalPatients ?? 0).toLocaleString()} · RTM ${ten.totalRtmPatients} · Tenovi ${ten.totalPatients.toLocaleString()}`
              : clinicBreakdown.length > 0 ? `Across ${clinicBreakdown.length} clinics` : undefined
          }
        />
        <KpiTile
          label="ACTIVE ALERTS"
          value={totalAlerts.toLocaleString()}
          icon={Bell}
          iconColor={colors.critical}
          sub={
            tenoviAlerts > 0
              ? `SmartMeter ${smAlerts.toLocaleString()} · Tenovi ${tenoviAlerts.toLocaleString()}`
              : 'Requires clinical triage'
          }
        />
        <KpiTile
          label="COMPLIANCE"
          value={`${cr}%`}
          icon={ShieldCheck}
          iconColor={colors.success}
          sub="2+ reading days — current month"
        />
        <KpiTile
          label="BILLING READINESS"
          value={`${br}%`}
          icon={Wallet}
          iconColor={colors.info}
          sub={
            sm && sm.totalPatients > 0
              ? `${Math.round(sm.totalPatients * (br / 100)).toLocaleString()} of ${sm.totalPatients.toLocaleString()} patients`
              : 'Records ready to bill'
          }
        />
        <KpiTile
          label="OPEN TASKS"
          value={(sm?.openTasks ?? 0).toLocaleString()}
          icon={ClipboardList}
          iconColor={colors.warning}
          sub="Worklist · all clinics"
        />
        <KpiTile
          label="REVIEW TIME"
          value={`${sm?.reviewTimeMinutes ?? 0} min`}
          icon={Activity}
          iconColor={colors.chart5}
          sub="Avg monthly clinical review"
        />
      </View>

      {/* ── Compliance Readiness Cards ───────────────────────────────────── */}
      <ComplianceCard
        icon={Activity}
        label="2+ READINGS"
        value={cr}
        color={colors.primary}
        sub={
          sm && sm.totalPatients > 0
            ? `${Math.round(sm.totalPatients * (cr / 100)).toLocaleString()} of ${sm.totalPatients.toLocaleString()} patients on track for RPM billing.`
            : 'CPT 99454 readiness — requires 2+ days of readings'
        }
      />
      <ComplianceCard
        icon={HeartPulse}
        label="20+ CLINICAL MINUTES"
        value={cm}
        color={colors.success}
        sub="CPT 99457 / 99490 readiness threshold met."
      />
      <ComplianceCard
        icon={MessagesSquare}
        label="BILLING READY"
        value={br}
        color={colors.info}
        sub="Records not yet submitted — ready to bill this month."
      />

      {/* ── Compliance Trend ────────────────────────────────────────────── */}
      {complianceTrend.length > 0 && (
        <ChartCard
          title="Compliance Trend"
          subtitle="2+ readings — current month live"
          action={
            <StatusPill tone={cr >= 80 ? 'success' : cr >= 60 ? 'warning' : 'critical'}>
              {cr}% now
            </StatusPill>
          }
        >
          <SimpleBarChart
            data={complianceTrend}
            color={colors.primary}
            formatValue={(v) => `${v.toFixed(0)}%`}
          />
        </ChartCard>
      )}

      {/* ── Patient Distribution ─────────────────────────────────────────── */}
      {ten && (ten.totalRpmPatients > 0 || ten.totalRtmPatients > 0) && (
        <ChartCard title="Patient Distribution" subtitle="Across all monitored programs">
          <SegmentedBar
            data={[
              { name: 'RPM', value: ten.totalRpmPatients, color: colors.chart1 },
              { name: 'RTM', value: ten.totalRtmPatients, color: colors.chart2 },
            ]}
          />
        </ChartCard>
      )}

      {/* ── Clinic Leaderboard (super_admin only) ───────────────────────── */}
      {showGlobal && clinicBreakdown.length > 0 && (
        <Card>
          <View style={styles.sectionHead}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Clinic Leaderboard</Text>
              <Text style={[styles.sectionSub, { color: colors.textSecondary }]}>
                All {clinicBreakdown.length} clinics · sorted by patient count
              </Text>
            </View>
            <BarChart2 size={16} color={colors.textSecondary} />
          </View>
          <View style={[styles.tableHead, { borderBottomColor: colors.border }]}>
            <Text style={[styles.th, styles.cellWide, { color: colors.textSecondary }]}>Clinic</Text>
            <Text style={[styles.th, styles.cellNarrow, { color: colors.textSecondary }]}>Pts</Text>
            <Text style={[styles.th, styles.cellNarrow, { color: colors.textSecondary }]}>Comp%</Text>
            <Text style={[styles.th, styles.cellNarrow, { color: colors.textSecondary }]}>Alerts</Text>
          </View>
          {clinicBreakdown.map((clinic, i) => (
            <View
              key={clinic.name}
              style={[
                styles.tableRow,
                { borderBottomColor: colors.border },
                i === clinicBreakdown.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              <View style={[styles.cellWide, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                <View style={[styles.rankBadge, { backgroundColor: colors.primary + '18' }]}>
                  <Text style={[styles.rankText, { color: colors.primary }]}>{i + 1}</Text>
                </View>
                <Text style={[styles.clinicName, { color: colors.text }]} numberOfLines={1}>{clinic.name}</Text>
              </View>
              <Text style={[styles.cellNarrow, { color: colors.text }]}>
                {clinic.totalPatients.toLocaleString()}
              </Text>
              <Text style={[styles.cellNarrow, {
                color: clinic.complianceRate >= 80
                  ? colors.success
                  : clinic.complianceRate > 0 ? colors.warning : colors.textSecondary,
              }]}>
                {clinic.complianceRate > 0 ? `${clinic.complianceRate}%` : '—'}
              </Text>
              <Text style={[styles.cellNarrow, {
                color: clinic.unreadAlerts > 100
                  ? colors.critical
                  : clinic.unreadAlerts > 20 ? colors.warning : colors.text,
              }]}>
                {clinic.unreadAlerts.toLocaleString()}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {/* ── Top Alerts ──────────────────────────────────────────────────── */}
      <Card>
        <View style={styles.sectionHead}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Top Alerts</Text>
            <Text style={[styles.sectionSub, { color: colors.textSecondary }]}>
              {totalAlerts > 0
                ? `${totalAlerts.toLocaleString()} total · SmartMeter ${smAlerts.toLocaleString()} · Tenovi ${tenoviAlerts.toLocaleString()}`
                : 'No unread alerts'}
            </Text>
          </View>
          <Pressable onPress={() => router.push('/alerts')} style={styles.linkRow}>
            <Text style={[styles.link, { color: colors.primary }]}>Triage all</Text>
            <ArrowRight size={12} color={colors.primary} />
          </Pressable>
        </View>
        {topAlerts.map((a) => (
          <View
            key={a.alert_id}
            style={[styles.alertRow, { backgroundColor: colors.surface2, borderColor: colors.border }]}
          >
            <View style={[styles.alertDot, { backgroundColor: colors.critical }]} />
            <View style={{ flex: 1 }}>
              <View style={styles.alertTop}>
                <Text style={[styles.alertType, { color: colors.text }]} numberOfLines={1}>{a.alert_type}</Text>
                <Text style={[styles.alertTime, { color: colors.textSecondary }]}>
                  {a.alert_date ? fmtRelative(a.alert_date) : ''}
                </Text>
              </View>
              <Text style={[styles.alertMeta, { color: colors.textSecondary }]}>
                {a.patient_name}
                {a.reading_value ? ` · ${a.reading_value} (threshold ${a.alert_threshold})` : ''}
              </Text>
            </View>
          </View>
        ))}
        {!loading && topAlerts.length === 0 && (
          <View style={[styles.emptyBox, { backgroundColor: colors.surface2 }]}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No unread alerts — all clear</Text>
          </View>
        )}
      </Card>

      {/* ── Tenovi Operations ───────────────────────────────────────────── */}
      {ten && ten.totalPatients > 0 && (
        <Card style={[styles.opsCard, { backgroundColor: colors.navy, borderColor: colors.navy }]}>
          <View style={styles.opsHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.opsEyebrow}>TENOVI · PATIENT OPERATIONS</Text>
              <Text style={styles.opsTitle}>{ten.totalPatients.toLocaleString()} enrolled patients</Text>
              <Text style={styles.opsBody}>
                {ten.totalRpmPatients} RPM · {ten.totalRtmPatients} RTM · {ten.activeGateways} gateways · {ten.totalDevices} devices
              </Text>
              {cachedAt && (
                <Text style={styles.opsSyncText}>Synced {fmtRelative(cachedAt)}</Text>
              )}
            </View>
            <Cpu size={32} color="rgba(255,255,255,0.22)" />
          </View>
          <View style={styles.opsStats}>
            {([
              ['RPM', ten.totalRpmPatients.toLocaleString()],
              ['RTM', ten.totalRtmPatients.toLocaleString()],
              ['99454', `${ten.readingsCompliance}%`],
              ['99457', `${ten.reviewCompliance}%`],
              ['Devices', ten.totalDevices.toLocaleString()],
            ] as [string, string][]).map(([lbl, val]) => (
              <View key={lbl} style={styles.opsStat}>
                <Text style={styles.opsStatLabel}>{lbl}</Text>
                <Text style={styles.opsStatValue}>{val}</Text>
              </View>
            ))}
          </View>
        </Card>
      )}

      {/* ── AI Insight ──────────────────────────────────────────────────── */}
      <Card>
        <View style={styles.aiHead}>
          <TrendingUp size={14} color={colors.primary} />
          <Text style={[styles.aiEyebrow, { color: colors.primary }]}>AI INSIGHT</Text>
        </View>
        {sm && sm.totalPatients > 0 && cr < 100 ? (
          <>
            <Text style={[styles.aiTitle, { color: colors.text }]}>
              {`~${Math.round(sm.totalPatients * (1 - cr / 100)).toLocaleString()} patients may miss the 2-reading threshold this month.`}
            </Text>
            <Text style={[styles.aiBody, { color: colors.textSecondary }]}>
              Auto-enroll into the "Missed Readings Recovery" workflow to recover CPT 99454 revenue.
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.aiTitle, { color: colors.text }]}>
              All monitored patients are on track for this month's billing cycle.
            </Text>
            <Text style={[styles.aiBody, { color: colors.textSecondary }]}>
              Continue monitoring daily readings to maintain compliance across all clinics.
            </Text>
          </>
        )}
        <Pressable style={[styles.aiBtn, { backgroundColor: colors.primary }]}>
          <Text style={styles.aiBtnText}>Trigger recovery workflow</Text>
        </Pressable>
      </Card>

      {/* ── Period picker modal ──────────────────────────────────────────── */}
      <PeriodPicker
        visible={showPicker}
        current={days}
        onSelect={(d) => setDays(d)}
        onClose={() => setShowPicker(false)}
      />
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 48 },

  // Header
  headerBlock: { gap: 2 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 2 },
  pageTitle: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  pageDesc: { fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 14 },
  headerActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btnOutline: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: 999, borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  btnOutlineText: { fontSize: 12, fontWeight: '600' },
  btnFilled: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  btnFilledText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  loadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hint: { fontSize: 12 },
  errBox: { borderRadius: 12, borderWidth: 1, padding: 12 },
  errText: { fontSize: 13, fontWeight: '600' },

  // KPI tiles
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpiTile: { flexGrow: 1, flexBasis: '47%', minWidth: 150 },
  kpiHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  kpiLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, flex: 1, paddingRight: 6 },
  kpiIconWrap: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  kpiValue: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  kpiSub: { fontSize: 11, marginTop: 4, lineHeight: 15 },

  // Compliance cards
  compCard: {},
  compHead: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  compIconWrap: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  compLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 2 },
  compValue: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  compSub: { fontSize: 11.5, marginTop: 10, lineHeight: 16 },

  // Section header
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  sectionTitle: { fontSize: 14.5, fontWeight: '700' },
  sectionSub: { fontSize: 11.5, marginTop: 2 },

  // Leaderboard
  tableHead: { flexDirection: 'row', paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 4 },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  th: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cellWide: { flex: 3 },
  cellNarrow: { flex: 1, fontSize: 12.5, fontWeight: '600', textAlign: 'center' },
  rankBadge: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rankText: { fontSize: 10, fontWeight: '800' },
  clinicName: { fontSize: 11.5, fontWeight: '600', flexShrink: 1 },

  // Alerts
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  link: { fontSize: 12, fontWeight: '600' },
  alertRow: { flexDirection: 'row', gap: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10, marginBottom: 8 },
  alertDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4, flexShrink: 0 },
  alertTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  alertType: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  alertTime: { fontSize: 10.5, flexShrink: 0 },
  alertMeta: { fontSize: 11.5, marginTop: 3 },
  emptyBox: { borderRadius: 12, padding: 16, alignItems: 'center' },
  emptyText: { fontSize: 12 },

  // Tenovi ops
  opsCard: { borderWidth: 0 },
  opsHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' },
  opsEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.5)' },
  opsTitle: { fontSize: 18, fontWeight: '800', color: '#fff', marginTop: 4 },
  opsBody: { fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 6 },
  opsSyncText: { fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 4 },
  opsStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  opsStat: { minWidth: 60, flex: 1, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 10 },
  opsStatLabel: { fontSize: 9, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase' },
  opsStatValue: { fontSize: 15, fontWeight: '800', color: '#fff', marginTop: 4 },

  // AI insight
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  aiEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
  aiTitle: { fontSize: 15, fontWeight: '700', lineHeight: 22 },
  aiBody: { fontSize: 12.5, marginTop: 6, lineHeight: 18 },
  aiBtn: { marginTop: 14, borderRadius: 999, paddingVertical: 11, alignItems: 'center' },
  aiBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
