import { useNavigation } from "expo-router";
import { Menu } from "lucide-react-native";
import { Pressable, StyleSheet, type ColorValue } from "react-native";

// Replaces expo-router's built-in DrawerToggleButton, which renders a static
// PNG recolored via the RN Image `tintColor` style — unreliable on some
// Android devices/OS versions, where it can render as a blank/white square
// instead of the intended tint (a known cross-platform Image-tinting quirk).
// A vector icon's `color` prop has no such ambiguity.
//
// Uses navigation.toggleDrawer() (the documented expo-router convenience
// method — see its useNavigation() docs) rather than importing DrawerActions
// from '@react-navigation/native': that package isn't a direct dependency
// here (expo-router vendors its own copy internally), so the bare import
// wouldn't resolve.
export function DrawerMenuButton({ tintColor }: { tintColor?: ColorValue }) {
  const navigation = useNavigation() as { toggleDrawer?: () => void };
  return (
    <Pressable
      onPress={() => navigation.toggleDrawer?.()}
      accessibilityLabel="Show navigation menu"
      hitSlop={12}
      style={styles.button}
    >
      <Menu size={24} color={(tintColor as string) ?? "#111827"} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 12, paddingVertical: 8 },
});
