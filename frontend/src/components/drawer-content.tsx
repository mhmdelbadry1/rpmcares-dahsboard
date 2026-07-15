import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";
import { useRouter, usePathname } from "expo-router";
import { HeartPulse, LogOut } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_META, useRole } from "@/contexts/role-context";
import { navItems } from "@/constants/nav-items";
import { useTheme } from "@/hooks/use-theme";

export function AppDrawerContent(props: DrawerContentComponentProps) {
  const colors = useTheme();
  const { role } = useRole();
  const { session, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const visible = navItems.filter((n) => !n.roles || n.roles.includes(role));

  const initials = (name: string) =>
    name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <View style={{ flex: 1, backgroundColor: colors.sidebar }}>
      <DrawerContentScrollView {...props} contentContainerStyle={{ paddingTop: 20 }}>

        {/* Brand */}
        <View style={[styles.brand, { borderBottomColor: colors.sidebarBorder }]}>
          <View style={[styles.brandIcon, { backgroundColor: colors.sidebarPrimary + "22" }]}>
            <HeartPulse size={18} color={colors.sidebarPrimary} strokeWidth={2.2} />
          </View>
          <View>
            <Text style={[styles.brandTitle, { color: "#fff" }]}>RPMCares</Text>
            <Text style={[styles.brandSub, { color: colors.sidebarForeground }]}>Command Center</Text>
          </View>
        </View>

        {/* Nav */}
        <View style={styles.nav}>
          <Text style={[styles.groupLabel, { color: colors.sidebarForeground }]}>Navigation</Text>
          {visible.map((item) => {
            const isSub = !!item.parent;
            const isActive = item.route === "/" ? pathname === "/" : pathname === item.route || pathname.startsWith(item.route + "/");
            const Icon = item.icon;
            return (
              <Pressable
                key={item.route}
                onPress={() => {
                  router.navigate(item.route as never);
                  props.navigation.closeDrawer();
                }}
                style={({ pressed }) => [
                  styles.item,
                  isSub && styles.subItem,
                  isActive && { backgroundColor: colors.sidebarAccent },
                  pressed && !isActive && { backgroundColor: colors.sidebarBorder },
                ]}>
                {isActive && <View style={[styles.activeBar, { backgroundColor: colors.sidebarPrimary }]} />}
                {isSub && (
                  <View style={[styles.subConnector, { borderColor: colors.sidebarBorder }]} />
                )}
                <Icon
                  size={isSub ? 13 : 17}
                  color={isActive ? colors.sidebarPrimary : colors.sidebarForeground}
                  strokeWidth={isActive ? 2.2 : 1.8}
                />
                <Text
                  style={[
                    styles.itemLabel,
                    isSub && styles.subLabel,
                    { color: isActive ? "#fff" : colors.sidebarForeground },
                    isActive && styles.itemLabelActive,
                  ]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </DrawerContentScrollView>

      {/* Footer */}
      <View style={[styles.footer, { borderTopColor: colors.sidebarBorder, backgroundColor: colors.sidebar }]}>
        <View style={[styles.avatarSmall, { backgroundColor: colors.sidebarAccent }]}>
          <Text style={[styles.avatarText, { color: colors.sidebarPrimary }]}>
            {session?.user.name ? initials(session.user.name) : "U"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.footerName, { color: "#fff" }]} numberOfLines={1}>
            {session?.user.name}
          </Text>
          <Text style={[styles.footerRole, { color: colors.sidebarForeground }]}>
            {ROLE_META[role].label}
          </Text>
        </View>
        <Pressable onPress={logout} hitSlop={12} style={styles.signOut}>
          <LogOut size={16} color={colors.sidebarForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingBottom: 18,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  brandTitle: { fontSize: 15, fontWeight: "800" },
  brandSub: { fontSize: 10.5, marginTop: 1, opacity: 0.8 },
  nav: { paddingTop: 8 },
  groupLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    paddingHorizontal: 18,
    marginBottom: 6,
    opacity: 0.55,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginHorizontal: 8,
    borderRadius: 10,
    overflow: "hidden",
  },
  activeBar: {
    position: "absolute",
    left: 0,
    top: "20%",
    bottom: "20%",
    width: 3,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  itemLabel: { fontSize: 13.5, fontWeight: "500" },
  itemLabelActive: { fontWeight: "700" },
  subItem:  { paddingLeft: 36, paddingVertical: 7 },
  subLabel: { fontSize: 12.5 },
  subConnector: { position: "absolute", left: 22, top: 0, bottom: 0, width: 10, borderLeftWidth: 1, borderBottomWidth: 1, borderBottomLeftRadius: 4 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  avatarSmall: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  avatarText: { fontSize: 12, fontWeight: "800" },
  footerName: { fontSize: 13, fontWeight: "700" },
  footerRole: { fontSize: 11, marginTop: 1 },
  signOut: { padding: 4 },
});
