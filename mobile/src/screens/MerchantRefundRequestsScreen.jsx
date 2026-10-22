import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MobileScreen, Section } from "../components/MobileScreen";
import { PrimaryButton } from "../components/PrimaryButton";
import { StatusBadge } from "../components/StatusBadge";
import {
  listMerchantRefundMarks,
  listMerchantStoreOrders,
  markOrderRefunded,
  revokeRefundMark
} from "../utils/apiClient";
import { formatCurrency } from "../utils/calculations";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

const REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function MerchantRefundRequestsScreen({ navigation, selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [capturedOrders, setCapturedOrders] = useState([]);
  const [refundMarks, setRefundMarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [formOrderId, setFormOrderId] = useState(null);
  const [formAmount, setFormAmount] = useState("");
  const [formReason, setFormReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  // The mark waiting for the merchant's confirmation. Its idempotency key is made once, when the dialog opens,
  // and reused by every retry of this same confirmation, so a double tap or a dropped connection cannot mark twice.
  const [confirming, setConfirming] = useState(null);
  const [confirmError, setConfirmError] = useState(null);
  // Two-step revoke: tapping 撤銷 once arms this mark's id, a second tap on 確定撤銷 actually sends it.
  const [revokeArmedId, setRevokeArmedId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const [activeOrders, historyOrders, marks] = await Promise.all([
        listMerchantStoreOrders(selectedMerchantStoreId, { scope: "active" }),
        listMerchantStoreOrders(selectedMerchantStoreId, { scope: "history" }),
        listMerchantRefundMarks(selectedMerchantStoreId)
      ]);
      const allOrders = [...(activeOrders.orders || []), ...(historyOrders.orders || [])];
      setCapturedOrders(allOrders.filter((order) => order.paymentStatus === "captured"));
      setRefundMarks(marks || []);
    } catch (error) {
      setLoadError(error.message || "退款資料載入失敗。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [selectedMerchantStoreId]);

  // Active refund-mark totals keyed by order id, built once per refundMarks change instead of
  // rescanning the whole array for every order on every render (incl. every keystroke in the form).
  const activeTotalByOrderId = useMemo(() => {
    const totals = new Map();
    for (const mark of refundMarks) {
      if (mark.status !== "active") continue;
      totals.set(mark.orderId, (totals.get(mark.orderId) || 0) + mark.amount);
    }
    return totals;
  }, [refundMarks]);

  // What's still refundable on this order: final amount minus every mark still in effect.
  // A revoked mark no longer counts, so revoking one makes room to mark again.
  function remainingRefundableAmount(order) {
    const activeTotal = activeTotalByOrderId.get(order.id) || 0;
    return Math.max((order.finalAmount ?? 0) - activeTotal, 0);
  }

  function beginRequest(order) {
    setFormOrderId(order.id);
    setFormAmount(String(remainingRefundableAmount(order)));
    setFormReason("");
    setNotice(null);
  }

  function cancelRequest() {
    setFormOrderId(null);
    setFormAmount("");
    setFormReason("");
  }

  // Validates the form and opens the confirmation dialog. Nothing is sent until the merchant confirms there.
  function openConfirmation(order) {
    const amount = Number(formAmount);
    const remaining = remainingRefundableAmount(order);
    if (!Number.isInteger(amount) || amount <= 0) {
      setNotice({ type: "error", text: "退款金額必須是大於 0 的整數。" });
      return;
    }
    if (amount > remaining) {
      setNotice({ type: "error", text: `退款金額不能超過剩餘可退金額 ${formatCurrency(remaining)}。` });
      return;
    }
    if (!formReason.trim()) {
      setNotice({ type: "error", text: "請填寫退款原因。" });
      return;
    }

    setNotice(null);
    setConfirmError(null);
    setConfirming({
      order,
      amount,
      reason: formReason.trim(),
      idempotencyKey: createRefundIdempotencyKey()
    });
  }

  function closeConfirmation() {
    if (submitting) return;
    setConfirming(null);
    setConfirmError(null);
  }

  async function confirmRefund() {
    if (!confirming || submitting) return;

    setSubmitting(true);
    setConfirmError(null);
    try {
      await markOrderRefunded(confirming.order.id, {
        amount: confirming.amount,
        reason: confirming.reason,
        idempotencyKey: confirming.idempotencyKey
      });
      setNotice({ type: "success", text: `已記錄 ${formatCurrency(confirming.amount)} 的退款。24 小時內可以在下方撤銷這筆記錄。` });
      setConfirming(null);
      cancelRequest();
      await loadData();
    } catch (error) {
      // The dialog stays open with the same key: pressing 確認 again is a safe retry.
      setConfirmError(getMarkErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function armRevoke(markId) {
    setRevokeArmedId(markId);
    setNotice(null);
  }

  function disarmRevoke() {
    setRevokeArmedId(null);
  }

  async function confirmRevoke(mark) {
    if (revokingId) return;
    setRevokingId(mark.id);
    try {
      await revokeRefundMark(mark.orderId, mark.id);
      setNotice({ type: "success", text: "已撤銷這筆退款記錄。" });
      setRevokeArmedId(null);
      await loadData();
    } catch (error) {
      setNotice({ type: "error", text: getRevokeErrorMessage(error) });
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <MobileScreen
      title="退款"
      subtitle="退款請你自己透過 LINE Pay、現金或轉帳退給顧客，這裡只負責記錄，方便統計正確。退款金額不能超過訂單剩餘可退金額。"
      onBack={() => navigation.goBack()}
    >
      {loading ? <Text style={styles.emptyText}>載入中…</Text> : null}
      {loadError ? (
        <View style={styles.syncError}>
          <Text style={styles.errorText}>{loadError}</Text>
          <PrimaryButton label="重新整理" variant="secondary" onPress={loadData} />
        </View>
      ) : null}
      {notice ? (
        <Text style={notice.type === "error" ? styles.errorText : styles.successText}>{notice.text}</Text>
      ) : null}

      {!loading && !loadError ? (
        <Section title={`已請款訂單（${capturedOrders.length} 筆）`}>
          {capturedOrders.length === 0 ? (
            <Text style={styles.emptyText}>目前沒有已請款的訂單。</Text>
          ) : null}
          {capturedOrders.map((order) => {
            const remaining = remainingRefundableAmount(order);
            const isEditing = formOrderId === order.id;

            return (
              <View key={order.id} style={styles.orderCard}>
                <View style={styles.orderHeader}>
                  <View style={styles.flex}>
                    <Text style={styles.orderTitle}>{order.activity?.title ?? "團購訂單"}</Text>
                    <Text style={styles.meta}>訂單編號：{order.id}</Text>
                  </View>
                  <Text style={styles.amount}>{formatCurrency(order.finalAmount ?? 0)}</Text>
                </View>

                {remaining <= 0 ? (
                  <Text style={styles.meta}>這筆訂單已全額標記退款。</Text>
                ) : isEditing ? (
                  <View style={styles.form}>
                    <Text style={styles.fieldLabel}>退款金額（剩餘可退 {formatCurrency(remaining)}）</Text>
                    <TextInput
                      accessibilityLabel="退款金額"
                      keyboardType="number-pad"
                      onChangeText={setFormAmount}
                      style={styles.input}
                      value={formAmount}
                    />
                    <Text style={styles.fieldLabel}>退款原因</Text>
                    <TextInput
                      accessibilityLabel="退款原因"
                      multiline
                      onChangeText={setFormReason}
                      placeholder="例如：飲品製作錯誤、顧客申訴"
                      placeholderTextColor={colors.textSecondary}
                      style={[styles.input, styles.reasonInput]}
                      value={formReason}
                    />
                    <View style={styles.formActions}>
                      <PrimaryButton
                        disabled={submitting}
                        label="取消"
                        onPress={cancelRequest}
                        style={styles.formActionButton}
                        variant="secondary"
                      />
                      <PrimaryButton
                        disabled={submitting}
                        label="下一步"
                        onPress={() => openConfirmation(order)}
                        style={styles.formActionButton}
                      />
                    </View>
                  </View>
                ) : (
                  <PrimaryButton label="退款" onPress={() => beginRequest(order)} variant="secondary" />
                )}
              </View>
            );
          })}
        </Section>
      ) : null}

      {!loading && !loadError ? (
        <Section title={`退款紀錄（${refundMarks.length} 筆）`}>
          {refundMarks.length === 0 ? (
            <Text style={styles.emptyText}>目前沒有退款紀錄。</Text>
          ) : null}
          {refundMarks.map((mark) => {
            const revokeDeadline = new Date(Date.parse(mark.createdAt) + REVOKE_WINDOW_MS);
            const canRevoke = mark.status === "active" && Date.now() < revokeDeadline.getTime();
            const isArmed = revokeArmedId === mark.id;
            const isRevoking = revokingId === mark.id;

            return (
              <View key={mark.id} style={styles.requestCard}>
                <View style={styles.orderHeader}>
                  <View style={styles.flex}>
                    <Text style={styles.meta}>訂單編號：{mark.orderId}</Text>
                    <Text style={styles.reasonText}>{mark.reason}</Text>
                  </View>
                  <StatusBadge owner="refundMark" value={mark.status} />
                </View>
                <Text style={styles.meta}>退款金額：{formatCurrency(mark.amount)}</Text>

                {canRevoke ? (
                  <View style={styles.revokeRow}>
                    <Text style={styles.meta}>可撤銷至 {formatTime(revokeDeadline)}</Text>
                    {isArmed ? (
                      <View style={styles.formActions}>
                        <PrimaryButton
                          disabled={isRevoking}
                          label="再按一次取消"
                          onPress={disarmRevoke}
                          style={styles.formActionButton}
                          variant="secondary"
                        />
                        <PrimaryButton
                          disabled={isRevoking}
                          label={isRevoking ? "撤銷中…" : "確定撤銷"}
                          onPress={() => confirmRevoke(mark)}
                          style={styles.formActionButton}
                        />
                      </View>
                    ) : (
                      <PrimaryButton label="撤銷" onPress={() => armRevoke(mark.id)} variant="secondary" />
                    )}
                  </View>
                ) : mark.status === "active" ? (
                  <Text style={styles.meta}>已過可撤銷時間。</Text>
                ) : null}
              </View>
            );
          })}
        </Section>
      ) : null}

      <RefundConfirmDialog
        confirming={confirming}
        error={confirmError}
        onCancel={closeConfirmation}
        onConfirm={confirmRefund}
        submitting={submitting}
      />
    </MobileScreen>
  );
}

// "Are you sure?" step before marking anything. Makes clear this only records the refund -- the
// merchant still has to actually return the money themselves -- and that it can be undone for 24h.
function RefundConfirmDialog({ confirming, error, submitting, onCancel, onConfirm }) {
  const styles = useThemedStyles(makeStyles);
  if (!confirming) return null;

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible>
      <View style={styles.dialogOverlay}>
        <Pressable accessibilityLabel="關閉" accessibilityRole="button" onPress={onCancel} style={StyleSheet.absoluteFillObject} />
        <View accessibilityViewIsModal style={styles.dialogCard}>
          <Text accessibilityRole="header" style={styles.dialogTitle}>確認標記退款</Text>
          <Text style={styles.dialogAmount}>{formatCurrency(confirming.amount)}</Text>
          <View style={styles.dialogLines}>
            <Text style={styles.dialogLine}>活動：{confirming.order.activity?.title ?? "團購訂單"}</Text>
            <Text style={styles.dialogLine}>訂單編號：{confirming.order.id}</Text>
            <Text style={styles.dialogLine}>原因：{confirming.reason}</Text>
          </View>
          <Text style={styles.dialogNote}>
            這筆退款請你自己透過 LINE Pay、現金或轉帳退給顧客。確認後，系統只會記錄這筆金額，用來更新營收結算，不會自動把錢退給顧客。
          </Text>
          <Text style={styles.dialogNote}>24 小時內可以在這個畫面撤銷這筆記錄（例如填錯金額）。</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.formActions}>
            <PrimaryButton
              disabled={submitting}
              label="取消"
              onPress={onCancel}
              style={styles.formActionButton}
              variant="secondary"
            />
            <PrimaryButton
              disabled={submitting}
              label={submitting ? "記錄中…" : "確認"}
              onPress={onConfirm}
              style={styles.formActionButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// One key per confirmed mark (see `confirming`); at least 8 characters, which the server requires.
function createRefundIdempotencyKey() {
  return `merchant-refund-mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(date) {
  return date.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function getMarkErrorMessage(error) {
  const errorCode = error?.payload?.status ?? error?.payload?.error;
  const messages = {
    order_not_found: "找不到這筆訂單。",
    order_not_captured: "這筆訂單沒有已請款的交易可以退款。",
    order_store_mismatch: "這筆訂單不屬於這間店。",
    invalid_refund_amount: "退款金額必須是大於 0 的整數。",
    refund_amount_exceeds_remaining_amount: "退款金額超過剩餘可退金額。",
    refund_reason_required: "請填寫退款原因。",
    idempotency_key_required: "系統發生問題，請重新操作一次。",
    idempotency_key_conflict: "系統發生問題，請重新操作一次（這筆標記與剛剛送出的不一致）。"
  };
  return messages[errorCode] || error?.message || "標記退款失敗，請稍後再試。";
}

function getRevokeErrorMessage(error) {
  const errorCode = error?.payload?.status ?? error?.payload?.error;
  const messages = {
    refund_mark_not_found: "找不到這筆退款記錄。",
    not_mark_owner: "只有標記這筆退款的商家本人可以撤銷。",
    revoke_window_expired: "已經超過 24 小時，無法自行撤銷，請聯絡管理員。"
  };
  return messages[errorCode] || error?.message || "撤銷失敗，請稍後再試。";
}

const makeStyles = (colors, tones) => StyleSheet.create({
  emptyText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19
  },
  errorText: {
    color: tones.danger.fg,
    fontSize: 12,
    fontWeight: "800"
  },
  successText: {
    color: tones.success.fg,
    fontSize: 12,
    fontWeight: "800"
  },
  syncError: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tones.danger.bg,
    backgroundColor: tones.danger.bg,
    padding: 12
  },
  orderCard: {
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.recess,
    padding: 12
  },
  requestCard: {
    gap: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.page,
    padding: 12
  },
  orderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10
  },
  flex: {
    flex: 1
  },
  orderTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900"
  },
  meta: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 3
  },
  amount: {
    color: colors.accentInk,
    fontSize: 16,
    fontWeight: "900"
  },
  revokeRow: {
    gap: 6
  },
  form: {
    gap: 8
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800"
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: 10,
    backgroundColor: colors.page,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  reasonInput: {
    minHeight: 72,
    textAlignVertical: "top"
  },
  formActions: {
    flexDirection: "row",
    gap: 8
  },
  formActionButton: {
    flex: 1
  },
  reasonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 3
  },
  dialogOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.5)"
  },
  dialogCard: {
    width: "100%",
    maxWidth: 420,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.page,
    padding: 20
  },
  dialogTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "900"
  },
  dialogAmount: {
    color: colors.accentInk,
    fontSize: 28,
    fontWeight: "900"
  },
  dialogLines: {
    gap: 4
  },
  dialogLine: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700"
  },
  dialogNote: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 18
  }
});
