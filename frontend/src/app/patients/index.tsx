import { useRouter } from 'expo-router';
import {
  Activity, ChevronDown, Plus, RefreshCw, Search, Trash2, User, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import {
  api,
  ApiError,
  type EnrollPatientInput,
  type Patient,
  type PatientProgram,
  type PatientSource,
} from '@/lib/api';

// ── helpers ────────────────────────────────────────────────────────────────

function ageFromDob(dob: string | null): string {
  if (!dob) return '—';
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return `${age} yrs`;
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

// Inserts slashes as user types so they only need to enter digits: 01011990 → 01/01/1990
function formatDobInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

function dobToIso(display: string): string {
  const [mm = '', dd = '', yyyy = ''] = display.split('/');
  const m = parseInt(mm, 10), d = parseInt(dd, 10), y = parseInt(yyyy, 10);
  if (yyyy.length === 4 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2030) {
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return '';
}

// ── ClinicPickerModal ──────────────────────────────────────────────────────

function ClinicPickerModal({
  visible, clinics, selectedId, onSelect, onClose, colors, loading,
}: {
  visible: boolean;
  clinics: { id: string; name: string }[];
  selectedId: string;
  onSelect: (id: string, name: string) => void;
  onClose: () => void;
  colors: any;
  loading: boolean;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () => clinics.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())),
    [clinics, q],
  );
  useEffect(() => { if (!visible) setQ(''); }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
        <View style={pk.header}>
          <Text style={[pk.title, { color: colors.text }]}>Select Clinic</Text>
          <Pressable onPress={onClose} hitSlop={12}><X size={20} color={colors.textSecondary} /></Pressable>
        </View>
        <View style={[pk.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Search size={14} color={colors.textSecondary} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search clinics…"
            placeholderTextColor={colors.textSecondary}
            style={[pk.searchInput, { color: colors.text }]}
            autoFocus
          />
        </View>
        {loading ? (
          <View style={pk.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            renderItem={({ item: c }) => (
              <Pressable
                onPress={() => { onSelect(c.id, c.name); onClose(); }}
                style={[
                  pk.row,
                  {
                    borderBottomColor: colors.border,
                    backgroundColor: selectedId === c.id ? colors.primary + '14' : 'transparent',
                  },
                ]}>
                <Text style={[pk.rowText, { color: selectedId === c.id ? colors.primary : colors.text, fontWeight: selectedId === c.id ? '700' : '400' }]}>
                  {c.name}
                </Text>
                {selectedId === c.id && <View style={[pk.dot, { backgroundColor: colors.primary }]} />}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[pk.emptyHint, { color: colors.textSecondary }]}>
                {q ? 'No clinics match.' : 'No clinics available for this system.'}
              </Text>
            }
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ── FilterDropdown ─────────────────────────────────────────────────────────

function FilterDropdown<T extends string>({
  label, options, value, onChange, colors,
}: {
  label: string;
  options: { label: string; value: T | '' }[];
  value: T | '';
  onChange: (v: T | '') => void;
  colors: any;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const isActive = !!value;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[fd.chip, { borderColor: isActive ? colors.primary : colors.border, backgroundColor: isActive ? colors.primary + '14' : colors.card }]}>
        <Text style={[fd.chipText, { color: isActive ? colors.primary : colors.textSecondary }]}>
          {selected?.label ?? label}
        </Text>
        <ChevronDown size={11} color={isActive ? colors.primary : colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={fd.backdrop} onPress={() => setOpen(false)}>
          <View style={[fd.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {options.map((o) => (
              <Pressable
                key={String(o.value)}
                onPress={() => { onChange(o.value); setOpen(false); }}
                style={[fd.item, { backgroundColor: value === o.value ? colors.primary + '14' : 'transparent' }]}>
                <Text style={[fd.itemText, { color: value === o.value ? colors.primary : colors.text, fontWeight: value === o.value ? '700' : '400' }]}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ── EnrollModal ────────────────────────────────────────────────────────────

type EnrollForm = {
  system: PatientSource;
  clinicId: string;
  clinicName: string;
  firstName: string;
  lastName: string;
  dob: string;
  sex: 'M' | 'F' | '';
  phone: string;
  language: 'EN' | 'ES' | 'AR';
  insurance: string;
  program: PatientProgram;
  diagnosis: string;
  orderingPhysician: string;
  healthCondition: string;
};

const BLANK: EnrollForm = {
  system: 'smartmeter', clinicId: '', clinicName: '',
  firstName: '', lastName: '', dob: '', sex: '', phone: '',
  language: 'EN', insurance: '', program: 'RPM',
  diagnosis: '', orderingPhysician: '', healthCondition: '',
};

function EField({
  label, value, onChangeText, placeholder, required, colors, keyboard,
}: {
  label: string; value: string; onChangeText: (t: string) => void;
  placeholder?: string; required?: boolean; colors: any;
  keyboard?: 'default' | 'phone-pad';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[em.label, { color: colors.textSecondary }]}>
        {label.toUpperCase()}{required ? ' *' : ''}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary + '80'}
        keyboardType={keyboard ?? 'default'}
        style={[em.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
      />
    </View>
  );
}

function ESegment<T extends string>({
  label, options, value, onChange, colors, required,
}: {
  label: string; options: { label: string; value: T }[]; value: T | '';
  onChange: (v: T) => void; colors: any; required?: boolean;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[em.label, { color: colors.textSecondary }]}>
        {label.toUpperCase()}{required ? ' *' : ''}
      </Text>
      <View style={em.segRow}>
        {options.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[em.segBtn, { borderColor: colors.border, backgroundColor: value === o.value ? colors.primary : colors.card }]}>
            <Text style={[em.segBtnText, { color: value === o.value ? '#fff' : colors.textSecondary }]}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function EnrollModal({
  visible, onClose, onSuccess, isSuperAdmin, myClinicId, myClinicName, token, colors,
}: {
  visible: boolean; onClose: () => void; onSuccess: () => void;
  isSuperAdmin: boolean; myClinicId: string | null; myClinicName: string;
  token: string; colors: any;
}) {
  const [form, setForm] = useState<EnrollForm>({ ...BLANK, clinicId: myClinicId ?? '', clinicName: myClinicName });
  const [systemClinics, setSystemClinics] = useState<{ id: string; name: string }[]>([]);
  const [clinicWarning, setClinicWarning] = useState('');
  const [loadingClinics, setLoadingClinics] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const set = useCallback(<K extends keyof EnrollForm>(k: K, v: EnrollForm[K]) =>
    setForm((f) => ({ ...f, [k]: v })), []);

  useEffect(() => {
    if (!visible) return;
    setForm({ ...BLANK, clinicId: myClinicId ?? '', clinicName: myClinicName });
    setError('');
    setClinicWarning('');
  }, [visible, myClinicId, myClinicName]);

  const currentSystem = form.system;
  useEffect(() => {
    if (!visible || !isSuperAdmin) return;
    setLoadingClinics(true);
    setClinicWarning('');
    setForm((f) => ({ ...f, clinicId: '', clinicName: '' }));
    api.getSystemClinics(token, currentSystem)
      .then((r) => {
        setSystemClinics(r.clinics);
        if (r.warning) setClinicWarning(r.warning);
      })
      .catch(() => setSystemClinics([]))
      .finally(() => setLoadingClinics(false));
  }, [visible, currentSystem, isSuperAdmin, token]);

  async function submit() {
    if (!form.firstName.trim() || !form.lastName.trim()) { setError('First Name and Last Name are required.'); return; }
    if (!form.clinicId) { setError('Please select a clinic.'); return; }
    const dobIso = form.dob ? dobToIso(form.dob) : '';
    if ((form.system === 'smartmeter' || form.system === 'local') && !dobIso) {
      setError(form.dob
        ? 'Please enter a valid date of birth (month 1–12, day 1–31, 4-digit year).'
        : 'Date of birth is required — enter as MM/DD/YYYY.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const payload: EnrollPatientInput = {
        clinicId:          form.clinicId,
        system:            form.system,
        firstName:         form.firstName.trim(),
        lastName:          form.lastName.trim(),
        dob:               dobIso || undefined,
        sex:               form.sex || undefined,
        program:           form.program,
        phone:             form.phone.trim() || undefined,
        language:          form.language || undefined,
        insurance:         form.insurance.trim() || undefined,
        diagnosis:         form.diagnosis.trim() || undefined,
        orderingPhysician: form.orderingPhysician.trim() || undefined,
        healthCondition:   form.healthCondition.trim() || undefined,
      };
      await api.enrollPatient(token, payload);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enrollment failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <View style={em.header}>
              <Text style={[em.title, { color: colors.text }]}>Enroll Patient</Text>
              <Pressable onPress={onClose} hitSlop={12}><X size={20} color={colors.textSecondary} /></Pressable>
            </View>

            <ScrollView contentContainerStyle={em.body} keyboardShouldPersistTaps="handled">
              <ESegment
                label="System" required
                options={[
                  { label: 'SmartMeter',   value: 'smartmeter' },
                  { label: 'Tenovi',       value: 'tenovi' },
                  { label: 'Local System', value: 'local' },
                ]}
                value={form.system}
                onChange={(v) => set('system', v as PatientSource)}
                colors={colors}
              />

              {isSuperAdmin ? (
                <View style={{ marginBottom: 14 }}>
                  <Text style={[em.label, { color: colors.textSecondary }]}>CLINIC *</Text>
                  {clinicWarning ? <Text style={[em.hint, { color: colors.warning }]}>{clinicWarning}</Text> : null}
                  <Pressable
                    onPress={() => setShowPicker(true)}
                    style={[em.dropBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                    <Text style={[em.dropBtnText, { color: form.clinicName ? colors.text : colors.textSecondary + '80' }]}>
                      {loadingClinics ? 'Loading clinics…' : form.clinicName || 'Select clinic'}
                    </Text>
                    <ChevronDown size={14} color={colors.textSecondary} />
                  </Pressable>
                </View>
              ) : (
                <View style={{ marginBottom: 14 }}>
                  <Text style={[em.label, { color: colors.textSecondary }]}>CLINIC</Text>
                  <Text style={[em.readonly, { color: colors.text }]}>{myClinicName || '—'}</Text>
                </View>
              )}

              <View style={em.row2}>
                <View style={{ flex: 1 }}>
                  <EField label="First Name" required value={form.firstName} onChangeText={(v) => set('firstName', v)} colors={colors} />
                </View>
                <View style={{ flex: 1 }}>
                  <EField label="Last Name" required value={form.lastName} onChangeText={(v) => set('lastName', v)} colors={colors} />
                </View>
              </View>

              <EField
                label="Date of Birth"
                required={form.system === 'smartmeter' || form.system === 'local'}
                value={form.dob}
                onChangeText={(v) => set('dob', formatDobInput(v))}
                placeholder="MM/DD/YYYY"
                keyboard="phone-pad"
                colors={colors}
              />
              <ESegment label="Sex" options={[{ label: 'Male', value: 'M' }, { label: 'Female', value: 'F' }]} value={form.sex} onChange={(v) => set('sex', v as 'M' | 'F')} colors={colors} />
              <EField label="Phone" value={form.phone} onChangeText={(v) => set('phone', v)} placeholder="+1 555 000 0000" keyboard="phone-pad" colors={colors} />
              <ESegment
                label="Program" required
                options={[{ label: 'RPM', value: 'RPM' }, { label: 'RTM', value: 'RTM' }, { label: 'CCM', value: 'CCM' }, { label: 'PCM', value: 'PCM' }]}
                value={form.program}
                onChange={(v) => set('program', v as PatientProgram)}
                colors={colors}
              />

              {(form.system === 'smartmeter' || form.system === 'local') && (
                <>
                  <EField label="Insurance Type" value={form.insurance} onChangeText={(v) => set('insurance', v)} placeholder="e.g. Medicare, Medicaid, Private" colors={colors} />
                  <EField label="Primary Diagnosis" value={form.diagnosis} onChangeText={(v) => set('diagnosis', v)} placeholder="e.g. Hypertension" colors={colors} />
                  <EField label="Ordering Physician" value={form.orderingPhysician} onChangeText={(v) => set('orderingPhysician', v)} placeholder="Dr. Name" colors={colors} />
                  <ESegment label="Language" options={[{ label: 'English', value: 'EN' }, { label: 'Spanish', value: 'ES' }, { label: 'Arabic', value: 'AR' }]} value={form.language} onChange={(v) => set('language', v as 'EN' | 'ES' | 'AR')} colors={colors} />
                </>
              )}

              {form.system === 'tenovi' && (
                <>
                  <EField label="Health Condition" value={form.healthCondition} onChangeText={(v) => set('healthCondition', v)} placeholder="hypertension" colors={colors} />
                  <EField label="Ordering Physician" value={form.orderingPhysician} onChangeText={(v) => set('orderingPhysician', v)} placeholder="Dr. Name" colors={colors} />
                </>
              )}

              {error ? (
                <View style={[em.errorBox, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '40' }]}>
                  <Text style={[em.errorText, { color: colors.destructive }]}>{error}</Text>
                </View>
              ) : null}
            </ScrollView>

            <View style={[em.footer, { borderTopColor: colors.border }]}>
              <Pressable onPress={submit} disabled={submitting} style={[em.submitBtn, { backgroundColor: submitting ? colors.primary + '80' : colors.primary }]}>
                {submitting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={em.submitBtnText}>Enroll Patient</Text>}
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <ClinicPickerModal
        visible={showPicker}
        clinics={systemClinics}
        selectedId={form.clinicId}
        onSelect={(id, name) => { set('clinicId', id); set('clinicName', name); }}
        onClose={() => setShowPicker(false)}
        colors={colors}
        loading={loadingClinics}
      />
    </>
  );
}

// ── Delete patient modal ───────────────────────────────────────────────────

function DeletePatientModal({
  patient, token, onClose, onDeleted, colors,
}: {
  patient: Patient | null; token: string;
  onClose: () => void; onDeleted: (id: string) => void; colors: any;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!patient) return;
    setError('');
  }, [patient]);

  async function confirm() {
    if (!patient) return;
    setDeleting(true);
    setError('');
    try {
      await api.deletePatient(token, patient.id);
      onDeleted(patient.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed. Please try again.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal visible={!!patient} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#00000060', justifyContent: 'center', padding: 24 }}>
        <View style={[dm.card, { backgroundColor: colors.card }]}>
          <View style={dm.iconWrap}>
            <Trash2 size={24} color="#EF4444" strokeWidth={1.75} />
          </View>
          <Text style={[dm.title, { color: colors.text }]}>Delete Patient</Text>
          <Text style={[dm.body, { color: colors.textSecondary }]}>
            <Text style={{ fontWeight: '700', color: colors.text }}>{patient?.full_name}</Text>
            {patient?.source === 'tenovi'
              ? ' will be removed from the dashboard and discharged in Tenovi.'
              : patient?.source === 'local'
              ? ' will be permanently removed from the system.'
              : ' will be removed from the dashboard and set to Inactive in SmartMeter.'
            }
          </Text>
          {error ? <Text style={[dm.error, { color: '#EF4444' }]}>{error}</Text> : null}
          <View style={dm.row}>
            <Pressable onPress={onClose} style={[dm.btn, { borderColor: colors.border }]}>
              <Text style={[dm.btnText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={confirm}
              disabled={deleting}
              style={[dm.btn, { backgroundColor: deleting ? '#EF444480' : '#EF4444', borderColor: 'transparent' }]}>
              {deleting
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={[dm.btnText, { color: '#fff' }]}>Delete</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const dm = StyleSheet.create({
  card:    { borderRadius: 20, padding: 24, gap: 12 },
  iconWrap:{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#EF444420', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  title:   { fontSize: 18, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 },
  body:    { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  input:   { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, fontSize: 15 },
  error:   { fontSize: 12, textAlign: 'center' },
  row:     { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn:     { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 14, fontWeight: '700' },
});

// ── Patient card ───────────────────────────────────────────────────────────

function PatientCard({
  patient, colors, canDelete, onDelete,
}: {
  patient: Patient; colors: any;
  canDelete?: boolean; onDelete?: (p: Patient) => void;
}) {
  const router = useRouter();
  const nameParts = patient.full_name.trim().split(' ');
  const initials  = ((nameParts[0]?.[0] ?? '') + (nameParts[nameParts.length - 1]?.[0] ?? '')).toUpperCase();

  return (
    <Pressable onPress={() => router.push(`/patients/${patient.id}`)}>
      <Card style={cd.root}>
        <View style={cd.top}>
          <View style={[cd.avatar, { backgroundColor: colors.primary + '18' }]}>
            <Text style={[cd.avatarText, { color: colors.primary }]}>{initials}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[cd.name, { color: colors.text }]}>{patient.full_name}</Text>
            <Text style={[cd.meta, { color: colors.textSecondary }]}>
              {(() => {
                const g = patient.sex === 'M' ? 'Male'
                  : patient.sex === 'F' ? 'Female'
                  : patient.profile_extras?.gender
                    ? (patient.profile_extras.gender.toLowerCase().startsWith('f') ? 'Female'
                      : patient.profile_extras.gender.toLowerCase().startsWith('m') ? 'Male'
                      : patient.profile_extras.gender)
                    : null;
                return g ? `${g} · ${patient.enrollment_status}` : patient.enrollment_status;
              })()}
            </Text>
            <Text style={[cd.meta, { color: colors.textSecondary }]} numberOfLines={1}>
              {patient.clinic_name ?? 'Unknown clinic'}
            </Text>
            {patient.diagnoses?.[0] ? (
              <Text style={[cd.diag, { color: colors.textSecondary }]} numberOfLines={1}>
                {patient.diagnoses[0]}
              </Text>
            ) : null}
          </View>
          <View style={cd.badges}>
            <StatusPill tone={enrollTone(patient.enrollment_status)}>{patient.enrollment_status}</StatusPill>
            {patient.risk !== 'low' && <StatusPill tone={riskTone(patient.risk)}>{patient.risk}</StatusPill>}
          </View>
        </View>
        <View style={[cd.bottom, { justifyContent: 'space-between' }]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 }}>
            <View style={[cd.chip, { borderColor: colors.border }]}>
              <Text style={[cd.chipText, { color: colors.text }]}>{patient.program}</Text>
            </View>
            <View style={[cd.chip, { borderColor: colors.border }]}>
              <Activity size={9} color={colors.textSecondary} />
              <Text style={[cd.chipText, { color: colors.textSecondary }]}>
                {patient.source === 'tenovi' ? 'Tenovi' : patient.source === 'local' ? 'Local' : 'SmartMeter'}
              </Text>
            </View>
            {patient.insurance_payer ? (
              <Text style={[cd.meta, { color: colors.textSecondary }]} numberOfLines={1}>{patient.insurance_payer}</Text>
            ) : null}
          </View>
          {canDelete && (
            <Pressable
              hitSlop={10}
              onPress={() => onDelete?.(patient)}
              style={{ padding: 6, marginLeft: 8 }}>
              <Trash2 size={15} color="#EF4444" strokeWidth={1.75} />
            </Pressable>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

// ── Filter options ─────────────────────────────────────────────────────────

const SOURCE_OPTS: { label: string; value: PatientSource | '' }[] = [
  { label: 'All Systems',    value: '' },
  { label: 'Tenovi',         value: 'tenovi' },
  { label: 'SmartMeter',     value: 'smartmeter' },
  { label: 'Local System',   value: 'local' },
];
const PROGRAM_OPTS: { label: string; value: PatientProgram | '' }[] = [
  { label: 'All Programs', value: '' },
  { label: 'RPM', value: 'RPM' }, { label: 'RTM', value: 'RTM' },
  { label: 'CCM', value: 'CCM' }, { label: 'PCM', value: 'PCM' },
];
const STATUS_OPTS = [
  { label: 'All Statuses', value: '' },
  { label: 'Active',     value: 'active'     },
  { label: 'Pending',    value: 'pending'    },
  { label: 'Hold',       value: 'hold'       },
  { label: 'Discharged', value: 'discharged' },
  { label: 'Declined',   value: 'declined'   },
];
const RISK_OPTS = [
  { label: 'All Risk',  value: '' },
  { label: 'Low',      value: 'low'      },
  { label: 'Medium',   value: 'medium'   },
  { label: 'High',     value: 'high'     },
  { label: 'Critical', value: 'critical' },
];

const PAGE_SIZE = 100;

// ── Pagination bar ─────────────────────────────────────────────────────────

function PaginationBar({
  page, totalPages, onPage, colors,
}: { page: number; totalPages: number; onPage: (p: number) => void; colors: any }) {
  if (totalPages <= 1) return null;

  // Show at most 5 page numbers centred around current page
  const range: number[] = [];
  const start = Math.max(1, page - 2);
  const end   = Math.min(totalPages, start + 4);
  for (let i = start; i <= end; i++) range.push(i);

  return (
    <View style={pg.wrap}>
      <Pressable
        onPress={() => onPage(page - 1)}
        disabled={page === 1}
        style={[pg.btn, { borderColor: colors.border, opacity: page === 1 ? 0.35 : 1 }]}
      >
        <Text style={[pg.btnText, { color: colors.textSecondary }]}>‹</Text>
      </Pressable>

      {start > 1 && (
        <>
          <Pressable onPress={() => onPage(1)} style={[pg.btn, { borderColor: colors.border }]}>
            <Text style={[pg.btnText, { color: colors.textSecondary }]}>1</Text>
          </Pressable>
          {start > 2 && <Text style={[pg.ellipsis, { color: colors.textSecondary }]}>…</Text>}
        </>
      )}

      {range.map((p) => (
        <Pressable
          key={p}
          onPress={() => onPage(p)}
          style={[pg.btn, {
            borderColor: p === page ? colors.primary : colors.border,
            backgroundColor: p === page ? colors.primary : 'transparent',
          }]}
        >
          <Text style={[pg.btnText, { color: p === page ? '#052B00' : colors.textSecondary, fontWeight: p === page ? '800' : '500' }]}>
            {p}
          </Text>
        </Pressable>
      ))}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && <Text style={[pg.ellipsis, { color: colors.textSecondary }]}>…</Text>}
          <Pressable onPress={() => onPage(totalPages)} style={[pg.btn, { borderColor: colors.border }]}>
            <Text style={[pg.btnText, { color: colors.textSecondary }]}>{totalPages}</Text>
          </Pressable>
        </>
      )}

      <Pressable
        onPress={() => onPage(page + 1)}
        disabled={page === totalPages}
        style={[pg.btn, { borderColor: colors.border, opacity: page === totalPages ? 0.35 : 1 }]}
      >
        <Text style={[pg.btnText, { color: colors.textSecondary }]}>›</Text>
      </Pressable>
    </View>
  );
}

const pg = StyleSheet.create({
  wrap:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 20 },
  btn:     { minWidth: 34, height: 34, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  btnText: { fontSize: 13 },
  ellipsis:{ fontSize: 13, paddingHorizontal: 2 },
});

// ── Main screen ────────────────────────────────────────────────────────────

export default function PatientsScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const isSuperAdmin  = session?.user.role === 'super_admin';
  const isClinicAdmin = session?.user.role === 'clinic_admin';

  const [patients, setPatients]         = useState<Patient[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [showEnroll, setShowEnroll]     = useState(false);
  const [deletingPatient, setDeletingPatient] = useState<Patient | null>(null);
  const [page, setPage]                 = useState(1);

  const [q, setQ]             = useState('');
  const [source, setSource]   = useState<PatientSource | ''>('');
  const [program, setProgram] = useState<PatientProgram | ''>('');
  const [status, setStatus]   = useState('');
  const [risk, setRisk]       = useState('');
  const [clinicId, setClinicId] = useState('');
  const [clinicFilterName, setClinicFilterName] = useState('');
  const [showClinicPicker, setShowClinicPicker] = useState(false);
  const [allClinics, setAllClinics] = useState<{ id: string; name: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Spinning animation for the refresh button
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    if (refreshing) {
      spinAnim.setValue(0);
      spinLoop.current = Animated.loop(
        Animated.timing(spinAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      );
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
      spinAnim.setValue(0);
    }
  }, [refreshing, spinAnim]);
  const spinStyle = {
    transform: [{ rotate: spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const myClinicName = useMemo(
    () => allClinics.find((c) => c.id === session?.user.clinicId)?.name ?? '',
    [allClinics, session],
  );

  useEffect(() => {
    if (!session || !isSuperAdmin) return;
    api.listClinics(session.token).then((r) => setAllClinics(r.clinics)).catch(() => {});
  }, [session, isSuperAdmin]);

  const load = useCallback(async (isRefresh = false) => {
    if (!session) return;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await api.listPatients(session.token, {
        search:   q        || undefined,
        source:   source   || undefined,
        program:  program  || undefined,
        status:   status   || undefined,
        risk:     risk     || undefined,
        clinicId: clinicId || undefined,
        page:     page - 1,   // backend is 0-indexed
        limit:    PAGE_SIZE,
      });
      setPatients(res.patients);
      setTotal(res.total);
    } catch {
      setPatients([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session, q, source, program, status, risk, clinicId, page]);

  // Reset to page 1 whenever filters or search change
  useEffect(() => {
    setPage(1);
  }, [q, source, program, status, risk, clinicId]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(), q ? 400 : 0);
    return () => clearTimeout(debounceRef.current);
  }, [load]);

  const anyFilter = !!source || !!program || !!status || !!risk || !!clinicId;

  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd   = Math.min(page * PAGE_SIZE, total);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <FlatList
        data={patients}
        keyExtractor={(item) => item.id}
        contentContainerStyle={s.content}
        onRefresh={() => { setPage(1); load(true); }}
        refreshing={refreshing}
        ListHeaderComponent={
          <View>
            <View style={s.headerRow}>
              <PageHeader
                eyebrow="Registry"
                title="Patient Registry"
                description={
                  loading
                    ? 'Loading…'
                    : total > 0
                    ? `${pageStart}–${pageEnd} of ${total.toLocaleString()} patients`
                    : '0 patients'
                }
              />
              <View style={s.headerActions}>
                <Pressable
                  onPress={() => load(true)}
                  disabled={refreshing}
                  style={[s.iconBtn, { borderColor: refreshing ? colors.primary : colors.border }]}>
                  <Animated.View style={spinStyle}>
                    <RefreshCw size={15} color={refreshing ? colors.primary : colors.textSecondary} />
                  </Animated.View>
                </Pressable>
                {(isSuperAdmin || isClinicAdmin) && (
                  <Pressable onPress={() => setShowEnroll(true)} style={[s.enrollBtn, { backgroundColor: colors.primary }]}>
                    <Plus size={15} color="#052B00" />
                    <Text style={s.enrollBtnText}>Enroll</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={[s.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Search size={14} color={colors.textSecondary} />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search by name, patient ID or MRN…"
                placeholderTextColor={colors.textSecondary}
                style={[s.searchInput, { color: colors.text }]}
              />
              {q ? <Pressable onPress={() => setQ('')} hitSlop={8}><X size={13} color={colors.textSecondary} /></Pressable> : null}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.filterRow}
              contentContainerStyle={{ gap: 6, paddingBottom: 4 }}>
              <FilterDropdown label="All Systems"  options={SOURCE_OPTS}  value={source}  onChange={setSource}  colors={colors} />
              <FilterDropdown label="All Programs" options={PROGRAM_OPTS} value={program} onChange={setProgram} colors={colors} />
              <FilterDropdown label="All Statuses" options={STATUS_OPTS}  value={status}  onChange={(v) => setStatus(v)} colors={colors} />
              <FilterDropdown label="All Risk"     options={RISK_OPTS}    value={risk}    onChange={(v) => setRisk(v)}   colors={colors} />
              {isSuperAdmin && (
                <Pressable
                  onPress={() => setShowClinicPicker(true)}
                  style={[fd.chip, {
                    borderColor: clinicId ? colors.primary : colors.border,
                    backgroundColor: clinicId ? colors.primary + '14' : colors.card,
                  }]}>
                  <Text style={[fd.chipText, { color: clinicId ? colors.primary : colors.textSecondary }]}>
                    {clinicFilterName || 'All Clinics'}
                  </Text>
                  <ChevronDown size={11} color={clinicId ? colors.primary : colors.textSecondary} />
                </Pressable>
              )}
              {anyFilter && (
                <Pressable
                  onPress={() => { setSource(''); setProgram(''); setStatus(''); setRisk(''); setClinicId(''); setClinicFilterName(''); }}
                  style={[fd.chip, { borderColor: colors.destructive + '60', backgroundColor: colors.destructive + '12' }]}>
                  <Text style={[fd.chipText, { color: colors.destructive }]}>Clear</Text>
                  <X size={10} color={colors.destructive} />
                </Pressable>
              )}
            </ScrollView>
          </View>
        }
        renderItem={({ item }) => (
          <PatientCard
            patient={item}
            colors={colors}
            canDelete={isSuperAdmin || isClinicAdmin}
            onDelete={setDeletingPatient}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListFooterComponent={
          !loading && patients.length > 0 ? (
            <PaginationBar
              page={page}
              totalPages={totalPages}
              onPage={(p) => setPage(p)}
              colors={colors}
            />
          ) : null
        }
        ListEmptyComponent={
          <View style={s.empty}>
            {loading ? (
              <ActivityIndicator color={colors.primary} size="large" />
            ) : (
              <>
                <User size={36} color={colors.textSecondary} />
                <Text style={[s.emptyTitle, { color: colors.text }]}>No patients found</Text>
                <Text style={[s.emptyDesc, { color: colors.textSecondary }]}>
                  {anyFilter || q
                    ? 'Try adjusting your filters or search term.'
                    : 'Patients sync hourly from Tenovi & SmartMeter.\nPull down to refresh or tap Enroll to add one.'}
                </Text>
              </>
            )}
          </View>
        }
      />

      {isSuperAdmin && (
        <ClinicPickerModal
          visible={showClinicPicker}
          clinics={[{ id: '', name: 'All Clinics' }, ...allClinics]}
          selectedId={clinicId}
          onSelect={(id, name) => {
            setClinicId(id);
            setClinicFilterName(id ? name : '');
          }}
          onClose={() => setShowClinicPicker(false)}
          colors={colors}
          loading={false}
        />
      )}

      {session && (
        <EnrollModal
          visible={showEnroll}
          onClose={() => setShowEnroll(false)}
          onSuccess={() => { setPage(1); load(); }}
          isSuperAdmin={isSuperAdmin}
          myClinicId={session.user.clinicId}
          myClinicName={myClinicName}
          token={session.token}
          colors={colors}
        />
      )}

      {session && (
        <DeletePatientModal
          patient={deletingPatient}
          token={session.token}
          onClose={() => setDeletingPatient(null)}
          onDeleted={(id) => setPatients((prev) => prev.filter((p) => p.id !== id))}
          colors={colors}
        />
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  content:       { padding: 16, paddingBottom: 48 },
  headerRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  iconBtn:       { width: 34, height: 34, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  enrollBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  enrollBtnText: { color: '#052B00', fontSize: 13, fontWeight: '700' },
  searchBox:     { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, height: 40, marginTop: 10 },
  searchInput:   { flex: 1, fontSize: 13 },
  filterRow:     { marginTop: 10, marginBottom: 14 },
  empty:         { alignItems: 'center', gap: 10, paddingVertical: 64 },
  emptyTitle:    { fontSize: 15, fontWeight: '700' },
  emptyDesc:     { fontSize: 12, textAlign: 'center', maxWidth: 270 },
});

const fd = StyleSheet.create({
  chip:     { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontSize: 12, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: '#00000040', justifyContent: 'center', alignItems: 'center' },
  dropdown: { minWidth: 180, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  item:     { paddingHorizontal: 16, paddingVertical: 12 },
  itemText: { fontSize: 13 },
});

const cd = StyleSheet.create({
  root:      { gap: 10 },
  top:       { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  bottom:    { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  avatar:    { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '800' },
  badges:    { alignItems: 'flex-end', gap: 4 },
  name:      { fontSize: 14.5, fontWeight: '700' },
  meta:      { fontSize: 11.5 },
  diag:      { fontSize: 11, fontStyle: 'italic' },
  chip:      { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  chipText:  { fontSize: 10.5, fontWeight: '700' },
});

const em = StyleSheet.create({
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16 },
  title:       { fontSize: 17, fontWeight: '800' },
  body:        { paddingHorizontal: 20, paddingBottom: 20 },
  footer:      { borderTopWidth: StyleSheet.hairlineWidth, padding: 16 },
  submitBtn:   { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  submitBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  label:       { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 },
  input:       { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13.5 },
  dropBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  dropBtnText: { fontSize: 13.5, flex: 1 },
  readonly:    { fontSize: 13.5, paddingVertical: 4 },
  segRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segBtn:      { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
  segBtnText:  { fontSize: 12.5, fontWeight: '600' },
  row2:        { flexDirection: 'row', gap: 12 },
  hint:        { fontSize: 11.5, marginBottom: 4 },
  errorBox:    { borderRadius: 10, borderWidth: 1, padding: 12, marginTop: 4 },
  errorText:   { fontSize: 12.5 },
});

const pk = StyleSheet.create({
  header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16 },
  title:     { fontSize: 17, fontWeight: '800' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, height: 40, marginBottom: 4 },
  searchInput: { flex: 1, fontSize: 13 },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText:   { flex: 1, fontSize: 14 },
  dot:       { width: 8, height: 8, borderRadius: 4 },
  emptyHint: { textAlign: 'center', fontSize: 13, padding: 32 },
});
