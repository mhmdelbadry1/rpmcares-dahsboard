import {
  Building2, CheckCircle2, ChevronRight, Eye, EyeOff, Globe, HeartPulse,
  KeyRound, Mail, Settings2, ShieldCheck, User, Zap,
} from "lucide-react-native";
import { useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from "react-native";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_META } from "@/contexts/role-context";
import { useTheme } from "@/hooks/use-theme";
import { api, ApiError } from "@/lib/api";

// ── Tab bar ───────────────────────────────────────────────────────────────
const TABS = ["Profile", "Organization", "Roles", "Audit"] as const;
type Tab = (typeof TABS)[number];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const colors = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
      {TABS.map((t) => {
        const isActive = t === active;
        return (
          <Pressable
            key={t}
            onPress={() => onChange(t)}
            style={[
              styles.tab,
              isActive
                ? { backgroundColor: colors.primary, borderColor: colors.primary }
                : { backgroundColor: colors.card, borderColor: colors.border },
            ]}>
            <Text style={[styles.tabText, { color: isActive ? "#fff" : colors.textSecondary }]}>{t}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );
}

// ── Reusable save-action row ──────────────────────────────────────────────
function SaveRow({
  saving, disabled, success, error, onPress,
}: {
  saving: boolean; disabled: boolean; success: boolean; error: string; onPress: () => void;
}) {
  const colors = useTheme();
  return (
    <>
      {error ? (
        <Text style={{ color: colors.critical, fontSize: 12.5, fontWeight: "600", marginTop: 10 }}>{error}</Text>
      ) : null}
      <View style={styles.saveRow}>
        {success && (
          <View style={styles.successRow}>
            <CheckCircle2 size={14} color={colors.success} />
            <Text style={[styles.successText, { color: colors.success }]}>Saved!</Text>
          </View>
        )}
        <Pressable
          onPress={onPress}
          disabled={saving || disabled}
          style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving || disabled ? 0.55 : 1 }]}>
          {saving
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={{ color: "#fff", fontSize: 13.5, fontWeight: "700" }}>Save changes</Text>}
        </Pressable>
      </View>
    </>
  );
}

// ── Profile tab ───────────────────────────────────────────────────────────
function ProfileTab() {
  const colors = useTheme();
  const { session, updateUser } = useAuth();
  const user = session?.user;

  // ── name state ──
  const [name, setName] = useState(user?.name ?? "");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── email state ──
  const [email, setEmail] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState(false);
  const [emailError, setEmailError] = useState("");
  const emailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── password state ──
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwError, setPwError] = useState("");
  const pwTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initials = (n: string) =>
    n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const flash = (
    setS: (v: boolean) => void,
    ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  ) => {
    setS(true);
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => setS(false), 3000);
  };

  const handleSaveName = async () => {
    if (!session || !name.trim()) return;
    setNameSaving(true); setNameError("");
    try {
      const res = await api.patchMe(session.token, { name: name.trim() });
      updateUser(res.user);
      flash(setNameSuccess, nameTimer);
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally { setNameSaving(false); }
  };

  const handleSaveEmail = async () => {
    if (!session || !email.trim()) return;
    setEmailSaving(true); setEmailError("");
    try {
      const res = await api.patchMe(session.token, { email: email.trim() });
      updateUser(res.user);
      setEmail("");
      flash(setEmailSuccess, emailTimer);
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : "Could not update email.");
    } finally { setEmailSaving(false); }
  };

  const handleSavePassword = async () => {
    if (!session) return;
    if (newPw.length < 8) { setPwError("Password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { setPwError("Passwords do not match."); return; }
    setPwSaving(true); setPwError("");
    try {
      await api.patchMe(session.token, { password: newPw });
      setNewPw(""); setConfirmPw("");
      flash(setPwSuccess, pwTimer);
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : "Could not update password.");
    } finally { setPwSaving(false); }
  };

  return (
    <View style={{ gap: 16 }}>
      {/* Avatar + identity */}
      <Card style={styles.profileCard}>
        <View style={styles.profileTop}>
          <View style={[styles.avatar, { backgroundColor: colors.primary + "18" }]}>
            <Text style={[styles.avatarText, { color: colors.primary }]}>
              {user?.name ? initials(user.name) : "U"}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.profileName, { color: colors.text }]}>{user?.name}</Text>
            <Text style={[styles.profileEmail, { color: colors.textSecondary }]}>{user?.email}</Text>
            <View style={{ marginTop: 6 }}>
              <StatusPill tone="primary">{ROLE_META[user?.role ?? "staff"].label}</StatusPill>
            </View>
          </View>
        </View>
      </Card>

      {/* Edit name */}
      <Card>
        <View style={styles.cardSectionHeader}>
          <User size={15} color={colors.textSecondary} />
          <Text style={[styles.fieldLabel, { color: colors.text, marginBottom: 0 }]}>Display name</Text>
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your full name"
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]}
        />
        <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
          Shown to team members across the platform.
        </Text>
        <SaveRow
          saving={nameSaving}
          disabled={name.trim() === user?.name}
          success={nameSuccess}
          error={nameError}
          onPress={handleSaveName}
        />
      </Card>

      {/* Change email */}
      <Card>
        <View style={styles.cardSectionHeader}>
          <Mail size={15} color={colors.textSecondary} />
          <Text style={[styles.fieldLabel, { color: colors.text, marginBottom: 0 }]}>Change email</Text>
        </View>
        <Text style={[styles.fieldHint, { color: colors.textSecondary, marginBottom: 8 }]}>
          Current: <Text style={{ fontWeight: "700", color: colors.text }}>{user?.email}</Text>
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="New email address"
          placeholderTextColor={colors.textSecondary}
          keyboardType="email-address"
          autoCapitalize="none"
          style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]}
        />
        <SaveRow
          saving={emailSaving}
          disabled={!email.trim() || !email.includes("@")}
          success={emailSuccess}
          error={emailError}
          onPress={handleSaveEmail}
        />
      </Card>

      {/* Change password */}
      <Card>
        <View style={styles.cardSectionHeader}>
          <KeyRound size={15} color={colors.textSecondary} />
          <Text style={[styles.fieldLabel, { color: colors.text, marginBottom: 0 }]}>Change password</Text>
        </View>
        <View style={[styles.pwWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <TextInput
            value={newPw}
            onChangeText={setNewPw}
            placeholder="New password (min. 8 characters)"
            placeholderTextColor={colors.textSecondary}
            secureTextEntry={!showNew}
            style={[styles.pwInput, { color: colors.text }]}
          />
          <Pressable onPress={() => setShowNew((v) => !v)} style={styles.eyeBtn}>
            {showNew
              ? <EyeOff size={16} color={colors.textSecondary} />
              : <Eye size={16} color={colors.textSecondary} />}
          </Pressable>
        </View>
        <View style={[styles.pwWrap, { borderColor: colors.border, backgroundColor: colors.surface, marginTop: 10 }]}>
          <TextInput
            value={confirmPw}
            onChangeText={setConfirmPw}
            placeholder="Confirm new password"
            placeholderTextColor={colors.textSecondary}
            secureTextEntry={!showConfirm}
            style={[styles.pwInput, { color: colors.text }]}
          />
          <Pressable onPress={() => setShowConfirm((v) => !v)} style={styles.eyeBtn}>
            {showConfirm
              ? <EyeOff size={16} color={colors.textSecondary} />
              : <Eye size={16} color={colors.textSecondary} />}
          </Pressable>
        </View>
        <SaveRow
          saving={pwSaving}
          disabled={newPw.length < 8 || newPw !== confirmPw}
          success={pwSuccess}
          error={pwError}
          onPress={handleSavePassword}
        />
      </Card>

      {/* Read-only info — Role is already shown in the header, so only
          surface Clinic ID here, and only when there is one (clinic_admin/staff). */}
      {user?.clinicId && (
        <Card style={{ gap: 12 }}>
          <InfoRow icon={Building2} label="Clinic ID" value={user.clinicId.slice(0, 8) + "…"} colors={colors} />
        </Card>
      )}
    </View>
  );
}

function InfoRow({
  icon: Icon, label, value, colors,
}: { icon: typeof Lock; label: string; value: string; colors: ReturnType<typeof useTheme> }) {
  return (
    <View style={styles.infoRow}>
      <Icon size={15} color={colors.textSecondary} />
      <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ── Organization tab ──────────────────────────────────────────────────────
function OrganizationTab() {
  const colors = useTheme();
  return (
    <View style={{ gap: 14 }}>
      <Card style={{ gap: 8 }}>
        <View style={[styles.orgIconWrap, { backgroundColor: colors.primary + "18" }]}>
          <HeartPulse size={20} color={colors.primary} />
        </View>
        <Text style={[styles.orgName, { color: colors.text }]}>RPMCares</Text>
        <Text style={[styles.orgDesc, { color: colors.textSecondary }]}>
          Multi-tenant RPM platform. Manages all clinics, providers, and patient data
          under a single HIPAA-compliant umbrella organization.
        </Text>
      </Card>
      {[
        { icon: Globe, label: "Platform type", value: "Multi-tenant SaaS" },
        { icon: ShieldCheck, label: "Compliance", value: "HIPAA, SOC 2 Type II" },
        { icon: Settings2, label: "Version", value: "RPMCares v2.0 (Expo SDK 56)" },
        { icon: Zap, label: "Data systems", value: "SmartMeter RPM · Tenovi" },
      ].map((row) => {
        const Icon = row.icon;
        return (
          <Card key={row.label} style={styles.orgInfoRow}>
            <View style={[styles.orgInfoIcon, { backgroundColor: colors.muted }]}>
              <Icon size={14} color={colors.textSecondary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[{ fontSize: 11, color: colors.textSecondary }]}>{row.label}</Text>
              <Text style={[{ fontSize: 13.5, fontWeight: "600", color: colors.text, marginTop: 1 }]}>{row.value}</Text>
            </View>
            <ChevronRight size={14} color={colors.border} />
          </Card>
        );
      })}
    </View>
  );
}

// ── Roles tab ─────────────────────────────────────────────────────────────
const ROLES_TABLE = [
  { role: "Super Admin", scope: "All clinics", perms: "Full platform access · billing · audit · user management" },
  { role: "Clinic Admin", scope: "Own clinic", perms: "Manage staff · submit orders · view revenue" },
  { role: "Staff", scope: "Assigned patients", perms: "Calls · SMS · alerts · documentation" },
];

function RolesTab() {
  const colors = useTheme();
  return (
    <Card style={{ padding: 0 }}>
      <View style={[styles.tableHead, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 1 }]}>Role</Text>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 1 }]}>Scope</Text>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 2 }]}>Permissions</Text>
      </View>
      {ROLES_TABLE.map((r, i) => (
        <View key={r.role} style={[styles.tableRow, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.tdRole, { color: colors.text, flex: 1 }]}>{r.role}</Text>
          <Text style={[styles.tdCell, { color: colors.textSecondary, flex: 1 }]}>{r.scope}</Text>
          <Text style={[styles.tdCell, { color: colors.textSecondary, flex: 2 }]}>{r.perms}</Text>
        </View>
      ))}
    </Card>
  );
}

// ── Audit tab ─────────────────────────────────────────────────────────────
function AuditTab() {
  const colors = useTheme();
  const EVENTS = [
    { action: "User invited", user: "admin@rpmcares.local", detail: "Invited staff@clinic.com as Staff", time: "2 min ago" },
    { action: "Clinic created", user: "admin@rpmcares.local", detail: "Created Cedar Park Internal Medicine", time: "1 hr ago" },
    { action: "Alert resolved", user: "staff@rpmcares.local", detail: "Alert #4821 marked resolved", time: "3 hrs ago" },
    { action: "Login", user: "admin@rpmcares.local", detail: "Successful sign-in from mobile app", time: "5 hrs ago" },
    { action: "Dashboard viewed", user: "admin@rpmcares.local", detail: "Loaded Command Center dashboard", time: "5 hrs ago" },
  ];
  return (
    <Card style={{ padding: 0 }}>
      <View style={[styles.tableHead, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 1.5 }]}>Event</Text>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 2 }]}>Detail</Text>
        <Text style={[styles.thCell, { color: colors.textSecondary, flex: 1, textAlign: "right" }]}>When</Text>
      </View>
      {EVENTS.map((e, i) => (
        <View key={i} style={[styles.tableRow, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <View style={{ flex: 1.5 }}>
            <Text style={[styles.tdRole, { color: colors.text }]}>{e.action}</Text>
            <Text style={[{ fontSize: 10.5, color: colors.textSecondary, marginTop: 1 }]}>{e.user}</Text>
          </View>
          <Text style={[styles.tdCell, { color: colors.textSecondary, flex: 2 }]}>{e.detail}</Text>
          <Text style={[styles.tdCell, { color: colors.textSecondary, flex: 1, textAlign: "right" }]}>{e.time}</Text>
        </View>
      ))}
    </Card>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────
export default function SettingsScreen() {
  const colors = useTheme();
  const [activeTab, setActiveTab] = useState<Tab>("Profile");

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Manage your profile, integrations, and platform configuration."
      />
      <TabBar active={activeTab} onChange={setActiveTab} />
      <View style={{ marginTop: 16 }}>
        {activeTab === "Profile" && <ProfileTab />}
        {activeTab === "Organization" && <OrganizationTab />}
        {activeTab === "Roles" && <RolesTab />}
        {activeTab === "Audit" && <AuditTab />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  // Tabs
  tabBar: { flexDirection: "row", gap: 8, marginTop: 4, paddingBottom: 2 },
  tab: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  tabText: { fontSize: 13, fontWeight: "600" },
  // Sections
  section: { gap: 8, marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: "700", marginBottom: 4 },
  // Profile
  profileCard: { flexDirection: "row", gap: 14 },
  profileTop: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  avatar: { width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontWeight: "800" },
  profileName: { fontSize: 16, fontWeight: "800" },
  profileEmail: { fontSize: 12.5, marginTop: 2 },
  cardSectionHeader: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 },
  fieldLabel: { fontSize: 13, fontWeight: "600", marginBottom: 8 },
  fieldHint: { fontSize: 11.5, marginTop: 6 },
  input: { height: 46, borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 14, fontSize: 15 },
  pwWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 14, height: 46 },
  pwInput: { flex: 1, fontSize: 15 },
  eyeBtn: { padding: 4 },
  saveRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 12, marginTop: 16 },
  successRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  successText: { fontSize: 13, fontWeight: "600" },
  saveBtn: { height: 40, borderRadius: 10, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  infoLabel: { fontSize: 12, flex: 0.7 },
  infoValue: { fontSize: 13.5, fontWeight: "600", flex: 1 },
  infoDivider: { height: StyleSheet.hairlineWidth },
  // Org
  orgIconWrap: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  orgName: { fontSize: 18, fontWeight: "800" },
  orgDesc: { fontSize: 13, lineHeight: 19 },
  orgInfoRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  orgInfoIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  // Table
  tableHead: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 16 },
  thCell: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  tableRow: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 12 },
  tdRole: { fontSize: 13, fontWeight: "700" },
  tdCell: { fontSize: 12 },
  // Integrations
  integrationCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 14 },
  integrationLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  integrationName: { fontSize: 13.5, fontWeight: "700" },
  integrationDesc: { fontSize: 11.5, marginTop: 1 },
  integrationRight: { alignItems: "flex-end", gap: 8 },
  integrationBtn: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  integrationBtnText: { fontSize: 12, fontWeight: "600" },
});
