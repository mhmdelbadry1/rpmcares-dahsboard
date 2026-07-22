import { Stack } from 'expo-router';
import { DrawerMenuButton } from '@/components/drawer-menu-button';
import { useTheme } from '@/hooks/use-theme';

export default function ClinicsLayout() {
  const colors = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
      }}>
      <Stack.Screen name="index" options={{ title: 'Clinics', headerLeft: () => <DrawerMenuButton tintColor={colors.text} /> }} />
      <Stack.Screen name="time-reviews" options={{ title: 'Time Reviews' }} />
    </Stack>
  );
}
