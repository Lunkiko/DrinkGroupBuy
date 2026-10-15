import { useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { MobileScreen, Section } from "../components/MobileScreen";
import { DiscountSummaryCard } from "../components/DiscountSummaryCard";
import { PrimaryButton } from "../components/PrimaryButton";
import { PearlTray } from "../components/PearlTray";
import { StatusBadge } from "../components/StatusBadge";
import { useAppState } from "../state/AppStateContext";
import { formatOrderItemCustomizations, toLocalOrderItem } from "../utils/orderItems";
import { useOrderListSync } from "../hooks/useOrderListSync";
import { formatCurrency, getStoreById, isWithdrawalLocked } from "../utils/calculations";
import { formatDeadlineLabel } from "../utils/deadlineTime";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function MerchantDashboardScreen({ navigation, route, appState, actions, selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { logout } = useAppState();
  const [pickupCode, setPickupCode] = useState("");
  const [pickupLookup, setPickupLookup] = useState(null);
  const [pickupNotice, setPickupNotice] = useState(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [readyAction, setReadyAction] = useState(null);
  const [expandedOrderIds, setExpandedOrderIds] = useState({});
  // The history-order-detail view used to be a local-state toggle (selectedHistoryOrderId)
  // invisible to the hardware back button. It's now a real stack entry: this screen's own route
  // is pushed a second time with orderId (see MerchantDashboardStack.jsx).
  const orderId = route.params?.orderId ?? null;
  const [cancelFormActivityId, setCancelFormActivityId] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelAction, setCancelAction] = useState(null);
  const cancelActionInFlightRef = useRef(false);
  const [tab, setTab] = useState("active");
  const { syncStatus, refreshOrders } = useOrderListSync(
    actions.syncMerchantOrderList,
    tab,
    selectedMerchantStoreId
  );
  const activitySyncStatus = appState.groupBuyActivitySyncStatus ?? "idle";
  const merchantStore = getStoreById(appState.stores ?? [], selectedMerchantStoreId) ?? null;
  const merchantStoreId = merchantStore?.id ?? selectedMerchantStoreId;
  const merchantGroupBuyActivities = appState.groupBuyActivities.filter((groupBuyActivity) => groupBuyActivity.storeId === merchantStoreId);
  const activeGroupBuyActivities = merchantGroupBuyActivities.filter((groupBuyActivity) => (
    ["recruiting", "confirmed", "ordering", "ready_for_pickup"].includes(groupBuyActivity.status)
  ));
  const activeGroupBuyActivityIds = new Set(activeGroupBuyActivities.map((groupBuyActivity) => groupBuyActivity.id));
  const merchantGroupBuyActivityIds = new Set(merchantGroupBuyActivities.map((groupBuyActivity) => groupBuyActivity.id));
  const activeOrders = appState.orders.filter((order) => activeGroupBuyActivityIds.has(order.groupBuyActivityId)
    && (order.lifecycleBucket ? order.lifecycleBucket === "active" : order.status !== "cancelled"));
  const historyOrders = appState.orders.filter((order) => {
    const groupBuyActivity = appState.groupBuyActivities.find((item) => item.id === order.groupBuyActivityId);
    return merchantGroupBuyActivityIds.has(order.groupBuyActivityId) && (order.lifecycleBucket
      ? order.lifecycleBucket === "history"
      : ["completed", "cancelled"].includes(order.status)
        || ["picked_up", "cancelled", "expired"].includes(order.pickupStatus)
        || ["cancelled", "failed", "completed"].includes(groupBuyActivity?.status));
  });
  const pendingPaymentCount = activeOrders.filter((order) => ["pending", "failed"].includes(order.paymentStatus)).length;
  const paidOrderCount = activeOrders.filter((order) => ["authorized", "captured"].includes(order.paymentStatus)).length;

  function handlePickupCodeChange(value) {
    setPickupCode(value.replace(/[^0-9]/g, "").slice(0, 6));
    setPickupLookup(null);
    setPickupNotice(null);
  }

  async function handlePickupLookup() {
    if (pickupCode.length !== 6) {
      setPickupNotice({ type: "error", text: "請輸入六位取餐碼。" });
      return;
    }

    setPickupBusy(true);
    setPickupLookup(null);
    setPickupNotice(null);
    try {
      const result = await actions.lookupPickupCredential(pickupCode);
      setPickupLookup(result.credential);
    } catch (error) {
      setPickupNotice({ type: "error", text: getPickupErrorMessage(error) });
    } finally {
      setPickupBusy(false);
    }
  }

  async function handlePickupRedeem() {
    if (!pickupLookup || pickupLookup.status !== "active" || pickupBusy) return;

    setPickupBusy(true);
    setPickupNotice(null);
    try {
      const result = await actions.redeemPickupCredential(pickupCode);
      setPickupLookup(null);
      setPickupCode("");
      setPickupNotice({
        type: "success",
        text: `${result.credential.customerDisplayName || "顧客"}的訂單已確認取餐。`
      });
    } catch (error) {
      setPickupNotice({ type: "error", text: getPickupErrorMessage(error) });
    } finally {
      setPickupBusy(false);
    }
  }

  async function handleMarkReady(groupBuyActivityId, orderId) {
    setReadyAction({ activityId: groupBuyActivityId, orderId: orderId ?? null, busy: true, text: null, type: null });
    try {
      const result = await actions.markOrdersReadyForPickupForGroupBuyActivity(groupBuyActivityId, orderId);
      setReadyAction({
        activityId: groupBuyActivityId,
        orderId: orderId ?? null,
        busy: false,
        type: "success",
        text: `已產生 ${result.createdCredentialCount} 筆六位取餐碼。`
      });
    } catch (error) {
      setReadyAction({
        activityId: groupBuyActivityId,
        orderId: orderId ?? null,
        busy: false,
        type: "error",
        text: getPickupErrorMessage(error)
      });
    }
  }

  function beginCancel(groupBuyActivityId) {
    setCancelFormActivityId(groupBuyActivityId);
    setCancelReason("");
    setCancelAction(null);
  }

  function cancelCancelForm() {
    setCancelFormActivityId(null);
    setCancelReason("");
  }

  async function handleCancelActivity(groupBuyActivityId) {
    if (cancelActionInFlightRef.current) return;
    if (!cancelReason.trim()) {
      setCancelAction({ activityId: groupBuyActivityId, busy: false, type: "error", text: "請填寫取消原因。" });
      return;
    }
    cancelActionInFlightRef.current = true;
    setCancelAction({ activityId: groupBuyActivityId, busy: true, text: null, type: null });
    try {
      const result = await actions.cancelMerchantGroupBuyActivity(groupBuyActivityId, cancelReason.trim());
      const failedCount = result.failedOrderIds?.length ?? 0;
      setCancelAction(failedCount > 0
        ? {
            activityId: groupBuyActivityId,
            busy: false,
            type: "error",
            text: `團購已取消，但有 ${failedCount} 筆訂單的付款處理失敗，請人工確認後續處理。`
          }
        : { activityId: groupBuyActivityId, busy: false, type: "success", text: "團購已取消。" });
      setCancelFormActivityId(null);
      setCancelReason("");
    } catch (error) {
      setCancelAction({
        activityId: groupBuyActivityId,
        busy: false,
        type: "error",
        text: getCancelErrorMessage(error)
      });
    } finally {
      cancelActionInFlightRef.current = false;
    }
  }

  function confirmLogout() {
    // Alert.alert is a no-op on react-native-web (react-native-web/src/exports/Alert is an
    // empty stub) -- window.confirm is the only way to get a blocking confirm on that platform.
    if (Platform.OS === "web") {
      if (window.confirm("確定要登出嗎？")) logout();
      return;
    }

    Alert.alert(
      "登出",
      "確定要登出嗎？",
      [
        { text: "取消", style: "cancel" },
        { text: "登出", style: "destructive", onPress: logout }
      ]
    );
  }

  const selectedHistoryOrder = orderId
    ? historyOrders.find((order) => order.id === orderId) ?? null
    : null;

  if (selectedHistoryOrder) {
    const orderActivity = appState.groupBuyActivities.find((item) => item.id === selectedHistoryOrder.groupBuyActivityId);
    return (
      <MobileScreen title="訂單明細" onBack={() => navigation.goBack()}>
        <MerchantHistoryOrderDetail order={selectedHistoryOrder} groupBuyActivity={orderActivity} />
      </MobileScreen>
    );
  }

  return (
    <MobileScreen title="">
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.storeAvatar}>
            <Text style={styles.storeAvatarText}>店</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.storeName}>{merchantStore?.name ?? "我的店家"}</Text>
            <Text style={styles.storeSubtitle}>商家首頁</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={confirmLogout}
            style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}
          >
            <Text style={styles.logoutButtonText}>登出</Text>
          </Pressable>
        </View>
        <View style={styles.metricRow}>
          <MetricCard label="進行中活動" value={activeGroupBuyActivities.length} />
          <MetricCard label="待付款" value={pendingPaymentCount} />
          <MetricCard label="已付款" value={paidOrderCount} />
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{tab === "active" ? "進行中的團購" : "歷史訂單"}</Text>
        {tab === "active" ? (
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" onPress={() => navigation.push("merchantRefundRequests")}>
              <Text style={styles.createLink}>退款申請</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => navigation.push("merchantCreate")}>
              <Text style={styles.createLink}>＋ 開團</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.tabRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setTab("active")}
          style={[styles.tabItem, tab === "active" && styles.activeTabItem]}
        >
          <Text style={[styles.tabText, tab === "active" && styles.activeTabText]}>進行中</Text>
        </Pressable>
        <View style={styles.tabDivider} />
        <Pressable
          accessibilityRole="button"
          onPress={() => setTab("history")}
          style={[styles.tabItem, tab === "history" && styles.activeTabItem]}
        >
          <Text style={[styles.tabText, tab === "history" && styles.activeTabText]}>歷史訂單</Text>
        </Pressable>
      </View>

      {syncStatus === "loading" ? <Text style={styles.syncText}>正在更新後端訂單…</Text> : null}
      {syncStatus === "error" ? (
        <View style={styles.syncError}>
          <Text style={styles.errorText}>訂單同步失敗，目前顯示上次成功載入的資料。</Text>
          <PrimaryButton label="重新整理" variant="secondary" onPress={refreshOrders} />
        </View>
      ) : null}
      <ActivitySyncNotice
        status={activitySyncStatus}
        onRetry={() => actions.syncGroupBuyActivities().catch(() => {})}
      />

      {tab === "active" ? (
        <>
          <Section title="取餐核銷">
            <TextInput
              accessibilityLabel="六位取餐碼"
              autoCorrect={false}
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={handlePickupCodeChange}
              onSubmitEditing={handlePickupLookup}
              placeholder="六位取餐碼"
              placeholderTextColor={colors.textSecondary}
              returnKeyType="done"
              style={styles.pickupInput}
              value={pickupCode}
            />
            <PrimaryButton
              disabled={pickupCode.length !== 6 || pickupBusy}
              label={pickupBusy ? "查詢中" : "查詢訂單"}
              onPress={handlePickupLookup}
            />
            {pickupNotice ? (
              <Text style={pickupNotice.type === "error" ? styles.errorText : styles.successText}>
                {pickupNotice.text}
              </Text>
            ) : null}
            {pickupLookup ? (
              <View style={styles.pickupLookupCard}>
                <Text style={styles.lookupTitle}>{pickupLookup.customerDisplayName || "顧客訂單"}</Text>
                <Text style={styles.lookupMeta}>{pickupLookup.activity.title}</Text>
                <Text style={styles.lookupMeta}>
                  {pickupLookup.totalCups} 杯 · {formatCurrency(pickupLookup.finalAmount)}
                </Text>
                {(pickupLookup.items ?? []).length > 0 ? (
                  <View style={styles.pickupLookupItems}>
                    {pickupLookup.items.map(toLocalOrderItem).map((item, index) => (
                      <View key={item.id ?? index} style={styles.pickupLookupItemRow}>
                        <Text style={styles.pickupLookupItemName}>{item.itemName} x{item.quantity}</Text>
                        <Text style={styles.pickupLookupItemMeta}>
                          {formatOrderItemCustomizations(item, { separator: "、" }) || "無客製化"}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <PrimaryButton
                  disabled={pickupBusy || pickupLookup.status !== "active"}
                  label={pickupBusy
                    ? "處理中"
                    : pickupLookup.status === "redeemed"
                      ? "已取餐"
                      : pickupLookup.status === "expired" ? "取餐碼已過期" : "確認已取餐"}
                  onPress={handlePickupRedeem}
                />
              </View>
            ) : null}
          </Section>
          <Section title="活動清單">
        {activeGroupBuyActivities.length === 0 ? (
          <Text style={styles.emptyText}>目前沒有進行中的團購。點右上「＋ 開團」建立測試活動。</Text>
        ) : null}
        {activeGroupBuyActivities.map((groupBuyActivity) => {
          const store = getStoreById(appState.stores ?? [], groupBuyActivity.storeId);
          const relatedOrders = appState.orders.filter((order) => (
            order.groupBuyActivityId === groupBuyActivity.id
            && order.status !== "cancelled"
          ));
          const pendingPaymentOrders = relatedOrders.filter((order) => ["pending", "failed"].includes(order.paymentStatus)).length;
          const paidOrders = relatedOrders.filter((order) => ["authorized", "captured"].includes(order.paymentStatus)).length;
          const capturedOrders = relatedOrders.filter((order) => order.paymentStatus === "captured").length;
          const readyPickups = relatedOrders.filter((order) => order.pickupStatus === "ready").length;
          const manufacturableOrderList = relatedOrders.filter((order) => (
            order.paymentStatus === "captured"
            && order.pickupStatus === "not_ready"
          ));
          const manufacturableOrders = manufacturableOrderList.length;

          return (
            <View key={groupBuyActivity.id} style={styles.card}>
              <View style={styles.header}>
                <View style={styles.flex}>
                  <Text style={styles.title}>{groupBuyActivity.title}</Text>
                  <Text style={styles.meta}>{store?.name}</Text>
                </View>
                <StatusBadge value={groupBuyActivity.status} />
              </View>
              <PearlTray
                currentCups={groupBuyActivity.currentCups}
                targetCups={groupBuyActivity.targetCups}
                participantCount={groupBuyActivity.participantCount}
                remainingTimeText={groupBuyActivity.remainingTimeText}
              />
              <DiscountSummaryCard compact groupBuyActivity={groupBuyActivity} />
              <View style={styles.summaryRow}>
                <Text style={styles.summary}>訂單 {relatedOrders.length} 筆</Text>
                <Text style={styles.summary}>已付款 {paidOrders} 筆</Text>
              </View>
              <Text style={styles.summary}>已請款 {capturedOrders} 筆 · 可取貨：{readyPickups} 筆</Text>
              {pendingPaymentOrders > 0 ? (
                <Text style={styles.warningText}>待付款 {pendingPaymentOrders} 筆，不列入製作清單。</Text>
              ) : null}
              {manufacturableOrderList.length > 0 ? (
                <View style={styles.productionList}>
                  <View style={styles.productionListHeader}>
                    <Text style={styles.productionListTitle}>待製作明細</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => navigation.push("merchantProductionList", { groupBuyActivityId: groupBuyActivity.id })}
                    >
                      <Text style={styles.productionListLink}>總製作清單 ＞</Text>
                    </Pressable>
                  </View>
                  {manufacturableOrderList.map((order) => {
                    const expanded = Boolean(expandedOrderIds[order.id]);
                    const items = order.items || [];
                    const totalCups = items.reduce((sum, item) => sum + item.quantity, 0);
                    return (
                      <View key={order.id} style={styles.productionOrderRow}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${order.customerDisplayName || order.customerId || "顧客"}的飲品明細`}
                          accessibilityState={{ expanded }}
                          style={styles.productionOrderHeader}
                          onPress={() => setExpandedOrderIds((current) => ({
                            ...current, [order.id]: !current[order.id]
                          }))}
                        >
                          <View style={styles.flex}>
                            <Text style={styles.productionCustomer}>{order.customerDisplayName || order.customerId || "顧客"}</Text>
                            <Text style={styles.productionItems}>{items.length} 項飲品 · 共 {totalCups} 杯</Text>
                          </View>
                          <Text style={styles.productionListLink}>{expanded ? "收合 ∧" : "展開 ∨"}</Text>
                        </Pressable>
                        {expanded ? (
                          <View style={styles.productionOrderDetails}>
                            {items.map((item, index) => (
                              <View key={item.id ?? `${order.id}-${index}`} style={styles.productionDrinkRow}>
                                <View style={styles.flex}>
                                  <Text style={styles.productionCustomer}>{item.itemName}</Text>
                                  <Text style={styles.productionItems}>
                                    {formatOrderItemCustomizations(item, { separator: "、" }) || "無客製化"}
                                  </Text>
                                </View>
                                <Text style={styles.productionCustomer}>×{item.quantity}</Text>
                              </View>
                            ))}
                            <PrimaryButton
                              disabled={Boolean(readyAction?.busy && readyAction.activityId === groupBuyActivity.id)}
                              label={readyAction?.busy && readyAction.activityId === groupBuyActivity.id && readyAction.orderId === order.id
                                ? "處理中"
                                : "標記可取餐"}
                              onPress={() => handleMarkReady(groupBuyActivity.id, order.id)}
                            />
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}
              {manufacturableOrders > 0 ? (
                <PrimaryButton
                  disabled={Boolean(readyAction?.busy && readyAction.activityId === groupBuyActivity.id)}
                  label={readyAction?.busy && readyAction.activityId === groupBuyActivity.id && readyAction.orderId == null
                    ? "處理中"
                    : `全部標記可取餐（${manufacturableOrders} 筆）`}
                  onPress={(event) => {
                    event.stopPropagation?.();
                    handleMarkReady(groupBuyActivity.id);
                  }}
                />
              ) : readyPickups > 0 ? (
                <Text style={styles.readyText}>已有 {readyPickups} 筆訂單完成，可顯示取貨碼</Text>
              ) : (
                <Text style={styles.settledText}>目前沒有待製作訂單</Text>
              )}
              {readyAction?.activityId === groupBuyActivity.id && readyAction.text ? (
                <Text style={readyAction.type === "error" ? styles.errorText : styles.successText}>
                  {readyAction.text}
                </Text>
              ) : null}
              {groupBuyActivity.status === "recruiting" ? (
                cancelFormActivityId === groupBuyActivity.id ? (
                  <View style={styles.cancelForm}>
                    <Text style={styles.fieldLabel}>取消原因</Text>
                    <TextInput
                      accessibilityLabel="取消原因"
                      multiline
                      onChangeText={setCancelReason}
                      placeholder="例如：食材短缺、店家臨時公休"
                      placeholderTextColor={colors.textSecondary}
                      style={styles.cancelReasonInput}
                      value={cancelReason}
                    />
                    <View style={styles.cancelFormActions}>
                      <PrimaryButton
                        disabled={cancelAction?.busy}
                        label="返回"
                        onPress={cancelCancelForm}
                        style={styles.cancelFormActionButton}
                        variant="secondary"
                      />
                      <PrimaryButton
                        disabled={cancelAction?.busy}
                        label={cancelAction?.busy ? "取消中…" : "確認取消團購"}
                        onPress={() => handleCancelActivity(groupBuyActivity.id)}
                        style={styles.cancelFormActionButton}
                      />
                    </View>
                  </View>
                ) : (
                  <PrimaryButton
                    disabled={isWithdrawalLocked(groupBuyActivity)}
                    label={isWithdrawalLocked(groupBuyActivity) ? "已進入截止前 30 分鐘，無法取消" : "取消團購"}
                    onPress={() => beginCancel(groupBuyActivity.id)}
                    variant="secondary"
                  />
                )
              ) : null}
              {cancelAction?.activityId === groupBuyActivity.id && cancelAction.text ? (
                <Text style={cancelAction.type === "error" ? styles.errorText : styles.successText}>
                  {cancelAction.text}
                </Text>
              ) : null}
            </View>
          );
        })}
        </Section>
        </>
      ) : (
        <Section title={`歷史訂單 ${historyOrders.length} 筆`}>
          {historyOrders.length === 0 ? (
            <Text style={styles.emptyText}>目前沒有歷史訂單。店家完成訂單、顧客取貨、取消或流團後會顯示在這裡。</Text>
          ) : null}
          {historyOrders.map((order) => {
            const groupBuyActivity = appState.groupBuyActivities.find((item) => item.id === order.groupBuyActivityId);
            const total = order.captureAmount ?? order.finalAmount ?? order.subtotal ?? order.originalAmount ?? 0;

            return (
              <Pressable
                key={order.id}
                accessibilityRole="button"
                onPress={() => navigation.push("merchantDashboard", { orderId: order.id })}
                style={({ pressed }) => [styles.historyCard, pressed && styles.pressed]}
              >
                <View style={styles.header}>
                  <View style={styles.flex}>
                    <Text style={styles.title}>{groupBuyActivity?.title ?? "團購活動"}</Text>
                    <Text style={styles.meta}>顧客：{order.customerDisplayName || order.customerId || "顧客"} · {order.quantity ?? 0} 杯</Text>
                  </View>
                  <Text style={styles.historyAmount}>{formatCurrency(total)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <StatusBadge owner="merchantPayment" value={order.paymentStatus} />
                  <StatusBadge owner="pickup" value={order.pickupStatus} />
                </View>
                <Text style={styles.summary}>訂單狀態：{getOrderStatusLabel(order.status)}</Text>
                <Text style={styles.openHint}>點擊查看明細 ＞</Text>
              </Pressable>
            );
          })}
        </Section>
      )}
    </MobileScreen>
  );
}

function getPickupErrorMessage(error) {
  const errorCode = error?.payload?.error;
  const messages = {
    activity_not_found: "找不到這筆團購活動。",
    activity_access_denied: "你沒有管理這筆團購的權限。",
    activity_not_readyable: "目前活動狀態不能標記為可取餐。",
    no_captured_orders: "目前沒有已扣款且可製作的訂單。",
    pickup_window_expired: "這筆團購的取餐期限已結束。",
    pickup_code_invalid: "請輸入六位取餐碼。",
    credential_not_found: "找不到有效的取餐碼。",
    credential_already_redeemed: "這組取餐碼已經使用過。",
    credential_expired: "這組取餐碼已經過期。",
    order_not_ready_for_pickup: "這筆訂單目前尚不可取餐。",
    operation_locked: "系統正在處理這筆團購，請等幾秒再試一次。",
    activity_already_changed: "這筆團購的狀態剛剛已經變更，請下拉重新整理後再確認。",
    credential_already_changed: "這組取餐碼剛剛已經被處理過，請重新整理後再確認。"
  };
  // An unknown code is shown so a screenshot is enough to tell which failure it was.
  if (!messages[errorCode] && errorCode) return `取餐操作失敗，請稍後再試。（代碼：${errorCode}）`;
  return messages[errorCode] || "取餐操作失敗，請稍後再試。";
}

function getCancelErrorMessage(error) {
  const errorCode = error?.payload?.error;
  const messages = {
    activity_not_found: "找不到這筆團購活動。",
    store_access_denied: "沒有權限取消此團購。",
    activity_locked_by_deadline: "已進入截止前 30 分鐘，無法取消。",
    activity_not_cancellable: "此團購目前狀態無法取消。"
  };
  return messages[errorCode] || "取消團購失敗，請稍後再試。";
}

function MerchantHistoryOrderDetail({ order, groupBuyActivity }) {
  const styles = useThemedStyles(makeStyles);
  const items = order.items || [];
  const finalAmount = order.captureAmount ?? order.finalAmount ?? order.originalAmount ?? 0;
  const discount = Math.max(0, (order.originalAmount ?? 0) - finalAmount);

  return (
    <>
      <Section title="訂單資訊">
        <DetailRow label="團購活動" value={groupBuyActivity?.title ?? "團購活動"} />
        <DetailRow label="顧客" value={order.customerDisplayName || order.customerId || "顧客"} />
        <DetailRow label="訂單編號" value={order.id} valueStyle={styles.monoValue} />
        <DetailRow label="送出時間" value={order.submittedAt ? formatDeadlineLabel(order.submittedAt) : "-"} />
        <View style={styles.summaryRow}>
          <StatusBadge owner="merchantPayment" value={order.paymentStatus} />
          <StatusBadge owner="pickup" value={order.pickupStatus} />
        </View>
      </Section>

      <Section title="飲品明細">
        {items.length === 0 ? (
          <Text style={styles.emptyText}>沒有品項資料。</Text>
        ) : (
          items.map((item, index) => (
            <View key={item.id ?? index} style={styles.detailItemRow}>
              <View style={styles.flex}>
                <Text style={styles.productionCustomer}>{item.itemName} ×{item.quantity}</Text>
                <Text style={styles.productionItems}>
                  {formatOrderItemCustomizations(item, { separator: "、" }) || "無客製化"}
                </Text>
              </View>
              <Text style={styles.summary}>{formatCurrency(item.subtotal)}</Text>
            </View>
          ))
        )}
      </Section>

      <Section title="對帳金額">
        <DetailRow label="原價" value={formatCurrency(order.originalAmount ?? 0)} />
        {discount > 0 ? <DetailRow label="優惠折抵" value={`-${formatCurrency(discount)}`} /> : null}
        <DetailRow label="實收金額" value={formatCurrency(finalAmount)} valueStyle={styles.historyAmount} />
      </Section>
    </>
  );
}

function DetailRow({ label, value, valueStyle }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueStyle]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function getOrderStatusLabel(status) {
  const labels = {
    draft: "草稿",
    submitted: "已送出",
    locked: "已鎖定",
    readyForPickup: "可取貨",
    completed: "已完成",
    cancelled: "已取消"
  };
  return labels[status] ?? status;
}

const makeStyles = (colors, tones) => StyleSheet.create({
  hero: {
    gap: 14
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  storeAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.lineDecor,
    backgroundColor: colors.recess
  },
  storeAvatarText: {
    color: colors.accentInk,
    fontSize: 20,
    fontWeight: "900"
  },
  storeName: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "900"
  },
  storeSubtitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 3
  },
  metricRow: {
    flexDirection: "row",
    gap: 8
  },
  metricCard: {
    flex: 1,
    gap: 3,
    borderRadius: 13,
    backgroundColor: colors.recess,
    padding: 9
  },
  metricValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  metricLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800"
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "900"
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14
  },
  createLink: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "900"
  },
  logoutButton: {
    minHeight: 32,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    backgroundColor: tones.danger.bg
  },
  logoutButtonText: {
    color: tones.danger.fg,
    fontSize: 13,
    fontWeight: "900"
  },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 15,
    backgroundColor: "transparent"
  },
  tabItem: {
    flex: 1,
    minHeight: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center"
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center"
  },
  tabDivider: {
    width: 1,
    height: 24,
    backgroundColor: colors.lineRow
  },
  activeTabItem: {
    backgroundColor: colors.recess
  },
  activeTabText: {
    color: colors.accentInk
  },
  pickupInput: {
    width: "100%",
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: 8,
    backgroundColor: colors.page,
    color: colors.text,
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 0,
    paddingHorizontal: 12,
    textAlign: "center"
  },
  pickupLookupCard: {
    gap: 7,
    borderWidth: 1,
    borderColor: colors.lineRow,
    borderRadius: 8,
    backgroundColor: colors.recess,
    padding: 12
  },
  lookupTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900"
  },
  lookupMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18
  },
  pickupLookupItems: {
    gap: 6,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: colors.lineRow,
    paddingTop: 8
  },
  pickupLookupItemRow: {
    gap: 2
  },
  pickupLookupItemName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800"
  },
  pickupLookupItemMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700"
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
  card: {
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.page,
    padding: 12
  },
  pressed: {
    opacity: 0.8
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10
  },
  flex: {
    flex: 1
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900"
  },
  meta: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 3
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10
  },
  summary: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800"
  },
  settledText: {
    color: tones.success.fg,
    fontSize: 12,
    fontWeight: "900"
  },
  warningText: {
    color: tones.warning.fg,
    fontSize: 12,
    fontWeight: "900"
  },
  readyText: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "900"
  },
  productionList: {
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.recess,
    padding: 10
  },
  productionListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  productionListTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "900"
  },
  productionListLink: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "900"
  },
  productionOrderRow: {
    borderWidth: 1,
    borderColor: colors.lineRow,
    borderRadius: 12,
    backgroundColor: colors.page,
    overflow: "hidden"
  },
  productionOrderHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    minHeight: 56
  },
  productionOrderDetails: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 10
  },
  productionDrinkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.lineRow
  },
  productionCustomer: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800"
  },
  productionItems: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19
  },
  syncText: {
    color: colors.textSecondary,
    fontSize: 12,
    paddingHorizontal: 16
  },
  syncError: {
    gap: 8,
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tones.danger.bg,
    backgroundColor: tones.danger.bg,
    padding: 12
  },
  historyCard: {
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.lineRow,
    backgroundColor: colors.recess,
    padding: 12
  },
  historyAmount: {
    color: colors.accentInk,
    fontSize: 18,
    fontWeight: "900"
  },
  openHint: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "right"
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  detailLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700"
  },
  detailValue: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: "900",
    textAlign: "right"
  },
  monoValue: {
    fontSize: 11
  },
  detailItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow
  },
  cancelForm: {
    gap: 8
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800"
  },
  cancelReasonInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: 10,
    backgroundColor: colors.page,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    textAlignVertical: "top"
  },
  cancelFormActions: {
    flexDirection: "row",
    gap: 8
  },
  cancelFormActionButton: {
    flex: 1
  }
});

function MetricCard({ label, value }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}
