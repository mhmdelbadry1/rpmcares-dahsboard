import { GitBranch } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

export default function WorkflowsScreen() {
  const colors = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <GitBranch size={32} color={colors.textSecondary} strokeWidth={1.5} />
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Workflows</Text>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>Coming soon</Text>
    </View>
  );
}
