import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { TonePill } from "./TonePill";
import { formatCurrency } from "../utils/calculations";
import { formatOrderItemCustomizations, toLocalOrderItem } from "../utils/orderItems";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

export function MerchantPickupLookup({ actions, activityId = null }) {
  const styles = useThemedStyles(makeStyles);
  const [code, setCode] = useState("");
  const [credential, setCredential] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function lookup() {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await actions.lookupPickupCredential(code);
      if (activityId && result.credential.activity?.id !== activityId) {
        setNotice({ type: "error", text: "這組取餐碼不屬於目前的團購活動。" });
        return;
      }
      setCredential({ ...result.credential, pickupCode: result.credential.pickupCode ?? code });
    } catch (error) {
      setNotice({ type: "error", text: getPickupErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!credential || credential.status !== "active" || busy) return;
    setBusy(true);
    try {
      await actions.redeemPickupCredential(code);
      setCredential(null);
      setCode("");
      setNotice({ type: "success", text: "已確認取餐，訂單狀態已更新。" });
    } catch (error) {
      setNotice({ type: "error", text: getPickupErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const items = (credential?.items ?? []).map((item) => item.customizations ? toLocalOrderItem(item) : item);
  const subtotal = items.reduce((sum, item) => sum + Number(item.subtotal ?? 0), 0);
  const finalAmount = credential?.finalAmount == null ? null : Number(credential.finalAmount);
  const discount = finalAmount == null ? null : Math.max(0, subtotal - finalAmount);

  return (
    <View style={styles.lookup}>
      <View style={styles.lookupRow}>
        <TextInput
          accessibilityLabel="六位取餐碼"
          autoCorrect={false}
          keyboardType="number-pad"
          maxLength={6}
          onChangeText={(value) => { setCode(value.replace(/[^0-9]/g, "").slice(0, 6)); setNotice(null); }}
          onSubmitEditing={lookup}
          placeholder="六位取餐碼"
          placeholderTextColor={styles.placeholder.color}
          returnKeyType="done"
          style={styles.input}
          value={code}
        />
        <PrimaryButton disabled={code.length !== 6 || busy} label={busy ? "查詢中" : "查詢"} onPress={lookup} style={styles.lookupButton} />
      </View>
      {notice ? <Text accessibilityRole="alert" style={notice.type === "error" ? styles.error : styles.success}>{notice.text}</Text> : null}
      <Modal visible={Boolean(credential)} transparent animationType="fade" onRequestClose={() => !busy && setCredential(null)}>
        <View style={styles.overlay}>
          <View style={styles.scrim} />
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <Text accessibilityRole="header" style={styles.dialogTitle}>取餐核銷</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="關閉取餐核銷" disabled={busy} onPress={() => setCredential(null)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogContent}>
              <View style={styles.codeRow}>
                <View style={styles.codeColumn}><Text style={styles.label}>六位取餐碼</Text><Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.code}>{credential?.pickupCode}</Text></View>
                <TonePill tone={credential?.status === "active" ? "success" : "neutral"} label={credential?.status === "active" ? "可取餐" : "不可核銷"} />
              </View>
              <View style={styles.infoBlock}>
                <InfoRow label="顧客" value={credential?.customerDisplayName || "顧客"} />
                {credential?.orderId ? <InfoRow label="訂單編號" value={credential.orderId} /> : null}
                <InfoRow label="活動" value={credential?.activity?.title || "團購活動"} />
              </View>
              <Text style={styles.sectionTitle}>飲品明細</Text>
              {items.map((item, index) => <View key={item.id ?? index} style={styles.itemRow}>
                <View style={styles.itemText}><Text style={styles.itemName}>{item.itemName ?? item.name} × {item.quantity}</Text><Text style={styles.itemMeta}>{formatOrderItemCustomizations(item)}</Text></View>
                <Text style={styles.itemAmount}>{formatCurrency(item.subtotal ?? 0)}</Text>
              </View>)}
              <View style={styles.amountRow}><Text style={styles.amountLabel}>共 {credential?.totalCups ?? 0} 杯</Text><Text style={styles.amountText}>小計 {formatCurrency(subtotal)}</Text></View>
              {discount != null ? <View style={styles.amountRow}><Text style={styles.amountLabel}>折扣金額</Text><Text style={styles.amountText}>{formatCurrency(discount)}</Text></View> : null}
              <View style={styles.amountRow}><Text style={styles.amountLabel}>已付款金額</Text><Text style={styles.amountStrong}>{finalAmount == null ? "金額待確認" : formatCurrency(finalAmount)}</Text></View>
              <Text style={styles.confirmHint}>請核對飲品與杯數，交付後再確認核銷。</Text>
              <PrimaryButton disabled={busy || credential?.status !== "active"} label={busy ? "處理中" : "確認已取餐"} onPress={redeem} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function InfoRow({ label, value }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.infoRow}><Text style={styles.infoLabel}>{label}</Text><Text numberOfLines={2} style={styles.infoValue}>{value}</Text></View>;
}

function getPickupErrorMessage(error) {
  const code = error?.payload?.error;
  const messages = {
    credential_not_found: "找不到有效的取餐碼。",
    credential_already_redeemed: "這組取餐碼已經使用過。",
    credential_expired: "這組取餐碼已經過期。",
    order_not_ready_for_pickup: "這筆訂單目前尚不可取餐。",
    operation_locked: "系統正在處理這筆團購，請稍候再試。",
    credential_already_changed: "這組取餐碼剛剛已變更，請重新查詢。"
  };
  return messages[code] ?? error?.message ?? "取餐操作失敗，請稍後再試。";
}

const makeStyles = (colors, tones) => StyleSheet.create({
  lookup: { gap: spacing.s8 },
  lookupRow: { flexDirection: "row", gap: spacing.s8, alignItems: "center" },
  input: { flex: 1, minWidth: 0, minHeight: sizes.buttonHeight, borderWidth: sizes.stroke, borderColor: colors.lineInput, borderRadius: radii.pill, color: colors.text, backgroundColor: colors.page, paddingHorizontal: spacing.s16, ...typeScale.button },
  placeholder: { color: colors.textSecondary },
  lookupButton: { minWidth: 92 },
  error: { ...typeScale.bodyDense, color: tones.danger.fg },
  success: { ...typeScale.bodyDense, color: tones.success.fg },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.s16 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.text, opacity: 0.65 },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "90%", borderRadius: radii.lg, backgroundColor: colors.page, padding: spacing.s20, gap: spacing.s12 },
  dialogHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dialogTitle: { ...typeScale.screenTitle, color: colors.text },
  closeButton: { width: sizes.tap, height: sizes.tap, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 30, lineHeight: 34, color: colors.textSecondary },
  dialogScroll: { flexGrow: 0 },
  dialogContent: { gap: spacing.s12, paddingBottom: spacing.s4 },
  codeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8 },
  codeColumn: { flex: 1 },
  label: { ...typeScale.bodyDense, color: colors.textSecondary },
  code: { ...typeScale.pickupCode, color: colors.accentInk, letterSpacing: 2 },
  infoBlock: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.lineRow, paddingVertical: spacing.s12, gap: spacing.s8 },
  infoRow: { flexDirection: "row", gap: spacing.s16 },
  infoLabel: { ...typeScale.body, color: colors.textSecondary, width: 72 },
  infoValue: { ...typeScale.body, color: colors.text, flex: 1 },
  sectionTitle: { ...typeScale.sectionTitle, color: colors.text },
  itemRow: { flexDirection: "row", gap: spacing.s8, borderBottomWidth: 1, borderBottomColor: colors.lineRow, paddingBottom: spacing.s12 },
  itemText: { flex: 1 },
  itemName: { ...typeScale.button, color: colors.text },
  itemMeta: { ...typeScale.bodyDense, color: colors.textSecondary },
  itemAmount: { ...typeScale.body, color: colors.text },
  amountRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.s8, borderBottomWidth: 1, borderBottomColor: colors.lineRow, paddingBottom: spacing.s8 },
  amountLabel: { ...typeScale.body, color: colors.textSecondary },
  amountText: { ...typeScale.body, color: colors.text },
  amountStrong: { ...typeScale.price, color: colors.text },
  confirmHint: { ...typeScale.bodyDense, color: colors.textSecondary, textAlign: "center" }
});
