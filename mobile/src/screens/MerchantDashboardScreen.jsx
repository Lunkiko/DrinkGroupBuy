import { useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { OrderDetailIcon } from "../components/OrderDetailIcon";
import { MerchantPickupLookup } from "../components/MerchantPickupLookup";
import { MobileScreen, Section } from "../components/MobileScreen";
import { DiscountSummaryCard } from "../components/DiscountSummaryCard";
import { PrimaryButton } from "../components/PrimaryButton";
import { PearlTray } from "../components/PearlTray";
import { StatusBadge } from "../components/StatusBadge";
import { useAppState } from "../state/AppStateContext";
import { formatOrderItemCustomizations } from "../utils/orderItems";
import { useOrderListSync } from "../hooks/useOrderListSync";
import { formatCurrency, getStoreById, isWithdrawalLocked } from "../utils/calculations";
import { formatDeadlineLabel } from "../utils/deadlineTime";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function MerchantDashboardScreen({ navigation, route, appState, actions, selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { logout } = useAppState();
  const [readyAction, setReadyAction] = useState(null);
  const [expandedOrderIds, setExpandedOrderIds] = useState({});
  const [expandedActivityIds, setExpandedActivityIds] = useState({});
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
    return merchantGroupBuyActivityIds.has(order.groupBuyActivityId) && (
      ["cancelled", "failed", "completed"].includes(groupBuyActivity?.status)
      || order.status === "cancelled"
      || order.pickupStatus === "expired"
    );
  });
  const pendingPaymentCount = activeOrders.filter((order) => ["pending", "failed"].includes(order.paymentStatus)).length;
  const paidOrderCount = activeOrders.filter((order) => ["authorized", "captured"].includes(order.paymentStatus)).length;

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
    setExpandedActivityIds((current) => ({ ...current, [groupBuyActivityId]: true }));
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
            <MerchantPickupLookup actions={actions} />
          </Section>
          <Section title="活動清單">
        {activeGroupBuyActivities.length === 0 ? (
          <View style={styles.activityEmpty}>
            <View style={styles.activityEmptyIcon}><OrderDetailIcon name="store" size={36} /></View>
            <Text style={styles.activityEmptyTitle}>目前沒有進行中的團購</Text>
            <Text style={styles.activityEmptyDescription}>建立團購活動，讓附近顧客一起享優惠。</Text>
          </View>
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
          const expanded = Boolean(expandedActivityIds[groupBuyActivity.id]);

          return (
            <View key={groupBuyActivity.id} style={styles.card}>
              <MerchantActivitySummary
                activity={groupBuyActivity}
                storeName={store?.name}
                orders={relatedOrders}
                manufacturableOrders={manufacturableOrderList}
                readyPickups={readyPickups}
                canCancel={groupBuyActivity.status === "recruiting" && !isWithdrawalLocked(groupBuyActivity)}
                onCancel={() => beginCancel(groupBuyActivity.id)}
                onOpen={() => navigation.push("merchantProductionList", { groupBuyActivityId: groupBuyActivity.id })}
                expanded={expanded}
              />
              {expanded ? <View style={styles.expandedActivity}>
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
                      <Text style={styles.productionListLink}>活動訂單 ＞</Text>
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
              {groupBuyActivity.status === "recruiting" && cancelFormActivityId === groupBuyActivity.id ? (
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
              ) : null}
              {cancelAction?.activityId === groupBuyActivity.id && cancelAction.text ? (
                <Text style={cancelAction.type === "error" ? styles.errorText : styles.successText}>
                  {cancelAction.text}
                </Text>
              ) : null}
              </View> : null}
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
            const cups = order.quantity ?? (order.items ?? []).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);

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
                    <Text style={styles.meta}>顧客：{order.customerDisplayName || order.customerId || "顧客"} · 共 {cups} 杯</Text>
                  </View>
                  <Text style={styles.historyAmount}>{formatCurrency(total)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <StatusBadge owner="merchantPayment" value={order.paymentStatus} />
                  <StatusBadge owner="pickup" value={order.pickupStatus} />
                </View>
                <Text style={styles.openHint}>查看訂單詳情 ›</Text>
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

export function MerchantActivitySummary({ activity, storeName, orders, manufacturableOrders, readyPickups, canCancel, onCancel, onOpen, expanded }) {
  const styles = useThemedStyles(makeStyles);
  const recruiting = activity.status === "recruiting";
  const confirmed = activity.status === "confirmed";
  const cups = Number(activity.settlement?.authorizedCups ?? activity.currentCups ?? 0);
  const target = Number(activity.targetCups ?? activity.tiers?.[0]?.targetCups ?? 0);
  const progress = target > 0 ? Math.max(0, Math.min(100, Math.round(cups / target * 100))) : 0;
  const orderAmount = orders.reduce((sum, order) => sum + Number(order.captureAmount ?? order.finalAmount ?? order.originalAmount ?? order.subtotal ?? 0), 0);
  const waitingCups = manufacturableOrders.reduce((sum, order) => sum + Number(order.quantity ?? 0), 0);
  const actionLabel = "查看活動訂單";

  return (
    <View style={styles.activitySummary}>
      <View style={styles.activityTopRow}>
        <Text numberOfLines={1} style={styles.activityStoreName}>{storeName || "店家資料"}</Text>
        {recruiting ? <View style={styles.activityRemaining}><OrderDetailIcon name="clock" size={18} /><Text numberOfLines={1} style={styles.activityMinor}>{activity.remainingTimeText || "招募中"}</Text></View>
          : confirmed ? <Text style={styles.activityMinor}>已截止</Text> : null}
      </View>
      <View style={styles.activityNameRow}>
        <Text numberOfLines={1} style={styles.activityName}>{activity.title}</Text>
        <StatusBadge value={activity.status} />
      </View>
      {recruiting ? <>
        <Text style={styles.activityCupCount}>{cups} / {target || "—"} 杯</Text>
        <View style={styles.activityProgressTrack}><View style={[styles.activityProgressFill, { width: `${progress}%` }]} /></View>
      </> : <View style={styles.activityStatRow}>
        <Text style={styles.activityStatLabel}>最終團購杯數</Text>
        <Text style={styles.activityStatValue}>{cups} 杯</Text>
      </View>}
      <View style={styles.activityMetricRow}>
        <View style={styles.activityMetric}><OrderDetailIcon name="people" size={19} /><Text numberOfLines={1} style={styles.activityMetricText}><Text style={styles.activityMetricValue}>{activity.participantCount ?? 0}</Text> 人參與</Text></View>
        <View style={[styles.activityMetric, styles.activityMetricRight]}><OrderDetailIcon name="receipt" size={19} /><Text numberOfLines={1} style={styles.activityMetricText}>訂單總金額 <Text style={styles.activityMetricValue}>{formatCurrency(orderAmount)}</Text></Text></View>
      </View>
      {(recruiting || confirmed) ? <View style={styles.activityTimeRow}>
        <View style={styles.activityTimeCell}><OrderDetailIcon name="calendar" size={18} /><Text numberOfLines={1} style={styles.activityTimeText}>截止：{formatMerchantShortTime(activity.deadlineAt)}</Text></View>
        <View style={styles.activityTimeCell}><OrderDetailIcon name="clock" size={18} /><Text numberOfLines={1} style={styles.activityTimeText}>取餐：{formatMerchantPickupTime(activity)}</Text></View>
      </View> : <View style={styles.activityPickupRow}><OrderDetailIcon name="clock" size={18} /><Text numberOfLines={1} style={styles.activityTimeText}>取餐：{formatMerchantPickupTime(activity)}</Text></View>}
      {!recruiting ? <View style={styles.activityProductionRow}><OrderDetailIcon name="receipt" size={18} /><Text numberOfLines={1} style={styles.activityProductionText}>待製作 {manufacturableOrders.length} 筆 · 共 {waitingCups} 杯{readyPickups > 0 ? ` · 可取餐 ${readyPickups} 筆` : ""}</Text></View> : null}
      <View style={styles.activityFooter}>
        {(recruiting || confirmed) ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canCancel }} disabled={!canCancel} onPress={onCancel} style={[styles.activityCancel, !canCancel && styles.activityCancelDisabled]}><Text style={[styles.activityCancelText, !canCancel && styles.activityCancelTextDisabled]}>取消團購</Text></Pressable> : <View />}
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.activityOpen}><Text numberOfLines={1} style={styles.activityOpenText}>{actionLabel} ›</Text></Pressable>
      </View>
    </View>
  );
}

function formatMerchantShortTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value ? String(value) : "時間待確認";
  const two = (number) => String(number).padStart(2, "0");
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function formatMerchantPickupTime(activity) {
  const start = activity.pickupStartAt;
  const end = activity.pickupEndAt;
  if (!start || !end) return activity.pickupTime || "時間待確認";
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return activity.pickupTime || "時間待確認";
  const two = (number) => String(number).padStart(2, "0");
  const sameDay = startDate.getFullYear() === endDate.getFullYear()
    && startDate.getMonth() === endDate.getMonth()
    && startDate.getDate() === endDate.getDate();
  return `${formatMerchantShortTime(start)}–${sameDay ? `${two(endDate.getHours())}:${two(endDate.getMinutes())}` : formatMerchantShortTime(end)}`;
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
    fontWeight: "700"
  },
  storeName: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "700"
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
    fontWeight: "700"
  },
  metricLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700"
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700"
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14
  },
  createLink: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "700"
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
    fontWeight: "700"
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
    fontWeight: "700",
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
    fontWeight: "700",
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
    fontWeight: "700"
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
    fontWeight: "700"
  },
  pickupLookupItemMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700"
  },
  errorText: {
    color: tones.danger.fg,
    fontSize: 12,
    fontWeight: "700"
  },
  successText: {
    color: tones.success.fg,
    fontSize: 12,
    fontWeight: "700"
  },
  card: {
    gap: spacing.s12,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page,
    padding: spacing.s12
  },
  activityEmpty: { minHeight: 185, borderWidth: sizes.stroke, borderColor: colors.lineDecor, borderRadius: radii.md, alignItems: "center", justifyContent: "center", gap: spacing.s8, padding: spacing.s20 },
  activityEmptyIcon: { width: 66, height: 66, borderRadius: radii.pill, backgroundColor: colors.recess, alignItems: "center", justifyContent: "center" },
  activityEmptyTitle: { ...typeScale.sectionTitle, color: colors.text, textAlign: "center" },
  activityEmptyDescription: { ...typeScale.bodyDense, color: colors.textSecondary, textAlign: "center" },
  activitySummary: { gap: spacing.s8 },
  activityTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8 },
  activityStoreName: { ...typeScale.bodyDense, color: colors.textSecondary, flex: 1 },
  activityRemaining: { flexDirection: "row", alignItems: "center", gap: spacing.s4, flexShrink: 0 },
  activityMinor: { ...typeScale.bodyDense, color: colors.textSecondary },
  activityNameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8 },
  activityName: { ...typeScale.sectionTitle, color: colors.text, flex: 1, minWidth: 0 },
  activityCupCount: { ...typeScale.price, color: colors.text },
  activityProgressTrack: { height: 10, backgroundColor: colors.progressTrack, borderRadius: radii.pill, overflow: "hidden" },
  activityProgressFill: { height: 10, backgroundColor: colors.progress, borderRadius: radii.pill },
  activityStatRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s12 },
  activityStatLabel: { ...typeScale.bodyDense, color: colors.textSecondary },
  activityStatValue: { ...typeScale.sectionTitle, color: colors.text },
  activityMetricRow: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s8 },
  activityMetric: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.s4 },
  activityMetricRight: { flex: 1.55, borderLeftWidth: 1, borderLeftColor: colors.lineRow, paddingLeft: spacing.s12 },
  activityMetricText: { ...typeScale.bodyDense, color: colors.textSecondary, flexShrink: 1 },
  activityMetricValue: { color: colors.text, fontWeight: "700" },
  activityTimeRow: { gap: spacing.s8, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s8 },
  activityTimeCell: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.s8 },
  activityTimeText: { ...typeScale.bodyDense, color: colors.textSecondary, flexShrink: 1 },
  activityPickupRow: { flexDirection: "row", alignItems: "center", gap: spacing.s4, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s8 },
  activityProductionRow: { flexDirection: "row", alignItems: "center", gap: spacing.s4, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s8 },
  activityProductionText: { ...typeScale.bodyDense, color: colors.textSecondary, flexShrink: 1 },
  activityFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s4 },
  activityCancel: { minHeight: sizes.tap, minWidth: 90, borderWidth: 1, borderColor: tones.danger.fg, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.s8 },
  activityCancelDisabled: { borderColor: colors.lineInput, backgroundColor: colors.recess },
  activityCancelText: { ...typeScale.bodyDense, color: tones.danger.fg, fontWeight: "700" },
  activityCancelTextDisabled: { color: colors.textSecondary },
  activityOpen: { minHeight: sizes.tap, justifyContent: "center", alignItems: "flex-end", flex: 1 },
  activityOpenText: { ...typeScale.bodyDense, color: colors.accentInk, fontWeight: "700" },
  expandedActivity: { gap: spacing.s12, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s12 },
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
    fontWeight: "700"
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
    fontWeight: "700"
  },
  settledText: {
    color: tones.success.fg,
    fontSize: 12,
    fontWeight: "700"
  },
  warningText: {
    color: tones.warning.fg,
    fontSize: 12,
    fontWeight: "700"
  },
  readyText: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "700"
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
    fontWeight: "700"
  },
  productionListLink: {
    color: colors.accentInk,
    fontSize: 12,
    fontWeight: "700"
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
    fontWeight: "700"
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
    gap: 16,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page,
    padding: spacing.s16
  },
  historyAmount: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700"
  },
  openHint: {
    color: colors.accentInk,
    fontSize: 16,
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
    fontWeight: "700",
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
    fontWeight: "700"
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
