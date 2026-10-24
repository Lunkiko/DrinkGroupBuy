import { useEffect, useMemo, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { ChoiceChip } from "../components/ChoiceChip";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { OrderDetailIcon } from "../components/OrderDetailIcon";
import { getOrderStage, OrderJourneyCard, OrderProgressCard, OrderStoreCard } from "../components/OrderDetailVisuals";
import { PickupPass } from "../components/PickupPass";
import { PrimaryButton } from "../components/PrimaryButton";
import { TonePill } from "../components/TonePill";
import { useOrderListSync } from "../hooks/useOrderListSync";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { formatCurrency, isWithdrawalLocked } from "../utils/calculations";
import { getBusinessNow } from "../utils/businessTime";
import { getGroupBuyActivityProgress, getOrderDiscountEstimate } from "../utils/groupBuyActivityProgress";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { getManualRepaymentStateInfo } from "../utils/manualRepayment";
import { formatOrderItemCustomizations, normalizeOrderItem } from "../utils/orderItems";
import { useThemedStyles } from "../theme/ThemeContext";

export function CustomerOrdersScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const [tab, setTab] = useState("active");
  // The order-detail view used to be a local-state toggle (selectedOrderId) invisible to the
  // hardware back button. It's now a real stack entry: this screen's own route is pushed a
  // second time with orderId (and which tab it was opened from, since the pushed instance's own
  // `tab` state defaults to "active" and can't be relied on to know which bucket the order is in).
  const orderId = route.params?.orderId ?? null;
  const historical = route.params?.historical ?? false;
  const { syncStatus, refreshOrders } = useOrderListSync(
    actions.syncCustomerOrderList,
    tab,
    selectedCustomerId
  );
  const customerOrders = appState.orders.filter((order) => order.customerId === selectedCustomerId);
  const cartItems = appState.cartItems.filter((item) => item.customerId === selectedCustomerId);
  const activeOrders = customerOrders.filter((order) => order.lifecycleBucket
    ? order.lifecycleBucket === "active"
    : !isHistoryOrder(order, appState.groupBuyActivities));
  const historyOrders = customerOrders.filter((order) => order.lifecycleBucket
    ? order.lifecycleBucket === "history"
    : isHistoryOrder(order, appState.groupBuyActivities));
  const displayTab = tab;
  const selectedOrder = useMemo(
    () => customerOrders.find((order) => order.id === orderId) ?? null,
    [orderId, customerOrders]
  );
  const cartGroupBuyActivity = cartItems.length > 0
    ? appState.groupBuyActivities.find((groupBuyActivity) => groupBuyActivity.id === cartItems[0].groupBuyActivityId) ?? null
    : null;
  const cartTotalQuantity = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotalAmount = cartItems.reduce((sum, item) => sum + item.subtotal, 0);

  useEffect(() => {
    if (!orderId) return;
    actions.syncOrderFromBackend(orderId).catch(() => {});
  }, [orderId]);

  const hasActivePickupCode = selectedOrder?.pickupCredential?.status === "active";
  // Tabs stay mounted, so the poll must also stop while this tab is in the background.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!orderId || !hasActivePickupCode || !isFocused) return undefined;
    // A customer looking at an active pickup code is typically standing at the counter waiting
    // for the merchant to redeem it on their own device -- nothing else refreshes this screen
    // once it's open (no AppState foreground listener here, unlike PaymentAuthorizationScreen),
    // so without a poll the code and payment badge stay frozen at whatever they were when the
    // screen was first opened, even after the merchant confirms pickup. Capped at 5 minutes so an
    // order left open indefinitely doesn't poll forever; re-entering the order (or the pull-to-
    // refresh already on the list) still works as a fallback after that.
    const deadline = Date.now() + 5 * 60 * 1000;
    const intervalId = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(intervalId);
        return;
      }
      actions.syncOrderFromBackend(orderId).catch(() => {});
    }, 5000);
    return () => clearInterval(intervalId);
  }, [orderId, hasActivePickupCode, isFocused]);

  function handleTabChange(nextTab) {
    setTab(nextTab);
  }

  if (selectedOrder) {
    return (
      <MobileScreen
        title="訂單明細"
        onBack={() => navigation.goBack()}
        backLabel="返回"
        headerRight={<Text numberOfLines={1} style={styles.orderNumber}>訂單編號 {selectedOrder.id}</Text>}
      >
        <OrderDetailCard
          order={selectedOrder}
          groupBuyActivities={appState.groupBuyActivities}
          payments={appState.paymentAuthorizations}
          actions={actions}
          navigation={navigation}
          historical={historical}
        />
      </MobileScreen>
    );
  }

  return (
    <MobileScreen title="我的訂單">
      {syncStatus === "loading" ? <Text style={styles.loadingText}>正在更新後端訂單…</Text> : null}
      {syncStatus === "error" ? (
        <Notice accessibilityRole="alert" message="訂單同步失敗，目前顯示上次成功載入的資料。" tone="danger">
          <PrimaryButton label="重新整理" variant="secondary" onPress={refreshOrders} style={styles.noticeButton} />
        </Notice>
      ) : null}
      {/* Always shown: history orders are only fetched once the history tab is opened, so hiding the
          tabs while the local list is empty made a customer with only past orders unable to reach them. */}
      <OrderTabs tab={displayTab} setTab={handleTabChange} />

      {displayTab === "active" ? (
        <>
          {cartItems.length > 0 ? (
            <CartDraftSection
              cartGroupBuyActivity={cartGroupBuyActivity}
              cartItems={cartItems}
              cartTotalQuantity={cartTotalQuantity}
              cartTotalAmount={cartTotalAmount}
              navigation={navigation}
            />
          ) : null}
          <OrderListSection
            title="訂單列表"
            orders={activeOrders}
            groupBuyActivities={appState.groupBuyActivities}
            payments={appState.paymentAuthorizations}
            emptyText="目前沒有進行中的訂單。加入團購後會顯示在這裡。"
            onSelectOrder={(id) => navigation.push("customerOrders", { orderId: id, historical: false })}
          />
          {activeOrders.length === 0 && cartItems.length === 0 ? (
            <View style={styles.emptyActions}>
              {historyOrders.length > 0 ? (
                <PrimaryButton label="查看歷史訂單" variant="secondary" onPress={() => handleTabChange("history")} />
              ) : null}
              {/* Cross-tab: liveMap lives in a different tab's own stack. */}
              <PrimaryButton label="去逛逛" onPress={() => navigation.navigate("CustomerTabs", { screen: "LiveMapTab" })} />
            </View>
          ) : null}
        </>
      ) : (
        <OrderListSection
          title="歷史訂單"
          orders={historyOrders}
          groupBuyActivities={appState.groupBuyActivities}
          payments={appState.paymentAuthorizations}
          emptyText="目前沒有歷史訂單。管理員刪除團購、流團、完成或取消的訂單會顯示在這裡。"
          onSelectOrder={(id) => navigation.push("customerOrders", { orderId: id, historical: true })}
          historical
        />
      )}
    </MobileScreen>
  );
}

function OrderListSection({ title, orders, groupBuyActivities, payments, emptyText, onSelectOrder, historical = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Section title={title} headerRight={historical ? <Text style={styles.historyCount}>共 {orders.length} 筆</Text> : null}>
      {orders.length === 0 ? (
        <EmptyPanel>{emptyText}</EmptyPanel>
      ) : (
        <View style={styles.orderList}>
          {orders.map((order) => (
            <OrderListCard
              key={order.id}
              order={order}
              groupBuyActivities={groupBuyActivities}
              payments={payments}
              historical={historical}
              onPress={() => onSelectOrder(order.id)}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

function OrderListCard({ order, groupBuyActivities, payments, historical, onPress }) {
  const styles = useThemedStyles(makeStyles);
  const groupBuyActivity = groupBuyActivities.find((item) => item.id === order.groupBuyActivityId) ?? null;
  const store = order.backendStore
    ?? getGroupBuyActivityStore(groupBuyActivity);
  const payment = payments.find((item) => item.orderId === order.id);
  const orderItems = (order.items ?? []).map(normalizeOrderItem);
  const total = payment?.captureAmount ?? getOrderSubtotal(order);
  const progress = groupBuyActivity ? getGroupBuyActivityProgress(groupBuyActivity) : null;
  const progressText = progress ? `${progress.currentCups} / ${progress.nextTarget} 杯` : "團購資料已不存在";

  if (historical) {
    const historyStatus = getHistoryCardStatus(order, groupBuyActivity);
    const historyAmount = payment?.captureAmount ?? order.finalAmount ?? getOrderSubtotal(order);
    return (
      <Card onPress={onPress} style={styles.historyCard}>
        <View style={styles.historyTop}>
          <Text style={styles.historyTitle}>{groupBuyActivity?.title ?? "團購活動"}</Text>
          {historyStatus.label === "已完成" ? (
            <View style={styles.historyCompletedBadge}>
              <View style={styles.historyCheckCircle}><Text style={styles.historyCheck}>✓</Text></View>
              <Text style={styles.historyCompletedText}>已完成</Text>
            </View>
          ) : <TonePill tone={historyStatus.tone} label={historyStatus.label} />}
        </View>
        <Text style={styles.historyStore}>{store?.name ?? "店家資料未提供"}</Text>
        <Text style={styles.historyDescription}>{historyStatus.description}</Text>
        <View style={styles.historyDivider} />
        <View style={styles.historyItemsRow}>
          <View style={styles.historyItems}>
            {orderItems.slice(0, 2).map((item) => (
              <Text key={item.id} style={styles.historyItemText}>{item.name} × {item.quantity}</Text>
            ))}
            {orderItems.length > 2 ? <Text style={styles.historyItemText}>另有 {orderItems.length - 2} 項</Text> : null}
            {orderItems.length === 0 ? <Text style={styles.historyItemText}>飲品資料未提供</Text> : null}
          </View>
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.historyAmount}>{formatHistoryAmount(historyAmount)}</Text>
        </View>
        <Text style={styles.historyOpenHint}>查看訂單詳情 ›</Text>
      </Card>
    );
  }

  return (
    <Card onPress={onPress} style={styles.orderListCard}>
      <View style={styles.listTop}>
        <View style={styles.flex}>
          <Text style={styles.storeNameSmall}>{store?.name ?? "店家資料"}</Text>
          <Text style={styles.orderSubtitle}>
            {historical ? getHistoryReason(order, groupBuyActivity) : `團購進度：${progressText}`}
          </Text>
        </View>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.listAmount}>{formatCurrency(total)}</Text>
      </View>
      <View style={styles.orderPreview}>
        {orderItems.slice(0, 2).map((item) => (
          <Text key={item.id} style={styles.previewText}>
            {item.name} x {item.quantity}
          </Text>
        ))}
        {orderItems.length > 2 ? <Text style={styles.previewText}>另有 {orderItems.length - 2} 項</Text> : null}
      </View>
      <Text style={styles.openHint}>點擊查看訂單明細</Text>
    </Card>
  );
}

export function OrderDetailCard({ order, groupBuyActivities, payments, actions, navigation, historical }) {
  const styles = useThemedStyles(makeStyles);
  const [cancelNotice, setCancelNotice] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const groupBuyActivity = groupBuyActivities.find((item) => item.id === order.groupBuyActivityId) ?? null;
  const payment = payments.find((item) => item.orderId === order.id);
  const store = order.backendStore
    ?? getGroupBuyActivityStore(groupBuyActivity);
  const orderItems = (order.items ?? []).map(normalizeOrderItem);
  const displaySubtotal = getOrderSubtotal(order);
  const pickupCode = order.pickupCredential?.status === "active"
    ? order.pickupCredential.pickupCode
    : null;
  const pickupPendingContent = getPickupPendingContent(order);
  const orderLocked = order.status === "locked";
  const withdrawalLocked = !historical && (orderLocked || isWithdrawalLocked(groupBuyActivity));
  const hasBackendActions = Array.isArray(order.availableActions);
  // Editing stays allowed even once the withdrawal lock kicks in -- only decreasing an *authorized*
  // order's total cups is actually rejected (at the createOrderRevision write). Pending orders have
  // no backend-enforced withdrawal lock at all (see CartScreen.jsx), so deletion isn't blocked for
  // them either -- only an authorized order's whole-item delete is unambiguously a decrease.
  const canEdit = hasBackendActions
    ? order.availableActions.includes("edit")
    : !orderLocked && !historical;
  const canDeleteItem = order.paymentStatus === "pending" ? canEdit : (canEdit && !withdrawalLocked);
  const progress = groupBuyActivity ? getGroupBuyActivityProgress(groupBuyActivity) : null;
  const manualRepayment = order.manualRepayment ?? null;
  const showManualRepayment = order.paymentStatus === "failed" && !historical;
  const repaymentState = showManualRepayment ? getManualRepaymentStateInfo(manualRepayment) : null;
  const stage = getOrderStage(order);
  const discountEstimate = groupBuyActivity ? getOrderDiscountEstimate(groupBuyActivity, { originalAmount: displaySubtotal }) : null;
  const paidAmount = payment?.captureAmount ?? order.finalAmount ?? null;
  const discountAmount = paidAmount == null ? discountEstimate?.discountAmount ?? 0 : Math.max(0, displaySubtotal - paidAmount);

  return (
    <View style={styles.orderCard}>
      <OrderJourneyCard order={order} historical={historical} activity={groupBuyActivity} historyReason={getHistoryReason(order, groupBuyActivity)} />
      <OrderStoreCard store={store} onDetailPress={() => navigation.push("groupBuyActivityDetail", { groupBuyActivityId: order.groupBuyActivityId })} />
      {!historical && stage <= 1 ? <OrderProgressCard activity={groupBuyActivity} progress={progress} stage={stage} /> : null}
      {!historical && stage === 2 ? (
        <Card style={styles.pickupCard}>
          <View style={styles.pickupTimeRow}>
            <OrderDetailIcon name="calendar" size={28} />
            <View style={styles.pickupTimeContent}>
              <Text style={styles.pickupTimeLabel}>取餐時間</Text>
              <Text style={styles.pickupTime}>{groupBuyActivity?.pickupTime ?? "時間待確認"}</Text>
            </View>
          </View>
          {pickupCode ? <PickupPass pickupCode={pickupCode} cupCount={order.quantity} showCups={false} /> : <Notice title="正在取得取餐碼" message="請稍候，或重新進入訂單更新取餐資訊。" tone="info" />}
          <Text style={styles.pickupHint}>請於取餐時間內到店出示取餐碼。</Text>
        </Card>
      ) : null}

      <Card style={styles.detailSection}>
        <Text style={styles.detailHeading}>訂單明細</Text>
        {showManualRepayment ? (
          <Notice accessibilityRole="alert" title="扣款失敗" message={repaymentState.statusText} tone="danger">
            <PrimaryButton
              label={repaymentState.disabled ? repaymentState.disabledLabel : "重新付款"}
              disabled={repaymentState.disabled}
              onPress={() => navigation.push("paymentAuthorization", {
                groupBuyActivityId: order.groupBuyActivityId,
                orderId: order.id,
                mode: "manualRepayment"
              })}
            />
          </Notice>
        ) : null}
        <ScrollView
          nestedScrollEnabled
          showsVerticalScrollIndicator
          style={styles.itemScroller}
          contentContainerStyle={styles.itemList}
        >
          {orderItems.map((item) => (
            <Pressable
              accessibilityRole="button"
              key={item.id}
              disabled={!canEdit || historical}
              onPress={() => navigation.push("drinkSelection", {
                // route.params must stay JSON-serializable, so editOrderId (looked up fresh by
                // DrinkSelectionScreen) replaces the onSaveOrderItem closure this used to pass.
                groupBuyActivityId: order.groupBuyActivityId,
                editMode: true,
                editOrderItem: item,
                editOrderId: order.id
              })}
              style={({ pressed }) => [
                styles.detailCard,
                pressed && styles.pressed
              ]}
            >
              <View style={styles.detailTop}>
                <View style={[styles.flex, (!canEdit || historical) && styles.detailTextDimmed]}>
                  <Text style={styles.itemTitle}>{item.name} × {item.quantity}</Text>
                  <View style={styles.chips}>
                    <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.chip}>{formatOrderItemCustomizations(item)}</Text>
                  </View>
                </View>
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.itemPrice}>{formatCurrency(item.subtotal)}</Text>
              </View>
              {canDeleteItem && !historical ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={(event) => {
                    event.stopPropagation?.();
                    const nextItems = orderItems.filter((current) => current.id !== item.id);
                    actions.updateOrderItems(order.id, nextItems);
                  }}
                  style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                >
                  <Text
                    maxFontSizeMultiplier={maxFontSizeMultiplier}
                    style={styles.deleteText}
                  >
                    刪除
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
          ))}
          {orderItems.length === 0 ? <EmptyPanel>目前沒有飲品明細。</EmptyPanel> : null}
        </ScrollView>

        {historical ? (
          <Notice message="歷史訂單不可修改，僅保留查詢紀錄。" tone="neutral" />
        ) : orderLocked ? (
          <Notice message="活動已到結束時間，系統已自動鎖定訂單。" tone="warning" />
        ) : withdrawalLocked ? (
          <Notice
            message={`截止前 ${groupBuyActivity?.withdrawalLockMinutes ?? 30} 分鐘訂單已鎖定，只能增加飲料，不能刪除、減少或退出團購。`}
            tone="warning"
          />
        ) : null}
        {order.revisionError ? (
          <Notice accessibilityRole="alert" message={order.revisionError} tone="danger" />
        ) : null}

        <View style={styles.amountLine}><Text style={styles.totalLabel}>共 {order.quantity} 杯</Text><Text style={styles.amountText}>小計 {formatCurrency(displaySubtotal)}</Text></View>
        <View style={styles.amountLine}><Text style={styles.amountLabel}>{paidAmount == null ? "目前預估折扣" : "折扣金額"}</Text><Text style={styles.amountText}>{formatCurrency(discountAmount)}</Text></View>
        <View style={styles.amountLine}><Text style={styles.amountLabel}>{paidAmount == null ? "目前預估金額" : "已付款金額"}</Text><Text style={styles.amountEmphasis}>{formatCurrency(paidAmount ?? discountEstimate?.finalAmount ?? displaySubtotal)}</Text></View>

        {order.reauthorizationReason === "order_amount_changed"
          && !historical
          && (!hasBackendActions || order.availableActions.includes("pay")) ? (
          <Notice
            message="修改後需重新完成 Line Pay 預授權，訂單才會重新計入團購杯數。"
            title="訂單金額已變動"
            tone="warning"
          >
            <PrimaryButton
              label="重新預授權"
              onPress={() => navigation.push("paymentAuthorization", { groupBuyActivityId: order.groupBuyActivityId, orderId: order.id })}
            />
          </Notice>
        ) : null}
      </Card>

      {historical || stage === 3 ? (
        <PrimaryButton label={historical ? "返回歷史訂單" : "返回首頁"} onPress={() => historical ? navigation.goBack() : navigation.navigate("HomeTab")} />
      ) : (
        <View style={styles.orderActions}>
          {order.paymentStatus === "pending" || order.paymentStatus === "failed" ? (
            <Notice message={pickupPendingContent.text} title={pickupPendingContent.title} tone={pickupPendingContent.tone}>
              {order.paymentStatus === "pending" ? <PrimaryButton label="前往付款" onPress={() => navigation.push("paymentAuthorization", { groupBuyActivityId: order.groupBuyActivityId, orderId: order.id })} /> : null}
            </Notice>
          ) : null}
          <Text style={styles.actionHint}>{canEdit ? `團購截止前 ${groupBuyActivity?.withdrawalLockMinutes ?? 30} 分鐘以前可修改訂單或退出團購。` : "團購已截止，訂單無法修改或退出。"}</Text>
          <View style={styles.actionRow}>
            <PrimaryButton
              label="修改訂單"
              variant="secondary"
              style={styles.actionButton}
              disabled={!canEdit || historical}
              onPress={() => navigation.push("drinkSelection", { groupBuyActivityId: order.groupBuyActivityId, editOrderId: order.id })}
            />
            <PrimaryButton
              label={cancelBusy ? "退出中…" : "退出團購"}
              variant="secondary"
              style={styles.actionButton}
              disabled={cancelBusy || !order.availableActions?.includes("cancel")}
              onPress={async () => {
                setCancelBusy(true);
                setCancelNotice(null);
                try {
                  await actions.cancelOrder(order.id);
                  setCancelNotice({ message: "訂單已取消，付款授權已依狀態處理。", tone: "success" });
                } catch (error) {
                  setCancelNotice({ message: error.message || "取消訂單失敗。", tone: "danger" });
                } finally {
                  setCancelBusy(false);
                }
              }}
            />
          </View>
          {cancelNotice ? <Notice message={cancelNotice.message} tone={cancelNotice.tone} /> : null}
        </View>
      )}
    </View>
  );
}

// `tone` is the Notice colour for each state (docs/ui-style-guide.md): unpaid = warning, failed = danger,
// order placed / being made = info, anything else = neutral.
function getPickupPendingContent(order) {
  if (order.paymentStatus === "pending") {
    return {
      title: "待付款",
      text: "完成 LINE Pay 預授權後，訂單才會成立並計入團購。",
      tone: "warning"
    };
  }
  if (order.paymentStatus === "failed") {
    return {
      title: "扣款失敗",
      text: "重新付款成功前，訂單不會進入製作中。",
      tone: "danger"
    };
  }
  if (order.paymentStatus === "authorized") {
    return {
      title: order.status === "locked" ? "訂單已鎖定" : "訂單已成立",
      text: "團購截止後系統會依結果扣款，扣款成功後進入製作中。",
      tone: "info"
    };
  }
  if (order.paymentStatus === "captured" || order.pickupStatus === "preparing") {
    return {
      title: "店家製作中",
      text: "店家標記可取貨後，取貨憑證才會顯示。",
      tone: "info"
    };
  }
  return {
    title: "尚未可取貨",
    text: "系統會依付款與取貨狀態更新取貨資訊。",
    tone: "neutral"
  };
}

function OrderTabs({ tab, setTab }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityRole="tablist" style={styles.tabRow}>
      <ChoiceChip
        label="訂單列表"
        onPress={() => setTab("active")}
        role="tab"
        selected={tab === "active"}
        style={styles.tab}
      />
      <ChoiceChip
        label="歷史訂單"
        onPress={() => setTab("history")}
        role="tab"
        selected={tab === "history"}
        style={styles.tab}
      />
    </View>
  );
}

function CartDraftSection({ cartGroupBuyActivity, cartItems, cartTotalQuantity, cartTotalAmount, navigation }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Section title={`購物車草稿，共 ${cartTotalQuantity} 杯`}>
      <Card style={styles.cartDraftCard}>
        <View style={styles.cartDraftHeader}>
          <View style={styles.cartDraftText}>
            <Text style={styles.cartDraftTitle}>{cartGroupBuyActivity?.title ?? "尚未選擇團購"}</Text>
            <Text style={styles.meta}>送出購物車後才會建立訂單，並進入 Line Pay 預授權流程。</Text>
          </View>
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cartDraftAmount}>{formatCurrency(cartTotalAmount)}</Text>
        </View>
        <View style={styles.cartDraftList}>
          {cartItems.map((item) => (
            <View key={item.id} style={styles.cartDraftItem}>
              <Text style={styles.cartDraftItemName}>{item.itemName} x {item.quantity}</Text>
              <Text style={styles.cartDraftItemMeta}>
                {formatOrderItemCustomizations(item, { separator: " / ", noToppingsLabel: "不加料" })}
              </Text>
            </View>
          ))}
        </View>
        <PrimaryButton
          label="查看購物車"
          onPress={() => cartGroupBuyActivity && navigation.push("cart", { groupBuyActivityId: cartGroupBuyActivity.id })}
        />
      </Card>
    </Section>
  );
}

function getOrderSubtotal(order) {
  const items = (order.items ?? []).map(normalizeOrderItem);
  if (items.length === 0) return order.subtotal ?? order.originalAmount ?? 0;
  return items.reduce((sum, item) => sum + item.subtotal, 0);
}

function isHistoryOrder(order, groupBuyActivities) {
  const groupBuyActivity = groupBuyActivities.find((item) => item.id === order.groupBuyActivityId);
  if (order.paymentStatus === "failed") {
    const pickupEndTime = Date.parse(groupBuyActivity?.pickupEndAt);
    if (Number.isNaN(pickupEndTime) || getBusinessNow().getTime() < pickupEndTime) return false;
  }
  const historyGroupBuyActivityStatuses = ["cancelled", "failed", "completed"];
  const historyOrderStatuses = ["cancelled", "completed"];
  return historyGroupBuyActivityStatuses.includes(groupBuyActivity?.status) || historyOrderStatuses.includes(order.status);
}

function getHistoryReason(order, groupBuyActivity) {
  if (groupBuyActivity?.status === "cancelled") return "此團購已由管理員取消，訂單已移至歷史訂單。";
  if (groupBuyActivity?.status === "failed") return "此團購未達門檻，訂單已移至歷史訂單。";
  if (groupBuyActivity?.status === "completed" || order.status === "completed") return "此訂單已完成。";
  if (order.status === "cancelled") return "此訂單已取消。";
  return "此訂單已歸入歷史訂單。";
}

function getHistoryCardStatus(order, groupBuyActivity) {
  if (order.status === "cancelled" || groupBuyActivity?.status === "cancelled") {
    return { label: "已取消", tone: "neutral", description: "訂單已取消。" };
  }
  if (order.paymentStatus === "refunded") {
    return { label: "已退款", tone: "neutral", description: "訂單已退款。" };
  }
  if (order.pickupStatus === "expired") {
    return { label: "逾期未取", tone: "danger", description: "取餐時間已結束。" };
  }
  if (groupBuyActivity?.status === "failed") {
    return { label: "流團", tone: "neutral", description: "團購未達門檻。" };
  }
  if (order.pickupStatus === "picked_up") {
    return { label: "已完成", tone: "success", description: "已取餐，訂單完成。" };
  }
  if (order.status === "completed") {
    return { label: "已完成", tone: "success", description: "訂單已完成。" };
  }
  return { label: "已結束", tone: "neutral", description: getHistoryReason(order, groupBuyActivity) };
}

function formatHistoryAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? `${value.toLocaleString("zh-TW")} 元` : "金額待確認";
}

const makeStyles = (colors, tones) => StyleSheet.create({
  orderNumber: { ...typeScale.caption, color: colors.textSecondary, maxWidth: 185, textAlign: "right" },
  detailSection: { gap: spacing.s12 },
  detailHeading: { ...typeScale.sectionTitle, color: colors.text },
  pickupCard: { gap: spacing.s16 },
  pickupTimeRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.s12 },
  pickupTimeContent: { flex: 1, minWidth: 0 },
  pickupTimeLabel: { ...typeScale.bodyDense, color: colors.textSecondary },
  pickupTime: { ...typeScale.body, color: colors.accentInk, flexShrink: 1 },
  pickupHint: { ...typeScale.bodyDense, color: colors.textSecondary, textAlign: "center" },
  amountLine: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s12, borderTopWidth: 1, borderTopColor: colors.lineRow },
  amountLabel: { ...typeScale.body, color: colors.textSecondary },
  amountText: { ...typeScale.body, color: colors.text },
  amountEmphasis: { ...typeScale.price, color: colors.text },
  orderActions: { gap: spacing.s12 },
  actionHint: { ...typeScale.bodyDense, color: colors.textSecondary, textAlign: "center" },
  actionRow: { flexDirection: "row", gap: spacing.s12 },
  actionButton: { flex: 1 },
  loadingText: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  noticeButton: {
    alignSelf: "flex-start"
  },
  orderList: {
    gap: spacing.s12
  },
  orderListCard: {
    gap: spacing.s12
  },
  historyCount: { ...typeScale.bodyDense, color: colors.textSecondary },
  historyCard: { gap: spacing.s8, padding: spacing.s16 },
  historyTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8 },
  historyTitle: { ...typeScale.sectionTitle, color: colors.text, flex: 1 },
  historyCompletedBadge: { flexDirection: "row", alignItems: "center", gap: spacing.s8, borderRadius: radii.pill, paddingHorizontal: spacing.s8, paddingVertical: spacing.s4, backgroundColor: colors.recess },
  historyCheckCircle: { width: spacing.s16, height: spacing.s16, borderRadius: radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  historyCheck: { color: colors.onAccent, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  historyCompletedText: { ...typeScale.label, color: colors.accentInk },
  historyStore: { ...typeScale.bodyDense, color: colors.text },
  historyDescription: { ...typeScale.bodyDense, color: colors.textSecondary },
  historyDivider: { borderTopWidth: sizes.stroke, borderTopColor: colors.lineRow, marginTop: spacing.s4 },
  historyItemsRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.s8 },
  historyItems: { flex: 1, gap: spacing.s4 },
  historyItemText: { ...typeScale.bodyDense, color: colors.text },
  historyAmount: { ...typeScale.price, color: colors.text, textAlign: "right" },
  historyOpenHint: { ...typeScale.button, color: colors.accentInk, marginTop: spacing.s4 },
  listTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  storeNameSmall: {
    ...typeScale.button,
    color: colors.text
  },
  orderSubtitle: {
    ...typeScale.caption,
    color: colors.textSecondary,
    marginTop: spacing.s4
  },
  listAmount: {
    ...typeScale.price,
    color: colors.text
  },
  orderPreview: {
    gap: spacing.s4
  },
  previewText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  openHint: {
    ...typeScale.label,
    color: colors.accentInk
  },
  emptyActions: {
    gap: spacing.s12
  },
  tabRow: {
    flexDirection: "row",
    gap: spacing.s8
  },
  tab: {
    flex: 1
  },
  summaryCard: {
    gap: spacing.s16
  },
  orderCard: {
    gap: spacing.s24
  },
  statusBar: {
    gap: spacing.s8
  },
  statusGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  statusText: {
    ...typeScale.label,
    color: colors.textSecondary
  },
  historyReason: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  summaryText: {
    flex: 1,
    gap: spacing.s8
  },
  flex: {
    flex: 1
  },
  meta: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  storeName: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  smallDetailButton: {
    alignSelf: "flex-start",
    minHeight: sizes.tap,
    justifyContent: "center",
    marginTop: spacing.s4,
    paddingHorizontal: spacing.s16,
    borderRadius: radii.pill,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    backgroundColor: colors.page
  },
  smallDetailText: {
    ...typeScale.button,
    color: colors.accentInk
  },
  priceGroup: {
    alignItems: "flex-end"
  },
  cartDraftCard: {
    gap: spacing.s16
  },
  cartDraftHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  cartDraftText: {
    flex: 1,
    gap: spacing.s4
  },
  cartDraftTitle: {
    ...typeScale.button,
    color: colors.text
  },
  cartDraftAmount: {
    ...typeScale.price,
    color: colors.text
  },
  cartDraftList: {
    gap: spacing.s8
  },
  cartDraftItem: {
    gap: spacing.s4,
    padding: spacing.s12,
    borderRadius: radii.sm,
    backgroundColor: colors.recess
  },
  cartDraftItemName: {
    ...typeScale.button,
    color: colors.text
  },
  cartDraftItemMeta: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  // Two order rows plus a peek of the third, so a longer order visibly scrolls instead of cutting a row in half.
  itemScroller: {
    maxHeight: 320
  },
  itemList: {
    gap: 0
  },
  price: {
    ...typeScale.price,
    color: colors.text
  },
  originalPrice: {
    ...typeScale.caption,
    color: colors.textSecondary,
    textDecorationLine: "line-through"
  },
  detailCard: {
    paddingVertical: spacing.s12,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow,
    backgroundColor: colors.page
  },
  // Dims only the row's text column (colors.text stays above 4.5:1 at this opacity). The delete / locked
  // label sits outside it at full strength, because it explains why the row can't be deleted.
  detailTextDimmed: {
    opacity: 0.72
  },
  pressed: {
    opacity: 0.8
  },
  detailTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.s12
  },
  // Text-only delete action, same as CartScreen. The negative margin cancels the horizontal padding so the
  // word lines up with the row's right edge while the tap area stays at least 44px. Locked / history
  // shows the state as plain secondary text.
  deleteButton: {
    minWidth: sizes.tap,
    minHeight: sizes.tap,
    alignSelf: "flex-end",
    alignItems: "center",
    justifyContent: "center"
  },
  deleteText: {
    ...typeScale.button,
    color: tones.danger.fg
  },
  deleteTextDisabled: {
    color: colors.textSecondary
  },
  itemTitle: {
    ...typeScale.button,
    color: colors.text
  },
  itemPrice: {
    ...typeScale.body,
    color: colors.text,
    textAlign: "right"
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.s4
  },
  chip: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  totalRow: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12,
    borderRadius: radii.sm,
    backgroundColor: colors.recess,
    paddingVertical: spacing.s12,
    paddingHorizontal: spacing.s16
  },
  totalLabel: {
    ...typeScale.button,
    color: colors.text
  }
});
