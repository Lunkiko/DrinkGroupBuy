import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { CheckRow } from "../components/CheckRow";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { QuantityStepper } from "../components/QuantityStepper";
import { maxFontSizeMultiplier, sizes, spacing, typeScale } from "../theme/tokens";
import { formatCurrency, getGroupBuyActivityById, isWithdrawalLocked } from "../utils/calculations";
import { isDeadlineReached } from "../utils/deadlineTime";
import { isDemoMode } from "../utils/demoMode";
import { getGroupBuyActivityCapacityInfo } from "../utils/groupBuyActivityProgress";
import { formatOrderItemCustomizations } from "../utils/orderItems";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useThemedStyles } from "../theme/ThemeContext";

export function CartScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const [acceptOriginalPrice, setAcceptOriginalPrice] = useState(true);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const groupBuyActivity = getGroupBuyActivityById(appState.groupBuyActivities, route.params?.groupBuyActivityId);
  if (!groupBuyActivity) {
    return (
      <MobileScreen
        title="購物車"
        onBack={() => navigation.goBack()}
      >
        <Section title="目前沒有團購資料">
          <EmptyPanel>團購已清空，購物車暫時不能送出。</EmptyPanel>
          <PrimaryButton label="返回首頁" variant="secondary" onPress={() => goToCustomerHome(navigation)} />
        </Section>
      </MobileScreen>
    );
  }

  const cartItems = appState.cartItems.filter((item) => (
    item.groupBuyActivityId === groupBuyActivity.id && (!item.customerId || item.customerId === selectedCustomerId)
  ));
  const totalQuantity = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = cartItems.reduce((sum, item) => sum + item.subtotal, 0);
  const groupBuyActivityClosed = groupBuyActivity.canJoin === false || isDeadlineReached(groupBuyActivity);
  const existingOrder = appState.orders.find((order) => (
    order.customerId === selectedCustomerId
    && order.groupBuyActivityId === groupBuyActivity.id
    && !["cancelled", "completed"].includes(order.status)
  ));
  const withdrawalLocked = Boolean(existingOrder && isWithdrawalLocked(groupBuyActivity));
  const quantityDelta = totalQuantity - (existingOrder?.quantity ?? 0);
  const wouldDecreaseCups = Boolean(existingOrder) && quantityDelta < 0;
  // Pending orders have no backend-enforced withdrawal lock (only the real deadline blocks them),
  // so the cart doesn't add one either. Authorized orders keep the lock, but only for decreases --
  // topping up an already-authorized order is allowed even in the last withdrawalLockMinutes.
  const canUpdatePendingOrder = Boolean(existingOrder && existingOrder.paymentStatus === "pending");
  const canCreateRevision = Boolean(
    existingOrder
    && existingOrder.paymentStatus === "authorized"
    && (!withdrawalLocked || !wouldDecreaseCups)
  );
  const blocksOrderUpdate = Boolean(existingOrder && !canUpdatePendingOrder && !canCreateRevision);
  const blockedByWithdrawalDecrease = Boolean(
    existingOrder
    && existingOrder.paymentStatus === "authorized"
    && withdrawalLocked
    && wouldDecreaseCups
  );
  const capacityInfo = getGroupBuyActivityCapacityInfo(groupBuyActivity);
  const capacityCheckQuantity = existingOrder && existingOrder.paymentStatus !== "pending"
    ? Math.max(0, quantityDelta)
    : totalQuantity;
  const exceedsCapacity = capacityInfo.maximumCups > 0 && capacityCheckQuantity > capacityInfo.remainingCapacity;
  const withdrawalLockMinutesLabel = groupBuyActivity.withdrawalLockMinutes ?? 30;
  const withdrawalLockedNoticeText = `已進入截止前 ${withdrawalLockMinutesLabel} 分鐘鎖定，這筆訂單目前只能增加飲料、不能減少。`;

  return (
    <MobileScreen
      title="購物車"
      subtitle={groupBuyActivity.title}
      onBack={() => navigation.goBack()}
    >
      {/* MobileScreen puts 24px between its direct children, so the notices and the continue button
          stay inside this Section (12px rhythm) and appearing / disappearing notices don't move it. */}
      <Section title={`飲料明細（${totalQuantity} 杯）`}>
        {cartItems.length > 0 ? cartItems.map((item) => (
          <Card compact key={item.id} style={styles.itemCard}>
            <View style={styles.itemTop}>
              <View style={styles.itemText}>
                <Text style={styles.itemName}>{item.itemName} x {item.quantity}</Text>
                <Text style={styles.meta}>{formatOrderItemCustomizations(item)}</Text>
              </View>
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.itemAmount}>{formatCurrency(item.subtotal)}</Text>
            </View>
            <View style={styles.itemActions}>
              <QuantityStepper
                value={item.quantity}
                decreaseLabel="減少一杯"
                increaseLabel="增加一杯"
                onDecrease={() => actions.updateCartItemQuantity(item.id, item.quantity - 1)}
                onIncrease={() => actions.updateCartItemQuantity(item.id, item.quantity + 1)}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => actions.removeCartItem(item.id)}
                style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
              >
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.removeText}>刪除</Text>
              </Pressable>
            </View>
          </Card>
        )) : (
          <EmptyPanel>購物車目前沒有飲料。</EmptyPanel>
        )}

        {groupBuyActivityClosed ? (
          <Notice tone="danger" message="活動已截止，系統已鎖定訂單，不能再送出或修改購物車。" />
        ) : null}
        {!groupBuyActivityClosed && exceedsCapacity ? (
          <Notice
            tone="warning"
            message={`此團購最高 ${capacityInfo.maximumCups} 杯，目前剩餘容量不足，請調整購物車數量。`}
          />
        ) : null}
        {submitError ? <Notice tone="danger" accessibilityRole="alert" message={submitError} /> : null}
        {canUpdatePendingOrder && cartItems.length > 0 ? (
          <Notice
            tone="info"
            message="此團購已有一筆尚未完成預授權的訂單。送出後會用目前購物車內容更新該訂單，再重新進行 LINE Pay 預授權。"
          />
        ) : null}
        {blockedByWithdrawalDecrease && cartItems.length > 0 ? (
          <Notice
            tone="warning"
            message={`${withdrawalLockedNoticeText}請調整購物車數量至不低於原本的 ${existingOrder?.quantity ?? 0} 杯，或前往訂單頁查看。`}
          />
        ) : null}
        {blocksOrderUpdate && !blockedByWithdrawalDecrease && cartItems.length > 0 ? (
          <Notice
            tone="warning"
            message="此團購已有一筆已請款或已鎖定的訂單，請先回到訂單頁查看。"
          />
        ) : null}
        {canCreateRevision && withdrawalLocked && cartItems.length > 0 ? (
          <Notice tone="warning" message={withdrawalLockedNoticeText} />
        ) : null}

        <PrimaryButton
          label="繼續選購飲料"
          variant="secondary"
          onPress={() => !groupBuyActivityClosed && navigation.push("drinkSelection", { groupBuyActivityId: groupBuyActivity.id })}
        />
      </Section>

      <Section title="訂單金額">
        <Card compact tone="recess" style={styles.totalCard}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>原價合計</Text>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.totalAmount}>{formatCurrency(totalAmount)}</Text>
          </View>
          {canUpdatePendingOrder || blocksOrderUpdate ? (
            <Text style={styles.totalNote}>
              {canUpdatePendingOrder
                ? "送出後會以目前購物車內容更新尚未授權的訂單。預授權成功後，購物車才會清空。"
                : blockedByWithdrawalDecrease
                  ? withdrawalLockedNoticeText
                  : "此團購已有一筆已請款或已鎖定的訂單，請先回到訂單頁查看。"}
            </Text>
          ) : null}
        </Card>
        <CheckRow checked={acceptOriginalPrice} onToggle={() => setAcceptOriginalPrice((value) => !value)}>
          <View style={styles.checkboxTextGroup}>
            <Text style={styles.checkboxTitle}>若無優惠接受原價購買</Text>
            <Text style={styles.checkboxHint}>未勾選時，若未達優惠門檻則不付款。</Text>
          </View>
        </CheckRow>
      </Section>

      <PrimaryButton
        label={isSubmitting
          ? "正在建立訂單..."
          : blocksOrderUpdate
            ? "前往既有訂單"
            : canUpdatePendingOrder
              ? "更新訂單並前往 LINE Pay"
              : "送出訂單並前往 LINE Pay"}
        onPress={async () => {
          if (isSubmitting) return;
          setSubmitError("");
          if (groupBuyActivityClosed) return;
          if (cartItems.length === 0) {
            if (existingOrder) navigation.push("paymentAuthorization", { groupBuyActivityId: groupBuyActivity.id, orderId: existingOrder.id });
            return;
          }
          if (blocksOrderUpdate) {
            navigation.push("paymentAuthorization", { groupBuyActivityId: groupBuyActivity.id, orderId: existingOrder.id });
            return;
          }
          if (exceedsCapacity) {
            setSubmitError(`此團購最多 ${capacityInfo.maximumCups} 杯，剩餘 ${capacityInfo.remainingCapacity} 杯可加入。`);
            return;
          }
          const fallbackPreference = acceptOriginalPrice ? "accept_original_price" : "decline_original_price";
          setIsSubmitting(true);
          try {
            const submitResult = await actions.submitCart(groupBuyActivity.id, fallbackPreference);
            if (submitResult?.error) {
              setSubmitError(submitResult.message);
              return;
            }
            const orderId = typeof submitResult === "string" ? submitResult : submitResult?.orderId;
            if (orderId && isDemoMode()) {
              // No real LINE Pay to authorize against -- this existing local-only action (built for
              // early prototyping, before the real LINE Pay integration) marks the order paid
              // directly, so demo mode can skip the payment screen and still show a completed order.
              // A brand-new order was already authorized inside submitCart; this re-applies the same
              // state (a no-op for it) and covers a revised or updated existing order.
              actions.authorizeLinePayPayment(orderId);
              // "customerOrders" lives in OrdersStack, a sibling tab's nested stack (CustomerTabs.jsx)
              // -- not reachable with push(), which only targets the current stack (cart is in
              // HomeStack). navigate()'s { screen, params } form is how React Navigation crosses into
              // another tab's nested screen.
              navigation.navigate("OrdersTab", { screen: "customerOrders", params: { orderId } });
              return;
            }
            const orderRevisionId = typeof submitResult === "object" ? submitResult.orderRevisionId : null;
            const revisionAmount = typeof submitResult === "object" ? submitResult.revisionAmount : null;
            const revisionItems = typeof submitResult === "object" ? submitResult.revisionItems : null;
            if (orderId) navigation.push("paymentAuthorization", { groupBuyActivityId: groupBuyActivity.id, orderId, orderRevisionId, revisionAmount, revisionItems });
          } finally {
            setIsSubmitting(false);
          }
        }}
      />
    </MobileScreen>
  );
}

const makeStyles = (colors, tones) => StyleSheet.create({
  itemCard: {
    gap: spacing.s12
  },
  itemTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  itemText: {
    flex: 1,
    gap: spacing.s4
  },
  itemName: {
    ...typeScale.button,
    color: colors.text
  },
  itemAmount: {
    ...typeScale.price,
    color: colors.text
  },
  meta: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  itemActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  // Text-only delete action. The negative margin cancels the horizontal padding so the word lines
  // up with the price above it while the tap area stays at least 44px.
  removeButton: {
    minWidth: sizes.tap,
    minHeight: sizes.tap,
    marginRight: -spacing.s12,
    paddingHorizontal: spacing.s12,
    alignItems: "center",
    justifyContent: "center"
  },
  removeText: {
    ...typeScale.button,
    color: tones.danger.fg
  },
  totalCard: {
    gap: spacing.s8
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  totalLabel: {
    ...typeScale.body,
    flex: 1,
    color: colors.textSecondary
  },
  totalAmount: {
    ...typeScale.amount,
    color: colors.text
  },
  totalNote: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  checkboxTextGroup: {
    gap: spacing.s4
  },
  checkboxTitle: {
    ...typeScale.body,
    fontWeight: typeScale.label.fontWeight,
    color: colors.text
  },
  checkboxHint: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  pressed: {
    opacity: 0.8
  }
});
