import { DefaultTheme, ThemeProvider } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { AlertCircle } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import { AppDrawerContent } from "@/components/drawer-content";
import { DrawerMenuButton } from "@/components/drawer-menu-button";
import { LoginScreen } from "@/components/login-screen";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { UnreadProvider, useUnread } from "@/contexts/unread-context";
import { useTheme } from "@/hooks/use-theme";

function CommHeaderTitle() {
  const { total } = useUnread();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ fontWeight: "700", fontSize: 16, color: "#ffffff" }}>Messages & Calls</Text>
      {total > 0 && (
        <View style={{ backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 10, minWidth: 20, height: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
          <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{total > 99 ? "99+" : total}</Text>
        </View>
      )}
    </View>
  );
}

function DrawerNav() {
  const colors = useTheme();
  return (
    <Drawer
      drawerContent={(props) => <AppDrawerContent {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700", fontSize: 16 },
        headerShadowVisible: false,
        headerLeft: (props) => <DrawerMenuButton tintColor={props.tintColor} />,
        drawerType: "slide",
        overlayColor: "transparent",
        sceneStyle: { backgroundColor: colors.background },
      }}>
      <Drawer.Screen name="index" options={{ title: "Command Center" }} />
      <Drawer.Screen name="patients" options={{ title: "Patient Registry", headerShown: false }} />
      <Drawer.Screen name="alerts" options={{ title: "Alerts & Triage" }} />
      <Drawer.Screen
        name="communications"
        options={{
          headerTitle: () => <CommHeaderTitle />,
          headerStyle: { backgroundColor: "#1e40af" },
          headerTintColor: "#ffffff",
        }}
      />
      <Drawer.Screen name="billing" options={{ title: "Billing & Compliance" }} />
      <Drawer.Screen name="workflows" options={{ title: "Workflows" }} />
      <Drawer.Screen name="devices" options={{ title: "Devices", headerShown: false }} />
      <Drawer.Screen name="clinics" options={{ title: "Clinics", headerShown: false }} />
      <Drawer.Screen name="staff" options={{ title: "Staff" }} />
      <Drawer.Screen name="analytics" options={{ title: "Analytics" }} />
      <Drawer.Screen name="ai" options={{ title: "AI Assistant" }} />
      <Drawer.Screen name="settings" options={{ title: "Settings" }} />
    </Drawer>
  );
}

function SuspendedScreen() {
  const colors = useTheme();
  const { clearSuspended } = useAuth();
  return (
    <View style={[ss.root, { backgroundColor: colors.background }]}>
      <View style={[ss.iconWrap, { backgroundColor: "#F59E0B18" }]}>
        <AlertCircle size={40} color="#F59E0B" strokeWidth={1.75} />
      </View>
      <Text style={[ss.title, { color: colors.text }]}>Account Suspended</Text>
      <Text style={[ss.body, { color: colors.textSecondary }]}>
        Your account has been suspended. Please contact your administrator for assistance.
      </Text>
      <Pressable style={[ss.btn, { backgroundColor: colors.primary }]} onPress={clearSuspended}>
        <Text style={ss.btnText}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const ss = StyleSheet.create({
  root:    { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  iconWrap:{ width: 80, height: 80, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 24 },
  title:   { fontSize: 22, fontWeight: "800", letterSpacing: -0.3, marginBottom: 10, textAlign: "center" },
  body:    { fontSize: 14, lineHeight: 22, textAlign: "center", marginBottom: 32 },
  btn:     { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});

function AuthGate() {
  const colors = useTheme();
  const { session, isReady, isSuspended } = useAuth();

  if (!isReady) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isSuspended) return <SuspendedScreen />;
  return session ? <DrawerNav /> : <LoginScreen />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={DefaultTheme}>
        <AuthProvider>
          <UnreadProvider>
            <AnimatedSplashOverlay />
            <AuthGate />
          </UnreadProvider>
        </AuthProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
