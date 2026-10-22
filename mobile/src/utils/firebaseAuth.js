import { useEffect } from "react";
import Constants from "expo-constants";
import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail
} from "firebase/auth";
import { Platform } from "react-native";

export function useFirebaseGoogleLogin() {
  const config = getAuthConfig();

  // Android goes through the official native Google Sign-In SDK (Google Play Services) --
  // Google no longer accepts a custom URL-scheme redirect for "Android" type OAuth clients at
  // all (any app could historically claim the same scheme and intercept the callback, so Google
  // closed that off), so a generic browser-redirect flow (what this project used before, via
  // expo-auth-session) can't work here regardless of the exact redirect URI used. webClientId is
  // what Firebase needs as the ID token's audience; the Android OAuth client registered in
  // Google Cloud Console is only used implicitly by Play Services, verified against the app's
  // own package name + signing certificate -- its client ID string is never read anywhere in
  // this file.
  useEffect(() => {
    if (Platform.OS !== "android" || !config.googleWebClientId) return;
    GoogleSignin.configure({ webClientId: config.googleWebClientId });
  }, [config.googleWebClientId]);

  async function signInWithGoogle() {
    assertFirebaseConfigured(config);
    const firebaseApp = getFirebaseApp(config.firebase);
    const auth = getAuth(firebaseApp);

    if (Platform.OS === "web") {
      const provider = new GoogleAuthProvider();
      // Without this, Google silently re-signs the person into whichever account the browser
      // already has a live Google session for, skipping the account picker entirely -- this
      // forces the picker to show every time, even for someone with one active Google session.
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        const credentialResult = await signInWithPopup(auth, provider);
        return toFirebaseLoginResult(credentialResult);
      } catch (error) {
        // Closing the account-picker popup is a deliberate, ordinary choice, not a failure --
        // normalize it to the same `.code` the Android branch below uses so the caller (see
        // RoleSelectScreen.jsx) can treat "the person changed their mind" the same way on both
        // platforms, without needing to know either one's provider-specific error shape.
        if (error?.code === "auth/popup-closed-by-user" || error?.code === "auth/cancelled-popup-request") {
          throw Object.assign(new Error("Google sign-in was cancelled"), { code: "cancelled" });
        }
        throw error;
      }
    }

    // iOS is not in this project's supported platform scope (see AGENTS.md; app.config.js's
    // `platforms` only lists android/web) -- only Android's native flow is implemented below.
    if (Platform.OS !== "android") {
      throw new Error(`Google sign-in is not supported on this platform: ${Platform.OS}`);
    }

    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Play Services caches the last-used Google account and silently re-selects it on the next
    // signIn() call, skipping the account picker -- signing out of the native Google session
    // first (not Firebase's own signOut, a separate cache) clears that so the picker always shows.
    try {
      await GoogleSignin.signOut();
    } catch {
      // Nothing was cached (first-ever sign-in on this device) -- fine, proceed to signIn().
    }
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      // The person backed out of the account picker -- a deliberate, ordinary choice, not a
      // failure. `.code` lets the caller skip showing an error for this specific case.
      throw Object.assign(new Error("Google sign-in was cancelled"), { code: "cancelled" });
    }
    const idToken = response.data.idToken;
    if (!idToken) {
      throw new Error("Google sign-in did not return an ID token");
    }
    const credential = GoogleAuthProvider.credential(idToken);
    const credentialResult = await signInWithCredential(auth, credential);
    return toFirebaseLoginResult(credentialResult);
  }

  return { signInWithGoogle };
}

// Email/password is a second, independent Firebase sign-in method alongside Google -- same
// project, same ID token shape, same backend verification path (POST /api/auth/firebase-session
// trusts any valid Firebase ID token regardless of which provider produced it). Doesn't require
// googleWebClientId, since no Google sign-in is involved.
export function useFirebaseEmailLogin() {
  const config = getAuthConfig();

  async function signUpWithEmail(email, password) {
    assertFirebaseConfigured(config, { requireGoogleClientId: false });
    const auth = getAuth(getFirebaseApp(config.firebase));
    const credentialResult = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(credentialResult.user);
    return toFirebaseLoginResult(credentialResult);
  }

  async function signInWithEmail(email, password) {
    assertFirebaseConfigured(config, { requireGoogleClientId: false });
    const auth = getAuth(getFirebaseApp(config.firebase));
    const credentialResult = await signInWithEmailAndPassword(auth, email, password);
    return toFirebaseLoginResult(credentialResult);
  }

  async function resetPassword(email) {
    assertFirebaseConfigured(config, { requireGoogleClientId: false });
    const auth = getAuth(getFirebaseApp(config.firebase));
    await sendPasswordResetEmail(auth, email);
  }

  return { signUpWithEmail, signInWithEmail, resetPassword };
}

export async function signOutFirebaseUser() {
  const config = getAuthConfig();
  if (!hasFirebaseConfig(config.firebase) || getApps().length === 0) return;
  await signOut(getAuth(getFirebaseApp(config.firebase)));
}

function getFirebaseApp(firebaseConfig) {
  return getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
}

async function toFirebaseLoginResult(credentialResult) {
  const firebaseIdToken = await credentialResult.user.getIdToken(true);

  return {
    firebaseIdToken,
    firebaseUser: {
      uid: credentialResult.user.uid,
      email: credentialResult.user.email,
      displayName: credentialResult.user.displayName
    }
  };
}

function getAuthConfig() {
  const extra = Constants.expoConfig?.extra
    || Constants.manifest2?.extra?.expoClient?.extra
    || {};

  return {
    firebase: {
      apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || extra.firebaseApiKey,
      authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || extra.firebaseAuthDomain,
      projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || extra.firebaseProjectId,
      appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || extra.firebaseAppId
    },
    googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || extra.googleWebClientId
  };
}

function assertFirebaseConfigured(config, { requireGoogleClientId = true } = {}) {
  if (!hasFirebaseConfig(config.firebase)) {
    throw new Error("Firebase mobile config is missing");
  }
  if (requireGoogleClientId && !config.googleWebClientId) {
    throw new Error("Google OAuth client ID is missing");
  }
}

function hasFirebaseConfig(firebaseConfig) {
  return Boolean(
    firebaseConfig.apiKey
    && firebaseConfig.authDomain
    && firebaseConfig.projectId
    && firebaseConfig.appId
  );
}
