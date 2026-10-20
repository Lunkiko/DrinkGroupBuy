import { StyleSheet, Text, View } from "react-native";
import { AccentHeading } from "../components/AccentHeading";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { EmptyPanel } from "../components/EmptyPanel";
import { Icon } from "../components/Icon";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { ProgressBar } from "../components/ProgressBar";
import { StatusBadge } from "../components/StatusBadge";
import { ValueRow } from "../components/ValueRow";
import { WarmPill } from "../components/WarmPill";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { paymentStatusLabels } from "../types/prototypeTypes";
import { getGroupBuyActivityById, formatCurrency } from "../utils/calculations";
import { formatDealFactorLabel, formatDiscountPercentAsDealFactor } from "../utils/discountPercentFormat";
import {
  findTierByCups,
  getFinalSettlementSnapshot,
  getGroupBuyActivityDiscountInfo,
  getGroupBuyActivityProgress,
  getOrderDiscountEstimate,
  isGroupBuyActivityOpen
} from "../utils/groupBuyActivityProgress";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { formatOrderItemCustomizations } from "../utils/orderItems";
import { formatShortTimeRange } from "../utils/shortDateTime";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function GroupProgressScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const groupBuyActivity = getGroupBuyActivityById(appState.groupBuyActivities, route.params?.groupBuyActivityId);
  const activitySyncStatus = appState.groupBuyActivitySyncStatus ?? "idle";
  const retryActivitySync = () => actions.syncGroupBuyActivities().catch(() => {});
  if (!groupBuyActivity) {
    return (
      <MobileScreen
        title="團購進度"
        onBack={() => navigation.goBack()}
      >
        <ActivitySyncNotice status={activitySyncStatus} onRetry={retryActivitySync} />
        <Section title="目前沒有團購資料">
          <EmptyPanel>團購已清空，或目前尚未有商家建立活動。</EmptyPanel>
          <PrimaryButton label="返回首頁" variant="secondary" onPress={() => goToCustomerHome(navigation)} />
        </Section>
      </MobileScreen>
    );
  }

  const order = appState.orders.find((item) => item.id === route.params?.orderId && item.customerId === selectedCustomerId)
    ?? appState.orders.find((item) => item.groupBuyActivityId === groupBuyActivity.id && item.customerId === selectedCustomerId);
  const payment = appState.paymentAuthorizations.find((item) => item.orderId === order?.id);
  const finalSettlement = getFinalSettlementSnapshot(groupBuyActivity, order);
  const store = getGroupBuyActivityStore(groupBuyActivity);
  const progress = getGroupBuyActivityProgress(groupBuyActivity);
  const discountStatus = progress.reachedTier ? "qualified" : "not_yet_qualified";

  return (
    <MobileScreen
      title="團購進度"
      onBack={() => navigation.goBack()}
    >
      <ActivitySyncNotice status={activitySyncStatus} onRetry={retryActivitySync} />

      <View style={styles.titleBlock}>
        <Text style={styles.storeName}>{store?.name ?? "店家資料未提供"}</Text>
        <Text style={styles.activityTitle}>{groupBuyActivity.title}</Text>
      </View>

      <ProgressCard groupBuyActivity={groupBuyActivity} progress={progress} />

      {finalSettlement ? (
        <Section title="最終結算結果">
          <View style={styles.rows}>
            <ValueRow label="結算結果" value={finalSettlement.outcomeLabel} />
            <ValueRow label="最終有效杯數" value={`${finalSettlement.authorizedCups} 杯`} />
            <ValueRow
              label="最終折數"
              value={finalSettlement.discountPercent ? formatDealFactorLabel(finalSettlement.discountPercent) : "未達優惠門檻"}
            />
            {finalSettlement.hasOrder ? (
              <AmountLine label="我的訂單原價" value={finalSettlement.originalAmount} />
            ) : null}
            {finalSettlement.hasOrder ? (
              <AmountLine
                label="我的實際應付"
                value={finalSettlement.finalAmount}
                emptyLabel="待同步訂單"
                emphasis
              />
            ) : null}
            {finalSettlement.hasOrder ? (
              <AmountLine
                label="我的訂單折扣"
                value={finalSettlement.orderDiscountAmount}
                emptyLabel="待同步訂單"
              />
            ) : null}
          </View>
          {/* Same text for every outcome, so a fixed neutral tone: it must not read as a success or failure signal. */}
          <Notice
            tone="neutral"
            message="此區使用 Backend 保存的截止結算快照，與截止前的預估折扣不同，結算後不再變動。"
          />
        </Section>
      ) : null}

      <View style={styles.block}>
        <AccentHeading title="我的訂單摘要" />
        {order ? (
          <OrderSummaryCard groupBuyActivity={groupBuyActivity} order={order} />
        ) : (
          <NoOrderCard />
        )}
      </View>

      {discountStatus === "qualified" && payment ? (
        <Section title="優惠請款試算">
          <View style={styles.rows}>
            <AmountLine label="預估結算金額" value={payment.finalAmount} />
            <AmountLine label="實際請款金額" value={payment.captureAmount} />
            <AmountLine label="釋放授權金額" value={payment.releasedAmount} />
          </View>
        </Section>
      ) : null}

      <View style={styles.actions}>
        {order ? (
          <>
            <PrimaryButton label="Line Pay 預授權" onPress={() => navigation.push("paymentAuthorization", { groupBuyActivityId: groupBuyActivity.id, orderId: order.id })} />
            <PrimaryButton label="取貨資訊" variant="secondary" onPress={() => navigation.push("pickupInfo", { groupBuyActivityId: groupBuyActivity.id, orderId: order.id })} />
          </>
        ) : (
          <PrimaryButton label="先選擇飲料" variant="secondary" onPress={() => navigation.push("drinkSelection", { groupBuyActivityId: groupBuyActivity.id })} />
        )}
      </View>
    </MobileScreen>
  );
}

// Cups, the discount reached so far, the amber bar, what the next tier needs, and the countdown.
// groupBuyActivity.targetCups is always the first tier's threshold, not a ceiling, so the denominator
// is progress.nextTarget (next unreached tier, or the highest once all are reached).
function ProgressCard({ groupBuyActivity, progress }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const discount = getGroupBuyActivityDiscountInfo(groupBuyActivity);
  const isOpen = isGroupBuyActivityOpen(groupBuyActivity);
  const nextTier = findTierByCups(groupBuyActivity, progress.nextTarget);
  const hasNext = nextTier && progress.currentCups < progress.nextTarget;
  const dealFactor = discount.isQualified ? formatDiscountPercentAsDealFactor(discount.currentTierDiscountPercent) : null;

  return (
    <View style={styles.progressCard}>
      <View style={styles.progressHeader}>
        <Text style={styles.cardTitle}>團購進度</Text>
        {groupBuyActivity.status === "recruiting" && isOpen
          ? <WarmPill label="招募中" />
          : <StatusBadge value={groupBuyActivity.status} />}
      </View>

      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.bigCups}>
        {progress.currentCups} / {progress.nextTarget}
        <Text style={styles.bigCupsUnit}> 杯</Text>
      </Text>
      {dealFactor ? (
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.discountLine}>
          {discount.isEstimated ? "預估享" : "最終享"} {dealFactor} 折
        </Text>
      ) : (
        <Text style={styles.mutedLine}>尚未達到優惠門檻</Text>
      )}

      <ProgressBar percent={progress.progressPercent} />

      <View style={styles.splitRow}>
        <Text style={styles.mutedLine}>
          {hasNext
            ? `下一級距 ${progress.nextTarget} 杯`
            : progress.reachedTier
              ? `已達目前最高級距：${progress.reachedTier} 杯`
              : "目前沒有下一級距資料"}
        </Text>
        <Text style={styles.mutedLine}>{progress.currentCups} / {progress.nextTarget} 杯</Text>
      </View>

      {hasNext ? (
        <Text style={styles.nextOffer}>
          再 {progress.remainingCups} 杯可享 {formatDiscountPercentAsDealFactor(nextTier.discountPercent)} 折
        </Text>
      ) : null}

      <View style={styles.divider} />
      {isOpen && groupBuyActivity.remainingTimeText ? (
        <View style={styles.inline}>
          <Icon color={colors.alert} name="clock" size={26} />
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.remaining}>{groupBuyActivity.remainingTimeText}</Text>
        </View>
      ) : null}
      <Text style={styles.mutedLine}>僅預授權成功的杯數計入優惠門檻</Text>
    </View>
  );
}

function OrderSummaryCard({ groupBuyActivity, order }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const discount = getGroupBuyActivityDiscountInfo(groupBuyActivity);
  const estimate = getOrderDiscountEstimate(groupBuyActivity, order);
  const dealFactor = discount.isQualified ? formatDiscountPercentAsDealFactor(discount.currentTierDiscountPercent) : null;
  const originalAmount = estimate?.originalAmount ?? order.subtotal;
  const discountAmount = estimate?.discountAmount ?? 0;
  const payable = estimate?.finalAmount ?? order.subtotal;
  const pickupText = formatShortTimeRange(groupBuyActivity.pickupStartAt, groupBuyActivity.pickupEndAt) || groupBuyActivity.pickupTime;

  return (
    <View style={styles.summaryCard}>
      <View style={styles.splitRow}>
        <Text style={[styles.itemName, styles.flex]}>{order.itemName}</Text>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.itemQuantity}>× {order.quantity}</Text>
      </View>
      <Text style={styles.mutedLine}>{formatOrderItemCustomizations(order)}</Text>

      <View style={styles.divider} />
      <View style={styles.splitRow}>
        <Text style={styles.amountLabel}>訂單原價</Text>
        <Text style={styles.amountValue}>{formatCurrency(originalAmount)}</Text>
      </View>
      {discountAmount > 0 ? (
        <View style={styles.splitRow}>
          <Text style={styles.amountLabel}>{discount.isEstimated ? "目前優惠" : "優惠"}（{dealFactor} 折）</Text>
          <Text style={styles.discountAmount}>-{formatCurrency(discountAmount)}</Text>
        </View>
      ) : null}
      <View style={styles.splitRow}>
        <Text style={styles.payableLabel}>小計</Text>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.payableValue}>{formatCurrency(payable)}</Text>
      </View>
      {discount.isEstimated ? <Text style={styles.mutedLine}>最終金額於團購截止後確認</Text> : null}

      <View style={styles.divider} />
      <View style={styles.splitRow}>
        <View style={styles.inline}>
          <Icon color={colors.accent} name="shield" size={26} />
          <Text style={styles.rowLabel}>付款狀態</Text>
        </View>
        <Text style={styles.statusValue}>{paymentStatusLabels[order.paymentStatus] ?? order.paymentStatus}</Text>
      </View>
      <Text style={styles.mutedLine}>
        流團偏好：{order.fallbackPurchasePreference === "accept_original_price" ? "接受原價購買" : "不原價購買"}
      </Text>

      <View style={styles.divider} />
      <View style={styles.splitRow}>
        <View style={styles.inline}>
          <Icon color={colors.textSecondary} name="calendar" size={26} />
          <Text style={styles.rowLabel}>預計取餐時間</Text>
        </View>
        <Text style={styles.mutedLine}>{pickupText}</Text>
      </View>
    </View>
  );
}

function NoOrderCard() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.summaryCard}>
      <View style={styles.emptyBlock}>
        <View style={styles.emptyDisc}>
          <Icon color={colors.accent} name="bag" size={40} />
        </View>
        <Text style={styles.emptyTitle}>尚未加入此團購。</Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.splitRow}>
        <View style={styles.inline}>
          <Icon color={colors.accent} name="shield" size={26} />
          <Text style={styles.rowLabel}>付款狀態</Text>
        </View>
        <Text style={styles.mutedLine}>尚未建立訂單</Text>
      </View>
    </View>
  );
}

function AmountLine({ label, value, emptyLabel = "待計算", emphasis }) {
  return <ValueRow label={label} value={value == null ? emptyLabel : formatCurrency(value)} emphasis={emphasis} />;
}

const makeStyles = (colors) => StyleSheet.create({
  flex: {
    flex: 1
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  block: {
    gap: spacing.s12
  },
  titleBlock: {
    gap: spacing.s4
  },
  storeName: {
    ...typeScale.screenTitle,
    color: colors.text
  },
  activityTitle: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  progressCard: {
    gap: spacing.s12,
    padding: spacing.s20,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  cardTitle: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  bigCups: {
    ...typeScale.pearlNumber,
    fontSize: 44,
    lineHeight: 52,
    color: colors.text
  },
  bigCupsUnit: {
    ...typeScale.body,
    fontSize: 20,
    color: colors.textSecondary
  },
  discountLine: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.warm
  },
  mutedLine: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  nextOffer: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  divider: {
    height: 1,
    backgroundColor: colors.lineRow
  },
  remaining: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  summaryCard: {
    gap: spacing.s12,
    padding: spacing.s20,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  itemName: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  itemQuantity: {
    ...typeScale.price,
    color: colors.text
  },
  amountLabel: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  amountValue: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  discountAmount: {
    ...typeScale.body,
    color: colors.warm
  },
  payableLabel: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  payableValue: {
    ...typeScale.amount,
    color: colors.accent
  },
  rowLabel: {
    ...typeScale.price,
    fontSize: 17,
    color: colors.text
  },
  statusValue: {
    ...typeScale.price,
    fontSize: 17,
    color: colors.accent
  },
  emptyBlock: {
    alignItems: "center",
    gap: spacing.s12,
    paddingVertical: spacing.s12
  },
  emptyDisc: {
    width: 76,
    height: 76,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  emptyTitle: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  rows: {
    gap: spacing.s8
  },
  actions: {
    gap: spacing.s12
  }
});
