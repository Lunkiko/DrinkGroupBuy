import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  getAuthMode,
  listDevAuthUsers,
  loginWithDevUser,
  loginWithFirebaseIdToken
} from "../utils/apiClient";
import { signOutFirebaseUser, useFirebaseEmailLogin, useFirebaseGoogleLogin } from "../utils/firebaseAuth";
import { getRouteForUser } from "../utils/authRouting";
import { isDemoMode } from "../utils/demoMode";
import { demoCustomerUserId, demoMerchantStoreId, demoMerchantUserProfile, demoUserProfile } from "../mock/demoContent";
import { useAppState } from "../state/AppStateContext";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function RoleSelectScreen(props) {
  // Checked before the dev-auth branch: unlike EXPO_PUBLIC_AUTH_MODE=dev (which still calls the
  // real backend to list/log in dev accounts), demo mode must not make any network request at all.
  if (isDemoMode()) {
    return <DemoRoleSelectContent {...props} />;
  }

  const isDevAuthMode = getAuthMode() === "dev";

  if (isDevAuthMode) {
    return <RoleSelectContent {...props} isDevAuthMode />;
  }

  return <FirebaseRoleSelectScreen {...props} />;
}

// No apiClient calls anywhere in this branch -- selectRole only touches local AppStateProvider
// state, so this works with no backend reachable at all (see ../utils/demoMode.js). Deliberately
// styled to match the real FirebaseRoleSelectScreen below (same hero, same primary button, same
// footer links) rather than looking like a distinct dev tool -- only the button actions differ.
function DemoRoleSelectContent({ navigation }) {
  const styles = useThemedStyles(makeStyles);
  const { selectRole } = useAppState();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <LoginHeroIllustration />
      </View>

      <View style={styles.actionStack}>
        <LoginOptionButton
          icon="G"
          iconStyle={styles.googleIcon}
          label="使用 Google 登入／註冊"
          onPress={() => selectRole("customer", { userId: demoCustomerUserId }, demoUserProfile)}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => selectRole("merchant", { storeId: demoMerchantStoreId }, demoMerchantUserProfile)}
          style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
        >
          <Text style={styles.textButtonLabel}>店家示範登入</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate("merchantApply")}
        style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
      >
        <Text style={styles.textButtonLabel}>申請成為商家</Text>
      </Pressable>

      <Text style={styles.terms}>
        登入代表你同意<Text style={styles.termsLink}>服務條款</Text>與<Text style={styles.termsLink}>隱私政策</Text>
      </Text>
      <Text style={styles.version}>揪飲 JOIN!</Text>
    </ScrollView>
  );
}

function FirebaseRoleSelectScreen(props) {
  const googleLogin = useFirebaseGoogleLogin();
  const emailLogin = useFirebaseEmailLogin();
  return <RoleSelectContent {...props} isDevAuthMode={false} googleLogin={googleLogin} emailLogin={emailLogin} />;
}

function RoleSelectContent({ navigation, isDevAuthMode, googleLogin = null, emailLogin = null }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { selectRole } = useAppState();
  const { signInWithGoogle } = googleLogin || {};
  const { signInWithEmail, signUpWithEmail, resetPassword } = emailLogin || {};
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [signedInUser, setSignedInUser] = useState(null);
  const [emailMode, setEmailMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const [isEmailBusy, setIsEmailBusy] = useState(false);
  const [devUsers, setDevUsers] = useState([]);
  const [selectedDevUserId, setSelectedDevUserId] = useState("");
  const [isDevDropdownOpen, setIsDevDropdownOpen] = useState(false);
  const [isLoadingDevUsers, setIsLoadingDevUsers] = useState(false);
  const [devUsersRetryToken, setDevUsersRetryToken] = useState(0);

  useEffect(() => {
    if (!isDevAuthMode) return undefined;

    let isMounted = true;
    setIsLoadingDevUsers(true);
    setLoginError("");

    listDevAuthUsers()
      .then((users) => {
        if (!isMounted) return;
        // Admin has no entry point in the mobile app -- it moved to the /admin web console
        // (see backend/server.js) -- so this dev-only identity switcher shouldn't offer it.
        // Checks roles directly (not the derived, prioritized primaryRole) so a user who ever
        // carries "admin" alongside another role is still excluded.
        const selectableUsers = users.filter((user) => !user.roles.includes("admin"));
        setDevUsers(selectableUsers);
        setSelectedDevUserId((currentUserId) => currentUserId || selectableUsers[0]?.id || "");
      })
      .catch((error) => {
        if (!isMounted) return;
        setLoginError(getDevLoginErrorMessage(error));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingDevUsers(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isDevAuthMode, devUsersRetryToken]);

  // Shared by every Firebase-backed login path (Google, email/password) -- not devLogin, which
  // has no Firebase result and builds signedInUser from a different shape entirely.
  const completeFirebaseLogin = async (firebaseResult) => {
    const backendResult = await loginWithFirebaseIdToken(firebaseResult.firebaseIdToken);
    setSignedInUser({
      ...firebaseResult.firebaseUser,
      backendUser: backendResult.user
    });

    const route = getRouteForUser(backendResult.user);
    selectRole(route.role, route.params, backendResult.user);
  };

  const login = async () => {
    try {
      setIsLoggingIn(true);
      setLoginError("");

      const firebaseResult = await signInWithGoogle();
      await completeFirebaseLogin(firebaseResult);
    } catch (error) {
      // Backing out of the account picker is a deliberate, ordinary choice -- showing a red
      // error banner for it would make the app look like it's complaining about nothing.
      if (error.code !== "cancelled") {
        setLoginError(getLoginErrorMessage(error));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Shared busy/status/error scaffold for every email-form action (sign in, sign up, forgot
  // password) -- each just supplies what happens on success.
  const runEmailAction = async (action) => {
    setIsEmailBusy(true);
    setEmailStatus("");
    try {
      await action();
    } catch (error) {
      setEmailStatus(getLoginErrorMessage(error));
    } finally {
      setIsEmailBusy(false);
    }
  };

  const submitEmailForm = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) return;
    setLoginError("");

    await runEmailAction(async () => {
      if (emailMode === "signup") {
        await signUpWithEmail(trimmedEmail, password);
        setEmailStatus("帳號已建立，請到信箱點擊驗證連結；驗證後再回來登入。");
        setEmailMode("signin");
        setPassword("");
        return;
      }

      const firebaseResult = await signInWithEmail(trimmedEmail, password);
      await completeFirebaseLogin(firebaseResult);
    });
  };

  const forgotPassword = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailStatus("請先輸入信箱，再點擊忘記密碼。");
      return;
    }

    await runEmailAction(async () => {
      await resetPassword(trimmedEmail);
      setEmailStatus("已寄出重設密碼信，請到信箱查看。");
    });
  };

  const devLogin = async () => {
    try {
      setIsLoggingIn(true);
      setLoginError("");

      const backendResult = await loginWithDevUser(selectedDevUserId);
      setSignedInUser({
        uid: backendResult.user.id,
        email: backendResult.user.email,
        displayName: backendResult.user.displayName,
        backendUser: backendResult.user
      });

      const route = getRouteForUser(backendResult.user);
      selectRole(route.role, route.params, backendResult.user);
    } catch (error) {
      setLoginError(getDevLoginErrorMessage(error));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const clearFirebaseSession = async () => {
    await signOutFirebaseUser();
    setSignedInUser(null);
    setLoginError("");
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <LoginHeroIllustration />
      </View>

      <View style={styles.actionStack}>
        {loginError ? <Text style={styles.errorText}>{loginError}</Text> : null}

        {isDevAuthMode && loginError && !isLoadingDevUsers && devUsers.length === 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setDevUsersRetryToken((value) => value + 1)}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
          >
            <Text style={styles.textButtonLabel}>重試</Text>
          </Pressable>
        ) : null}

        {!isDevAuthMode ? (
          <View style={styles.emailPanel}>
            {emailStatus ? <Text style={styles.emailStatus}>{emailStatus}</Text> : null}
            <TextInput
              accessibilityLabel="信箱"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="信箱"
              placeholderTextColor={colors.textSecondary}
              style={styles.emailInput}
              value={email}
            />
            <TextInput
              accessibilityLabel="密碼"
              autoCapitalize="none"
              onChangeText={setPassword}
              placeholder="密碼"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
              style={styles.emailInput}
              value={password}
            />
            <LoginOptionButton
              compact
              label={isEmailBusy ? "處理中..." : emailMode === "signin" ? "登入" : "建立帳號"}
              disabled={isEmailBusy || !email.trim() || !password}
              onPress={() => !isEmailBusy && submitEmailForm()}
            />
            {/* Self-service email signup is temporarily Google-only (backend rejects it at
                POST /api/auth/firebase-session regardless) -- this entry point into emailMode
                "signup" stays out of the UI until that policy changes, not removed outright. */}
            {emailMode === "signin" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => !isEmailBusy && forgotPassword()}
                style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
              >
                <Text style={styles.textButtonLabel}>忘記密碼</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {!isDevAuthMode ? (
          <LoginOptionButton
            icon="G"
            iconStyle={styles.googleIcon}
            label={isLoggingIn ? "登入中..." : "使用 Google 登入／註冊"}
            disabled={isLoggingIn}
            onPress={() => !isLoggingIn && login()}
          />
        ) : null}

        {signedInUser ? (
          <View style={styles.userCard}>
            <View style={styles.userAvatar}>
              <Text style={styles.userAvatarText}>
                {(signedInUser.backendUser?.displayName || signedInUser.displayName || signedInUser.email || "會").slice(0, 1)}
              </Text>
            </View>
            <View style={styles.userInfo}>
              <Text style={styles.userLabel}>目前登入</Text>
              <Text numberOfLines={1} style={styles.userName}>
                {signedInUser.backendUser?.displayName || signedInUser.displayName || signedInUser.email}
              </Text>
              <Text numberOfLines={1} style={styles.userMeta}>
                {signedInUser.email || signedInUser.uid}
              </Text>
            </View>
          </View>
        ) : null}

        {!isDevAuthMode && signedInUser ? (
          <Pressable
            accessibilityRole="button"
            onPress={clearFirebaseSession}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
          >
            <Text style={styles.textButtonLabel}>登出 Google 登入狀態</Text>
          </Pressable>
        ) : null}

        {isDevAuthMode ? (
          <View style={styles.devPanel}>
            <View style={styles.devHeader}>
              <Text style={styles.devTitle}>本機測試身份</Text>
              <Text style={styles.devBadge}>開發模式</Text>
            </View>
            <DevIdentityDropdown
              users={devUsers}
              selectedUserId={selectedDevUserId}
              isOpen={isDevDropdownOpen}
              onToggle={() => setIsDevDropdownOpen((value) => !value)}
              onSelect={(userId) => {
                setSelectedDevUserId(userId);
                setIsDevDropdownOpen(false);
              }}
            />
            <LoginOptionButton
              compact
              label={isLoadingDevUsers
                ? "讀取測試身份中..."
                : isLoggingIn
                  ? "切換身份中..."
                  : "登入"}
              disabled={isLoadingDevUsers || !selectedDevUserId || isLoggingIn}
              onPress={() => {
                if (!isLoggingIn && selectedDevUserId) {
                  devLogin();
                }
              }}
            />
          </View>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate("merchantApply")}
        style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
      >
        <Text style={styles.textButtonLabel}>申請成為商家</Text>
      </Pressable>

      <Text style={styles.terms}>
        登入代表你同意<Text style={styles.termsLink}>服務條款</Text>與<Text style={styles.termsLink}>隱私政策</Text>
      </Text>
      <Text style={styles.version}>揪飲 JOIN!</Text>
    </ScrollView>
  );
}

// Light mode shows the 揪飲 JOIN stacked logo (it already contains the name). Dark mode keeps the line-art
// drinks recoloured to light blue: the logo's navy outlines would disappear on the dark page, and a plate or
// halo around it looked wrong (2026-10-06), so the logo is light-mode only for now.
const HERO_LIGHT = require("../../assets/login-logo-light.png");
const HERO_DARK = require("../../assets/login-hero-dark.png");

function LoginHeroIllustration() {
  const styles = useThemedStyles(makeStyles);
  const { isDark } = useTheme();
  return (
    <Image
      source={isDark ? HERO_DARK : HERO_LIGHT}
      style={isDark ? styles.illustration : styles.logo}
      resizeMode="contain"
      accessibilityLabel="揪飲 JOIN 插圖"
    />
  );
}

function LoginOptionButton({ icon, iconStyle, label, onPress, disabled = false, compact = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.loginButton,
        compact && styles.compactLoginButton,
        disabled && styles.loginButtonDisabled,
        pressed && !disabled && styles.pressed
      ]}
    >
      {icon ? <Text style={[styles.loginIcon, compact && styles.compactLoginIcon, iconStyle]}>{icon}</Text> : null}
      <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.loginButtonLabel, compact && styles.compactLoginButtonLabel]}>{label}</Text>
    </Pressable>
  );
}

// Keep in sync with backend/server.js's describeBackendError/describeFirebaseError (the
// /admin/login page's inline script) -- same Firebase/backend error codes, translated
// independently here because this file ships in the React Native bundle and that one in a
// server-rendered HTML page, with no shared module system between the two runtimes.
function getLoginErrorMessage(error) {
  if (error.payload?.error === "email_not_verified") {
    return "信箱尚未完成驗證，請先點擊驗證信裡的連結，再重新登入。";
  }
  if (error.payload?.error === "email_registration_disabled") {
    return "目前尚未開放信箱註冊，請改用 Google 登入／註冊。";
  }
  if (error.payload?.error === "Invalid Firebase ID token") {
    return "登入驗證失敗，請重新登入一次。";
  }
  if (error.payload?.error === "This account is disabled" || error.payload?.error === "This Google account is disabled") {
    return "這個帳號已被停用，如有疑問請聯絡管理員。";
  }
  if (error.payload?.error?.startsWith("This email is already linked to another account")) {
    return "這個 Email 已經連結到另一個帳號，請聯絡管理員處理。";
  }

  // Firebase client SDK errors (only ever come from the email/password form -- Google sign-in's
  // own failures are normalized to `.code === "cancelled"` before reaching here).
  const code = error.code;
  if (code === "auth/email-already-in-use") return "這個信箱已經註冊過，請改用登入。";
  if (code === "auth/weak-password") return "密碼至少需要 6 碼。";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "帳號或密碼不正確。";
  }
  if (code === "auth/too-many-requests") return "嘗試次數過多，請稍後再試。";
  if (code === "auth/invalid-email") return "信箱格式不正確。";
  if (code === "auth/operation-not-allowed") return "信箱登入功能尚未開通，請聯絡系統管理員。";

  return error.message || "登入失敗";
}

function getDevLoginErrorMessage(error) {
  if (error.payload?.error === "Not found") {
    return "後端尚未開啟 AUTH_DEV_MODE=true，無法使用本機測試身份。";
  }
  return getLoginErrorMessage(error);
}

function DevIdentityDropdown({ users, selectedUserId, isOpen, onToggle, onSelect }) {
  const styles = useThemedStyles(makeStyles);
  const selectedUser = users.find((user) => user.id === selectedUserId);

  return (
    <View style={styles.dropdown}>
      <Pressable
        accessibilityRole="button"
        onPress={onToggle}
        style={({ pressed }) => [styles.dropdownButton, pressed && styles.pressed]}
      >
        <View style={styles.dropdownTextGroup}>
          <Text style={styles.dropdownLabel}>測試身份</Text>
          <Text numberOfLines={1} style={styles.dropdownValue}>
            {selectedUser ? selectedUser.label : "沒有可用身份"}
          </Text>
        </View>
        <Text style={styles.dropdownIcon}>{isOpen ? "▲" : "▼"}</Text>
      </Pressable>

      {isOpen ? (
        <View style={styles.optionList}>
          {users.map((user) => (
            <Pressable
              key={user.id}
              accessibilityRole="button"
              onPress={() => onSelect(user.id)}
              style={({ pressed }) => [
                styles.option,
                user.id === selectedUserId && styles.selectedOption,
                pressed && styles.pressed
              ]}
            >
              <Text numberOfLines={1} style={styles.optionText}>{user.label}</Text>
              <Text numberOfLines={1} style={styles.optionMeta}>
                {getDevUserMeta(user)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function getDevUserMeta(user) {
  if (user.primaryRole === "merchant") {
    const store = user.merchantStores?.[0];
    return store ? `${user.id} / ${store.id}` : user.id;
  }
  return `${user.id} / ${user.roles.join(", ")}`;
}

const makeStyles = (colors, tones) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.page
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 30,
    paddingTop: 28,
    paddingBottom: 22
  },
  hero: {
    alignItems: "center",
    marginTop: 24,
    marginBottom: 14
  },
  illustration: {
    width: 282,
    height: 246
  },
  logo: {
    width: 200,
    height: 254
  },
  actionStack: {
    gap: 10
  },
  loginButton: {
    minHeight: 58,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.page,
    paddingHorizontal: 18
  },
  compactLoginButton: {
    minHeight: 42,
    paddingHorizontal: 14
  },
  loginButtonDisabled: {
    opacity: 0.62
  },
  loginIcon: {
    position: "absolute",
    left: 18,
    width: 28,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "900"
  },
  compactLoginIcon: {
    left: 14,
    fontSize: 17
  },
  googleIcon: {
    color: colors.accentInk
  },
  loginButtonLabel: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center"
  },
  compactLoginButtonLabel: {
    fontSize: 15
  },
  emailPanel: {
    gap: 8
  },
  emailStatus: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17
  },
  emailInput: {
    minHeight: 46,
    borderWidth: 1.3,
    borderColor: colors.lineInput,
    borderRadius: 5,
    backgroundColor: colors.page,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 12
  },
  userCard: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineDecor,
    backgroundColor: colors.recess,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  userAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent
  },
  userAvatarText: {
    color: colors.onAccent,
    fontSize: 18,
    fontWeight: "900"
  },
  userInfo: {
    flex: 1,
    gap: 3
  },
  userLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "900"
  },
  userName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900"
  },
  userMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700"
  },
  textButton: {
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center"
  },
  textButtonLabel: {
    color: colors.accentInk,
    fontSize: 14,
    fontWeight: "900"
  },
  errorText: {
    color: tones.danger.fg,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 19,
    borderRadius: 6,
    backgroundColor: tones.danger.bg,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  devPanel: {
    gap: 8,
    marginTop: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page,
    padding: 10
  },
  devHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  devTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900"
  },
  devBadge: {
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: tones.info.bg,
    color: tones.info.fg,
    fontSize: 11,
    fontWeight: "900",
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  dropdown: {
    gap: 7
  },
  dropdownButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 5,
    borderWidth: 1.3,
    borderColor: colors.lineInput,
    backgroundColor: colors.page,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  dropdownTextGroup: {
    flex: 1,
    gap: 2,
    paddingRight: 10
  },
  dropdownLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "900"
  },
  dropdownValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900"
  },
  dropdownIcon: {
    color: colors.accentInk,
    fontSize: 14,
    fontWeight: "900"
  },
  optionList: {
    overflow: "hidden",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  option: {
    gap: 4,
    minHeight: 52,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  selectedOption: {
    backgroundColor: colors.recess
  },
  optionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900"
  },
  optionMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700"
  },
  terms: {
    marginTop: 26,
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 22,
    textAlign: "center"
  },
  termsLink: {
    color: colors.accentInk,
    fontWeight: "900"
  },
  version: {
    marginTop: 20,
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center"
  },
  pressed: {
    opacity: 0.72
  }
});
