import { RefreshCw, Timer } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { api, type WorkflowClinic } from '@/lib/api';

function ClinicRow({ clinic, colors, onToggle }: {
  clinic: WorkflowClinic;
  colors: any;
  onToggle: (id: string, mode: 'automatic' | 'manual') => void;
}) {
  const isAuto = clinic.review_mode === 'automatic';
  return (
    <View style={[tr.row, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[tr.clinicName, { color: colors.text }]}>{clinic.name}</Text>
        <Text style={{ fontSize: 11, color: colors.textSecondary }}>
          {clinic.has_smartmeter ? 'SmartMeter' : 'Tenovi'}
        </Text>
      </View>
      <View style={[tr.badge, { backgroundColor: (isAuto ? '#059669' : '#7C3AED') + '18' }]}>
        <Text style={[tr.badgeText, { color: isAuto ? '#059669' : '#7C3AED' }]}>
          {isAuto ? 'Automatic' : 'Manual'}
        </Text>
      </View>
      <Switch
        value={isAuto}
        onValueChange={(v) => onToggle(clinic.id, v ? 'automatic' : 'manual')}
        trackColor={{ false: '#7C3AED40', true: '#05966940' }}
        thumbColor={isAuto ? '#059669' : '#7C3AED'}
      />
    </View>
  );
}

export default function TimeReviewsScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const [clinics, setClinics] = useState<WorkflowClinic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!session) return;
    setLoading(true);
    api.getWorkflows(session.token)
      .then((r) => setClinics(r.clinics))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session]);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(clinicId: string, mode: 'automatic' | 'manual') {
    if (!session) return;
    setClinics((prev) => prev.map((c) => c.id === clinicId ? { ...c, review_mode: mode } : c));
    setSaving(true);
    try {
      await api.setReviewMode(session.token, clinicId, mode);
    } catch {
      setClinics((prev) =>
        prev.map((c) => c.id === clinicId
          ? { ...c, review_mode: mode === 'automatic' ? 'manual' : 'automatic' }
          : c),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, gap: 14 }}>

      {/* Legend */}
      <Card style={{ gap: 10 }}>
        <View style={tr.legendRow}>
          <View style={[tr.dot, { backgroundColor: '#059669' }]} />
          <View style={{ flex: 1 }}>
            <Text style={[tr.legendTitle, { color: colors.text }]}>Automatic</Text>
            <Text style={[tr.legendDesc, { color: colors.textSecondary }]}>
              A review timer starts automatically the moment staff opens a patient profile, and saves when they navigate away (≥30 sec).
            </Text>
          </View>
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
        <View style={tr.legendRow}>
          <View style={[tr.dot, { backgroundColor: '#7C3AED' }]} />
          <View style={{ flex: 1 }}>
            <Text style={[tr.legendTitle, { color: colors.text }]}>Manual</Text>
            <Text style={[tr.legendDesc, { color: colors.textSecondary }]}>
              Staff must open the patient profile and press the timer button or enter minutes directly.
            </Text>
          </View>
        </View>
      </Card>

      {/* Clinic list */}
      <Card style={{ gap: 0, padding: 0 }}>
        <View style={[tr.listHead, { borderBottomColor: colors.border }]}>
          <Text style={[tr.listHeadText, { color: colors.text }]}>Clinics</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {saving && <ActivityIndicator size="small" color={colors.primary} />}
            <Pressable onPress={load} hitSlop={8}>
              <RefreshCw size={15} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ margin: 24 }} />
        ) : clinics.length === 0 ? (
          <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
            <Timer size={24} color={colors.textSecondary} strokeWidth={1.5} />
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>No clinics found.</Text>
          </View>
        ) : (
          clinics.map((clinic) => (
            <ClinicRow key={clinic.id} clinic={clinic} colors={colors} onToggle={handleToggle} />
          ))
        )}
      </Card>
    </ScrollView>
  );
}

const tr = StyleSheet.create({
  row:         { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  clinicName:  { fontSize: 13.5, fontWeight: '700' },
  badge:       { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText:   { fontSize: 11, fontWeight: '700' },
  listHead:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  listHeadText:{ fontSize: 13, fontWeight: '800' },
  legendRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  dot:         { width: 9, height: 9, borderRadius: 5, marginTop: 3 },
  legendTitle: { fontSize: 13, fontWeight: '800', marginBottom: 2 },
  legendDesc:  { fontSize: 12, lineHeight: 18 },
});
