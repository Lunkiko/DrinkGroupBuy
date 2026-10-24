import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { EmptyPanel } from "../components/EmptyPanel";
import { LegalInfoModal } from "../components/LegalInfoModal";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { OrderDetailIcon } from "../components/OrderDetailIcon";
import { PrimaryButton } from "../components/PrimaryButton";
import { ProfileEditModal } from "../components/ProfileEditModal";
import { ThemeToggleButton } from "../components/ThemeToggleButton";
import { demoPickupRule } from "../mock/demoPickupRule";
import { useAppState } from "../state/AppStateContext";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";
import { getCustomerSavings, getPickupOverdueRule } from "../utils/apiClient";
import { normalizeCustomerSavings } from "../utils/customerSavings";
import { isDemoMode } from "../utils/demoMode";

function useCustomerSavings(enabled) {
  const [state, setState] = useState({ status: "loading", savings: null });
  const [reloadCount, setReloadCount] = useState(0);
  useFocusEffect(useCallback(() => {
    if (!enabled) return undefined;
    let active = true;
    setState((current) => (current.savings ? current : { status: "loading", savings: null }));
    getCustomerSavings()
      .then((payload) => {
        if (!active) return;
        const savings = normalizeCustomerSavings(payload);
        setState(savings ? { status: "ready", savings } : { status: "error", savings: null });
      })
      .catch(() => {
        if (active) setState({ status: "error", savings: null });
      });
    return () => { active = false; };
  }, [enabled, reloadCount]));
  return { ...state, retry: () => setReloadCount((count) => count + 1) };
}

function ProfileHeading({ children }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.headingRow}>
      <View style={styles.headingBar} />
      <Text accessibilityRole="header" style={styles.headingText}>{children}</Text>
    </View>
  );
}

function BellIcon() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.bellFrame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.bellDome} />
      <View style={styles.bellFoot} />
      <View style={styles.bellDot} />
    </View>
  );
}

export function ProfileScreen({ currentUserProfile, memberAction }) {
  const styles = useThemedStyles(makeStyles);
  const { logout } = useAppState();
  const savings = useCustomerSavings(Boolean(currentUserProfile));
  const [editVisible, setEditVisible] = useState(false);
  const [previewProfile, setPreviewProfile] = useState(null);
  const [pickupRuleOpen, setPickupRuleOpen] = useState(false);
  const [pickupRule, setPickupRule] = useState({ status: "idle", content: "" });
  const [unavailableNotice, setUnavailableNotice] = useState("");
  const [legalType, setLegalType] = useState(null);

  if (!currentUserProfile) {
    return (
      <MobileScreen title="個人中心" headerRight={<ThemeToggleButton />}>
        <Section title="會員資料">
          <EmptyPanel>找不到目前登入的會員資料，請重新登入。</EmptyPanel>
          <PrimaryButton label="重新登入" onPress={memberAction} />
        </Section>
      </MobileScreen>
    );
  }

  const displayName = previewProfile?.displayName || currentUserProfile.displayName || "會員";
  const photoUrl = previewProfile?.photoUrl || currentUserProfile.photoUrl || currentUserProfile.photoURL;
  const showPickupRule = async () => {
    if (pickupRuleOpen) {
      setPickupRuleOpen(false);
      return;
    }
    setPickupRuleOpen(true);
    if (pickupRule.status === "ready") return;
    if (isDemoMode()) {
      setPickupRule({ status: "ready", content: `${demoPickupRule.title}\n${demoPickupRule.content}` });
      return;
    }
    setPickupRule({ status: "loading", content: "" });
    try {
      const rule = await getPickupOverdueRule();
      setPickupRule({ status: "ready", content: `${rule.title}\n${rule.content}` });
    } catch {
      setPickupRule({ status: "error", content: "取餐規則暫時無法載入，請稍後再試。" });
    }
  };

  return (
    <>
    <MobileScreen title="個人中心" headerRight={<ThemeToggleButton />}>
      <View style={styles.memberBlock}>
        <View style={styles.memberRow}>
          {photoUrl ? (
            <Image source={{ uri: photoUrl }} style={styles.avatar} accessibilityLabel="會員相片" />
          ) : (
            <View style={styles.avatar}>
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.avatarText}>{displayName.slice(0, 1)}</Text>
            </View>
          )}
          <View style={styles.memberInfo}>
            <Text numberOfLines={1} style={styles.memberName}>{displayName}</Text>
            {currentUserProfile.email ? <Text numberOfLines={1} style={styles.memberEmail}>{currentUserProfile.email}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="編輯會員資料" onPress={() => setEditVisible(true)} style={styles.editButton}>
            <Text style={styles.editSymbol}>✎</Text>
            <Text style={styles.editLabel}>編輯</Text>
          </Pressable>
        </View>
        {previewProfile ? <Text style={styles.previewCaption}>目前為畫面預覽，尚未儲存至會員帳號。</Text> : null}
      </View>

      <View style={styles.sectionBlock}>
        <ProfileHeading>省錢統計</ProfileHeading>
        <SavingsSummary status={savings.status} savings={savings.savings} onRetry={savings.retry} />
      </View>

      <View style={styles.sectionBlock}>
        <ProfileHeading>設定</ProfileHeading>
        <Card style={styles.settingsCard}>
          <Pressable accessibilityRole="button" accessibilityLabel="訂單通知設定尚未開放" onPress={() => setUnavailableNotice("訂單通知開關尚未接上設定功能。")} style={styles.settingsRow}>
            <BellIcon />
            <View style={styles.settingsCopy}>
              <Text style={styles.settingsTitle}>訂單通知</Text>
              <Text style={styles.settingsDescription}>成團、可取餐及取消通知</Text>
            </View>
            <View style={styles.switchTrack}><View style={styles.switchThumb} /></View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable accessibilityRole="button" accessibilityLabel="查看取餐規則" onPress={showPickupRule} style={styles.settingsRow}>
            <OrderDetailIcon name="receipt" size={28} />
            <Text style={[styles.settingsTitle, styles.settingsCopy]}>取餐規則</Text>
            <Text style={styles.chevron}>{pickupRuleOpen ? "⌃" : "›"}</Text>
          </Pressable>
          {pickupRuleOpen ? <Text style={styles.ruleText}>{pickupRule.status === "loading" ? "正在載入取餐規則…" : pickupRule.content}</Text> : null}
        </Card>
        {unavailableNotice ? <Notice tone="info" message={unavailableNotice} /> : null}
      </View>

      <View style={styles.legalRow}>
        <Pressable accessibilityRole="link" onPress={() => setLegalType("terms")} style={styles.legalTarget}><Text style={styles.legalLink}>服務條款</Text></Pressable>
        <Text style={styles.legalSeparator}>·</Text>
        <Pressable accessibilityRole="link" onPress={() => setLegalType("privacy")} style={styles.legalTarget}><Text style={styles.legalLink}>隱私政策</Text></Pressable>
      </View>

      <Section title="帳號">
        <PrimaryButton label="登出" variant="secondary" onPress={logout} />
      </Section>
    </MobileScreen>
    <ProfileEditModal
      visible={editVisible}
      displayName={displayName}
      photoUrl={photoUrl}
      onClose={() => setEditVisible(false)}
      onApplyPreview={(profile) => {
        setPreviewProfile(profile);
        setEditVisible(false);
      }}
    />
    <LegalInfoModal type={legalType} onClose={() => setLegalType(null)} />
    </>
  );
}

function SavingsSummary({ status, savings, onRetry }) {
  const styles = useThemedStyles(makeStyles);
  const [explanationOpen, setExplanationOpen] = useState(false);
  if (status === "loading") return <EmptyPanel>正在計算你省下的金額…</EmptyPanel>;
  if (status === "error") {
    return (
      <Notice accessibilityRole="alert" tone="danger" message="暫時無法載入省錢統計，請稍後再試。">
        <PrimaryButton label="重新載入" variant="secondary" onPress={onRetry} />
      </Notice>
    );
  }
  if (savings.savedOrderCount === 0) {
    return <EmptyPanel title="還沒有省錢紀錄">參加的團購成團並完成請款後，折扣省下的金額會累計在這裡。</EmptyPanel>;
  }
  return (
    <Card style={styles.savingsCard}>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.savingsLabel}>累計省下</Text>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.savingsAmount}>
        {new Intl.NumberFormat("zh-TW").format(savings.totalSavedAmount)} 元
      </Text>
      <View style={styles.divider} />
      <Text style={styles.savingsDetail}>•  {savings.savedOrderCount} 筆訂單</Text>
      <Text style={styles.savingsDetail}>•  {savings.savedCupCount} 杯飲品</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="統計說明" onPress={() => setExplanationOpen((open) => !open)} style={styles.explanationRow}>
        <Text style={styles.infoSymbol}>ⓘ</Text>
        <Text style={styles.explanationLabel}>統計說明</Text>
        <Text style={styles.chevron}>{explanationOpen ? "⌃" : "⌄"}</Text>
      </Pressable>
      {explanationOpen ? <Text style={styles.savingsNote}>累計省下＝符合條件的訂單原價減最終請款金額；訂單數與飲品杯數也只計入有實際折扣的訂單。已全額退款、逾期未取或團購被取消的不列入；部分退款不會改變原本的團購折扣金額。</Text> : null}
    </Card>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  memberBlock: { gap: spacing.s12 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: spacing.s12, minHeight: 76 },
  avatar: { width: 72, height: 72, borderRadius: radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.recess },
  avatarText: { ...typeScale.screenTitle, color: colors.text },
  memberInfo: { flex: 1, minWidth: 0, gap: spacing.s4 },
  memberName: { ...typeScale.loginAction, color: colors.text },
  memberEmail: { ...typeScale.body, color: colors.textSecondary },
  previewCaption: { ...typeScale.caption, color: colors.textSecondary },
  editButton: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", gap: spacing.s4 },
  editSymbol: { ...typeScale.screenTitle, color: colors.accentInk },
  editLabel: { ...typeScale.sectionTitle, color: colors.accentInk },
  sectionBlock: { gap: spacing.s12 },
  headingRow: { flexDirection: "row", alignItems: "center", gap: spacing.s8 },
  headingBar: { width: 6, height: 24, borderRadius: radii.xs, backgroundColor: colors.warmInk },
  headingText: { ...typeScale.loginAction, color: colors.text },
  savingsCard: { gap: spacing.s4, paddingVertical: spacing.s16, backgroundColor: colors.recess },
  savingsLabel: { ...typeScale.body, color: colors.textSecondary },
  savingsAmount: { ...typeScale.pearlNumber, color: colors.text },
  savingsDetail: { ...typeScale.body, color: colors.text },
  savingsNote: { ...typeScale.caption, color: colors.textSecondary },
  divider: { height: 1, backgroundColor: colors.lineRow, marginVertical: spacing.s4 },
  explanationRow: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", gap: spacing.s8 },
  infoSymbol: { ...typeScale.screenTitle, color: colors.accentInk },
  explanationLabel: { ...typeScale.body, color: colors.accentInk, flex: 1 },
  settingsCard: { gap: 0, paddingVertical: spacing.s12 },
  settingsRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  settingsCopy: { flex: 1, minWidth: 0 },
  settingsTitle: { ...typeScale.sectionTitle, color: colors.text },
  settingsDescription: { ...typeScale.bodyDense, color: colors.textSecondary },
  bellFrame: { width: 28, height: 28, alignItems: "center" },
  bellDome: { position: "absolute", width: 18, height: 19, top: 2, borderWidth: sizes.stroke, borderColor: colors.accent, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomWidth: 0 },
  bellFoot: { position: "absolute", width: 24, height: sizes.stroke, top: 20, backgroundColor: colors.accent },
  bellDot: { position: "absolute", width: 6, height: 4, top: 23, borderRadius: radii.pill, backgroundColor: colors.accent },
  switchTrack: { width: 46, height: 28, borderRadius: radii.pill, backgroundColor: colors.recess, borderWidth: sizes.stroke, borderColor: colors.lineInput, justifyContent: "center", padding: 2 },
  switchThumb: { width: 20, height: 20, borderRadius: radii.pill, backgroundColor: colors.lineInput },
  chevron: { ...typeScale.screenTitle, color: colors.textSecondary },
  ruleText: { ...typeScale.bodyDense, color: colors.textSecondary, paddingTop: spacing.s8 },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.s12, marginVertical: -spacing.s12 },
  legalTarget: { minHeight: sizes.tap, justifyContent: "center" },
  legalLink: { ...typeScale.body, color: colors.accentInk, textDecorationLine: "underline" },
  legalSeparator: { ...typeScale.body, color: colors.textSecondary }
});
