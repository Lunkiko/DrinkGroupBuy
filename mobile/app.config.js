const fs = require("node:fs");
const path = require("node:path");

// Firebase's Android config, needed for push notifications (FCM): without it getExpoPushTokenAsync
// fails on Android and no device ever registers for pushes. Kept out of Git (see .gitignore) and
// only wired in when present, so a checkout without it still builds -- just without push.
const googleServicesFile = path.join(__dirname, "google-services.json");
const hasGoogleServicesFile = fs.existsSync(googleServicesFile);

const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
const googleMapsWebApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || googleMapsApiKey;
const backendBaseUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
const devConsoleBaseUrl = process.env.EXPO_PUBLIC_DEV_CONSOLE_URL;
const firebaseApiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const firebaseAuthDomain = process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN;
const firebaseProjectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const firebaseAppId = process.env.EXPO_PUBLIC_FIREBASE_APP_ID;
const googleAndroidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const appScheme = process.env.EXPO_PUBLIC_APP_SCHEME || "drinkgroupbuy";
const authMode = process.env.EXPO_PUBLIC_AUTH_MODE || "firebase";

module.exports = {
  name: "飲料團購",
  slug: "drink-group-buy-mobile-prototype",
  owner: "royor",
  version: "0.2.0",
  icon: "./assets/icon.png",
  updates: {
    url: "https://u.expo.dev/834894ac-fe79-4a32-872f-6cee5edf2214",
    // `eas build` injects this header automatically from the build profile's `channel`; a plain
    // `expo run:android` local build skips that step entirely, so without this the app has no
    // way to know which branch's updates it should be checking -- checkForUpdateAsync() finds
    // nothing to apply even though publishing itself succeeds.
    requestHeaders: {
      "expo-channel-name": "preview"
    }
  },
  runtimeVersion: {
    policy: "appVersion"
  },
  newArchEnabled: true,
  scheme: appScheme,
  orientation: "portrait",
  // "automatic" lets the app see the phone's dark setting (Appearance / the theme's first-launch choice); it
  // is a native setting, so it only takes effect in the next native build.
  userInterfaceStyle: "automatic",
  splash: {
    backgroundColor: "#f6f8fb"
  },
  androidStatusBar: {
    backgroundColor: "#f6f8fb",
    barStyle: "dark-content",
    translucent: false
  },
  platforms: ["android", "web"],
  android: {
    package: "com.drinkgroupbuy.prototype",
    ...(hasGoogleServicesFile ? { googleServicesFile: "./google-services.json" } : {}),
    config: {
      googleMaps: {
        apiKey: googleMapsApiKey
      }
    }
  },
  plugins: [
    [
      "expo-build-properties",
      {
        // Android 9+ blocks plain-HTTP traffic by default; the dev backend is HTTP-only
        // (no local TLS cert setup), so real devices and emulators alike need this to reach
        // it. This project has no separate production build profile yet, so gate it on
        // NODE_ENV instead of leaving it unconditionally true -- a build ever run with
        // NODE_ENV=production won't silently allow plaintext HTTP app-wide.
        android: {
          usesCleartextTraffic: process.env.NODE_ENV !== "production"
        }
      }
    ],
    // No iosUrlScheme option here -- this project only targets android/web (see `platforms`
    // above), and that option is iOS-only.
    "@react-native-google-signin/google-signin",
    "expo-secure-store",
    "expo-notifications"
  ],
  extra: {
    prototypeOnly: true,
    googleMapsConfigured: Boolean(googleMapsApiKey),
    googleMapsWebApiKey,
    googleMapsWebConfigured: Boolean(googleMapsWebApiKey),
    backendBaseUrl,
    devConsoleBaseUrl,
    firebaseApiKey,
    firebaseAuthDomain,
    firebaseProjectId,
    firebaseAppId,
    googleAndroidClientId,
    googleIosClientId,
    googleWebClientId,
    appScheme,
    authMode,
    eas: {
      projectId: "834894ac-fe79-4a32-872f-6cee5edf2214"
    }
  }
};
