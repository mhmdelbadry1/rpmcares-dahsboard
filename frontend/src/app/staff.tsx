import {
  CheckCircle2, Copy, KeyRound, Mail, MoreVertical, Pencil,
  ShieldOff, ShieldCheck, Trash2, UserPlus, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Clipboard, Modal, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { ROLE_META } from '@/contexts/role-context';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, type Clinic, type Member } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionSheet =
  | { type: 'menu';       member: Member }
  | { type: 'edit';       member: Member }
  | { type: 'delete';     member: Member }
  | { type: 'inviteLink'; link: string | null; email: string; emailSent: boolean; emailError?: string }
  | { type: 'resetLink';  link: string; email: string }
  | null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSuspended(m: Member): boolean {
  if (!m.banned_until) return false;
  return new Date(m.banned_until) > new Date();
}

function initials(name: string) {
  return name.split(' ').map((n) => n[0] ?? '').join('').slice(0, 2).toUpperCase();
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function StaffScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const isSuperAdmin = session?.user.role === 'super_admin';

  const [members, setMembers]   = useState<Member[] | null>(null);
  const [clinics, setClinics]   = useState<Clinic[]>([]);
  const [loadError, setLoadError] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [actionSheet, setActionSheet] = useState<ActionSheet>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const clinicName = (id: string | null) => clinics.find((c) => c.id === id)?.name ?? '—';

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError('');
    try {
      const [membersRes, clinicsRes] = await Promise.all([
        api.listMembers(session.token),
        api.listClinics(session.token),
      ]);
      setMembers(membersRes.members);
      setClinics(clinicsRes.clinics);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load staff.');
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  function setBusyFor(id: string, val: boolean) {
    setBusy((prev) => ({ ...prev, [id]: val }));
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleDelete(member: Member) {
    if (!session) return;
    setBusyFor(member.id, true);
    try {
      await api.removeMember(session.token, member.id);
      setActionSheet(null);
      load();
    } catch (err) {
      // show error inline in delete confirm modal
    } finally {
      setBusyFor(member.id, false);
    }
  }

  async function handleSuspend(member: Member) {
    if (!session) return;
    setBusyFor(member.id, true);
    setActionSheet(null);
    try {
      if (isSuspended(member)) {
        await api.unsuspendMember(session.token, member.id);
      } else {
        await api.suspendMember(session.token, member.id);
      }
      load();
    } catch { /* silent — list will still refresh */ }
    finally { setBusyFor(member.id, false); }
  }

  async function handleResetPassword(member: Member) {
    if (!session) return;
    setBusyFor(member.id, true);
    setActionSheet(null);
    try {
      const res = await api.resetMemberPassword(session.token, member.id);
      setActionSheet({ type: 'resetLink', link: res.resetLink, email: res.email });

    } catch (err) {
      setActionSheet(null);
    } finally {
      setBusyFor(member.id, false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={styles.content}
    >
      <PageHeader
        eyebrow="Care Team"
        title="Staff & Access"
        description={
          isSuperAdmin
            ? 'Manage clinic admins and staff across every clinic.'
            : 'Manage staff accounts for your clinic.'
        }
        actions={
          <Pressable
            onPress={() => setInviteOpen(true)}
            style={[styles.inviteBtn, { backgroundColor: colors.primary }]}
          >
            <UserPlus size={15} color={colors.primaryForeground} />
            <Text style={[styles.inviteBtnLabel, { color: colors.primaryForeground }]}>Invite</Text>
          </Pressable>
        }
      />

      {loadError ? (
        <Card>
          <Text style={[styles.error, { color: colors.destructive }]}>{loadError}</Text>
        </Card>
      ) : members === null ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
      ) : members.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32, gap: 8 }}>
          <Mail size={26} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
            No one invited yet. Tap Invite to send the first account-setup email.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {members.map((member) => {
            const suspended = isSuspended(member);
            const loading   = busy[member.id] ?? false;
            return (
              <Card key={member.id} style={[styles.memberRow, suspended && { opacity: 0.75 }]}>
                <View style={[styles.avatar, { backgroundColor: colors.primary + '1f' }]}>
                  {loading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Text style={[styles.avatarText, { color: colors.primary }]}>
                      {initials(member.name)}
                    </Text>
                  )}
                </View>

                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>
                      {member.name}
                    </Text>
                    {suspended && (
                      <View style={[styles.suspendedBadge, { backgroundColor: '#D9770618', borderColor: '#D97706' }]}>
                        <ShieldOff size={9} color="#D97706" />
                        <Text style={{ fontSize: 9, fontWeight: '800', color: '#D97706' }}>SUSPENDED</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.memberEmail, { color: colors.textSecondary }]} numberOfLines={1}>
                    {member.email}
                  </Text>
                  <View style={styles.memberMetaRow}>
                    <StatusPill tone={member.role === 'super_admin' ? 'primary' : member.role === 'clinic_admin' ? 'info' : 'muted'}>
                      {ROLE_META[member.role].label}
                    </StatusPill>
                    {isSuperAdmin && (
                      <Text style={[styles.clinicName, { color: colors.textSecondary }]} numberOfLines={1}>
                        {clinicName(member.clinic_id)}
                      </Text>
                    )}
                  </View>
                </View>

                <Pressable
                  hitSlop={10}
                  onPress={() => setActionSheet({ type: 'menu', member })}
                  style={styles.moreBtn}
                >
                  <MoreVertical size={18} color={colors.textSecondary} />
                </Pressable>
              </Card>
            );
          })}
        </View>
      )}

      {/* ── Invite modal ───────────────────────────────────────────────────── */}
      <InviteModal
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={(result) => {
          setInviteOpen(false);
          load();
          setActionSheet({
            type: 'inviteLink',
            link: result.inviteLink,
            email: result.email,
            emailSent: result.emailSent,
            emailError: result.emailError,
          });
        }}
        isSuperAdmin={isSuperAdmin}
        clinics={clinics}
        callerClinicId={session?.user.clinicId ?? null}
      />

      {/* ── Action menu ────────────────────────────────────────────────────── */}
      {actionSheet?.type === 'menu' && (
        <ActionMenu
          member={actionSheet.member}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setActionSheet(null)}
          onEdit={() => setActionSheet({ type: 'edit', member: actionSheet.member })}
          onDelete={() => setActionSheet({ type: 'delete', member: actionSheet.member })}
          onSuspend={() => handleSuspend(actionSheet.member)}
          onResetPassword={() => handleResetPassword(actionSheet.member)}
        />
      )}

      {/* ── Edit modal ─────────────────────────────────────────────────────── */}
      {actionSheet?.type === 'edit' && (
        <EditMemberModal
          member={actionSheet.member}
          clinics={clinics}
          token={session?.token ?? ''}
          onClose={() => setActionSheet(null)}
          onSaved={() => { setActionSheet(null); load(); }}
        />
      )}

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      {actionSheet?.type === 'delete' && (
        <DeleteConfirmModal
          member={actionSheet.member}
          token={session?.token ?? ''}
          onClose={() => setActionSheet(null)}
          onDeleted={() => { setActionSheet(null); load(); }}
        />
      )}

      {/* ── Invite result ───────────────────────────────────────────────────── */}
      {actionSheet?.type === 'inviteLink' && (
        <InviteResultModal
          email={actionSheet.email}
          emailSent={actionSheet.emailSent}
          emailError={actionSheet.emailError}
          link={actionSheet.link}
          onClose={() => setActionSheet(null)}
        />
      )}

      {/* ── Reset link ─────────────────────────────────────────────────────── */}
      {actionSheet?.type === 'resetLink' && (
        <ShareLinkModal
          title="Password reset link"
          subtitle="Share this secure one-time link with"
          email={actionSheet.email}
          link={actionSheet.link}
          note="The link expires after use or within 24 hours."
          onClose={() => setActionSheet(null)}
        />
      )}
    </ScrollView>
  );
}

// ── Action menu sheet ─────────────────────────────────────────────────────────

function ActionMenu({
  member, isSuperAdmin, onClose, onEdit, onDelete, onSuspend, onResetPassword,
}: {
  member: Member;
  isSuperAdmin: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSuspend: () => void;
  onResetPassword: () => void;
}) {
  const colors  = useTheme();
  const suspended = isSuspended(member);

  const items: { icon: any; label: string; color?: string; onPress: () => void }[] = [];

  if (isSuperAdmin && member.role !== 'super_admin') {
    items.push({ icon: Pencil,  label: 'Edit profile',   onPress: () => { onClose(); onEdit(); } });
    items.push({
      icon: suspended ? ShieldCheck : ShieldOff,
      label: suspended ? 'Unsuspend account' : 'Suspend account',
      color: suspended ? '#059669' : '#D97706',
      onPress: () => { onClose(); onSuspend(); },
    });
  }

  items.push({
    icon: KeyRound, label: 'Send password reset',
    onPress: () => { onClose(); onResetPassword(); },
  });

  items.push({
    icon: Trash2, label: 'Remove from system',
    color: colors.destructive,
    onPress: () => { onClose(); onDelete(); },
  });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <View>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>{member.name}</Text>
              <Text style={[styles.sheetSub, { color: colors.textSecondary }]}>{member.email}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <X size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />

          {items.map((item) => (
            <Pressable
              key={item.label}
              onPress={item.onPress}
              style={({ pressed }) => [
                styles.menuItem,
                { backgroundColor: pressed ? colors.surface : 'transparent' },
              ]}
            >
              <View style={[styles.menuIconWrap, { backgroundColor: (item.color ?? colors.primary) + '18' }]}>
                <item.icon size={15} color={item.color ?? colors.primary} strokeWidth={1.75} />
              </View>
              <Text style={[styles.menuLabel, { color: item.color ?? colors.text }]}>{item.label}</Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Edit member modal ─────────────────────────────────────────────────────────

function EditMemberModal({
  member, clinics, token, onClose, onSaved,
}: {
  member: Member;
  clinics: Clinic[];
  token: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useTheme();
  const [name,     setName]     = useState(member.name);
  const [role,     setRole]     = useState<'clinic_admin' | 'staff'>(member.role as any);
  const [clinicId, setClinicId] = useState<string | null>(member.clinic_id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim() || !clinicId) { setError('Name and clinic are required.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await api.updateMember(token, member.id, { name: name.trim(), role, clinic_id: clinicId });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Edit member</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Full name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
            placeholderTextColor={colors.textSecondary}
          />

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Role</Text>
          <View style={styles.segmentRow}>
            {(['staff', 'clinic_admin'] as const).map((r) => (
              <Pressable
                key={r}
                onPress={() => setRole(r)}
                style={[
                  styles.segment,
                  { borderColor: colors.border, backgroundColor: role === r ? colors.primary : colors.card },
                ]}
              >
                <Text style={{ color: role === r ? colors.primaryForeground : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                  {ROLE_META[r].label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Clinic</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {clinics.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => setClinicId(c.id)}
                style={[
                  styles.segment,
                  { borderColor: colors.border, backgroundColor: clinicId === c.id ? colors.primary : colors.card },
                ]}
              >
                <Text style={{ color: clinicId === c.id ? colors.primaryForeground : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                  {c.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {error ? <Text style={[styles.error, { color: colors.destructive, marginTop: 10 }]}>{error}</Text> : null}

          <Pressable
            onPress={handleSave}
            disabled={submitting}
            style={[styles.submit, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: 14.5, fontWeight: '700' }}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Delete confirm modal ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  member, token, onClose, onDeleted,
}: {
  member: Member;
  token: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const colors = useTheme();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setSubmitting(true);
    setError('');
    try {
      await api.removeMember(token, member.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove account.');
      setSubmitting(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Remove account</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>

          <Text style={[styles.sheetSub, { color: colors.textSecondary, marginTop: 8, lineHeight: 20 }]}>
            This will permanently remove{' '}
            <Text style={{ fontWeight: '700', color: colors.text }}>{member.name}</Text>
            {' '}({member.email}) from the system.{'\n\n'}
            They will lose access immediately but can be re-invited with the same email.
          </Text>

          {error ? <Text style={[styles.error, { color: colors.destructive, marginTop: 10 }]}>{error}</Text> : null}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 22 }}>
            <Pressable
              onPress={onClose}
              style={[styles.submit, { flex: 1, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}
            >
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleDelete}
              disabled={submitting}
              style={[styles.submit, { flex: 1, backgroundColor: colors.destructive, opacity: submitting ? 0.6 : 1 }]}
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                {submitting ? 'Removing…' : 'Remove'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Invite result modal ───────────────────────────────────────────────────────

function InviteResultModal({
  email, emailSent, emailError, link, onClose,
}: {
  email: string;
  emailSent: boolean;
  emailError?: string;
  link: string | null;
  onClose: () => void;
}) {
  const colors  = useTheme();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!link) return;
    Clipboard.setString(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Invitation sent</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>

          {/* Email status */}
          <View style={[
            styles.statusRow,
            { backgroundColor: emailSent ? '#05966912' : '#D9770612', borderColor: emailSent ? '#05966940' : '#D9770640' },
          ]}>
            {emailSent
              ? <CheckCircle2 size={15} color="#059669" />
              : <Mail size={15} color="#D97706" />}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: emailSent ? '#059669' : '#D97706' }}>
                {emailSent ? `Invite email sent to ${email}` : 'Email could not be delivered'}
              </Text>
              {!emailSent && emailError && (
                <Text style={{ fontSize: 11.5, color: colors.textSecondary, marginTop: 2 }}>{emailError}</Text>
              )}
            </View>
          </View>

          {/* Invite link */}
          {link ? (
            <>
              <Text style={[{ fontSize: 12.5, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 6 }]}>
                Backup invite link
              </Text>
              <Text style={[styles.sheetSub, { color: colors.textSecondary, marginBottom: 8 }]}>
                {emailSent
                  ? 'Share this link via WhatsApp or SMS as a backup. Note: once clicked, the emailed link will no longer work.'
                  : 'Share this link directly with the invitee to let them set up their account.'}
              </Text>
              <View style={[styles.linkBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.linkText, { color: colors.textSecondary }]} numberOfLines={4} selectable>
                  {link}
                </Text>
              </View>
              <Pressable
                onPress={handleCopy}
                style={[styles.submit, { backgroundColor: copied ? '#059669' : colors.primary }]}
              >
                {copied
                  ? <CheckCircle2 size={16} color="#fff" />
                  : <Copy size={16} color={colors.primaryForeground} />}
                <Text style={{ color: copied ? '#fff' : colors.primaryForeground, fontSize: 14.5, fontWeight: '700', marginLeft: 6 }}>
                  {copied ? 'Copied!' : 'Copy link'}
                </Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              onPress={onClose}
              style={[styles.submit, { backgroundColor: colors.primary, marginTop: 20 }]}
            >
              <Text style={{ color: colors.primaryForeground, fontSize: 14.5, fontWeight: '700' }}>Done</Text>
            </Pressable>
          )}

          <Pressable onPress={onClose} style={{ alignItems: 'center', marginTop: 12 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Share link modal (password reset) ─────────────────────────────────────────

function ShareLinkModal({
  title, subtitle, email, link, note, onClose,
}: {
  title: string;
  subtitle: string;
  email: string;
  link: string;
  note?: string;
  onClose: () => void;
}) {
  const colors  = useTheme();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    Clipboard.setString(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>

          <Text style={[styles.sheetSub, { color: colors.textSecondary, marginTop: 8, lineHeight: 20 }]}>
            {subtitle}{' '}
            <Text style={{ fontWeight: '700', color: colors.text }}>{email}</Text>.
            {note ? `\n${note}` : ''}
          </Text>

          <View style={[styles.linkBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.linkText, { color: colors.textSecondary }]} numberOfLines={4} selectable>
              {link}
            </Text>
          </View>

          <Pressable
            onPress={handleCopy}
            style={[styles.submit, { backgroundColor: copied ? '#059669' : colors.primary }]}
          >
            {copied
              ? <CheckCircle2 size={16} color="#fff" />
              : <Copy size={16} color={colors.primaryForeground} />}
            <Text style={{ color: copied ? '#fff' : colors.primaryForeground, fontSize: 14.5, fontWeight: '700', marginLeft: 6 }}>
              {copied ? 'Copied!' : 'Copy link'}
            </Text>
          </Pressable>

          <Pressable onPress={onClose} style={{ alignItems: 'center', marginTop: 12 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Invite modal ──────────────────────────────────────────────────────────────

function InviteModal({
  visible, onClose, onInvited, isSuperAdmin, clinics, callerClinicId,
}: {
  visible: boolean;
  onClose: () => void;
  onInvited: (result: { inviteLink: string | null; email: string; emailSent: boolean; emailError?: string }) => void;
  isSuperAdmin: boolean;
  clinics: Clinic[];
  callerClinicId: string | null;
}) {
  const colors = useTheme();
  const { session } = useAuth();
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [role,     setRole]     = useState<'clinic_admin' | 'staff' | 'super_admin'>('staff');
  const [clinicId, setClinicId] = useState<string | null>(isSuperAdmin ? null : callerClinicId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible) {
      setName(''); setEmail(''); setRole('staff');
      setClinicId(isSuperAdmin ? null : callerClinicId);
      setError('');
    }
  }, [visible, isSuperAdmin, callerClinicId]);

  const handleSubmit = async () => {
    if (!session) return;
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required.');
      return;
    }
    if (role !== 'super_admin' && !clinicId) {
      setError('Name, email and clinic are all required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await api.inviteMember(session.token, {
        name: name.trim(),
        email: email.trim(),
        role,
        clinicId: role === 'super_admin' ? null : clinicId,
      });
      onInvited({ inviteLink: res.inviteLink, email: res.email, emailSent: res.emailSent, emailError: res.emailError });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invite.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Invite to RPMCares</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={18} color={colors.textSecondary} /></Pressable>
          </View>
          <Text style={[styles.sheetSub, { color: colors.textSecondary }]}>
            They'll get an email with a secure link to set up their own password.
          </Text>

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Full name</Text>
          <TextInput
            value={name} onChangeText={setName} placeholder="Jordan Lee"
            placeholderTextColor={colors.textSecondary}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
          />

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Email</Text>
          <TextInput
            value={email} onChangeText={setEmail}
            placeholder="jordan@clinic.com"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none" keyboardType="email-address"
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
          />

          {isSuperAdmin && (
            <>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Role</Text>
              <View style={styles.segmentRow}>
                {(['staff', 'clinic_admin', 'super_admin'] as const).map((r) => (
                  <Pressable
                    key={r}
                    onPress={() => { setRole(r); if (r === 'super_admin') setClinicId(null); }}
                    style={[
                      styles.segment,
                      { borderColor: colors.border, backgroundColor: role === r ? colors.primary : colors.card },
                    ]}
                  >
                    <Text style={{ color: role === r ? colors.primaryForeground : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                      {ROLE_META[r].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {isSuperAdmin && role !== 'super_admin' ? (
            <>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Clinic</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {clinics.map((c) => (
                  <Pressable
                    key={c.id} onPress={() => setClinicId(c.id)}
                    style={[
                      styles.segment,
                      { borderColor: colors.border, backgroundColor: clinicId === c.id ? colors.primary : colors.card },
                    ]}
                  >
                    <Text style={{ color: clinicId === c.id ? colors.primaryForeground : colors.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                      {c.name}
                    </Text>
                  </Pressable>
                ))}
                {clinics.length === 0 && (
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>No clinics yet — add one first.</Text>
                )}
              </ScrollView>
            </>
          ) : !isSuperAdmin ? (
            <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: 16 }]}>
              Role: Staff · Clinic: {clinics.find((c) => c.id === callerClinicId)?.name ?? 'your clinic'}
            </Text>
          ) : null}

          {error ? <Text style={[styles.error, { color: colors.destructive, marginTop: 12 }]}>{error}</Text> : null}

          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            style={[styles.submit, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: 14.5, fontWeight: '700' }}>
              {submitting ? 'Sending invite…' : 'Send invite'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content:     { padding: 16, paddingBottom: 48 },
  inviteBtn:   { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  inviteBtnLabel: { fontSize: 13, fontWeight: '700' },
  error:       { fontSize: 12.5, fontWeight: '600' },

  memberRow:   { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar:      { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText:  { fontSize: 14, fontWeight: '800' },
  memberName:  { fontSize: 14.5, fontWeight: '700' },
  memberEmail: { fontSize: 11.5, marginTop: 1 },
  memberMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  clinicName:  { fontSize: 11, flexShrink: 1 },
  moreBtn:     { padding: 8 },
  suspendedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 2,
  },

  // Shared modal styles
  backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet:       { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingBottom: 36 },
  sheetHead:   { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  sheetTitle:  { fontSize: 16, fontWeight: '800' },
  sheetSub:    { fontSize: 12.5, marginTop: 4 },
  menuDivider: { height: StyleSheet.hairlineWidth, marginVertical: 14 },
  menuItem:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderRadius: 10 },
  menuIconWrap:{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuLabel:   { fontSize: 14.5, fontWeight: '600' },

  fieldLabel:  { fontSize: 12.5, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  input:       { height: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, fontSize: 14.5 },
  segmentRow:  { flexDirection: 'row', gap: 8 },
  segment:     { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  submit:      { height: 46, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginTop: 16, flexDirection: 'row' },

  statusRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginTop: 14 },
  linkBox:     { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginTop: 14 },
  linkText:    { fontSize: 11.5, lineHeight: 18, fontFamily: 'monospace' },
});
