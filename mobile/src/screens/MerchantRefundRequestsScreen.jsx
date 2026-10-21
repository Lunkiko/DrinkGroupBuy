import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MobileScreen, Section } from "../components/MobileScreen";
import { PrimaryButton } from "../components/PrimaryButton";
import { StatusBadge } from "../components/StatusBadge";
import {
  listMerchantRefundRequests,
  listMerchantStoreOrders,
  refundMerchantOrder
} from "../utils/apiClient";
import { formatCurrency } from "../utils/calculations";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function MerchantRefundRequestsScreen({ navigation, selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [capturedOrders, setCapturedOrders] = useState([]);
  const [refundRequests, setRefundRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [formOrderId, setFormOrderId] = useState(null);
  const [formAmount, setFormAmount] = useState("");
  const [formReason, setFormReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  // The refund waiting for the merchant's confirmation. Its idempotency key is made once, when the dialog opens,
  // and reused by every retry of this same confirmation, so a double tap or a dropped connection cannot refund twice.
  const [confirming, setConfirming] = useState(null);
  const [confirmError, setConfirmError] = useState(null);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const [activeOrders, historyOrders, requests] = await Promise.all([
        listMerchantStoreOrders(selectedMerchantStoreId, { scope: "active" }),
        listMerchantStoreOrders(selectedMerchantStoreId, { scope: "history" }),
        listMerchantRefundRequests(selectedMerchantStoreId)
      ]);
      const allOrders = [...(activeOrders.orders || []), ...(historyOrders.orders || [])];
      setCapturedOrders(allOrders.filter((order) => order.paymentStatus === "captured"));
      setRefundRequests(requests || []);
    } catch (error) {
      setLoadError(error.message || "退款資料載入失敗。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [selectedMerchantStoreId]);

  function pendingRequestForOrder(orderId) {
    return refundRequests.find((request) => request.orderId === orderId && request.status === "pending");
  }

  function beginRequest(order) {
    setFormOrderId(order.id);
    setFormAmount(String(order.finalAmount ?? 0));
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
    const requestedAmount = Number(formAmount);
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
      setNotice({ type: "error", text: "退款金額必須是大於 0 的整數。" });
      return;
    }
    if (requestedAmount > (order.finalAmount ?? 0)) {
      setNotice({ type: "error", text: `退款金額不能超過訂單金額 ${formatCurrency(order.finalAmount ?? 0)}。` });
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
      requestedAmount,
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
      await refundMerchantOrder(confirming.order.id, {
        requestedAmount: confirming.requestedAmount,
        reason: confirming.reason,
        idempotencyKey: confirming.idempotencyKey
      });
      setNotice({ type: "success", text: `已退款 ${formatCurrency(confirming.requestedAmount)}，款項會退回顧客的 LINE Pay。` });
      setConfirming(null);
      cancelRequest();
      await loadData();
    } catch (error) {
      // The dialog stays open with the same key: pressing 確認退款 again is a safe retry.
      setConfirmError(getRefundErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MobileScreen
      title="退款"
      subtitle="對已請款的訂單直接退款，款項會退回顧客的 LINE Pay。退款金額不能超過訂單金額。"
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
            const existingPending = pendingRequestForOrder(order.id);
            const amount = order.finalAmount ?? 0;
            const isEditing = formOrderId === order.id;

            return (
              <View key={order.id} style={styles.orderCard}>
                <View style={styles.orderHeader}>
                  <View style={styles.flex}>
                    <Text style={styles.orderTitle}>{order.activity?.title ?? "團購訂單"}</Text>
                    <Text style={styles.meta}>訂單編號：{order.id}</Text>
                  </View>
                  <Text style={styles.amount}>{formatCurrency(amount)}</Text>
                </View>

                {existingPending ? (
                  <View style={styles.pendingRow}>
                    <StatusBadge owner="refundRequest" value="pending" />
                    <Text style={styles.meta}>有一筆 {formatCurrency(existingPending.requestedAmount)} 的退款尚在處理中</Text>
                  </View>
                ) : isEditing ? (
                  <View style={styles.form}>
                    <Text style={styles.fieldLabel}>退款金額（最多 {formatCurrency(amount)}）</Text>
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
        <Section title={`退款紀錄（${refundRequests.length} 筆）`}>
          {refundRequests.length === 0 ? (
            <Text style={styles.emptyText}>目前沒有退款紀錄。</Text>
          ) : null}
          {refundRequests.map((request) => (
            <View key={request.id} style={styles.requestCard}>
              <View style={styles.orderHeader}>
                <View style={styles.flex}>
                  <Text style={styles.meta}>訂單編號：{request.orderId}</Text>
                  <Text style={styles.reasonText}>{request.reason}</Text>
                </View>
                <StatusBadge owner="refundRequest" value={request.status} />
              </View>
              <Text style={styles.meta}>退款金額：{formatCurrency(request.requestedAmount)}</Text>
              {request.status === "rejected" && request.rejectionReason ? (
                <Text style={styles.errorText}>未退款原因：{request.rejectionReason}</Text>
              ) : null}
            </View>
          ))}
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

// "Are you sure?" step before any money moves. Shows exactly what will be refunded and that it cannot be undone.
function RefundConfirmDialog({ confirming, error, submitting, onCancel, onConfirm }) {
  const styles = useThemedStyles(makeStyles);
  if (!confirming) return null;

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible>
      <View style={styles.dialogOverlay}>
        <Pressable accessibilityLabel="關閉" accessibilityRole="button" onPress={onCancel} style={StyleSheet.absoluteFillObject} />
        <View accessibilityViewIsModal style={styles.dialogCard}>
          <Text accessibilityRole="header" style={styles.dialogTitle}>確認退款</Text>
          <Text style={styles.dialogAmount}>{formatCurrency(confirming.requestedAmount)}</Text>
          <View style={styles.dialogLines}>
            <Text style={styles.dialogLine}>活動：{confirming.order.activity?.title ?? "團購訂單"}</Text>
            <Text style={styles.dialogLine}>訂單編號：{confirming.order.id}</Text>
            <Text style={styles.dialogLine}>原因：{confirming.reason}</Text>
          </View>
          <Text style={styles.dialogWarning}>確認後會立刻退款到顧客的 LINE Pay，無法撤回。</Text>
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
              label={submitting ? "退款中…" : "確認退款"}
              onPress={onConfirm}
              style={styles.formActionButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// One key per confirmed refund (see `confirming`); at least 8 characters, which the server requires.
function createRefundIdempotencyKey() {
  return `merchant-refund-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getRefundErrorMessage(error) {
  const errorCode = error?.payload?.error ?? error?.payload?.status;
  const messages = {
    captured_payment_not_found: "找不到這筆訂單的已請款交易。",
    order_store_mismatch: "這筆訂單不屬於這間店。",
    already_fully_refunded: "這筆交易已經全額退款，沒有可退款的餘額。",
    refund_request_already_pending: "這筆訂單已經有一筆退款在處理中，請稍後重新整理。",
    invalid_refund_amount: "退款金額必須是大於 0 的整數。",
    refund_amount_exceeds_remaining_amount: "退款金額超過可退款餘額。",
    refund_reason_required: "請填寫退款原因。",
    refund_request_rejected: "這次退款已經失敗，款項沒有退出。請取消後重新操作。",
    refund_failed: "金流商退款失敗，款項沒有退出，請稍後再試。",
    payment_operation_locked: "系統正在處理這筆訂單，請等幾秒再按一次確認退款。",
    refund_already_pending: "這筆退款已經在處理中，請稍後重新整理。"
  };
  return messages[errorCode] || error?.message || "退款失敗，請稍後再試。";
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
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
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
  dialogWarning: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800"
  }
});
