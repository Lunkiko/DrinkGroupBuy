import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { registerPushToken } from "./apiClient";

// This project only targets Android (see app.config.js's `platforms`) -- web has no Expo push
// support worth wiring up here, and iOS was never a target platform for this app.
const pushSupported = Platform.OS === "android";

// Without a handler, Android swallows a notification that arrives while the app is open (foreground),
// which would hide the most useful ones -- e.g. "your drink is ready" when the customer is looking at
// their order. This shows it as a banner + in the notification list instead. shouldPlaySound must be
// true: on Android, false suppresses the drop-down alert no matter the priority (expo-notifications docs).
if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false
    })
  });
}

// Best-effort, same shape as authSession.js/Location.requestForegroundPermissionsAsync at the
// selectRole() call site: a denied permission or a failed token/network call just means this
// device won't get pushes yet, not a broken login. Never throws.
export async function registerForPushNotifications() {
  if (!pushSupported) return;

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    const finalStatus = existingStatus === "granted"
      ? existingStatus
      : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== "granted") return;

    // Required on Android 8+ for a notification to actually show; a no-op if it already exists.
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT
    });

    const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    await registerPushToken(expoPushToken, Platform.OS);
  } catch {
    // Best-effort -- see module comment.
  }
}
