import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  getAuthMode,
  listDevAuthUsers,
  loginWithDevUser,
  loginWithFirebaseIdToken
} from "../utils/apiClient";
import { signOutFirebaseUser, useFirebaseGoogleLogin } from "../utils/firebaseAuth";
import { LegalInfoModal } from "../components/LegalInfoModal";
import { getRouteForUser } from "../utils/authRouting";
import { isDemoMode } from "../utils/demoMode";
import { demoCustomerUserId, demoMerchantStoreId, demoMerchantUserProfile, demoUserProfile } from "../mock/demoContent";
import { useAppState } from "../state/AppStateContext";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { brandColors, radii, sizes, typeScale } from "../theme/tokens";

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
  const [legalType, setLegalType] = useState(null);

  return (
    <>
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <LoginHeroIllustration />
      </View>

      <View style={styles.actionStack}>
        <LoginOptionButton
          icon={GOOGLE_ICON}
          label="使用 Google 登入／註冊"
          onPress={() => selectRole("customer", { userId: demoCustomerUserId }, demoUserProfile)}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate("merchantApply")}
        style={({ pressed }) => [styles.merchantApply, pressed && styles.pressed]}
      >
        <Text style={styles.merchantApplyLabel}>申請成為商家</Text>
      </Pressable>

      <Text style={styles.terms}>
        登入前請閱讀<Text accessibilityRole="link" onPress={() => setLegalType("terms")} style={styles.termsLink}>服務條款</Text>與<Text accessibilityRole="link" onPress={() => setLegalType("privacy")} style={styles.termsLink}>隱私政策</Text>
      </Text>
      <Text style={styles.version}>揪飲 JOIN!</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => selectRole("merchant", { storeId: demoMerchantStoreId }, demoMerchantUserProfile)}
        style={({ pressed }) => [styles.demoEntry, pressed && styles.pressed]}
      >
        <Text style={styles.textButtonLabel}>店家示範登入</Text>
      </Pressable>
    </ScrollView>
    <LegalInfoModal type={legalType} onClose={() => setLegalType(null)} />
    </>
  );
}

function FirebaseRoleSelectScreen(props) {
  const googleLogin = useFirebaseGoogleLogin();
  return <RoleSelectContent {...props} isDevAuthMode={false} googleLogin={googleLogin} />;
}

function RoleSelectContent({ navigation, isDevAuthMode, googleLogin = null }) {
  const styles = useThemedStyles(makeStyles);
  const [legalType, setLegalType] = useState(null);
  const { selectRole } = useAppState();
  const { signInWithGoogle } = googleLogin || {};
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [signedInUser, setSignedInUser] = useState(null);
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

  // The Google login path receives a Firebase result; devLogin builds a different user shape.
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
    <>
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
          <LoginOptionButton
            icon={GOOGLE_ICON}
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
        style={({ pressed }) => [styles.merchantApply, pressed && styles.pressed]}
      >
        <Text style={styles.merchantApplyLabel}>申請成為商家</Text>
      </Pressable>

      <Text style={styles.terms}>
        登入前請閱讀<Text accessibilityRole="link" onPress={() => setLegalType("terms")} style={styles.termsLink}>服務條款</Text>與<Text accessibilityRole="link" onPress={() => setLegalType("privacy")} style={styles.termsLink}>隱私政策</Text>
      </Text>
      <Text style={styles.version}>揪飲 JOIN!</Text>
    </ScrollView>
    <LegalInfoModal type={legalType} onClose={() => setLegalType(null)} />
    </>
  );
}

// Light mode shows the 揪飲 JOIN stacked logo (it already contains the name). Dark mode keeps the line-art
// drinks recoloured to light blue: the logo's navy outlines would disappear on the dark page, and a plate or
// halo around it looked wrong (2026-10-06), so the logo is light-mode only for now.
const HERO_LIGHT = require("../../assets/login-logo-light.png");
const HERO_DARK = require("../../assets/login-hero-dark.png");
const GOOGLE_ICON = require("../../assets/google-g.png");

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

function LoginOptionButton({ icon, label, onPress, disabled = false, compact = false }) {
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
      {icon ? (
        <View style={styles.loginIconBackground}>
          <Image source={icon} style={styles.loginIcon} resizeMode="contain" accessibilityIgnoresInvertColors />
        </View>
      ) : null}
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
    paddingHorizontal: 28,
    paddingTop: 68,
    paddingBottom: 28
  },
  hero: {
    flexGrow: 1,
    minHeight: 370,
    alignItems: "center",
    justifyContent: "center"
  },
  illustration: {
    width: 260,
    height: 225
  },
  logo: {
    width: 260,
    height: 330
  },
  actionStack: {
    gap: 10
  },
  loginButton: {
    minHeight: 62,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    borderRadius: radii.sm,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    backgroundColor: colors.page,
    paddingHorizontal: 14
  },
  compactLoginButton: {
    minHeight: sizes.tap,
    paddingHorizontal: 14
  },
  loginButtonDisabled: {
    opacity: 0.62
  },
  loginIconBackground: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: brandColors.googleLogoBackground,
    alignItems: "center",
    justifyContent: "center"
  },
  loginIcon: {
    width: 28,
    height: 28
  },
  loginButtonLabel: {
    color: colors.text,
    ...typeScale.loginAction,
    textAlign: "center"
  },
  compactLoginButtonLabel: {
    fontSize: typeScale.body.fontSize
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
    fontWeight: "700"
  },
  userInfo: {
    flex: 1,
    gap: 3
  },
  userLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700"
  },
  userName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700"
  },
  userMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700"
  },
  textButton: {
    minHeight: sizes.tap,
    alignItems: "center",
    justifyContent: "center"
  },
  textButtonLabel: {
    color: colors.accentInk,
    fontSize: 14,
    fontWeight: "700"
  },
  merchantApply: {
    minHeight: sizes.tap,
    marginTop: 28,
    alignItems: "center",
    justifyContent: "center"
  },
  merchantApplyLabel: {
    color: colors.accentInk,
    ...typeScale.price
  },
  demoEntry: {
    minHeight: sizes.tap,
    marginTop: 48,
    alignItems: "center",
    justifyContent: "center"
  },
  errorText: {
    color: tones.danger.fg,
    fontSize: 13,
    fontWeight: "700",
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
    fontWeight: "700"
  },
  devBadge: {
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: tones.info.bg,
    color: tones.info.fg,
    fontSize: 11,
    fontWeight: "700",
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
    fontWeight: "700"
  },
  dropdownValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  dropdownIcon: {
    color: colors.accentInk,
    fontSize: 14,
    fontWeight: "700"
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
    fontWeight: "700"
  },
  optionMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700"
  },
  terms: {
    marginTop: 24,
    color: colors.textSecondary,
    ...typeScale.body,
    textAlign: "center"
  },
  termsLink: {
    color: colors.accentInk,
    fontWeight: "700",
    textDecorationLine: "underline"
  },
  version: {
    marginTop: 52,
    color: colors.textSecondary,
    ...typeScale.button,
    textAlign: "center"
  },
  pressed: {
    opacity: 0.72
  }
});
