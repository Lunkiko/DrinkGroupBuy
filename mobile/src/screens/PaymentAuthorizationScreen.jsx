import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { CheckRow } from "../components/CheckRow";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { StatusBadge } from "../components/StatusBadge";
import { ValueRow } from "../components/ValueRow";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { formatCurrency } from "../utils/calculations";
import { getManualRepaymentStateInfo } from "../utils/manualRepayment";
import {
  getAuthMode,
  getPickupOverdueRule,
  requestLinePayAuthorization,
  requestLinePayRepayment
} from "../utils/apiClient";
import { useThemedStyles } from "../theme/ThemeContext";

const LINE_PAY_SYNC_POLL_INTERVAL_MS = 3000;
const LINE_PAY_SYNC_POLL_TIMEOUT_MS = 90000;
const PAYMENT_SYNC_FINISHED_STATUSES = new Set([
  "authorized",
  "captured",
  "authorization_voided",
  "failed",
  "refunded"
]);

export function PaymentAuthorizationScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const isDevAuthMode = getAuthMode() === "dev";
  const [linePayStatus, setLinePayStatus] = useState("idle");
  const [linePayMessage, setLinePayMessage] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [pickupRule, setPickupRule] = useState(null);
  const [pickupRuleStatus, setPickupRuleStatus] = useState("idle");
  const [pickupRuleMessage, setPickupRuleMessage] = useState("");
  const [pickupRuleAccepted, setPickupRuleAccepted] = useState(false);
  const [pickupRuleReloadKey, setPickupRuleReloadKey] = useState(0);
  const [pickupRuleContentExpanded, setPickupRuleContentExpanded] = useState(false);
  const pollIntervalRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const pollInFlightRef = useRef(false);
  const allowedOrderIds = new Set(appState.orders.filter((order) => order.customerId === selectedCustomerId).map((order) => order.id));
  const payment = appState.paymentAuthorizations.find((item) => item.orderId === route.params?.orderId && allowedOrderIds.has(item.orderId))
    ?? appState.paymentAuthorizations.find((item) => allowedOrderIds.has(item.orderId));
  const order = payment ? appState.orders.find((item) => item.id === payment.orderId) : null;
  const needsPickupRuleConsent = Boolean(
    payment
    && route.params?.mode !== "manualRepayment"
    && payment.paymentStatus !== "failed"
    && order?.paymentStatus !== "failed"
    && payment.paymentStatus !== "authorized"
    && payment.status !== "authorized"
    && payment.paymentStatus !== "captured"
    && payment.status !== "captured"
  );

  useEffect(() => () => {
    stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef });
  }, []);

  useEffect(() => {
    if (!needsPickupRuleConsent) return undefined;
    let active = true;
    setPickupRuleStatus("loading");
    setPickupRuleMessage("");
    setPickupRuleAccepted(false);

    getPickupOverdueRule()
      .then((rule) => {
        if (!active) return;
        setPickupRule(rule);
        setPickupRuleStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setPickupRule(null);
        setPickupRuleStatus("error");
        setPickupRuleMessage(error.message || "取餐規則載入失敗");
      });

    return () => {
      active = false;
    };
  }, [needsPickupRuleConsent, payment?.orderId, pickupRuleReloadKey]);

  useEffect(() => {
    if (!payment?.orderId) return undefined;

    const syncWhenActive = () => {
      syncBackendOrder({
        orderId: payment.orderId,
        actions,
        setSyncStatus,
        setSyncMessage,
        silentPending: true,
        silentError: true
      }).catch(() => {
        // Keep foreground refresh non-intrusive; manual refresh still reports the error.
      });
    };

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        syncWhenActive();
      }
    });

    let removeWindowFocusListener = null;
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("focus", syncWhenActive);
      removeWindowFocusListener = () => window.removeEventListener("focus", syncWhenActive);
    }

    return () => {
      appStateSubscription?.remove?.();
      removeWindowFocusListener?.();
    };
  }, [actions, payment?.orderId]);

  if (!payment) {
    return (
      <MobileScreen
        title="付款預授權"
        onBack={() => navigation.goBack()}
      >
        <Section title="目前沒有付款資料">
          <EmptyPanel>訂單已清空，送出購物車後才會建立 LINE Pay 預授權。</EmptyPanel>
        </Section>
      </MobileScreen>
    );
  }

  const isAuthorized = payment.paymentStatus === "authorized" || payment.status === "authorized";
  const isCaptured = payment.paymentStatus === "captured" || payment.status === "captured";
  const isManualRepayment = route.params?.mode === "manualRepayment"
    || payment.paymentStatus === "failed"
    || order?.paymentStatus === "failed";
  const manualRepayment = order?.manualRepayment ?? null;
  const repaymentState = isManualRepayment ? getManualRepaymentStateInfo(manualRepayment) : null;
  const canCapture = payment.discountStatus === "qualified";
  const deepLinkResultMessage = getDeepLinkResultMessage(route.params);

  return (
    <MobileScreen
      title={isManualRepayment ? "重新付款" : "付款預授權"}
      onBack={() => navigation.goBack()}
    >
      <Section title={isManualRepayment ? "付款狀態" : "預授權狀態"}>
        <Card>
          <StatusBadge owner="payment" value={payment.status} />
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.amount}>{formatCurrency(isManualRepayment ? (manualRepayment?.finalAmount ?? payment.finalAmount ?? payment.originalAmount) : payment.originalAmount)}</Text>
          {isManualRepayment ? (
            <View style={styles.metaGroup}>
              <Text style={styles.meta}>{repaymentState.statusText}</Text>
              {manualRepayment?.reason !== "manual_repayment_expired" ? (
                <Text style={styles.meta}>可付款至 {formatRepaymentCutoff(manualRepayment?.cutoffAt)}。</Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.metaGroup}>
              <Text style={styles.meta}>目前僅預授權，尚未正式扣款。</Text>
              <Text style={styles.meta}>達標後將依優惠價請款。</Text>
            </View>
          )}
        </Card>
      </Section>

      <Section title="授權金額">
        <Card compact>
          <Text style={styles.providerName}>LINE Pay</Text>
          <Text style={styles.providerMeta}>付款對象：{payment.recipientName}</Text>
        </Card>
        <View style={styles.amountRows}>
          <AmountRow label="訂單原價" value={payment.originalAmount} />
          <AmountRow emphasis label="已授權金額" value={payment.authorizedAmount} />
        </View>
      </Section>

      {needsPickupRuleConsent ? (
        <Section title="付款前確認">
          {pickupRuleStatus === "loading" ? (
            <EmptyPanel>正在載入取餐與逾期未取規則...</EmptyPanel>
          ) : null}
          {pickupRuleStatus === "error" ? (
            <Notice accessibilityRole="alert" tone="danger" message="規則載入失敗，為避免未經同意付款，目前不能建立預授權。">
              {pickupRuleMessage ? <Text style={styles.noticeDetail}>{pickupRuleMessage}</Text> : null}
              <PrimaryButton
                label="重新載入規則"
                variant="secondary"
                style={styles.retry}
                onPress={() => setPickupRuleReloadKey((value) => value + 1)}
              />
            </Notice>
          ) : null}
          {pickupRuleStatus === "ready" && pickupRule ? (
            <Card compact style={pickupRuleAccepted && styles.consentAccepted}>
              <CheckRow checked={pickupRuleAccepted} onToggle={() => setPickupRuleAccepted((value) => !value)}>
                {`我已閱讀並同意「${pickupRule.title}」`}
              </CheckRow>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={pickupRuleContentExpanded ? "收合詳細資訊" : "展開詳細資訊"}
                onPress={() => setPickupRuleContentExpanded((value) => !value)}
                style={({ pressed }) => [styles.ruleConsentToggleRow, pressed && styles.pressed]}
              >
                <Text style={styles.ruleConsentToggleText}>詳細資訊</Text>
                <View
                  importantForAccessibility="no-hide-descendants"
                  style={[styles.chevron, pickupRuleContentExpanded && styles.chevronUp]}
                />
              </Pressable>
              {pickupRuleContentExpanded ? (
                <View style={styles.ruleConsentTextGroup}>
                  <Text style={styles.ruleConsentContent}>{pickupRule.content}</Text>
                  <Text style={styles.ruleVersion}>規則版本：{pickupRule.ruleVersion}</Text>
                </View>
              ) : null}
            </Card>
          ) : null}
        </Section>
      ) : null}

      <Section title="LINE Pay">
        {linePayMessage ? (
          <MessageNotice isError={linePayStatus === "error"} message={linePayMessage} />
        ) : null}
        {deepLinkResultMessage ? (
          <MessageNotice isError={deepLinkResultMessage.type === "error"} message={deepLinkResultMessage.message} />
        ) : null}
        {!isAuthorized && !isCaptured ? (
          <>
            <View style={styles.metaGroup}>
              <Text style={styles.meta}>
                {isManualRepayment
                  ? "此按鈕會開啟 LINE Pay，並以結算後金額直接付款。"
                  : "點擊後會開啟 LINE Pay 付款頁，完成授權即完成加入團購的付款程序。"}
              </Text>
              <Text style={styles.meta}>
                {isManualRepayment
                  ? "付款成功後會自動更新訂單並加入店家製作清單。"
                  : "完成後畫面會自動更新付款狀態。"}
              </Text>
            </View>
            <PrimaryButton
              label={repaymentState?.disabled
                ? repaymentState.disabledLabel
                : linePayStatus === "loading"
                  ? "正在建立付款請求..."
                  : isManualRepayment
                    ? "前往 LINE Pay 重新付款"
                    : "前往 LINE Pay 預授權"}
              disabled={Boolean(
                repaymentState?.disabled
                || (needsPickupRuleConsent && (pickupRuleStatus !== "ready" || !pickupRuleAccepted))
              )}
              onPress={() => {
                if (
                  linePayStatus === "loading"
                  || repaymentState?.disabled
                  || (needsPickupRuleConsent && (pickupRuleStatus !== "ready" || !pickupRuleAccepted))
                ) return;
                const startPayment = isManualRepayment ? startLinePayRepayment : startPaymentAuthorization;
                startPayment({
                  payment,
                  order,
                  routeRevision: {
                    id: route.params?.orderRevisionId,
                    amount: route.params?.revisionAmount,
                    items: route.params?.revisionItems
                  },
                  ruleConsent: needsPickupRuleConsent && pickupRule ? {
                    accepted: pickupRuleAccepted,
                    ruleType: pickupRule.ruleType,
                    ruleVersion: pickupRule.ruleVersion
                  } : null,
                  onRuleOutdated: () => setPickupRuleReloadKey((value) => value + 1),
                  actions,
                  pollIntervalRef,
                  pollTimeoutRef,
                  pollInFlightRef,
                  setLinePayStatus,
                  setLinePayMessage,
                  setSyncStatus,
                  setSyncMessage
                });
              }}
            />
            {syncMessage ? (
              <MessageNotice isError={syncStatus === "error"} message={syncMessage} />
            ) : null}
          </>
        ) : null}
      </Section>

      {isCaptured ? (
        <Section title="請款結果">
          <View style={styles.amountRows}>
            <AmountRow label="優惠後金額" value={payment.finalAmount} />
            <AmountRow emphasis label="實際請款金額" value={payment.captureAmount} />
            <AmountRow label="已釋放差額" value={payment.releasedAmount} />
          </View>
        </Section>
      ) : null}

      {/* Real capture only ever happens via the backend's automatic deadline settlement -- a
          customer must never be able to trigger it themselves. captureQualifiedPayment is a
          local-only prototype mock (no real backend call), kept as a dev-testing convenience;
          gated so it can't render or fire outside dev auth mode. */}
      <View style={styles.actions}>
        {!isManualRepayment && (isAuthorized || isCaptured) ? (
          <PrimaryButton
            label={isCaptured
              ? "已完成優惠價請款"
              : isDevAuthMode && canCapture
                ? "模擬達標後部分請款"
                : "等待達標後請款"}
            onPress={() => {
              if (isCaptured || !isDevAuthMode || !canCapture) return;
              actions.captureQualifiedPayment(payment.orderId, payment.finalAmount ?? Math.round(payment.originalAmount * 0.83));
            }}
          />
        ) : null}
        <PrimaryButton label="前往取貨資訊" variant="secondary" onPress={() => navigation.push("pickupInfo", { orderId: payment.orderId })} />
      </View>
    </MobileScreen>
  );
}

async function syncBackendOrder({
  orderId,
  actions,
  setSyncStatus,
  setSyncMessage,
  silentPending = false,
  silentError = false
}) {
  try {
    if (!silentPending) {
      setSyncStatus("loading");
      setSyncMessage("");
    }
    const result = await actions.syncOrderFromBackend(orderId);
    if (silentPending && !PAYMENT_SYNC_FINISHED_STATUSES.has(result.order.paymentStatus)) {
      return result;
    }
    setSyncStatus("ready");
    setSyncMessage(`已同步後端狀態：${result.order.paymentStatus}`);
    return result;
  } catch (error) {
    if (!silentError) {
      setSyncStatus("error");
      setSyncMessage(error.message);
    }
    throw error;
  }
}

async function openLinePayCheckoutUrl(paymentUrl) {
  // Tried preferring paymentUrl.app (the LINE app deep link) on 2026-09-16 so an
  // already-logged-in LINE app could skip the browser entirely. Reverted the same day: when LINE
  // is installed, Linking.openURL(appUrl) *succeeds* (Android found a handler for the scheme), so
  // the catch-and-fall-back-to-web path never triggers -- but this project's LINE Pay is still
  // LINE_PAY_ENV=sandbox, and LINE's real app can't process a sandbox reservation once opened, so
  // it just shows its own "載入失敗" error instead of completing checkout. The failure mode this
  // was written to catch (nothing can open the URL at all) isn't the one sandbox actually hits.
  // Revisit trying the app link again only once this project has real production LINE Pay to test
  // against, not sandbox.
  const paymentPageUrl = paymentUrl?.web || paymentUrl?.app;
  if (!paymentPageUrl) throw new Error("LINE Pay 沒有回傳付款網址");
  await Linking.openURL(paymentPageUrl);
}

async function startLinePayRepayment({
  payment,
  order,
  actions,
  pollIntervalRef,
  pollTimeoutRef,
  pollInFlightRef,
  setLinePayStatus,
  setLinePayMessage,
  setSyncStatus,
  setSyncMessage
}) {
  try {
    if (!payment || !order) {
      throw new Error("找不到可重新付款的訂單資料");
    }

    setLinePayStatus("loading");
    setLinePayMessage("");
    const payload = await requestLinePayRepayment({
      orderId: order.id,
      productName: order.itemName || "DrinkGroupBuy 飲料訂單",
      packageName: payment.recipientName || "DrinkGroupBuy"
    });
    await openLinePayCheckoutUrl(payload.paymentUrl);
    setLinePayStatus("ready");
    setLinePayMessage("已開啟 LINE Pay。付款完成後回到 App，訂單狀態會自動刷新。");
    startLinePaySyncPolling({
      orderId: payment.orderId,
      actions,
      pollIntervalRef,
      pollTimeoutRef,
      pollInFlightRef,
      setSyncStatus,
      setSyncMessage,
      finishedStatuses: new Set(["captured"]),
      waitingMessage: "等待 LINE Pay 重新付款結果。"
    });
  } catch (error) {
    setLinePayStatus("error");
    setLinePayMessage(getManualRepaymentErrorMessage(error));
    if (error.payload?.status === "already_paid") {
      syncBackendOrder({
        orderId: payment.orderId,
        actions,
        setSyncStatus,
        setSyncMessage
      }).catch(() => {});
    }
  }
}

async function startPaymentAuthorization({
  payment,
  order,
  routeRevision = null,
  ruleConsent = null,
  onRuleOutdated = null,
  actions,
  pollIntervalRef,
  pollTimeoutRef,
  pollInFlightRef,
  setLinePayStatus,
  setLinePayMessage,
  setSyncStatus,
  setSyncMessage
}) {
  const providerLabel = "LINE Pay";
  let revisionPayment = null;
  try {
    if (!payment || !order) {
      throw new Error("找不到可預授權的訂單資料");
    }

    setLinePayStatus("loading");
    setLinePayMessage("");

    revisionPayment = getRevisionPaymentContext(order, payment, routeRevision);
    const paymentAmount = revisionPayment?.amount ?? payment.originalAmount;

    const payload = await requestLinePayAuthorization({
      orderId: order.id,
      orderRevisionId: revisionPayment?.id,
      amount: paymentAmount,
      ruleConsent,
      productName: order.itemName || "DrinkGroupBuy 飲料訂單",
      packageName: payment.recipientName || "DrinkGroupBuy",
      products: buildLinePayProducts(order, payment, revisionPayment)
    });
    await openLinePayCheckoutUrl(payload.paymentUrl);
    setLinePayStatus("ready");
    setLinePayMessage(`已開啟${providerLabel}。完成授權後回到 App，付款狀態會自動刷新。`);
    startLinePaySyncPolling({
      orderId: payment.orderId,
      orderRevisionId: revisionPayment?.id,
      actions,
      pollIntervalRef,
      pollTimeoutRef,
      pollInFlightRef,
      setSyncStatus,
      setSyncMessage
    });
  } catch (error) {
    if (error.payload?.status === "rule_version_outdated") {
      onRuleOutdated?.();
    }
    if (error.payload?.status === "already_authorized") {
      setLinePayStatus("ready");
      setLinePayMessage(`此訂單已完成${providerLabel}授權，正在同步最新付款狀態。`);
      syncBackendOrder({
        orderId: payment.orderId,
        actions,
        setSyncStatus,
        setSyncMessage
      }).catch(() => {});
      return;
    }

    setLinePayStatus("error");
    setLinePayMessage(getLinePayErrorMessage(error));
  }
}

function startLinePaySyncPolling({
  orderId,
  orderRevisionId,
  actions,
  pollIntervalRef,
  pollTimeoutRef,
  pollInFlightRef,
  setSyncStatus,
  setSyncMessage,
  finishedStatuses = PAYMENT_SYNC_FINISHED_STATUSES,
  waitingMessage = "等待 LINE Pay 授權結果，完成後會自動更新訂單狀態。"
}) {
  stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef });
  const deadline = Date.now() + LINE_PAY_SYNC_POLL_TIMEOUT_MS;

  setSyncStatus("loading");
  setSyncMessage(waitingMessage);

  const poll = async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;

    try {
      const result = await actions.syncOrderFromBackend(orderId);
      const paymentStatus = result.order.paymentStatus;
      const revisionStillPending = orderRevisionId && result.order.pendingRevision?.id === orderRevisionId;

      if (finishedStatuses.has(paymentStatus) && !revisionStillPending) {
        stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef });
        setSyncStatus("ready");
        setSyncMessage(`已同步後端狀態：${paymentStatus}`);
        return;
      }

      if (Date.now() >= deadline) {
        stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef });
        setSyncStatus("idle");
        setSyncMessage("尚未收到 LINE Pay 授權結果，稍後回到 App 時會自動再次確認。");
      }
    } catch (error) {
      stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef });
      setSyncStatus("error");
      setSyncMessage(error.message);
    } finally {
      pollInFlightRef.current = false;
    }
  };

  pollTimeoutRef.current = setTimeout(poll, 1500);
  pollIntervalRef.current = setInterval(poll, LINE_PAY_SYNC_POLL_INTERVAL_MS);
}

function stopLinePaySyncPolling({ pollIntervalRef, pollTimeoutRef }) {
  if (pollIntervalRef.current) {
    clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
  }
  if (pollTimeoutRef.current) {
    clearTimeout(pollTimeoutRef.current);
    pollTimeoutRef.current = null;
  }
}

function getLinePayErrorMessage(error) {
  if (error.payload?.status === "rule_consent_required") {
    return "請先閱讀並同意取餐與逾期未取規則。";
  }
  if (error.payload?.status === "rule_version_outdated") {
    return "取餐規則已更新，請重新載入並再次確認。";
  }
  if (error.payload?.status === "rule_consent_persistence_failed") {
    return "同意紀錄保存失敗，尚未送出付款請求，請稍後再試。";
  }
  if (error.payload?.status === "already_authorized") {
    return "此訂單已完成 LINE Pay 授權，不需要重複付款。";
  }
  if (error.payload?.status === "activity_deadline_passed") {
    return "這個團購已經截止，無法再付款。";
  }
  return error.message;
}

function getManualRepaymentErrorMessage(error) {
  const messages = {
    already_paid: "這筆訂單已完成付款，正在更新訂單狀態。",
    repayment_already_pending: "已有一筆重新付款流程進行中，請完成該流程或稍後再試。",
    repayment_request_in_progress: "正在建立重新付款，請勿重複操作。",
    automatic_capture_not_finished: "系統仍在自動請款，暫時不能手動重新付款。",
    manual_repayment_expired: "已超過取餐前 15 分鐘，不能再重新付款。",
    original_payment_state_unknown: "暫時無法確認原付款狀態，請稍後再試。",
    original_authorization_void_failed: "原付款授權尚未解除，請稍後再試。"
  };
  return messages[error.payload?.status] || error.message;
}

function formatRepaymentCutoff(value) {
  if (!value) return "取餐開始前 15 分鐘";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "取餐開始前 15 分鐘";
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function getDeepLinkResultMessage(params = {}) {
  if (!params.linePayResultStatus) return null;
  const providerLabel = "LINE Pay";
  if (params.linePayResultStatus === "authorized") {
    return { type: "success", message: `已從${providerLabel}返回 App，正在同步預授權結果。` };
  }
  if (params.linePayResultStatus === "captured") {
    return { type: "success", message: `已從${providerLabel}返回 App，正在同步付款結果。` };
  }
  if (params.linePayResultStatus === "cancelled") {
    return { type: "error", message: `${providerLabel}付款已取消，可重新發起付款。` };
  }
  if (params.linePayResultStatus === "pending") {
    return { type: "success", message: `已從${providerLabel}返回 App，付款結果確認中，請稍候。` };
  }
  return { type: "error", message: `${providerLabel}流程未完成，請查看付款狀態或重新付款。` };
}

function getRevisionPaymentContext(order, payment, routeRevision = null) {
  const id = routeRevision?.id
    ?? payment.pendingRevisionId
    ?? order.pendingRevisionId
    ?? order.pendingRevision?.id
    ?? null;
  if (!id) return null;

  return {
    id,
    amount: routeRevision?.amount
      ?? payment.revisionAmount
      ?? order.pendingRevisionAmount
      ?? order.pendingRevision?.originalAmount
      ?? payment.originalAmount,
    items: routeRevision?.items
      ?? payment.revisionItems
      ?? order.pendingRevisionItems
      ?? order.pendingRevision?.items
      ?? order.items
      ?? []
  };
}

function buildLinePayProducts(order, payment, revisionPayment = null) {
  const paymentAmount = revisionPayment?.amount ?? payment.originalAmount;
  const items = revisionPayment?.items || order.items || [];
  const products = items
    .map((item) => {
      const quantity = item.quantity || 1;
      const subtotal = Number(item.subtotal);
      if (!Number.isInteger(subtotal) || subtotal <= 0 || subtotal % quantity !== 0) {
        return null;
      }
      return {
        name: item.itemName || order.itemName || "飲料",
        quantity,
        price: subtotal / quantity
      };
    })
    .filter(Boolean);
  const productTotal = products.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (products.length > 0 && productTotal === paymentAmount) {
    return products;
  }

  return [
    {
      name: order.itemName || "DrinkGroupBuy 飲料訂單",
      quantity: 1,
      price: paymentAmount
    }
  ];
}

function AmountRow({ label, value, emphasis = false }) {
  return <ValueRow emphasis={emphasis} label={label} value={value == null ? "待計算" : formatCurrency(value)} />;
}

// Draws a result message; whether it is an error is still decided by the caller's own condition.
function MessageNotice({ isError, message }) {
  return (
    <Notice
      accessibilityRole={isError ? "alert" : undefined}
      message={message}
      tone={isError ? "danger" : "success"}
    />
  );
}

const makeStyles = (colors, tones) => StyleSheet.create({
  amount: {
    ...typeScale.amount,
    color: colors.text
  },
  meta: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  // Two explanation lines that read as one paragraph.
  metaGroup: {
    gap: spacing.s4
  },
  providerName: {
    ...typeScale.price,
    color: colors.text
  },
  providerMeta: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  amountRows: {
    gap: spacing.s8
  },
  consentAccepted: {
    borderColor: colors.accent
  },
  noticeDetail: {
    ...typeScale.bodyDense,
    color: tones.danger.fg
  },
  retry: {
    alignSelf: "flex-start"
  },
  ruleConsentToggleRow: {
    minHeight: sizes.tap,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8,
    // Lines the link up under the label text: the checkbox (24) plus the gap (12) of CheckRow.
    marginLeft: spacing.s24 + spacing.s12
  },
  ruleConsentToggleText: {
    ...typeScale.bodyDense,
    fontWeight: typeScale.label.fontWeight,
    color: colors.accentInk
  },
  // A drawn chevron: two borders of a square, rotated. The margin re-centres the visible "v".
  chevron: {
    width: 10,
    height: 10,
    marginTop: -spacing.s4,
    borderRightWidth: sizes.stroke,
    borderBottomWidth: sizes.stroke,
    borderColor: colors.accentInk,
    transform: [{ rotate: "45deg" }]
  },
  chevronUp: {
    marginTop: spacing.s4,
    transform: [{ rotate: "-135deg" }]
  },
  ruleConsentTextGroup: {
    gap: spacing.s8,
    padding: spacing.s16,
    borderRadius: radii.sm,
    backgroundColor: colors.recess
  },
  ruleConsentContent: {
    ...typeScale.body,
    color: colors.text
  },
  ruleVersion: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  actions: {
    gap: spacing.s12
  },
  pressed: {
    opacity: 0.8
  }
});
