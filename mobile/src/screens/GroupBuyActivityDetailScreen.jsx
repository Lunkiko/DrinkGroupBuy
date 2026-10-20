import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AccentHeading } from "../components/AccentHeading";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { EmptyPanel } from "../components/EmptyPanel";
import { Icon } from "../components/Icon";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { ProgressBar } from "../components/ProgressBar";
import { StatusBadge } from "../components/StatusBadge";
import { WarmPill } from "../components/WarmPill";
import { maxFontSizeMultiplier, spacing, typeScale } from "../theme/tokens";
import { getGroupBuyActivityById, isWithdrawalLocked } from "../utils/calculations";
import { formatDealFactorLabelWithSpace, formatDiscountPercentAsDealFactor } from "../utils/discountPercentFormat";
import { formatShortDateTime, formatShortTimeRange } from "../utils/shortDateTime";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { getGroupBuyActivityJoinAction } from "../utils/groupBuyActivityJoinState";
import {
  findTierByCups,
  getGroupBuyActivityDiscountInfo,
  getGroupBuyActivityProgress,
  isGroupBuyActivityOpen
} from "../utils/groupBuyActivityProgress";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

// Standing rules shown when the activity has no notices of its own (same rules as the withdrawal-lock
// notice and the progress screen: docs/open-questions.md, "團購活動與優惠" / "訂單").
const STANDING_NOTICE = "只有預授權成功的杯數才計入優惠門檻；截止前 30 分鐘內不能減少或退出訂單。";

export function GroupBuyActivityDetailScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const groupBuyActivity = getGroupBuyActivityById(appState.groupBuyActivities, route.params?.groupBuyActivityId);
  const existingOrder = groupBuyActivity
    ? appState.orders.find((order) => (
      order.groupBuyActivityId === groupBuyActivity.id
        && order.customerId === selectedCustomerId
        && order.status !== "cancelled"
    ))
    : null;
  const activitySyncStatus = appState.groupBuyActivitySyncStatus ?? "idle";
  const retryActivitySync = () => actions.syncGroupBuyActivities().catch(() => {});
  if (!groupBuyActivity) {
    return (
      <MobileScreen
        title="團購詳情"
        onBack={() => navigation.goBack()}
      >
        <ActivitySyncNotice status={activitySyncStatus} onRetry={retryActivitySync} />
        <Section title="目前沒有團購資料">
          <EmptyPanel>團購已清空，或目前尚未有商家建立活動。</EmptyPanel>
          {/* This screen is reachable from three different tabs (Home/LiveMap/Orders); navigating by
              root-level name lets react-navigation find the Home tab regardless of which one this is. */}
          <PrimaryButton label="返回首頁" variant="secondary" onPress={() => goToCustomerHome(navigation)} />
        </Section>
      </MobileScreen>
    );
  }

  const store = getGroupBuyActivityStore(groupBuyActivity);
  const withdrawalLocked = isWithdrawalLocked(groupBuyActivity);
  const joinAction = getGroupBuyActivityJoinAction(groupBuyActivity, Boolean(existingOrder));

  return (
    <MobileScreen
      title="團購詳情"
      onBack={() => navigation.goBack()}
    >
      <ActivitySyncNotice status={activitySyncStatus} onRetry={retryActivitySync} />
      <StoreCard groupBuyActivity={groupBuyActivity} store={store} />

      <Text style={styles.activityTitle}>{groupBuyActivity.title}</Text>

      <ProgressCard groupBuyActivity={groupBuyActivity} />

      <View style={styles.block}>
        <AccentHeading title="杯數優惠" />
        <View style={styles.tierCard}>
          {groupBuyActivity.tiers.map((tier, index) => (
            <View key={tier.cups} style={[styles.tierRow, index > 0 && styles.tierRowDivider]}>
              <TierIcon />
              <Text style={[styles.tierText, styles.flex]}>滿 {tier.cups} 杯</Text>
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.tierValue}>
                打 {formatDealFactorLabelWithSpace(tier.discountPercent)}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {withdrawalLocked ? <Notice tone="warning" message="目前距截止時間 30 分鐘內：仍可加入，既有訂單只能增加飲料，不能減少或退出。" /> : null}
      {groupBuyActivity.cancellationReason ? <Notice tone="danger" message={`取消原因：${groupBuyActivity.cancellationReason}`} /> : null}
      <NoticesCard notices={groupBuyActivity.notices} />

      <View style={styles.actions}>
        <PrimaryButton
          label={joinAction.label}
          onPress={() => {
            if (joinAction.target === "customerOrders") {
              // Cross-tab: customerOrders is the Orders tab's own root, not a screen in this stack.
              navigation.navigate("CustomerTabs", { screen: "OrdersTab" });
            } else if (joinAction.target === "drinkSelection") {
              navigation.push("drinkSelection", { groupBuyActivityId: groupBuyActivity.id });
            }
          }}
        />
        <PrimaryButton
          label="查看團購進度"
          variant="secondary"
          onPress={() => navigation.push("groupProgress", { groupBuyActivityId: groupBuyActivity.id })}
        />
      </View>
    </MobileScreen>
  );
}

function TierIcon() {
  const { colors } = useTheme();
  return <Icon color={colors.accent} name="tag" size={18} />;
}

function StoreCard({ groupBuyActivity, store }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const recruiting = groupBuyActivity.status === "recruiting";
  return (
    <View style={styles.storeCard}>
      <View style={styles.storeLogo}>
        <Icon color={colors.accent} name="store" size={34} />
      </View>
      <View style={[styles.flex, styles.storeInfo]}>
        <View style={styles.storeTop}>
          <Text style={[styles.storeName, styles.flex]}>{store?.name ?? "店家資料未提供"}</Text>
          {recruiting ? <WarmPill label="招募中" /> : <StatusBadge value={groupBuyActivity.status} />}
        </View>
        <View style={styles.iconLine}>
          <Icon color={colors.textSecondary} filled name="pin" size={16} />
          <Text style={[styles.lineText, styles.flex]}>{store?.address || "地址未提供"}</Text>
        </View>
        {store?.phone ? (
          <View style={styles.iconLine}>
            <Icon color={colors.textSecondary} name="phone" size={16} />
            <Text style={[styles.lineText, styles.flex]}>{store.phone}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// "Current progress": cups and people, the amber bar with its percentage, what the next tier needs, and the
// deadline / pickup window. groupBuyActivity.targetCups is always the FIRST tier's threshold, not a ceiling,
// so the denominator comes from getGroupBuyActivityProgress (next unreached tier, or the highest one).
function ProgressCard({ groupBuyActivity }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const progress = getGroupBuyActivityProgress(groupBuyActivity);
  const discount = getGroupBuyActivityDiscountInfo(groupBuyActivity);
  const isOpen = isGroupBuyActivityOpen(groupBuyActivity);
  const nextTier = findTierByCups(groupBuyActivity, progress.nextTarget);
  const deadlineText = formatShortDateTime(groupBuyActivity.deadlineAt) || groupBuyActivity.endTime;
  const pickupText = formatShortTimeRange(groupBuyActivity.pickupStartAt, groupBuyActivity.pickupEndAt) || groupBuyActivity.pickupTime;
  const dealFactor = discount.isQualified ? formatDiscountPercentAsDealFactor(discount.currentTierDiscountPercent) : null;

  return (
    <View style={styles.progressCard}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressTitle}>目前進度</Text>
        {isOpen && groupBuyActivity.remainingTimeText ? (
          <View style={styles.inline}>
            <Icon color={colors.alert} name="clock" size={21} />
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.remaining}>{groupBuyActivity.remainingTimeText}</Text>
          </View>
        ) : null}
      </View>

      <View>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.bigCups}>
          {progress.currentCups} / {progress.nextTarget}
          <Text style={styles.bigCupsUnit}> 杯</Text>
        </Text>
        <Text style={styles.people}>{groupBuyActivity.participantCount ?? 0} 人參與</Text>
      </View>

      <View style={styles.barRow}>
        <View style={styles.flex}>
          <ProgressBar percent={progress.progressPercent} />
        </View>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.percent}>{progress.progressPercent}%</Text>
      </View>

      {isOpen && nextTier && progress.remainingCups > 0 ? (
        <Text style={styles.offer}>
          再 <Text style={styles.offerStrong}>{progress.remainingCups}</Text> 杯享{" "}
          <Text style={styles.offerStrong}>{formatDiscountPercentAsDealFactor(nextTier.discountPercent)}</Text> 折
        </Text>
      ) : null}
      {dealFactor ? (
        <Text style={styles.estimate}>
          {discount.isEstimated ? `目前預估享 ${dealFactor} 折（截止前為預估值）` : `最終享 ${dealFactor} 折`}
        </Text>
      ) : null}

      <View style={styles.divider} />
      <View style={styles.scheduleRow}>
        <View style={styles.scheduleItem}>
          <Icon color={colors.textSecondary} name="calendar" size={20} />
          <Text style={styles.scheduleText}>
            <Text style={styles.scheduleLabel}>截止：</Text>{deadlineText}
          </Text>
        </View>
        <View style={styles.scheduleDivider} />
        <View style={[styles.scheduleItem, styles.flex]}>
          <Icon color={colors.textSecondary} name="shopBag" size={20} />
          <Text style={[styles.scheduleText, styles.flex]}>
            <Text style={styles.scheduleLabel}>取餐：</Text>{pickupText}
          </Text>
        </View>
      </View>
    </View>
  );
}

// Collapsed by default, like the blueprint. The activity's own notices when it has any, otherwise the
// standing rules.
function NoticesCard({ notices }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const lines = notices && notices.length > 0 ? notices : [STANDING_NOTICE];
  return (
    <View style={styles.noticeCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.noticeHeader}
      >
        <Text style={styles.noticeTitle}>注意事項</Text>
        <Icon color={colors.textSecondary} name={open ? "chevronUp" : "chevronDown"} size={16} />
      </Pressable>
      {open ? (
        <View style={styles.noticeBody}>
          {lines.map((line) => <Text key={line} style={styles.lineText}>· {line}</Text>)}
        </View>
      ) : null}
    </View>
  );
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
  storeCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.s16,
    padding: spacing.s16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  storeLogo: {
    width: 72,
    height: 72,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  storeInfo: {
    gap: spacing.s8
  },
  storeTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  storeName: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  iconLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  lineText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  activityTitle: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  progressCard: {
    gap: spacing.s12,
    padding: spacing.s16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  progressTitle: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  remaining: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  bigCups: {
    ...typeScale.amount,
    color: colors.text
  },
  bigCupsUnit: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  people: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  barRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
  },
  percent: {
    ...typeScale.bodyDense,
    fontSize: 13,
    minWidth: 40,
    textAlign: "right",
    color: colors.textSecondary
  },
  offer: {
    ...typeScale.body,
    color: colors.text
  },
  offerStrong: {
    ...typeScale.button,
    fontSize: 15,
    lineHeight: 23,
    color: colors.text
  },
  estimate: {
    ...typeScale.caption,
    color: colors.warm
  },
  divider: {
    height: 1,
    backgroundColor: colors.lineRow
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
  },
  scheduleItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
  },
  scheduleLabel: {
    color: colors.textSecondary
  },
  scheduleText: {
    ...typeScale.caption,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text
  },
  scheduleDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.lineRow
  },
  tierCard: {
    paddingHorizontal: spacing.s16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  tierRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
  },
  tierRowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.lineRow
  },
  tierText: {
    ...typeScale.bodyDense,
    color: colors.text
  },
  tierValue: {
    ...typeScale.bodyDense,
    fontWeight: "700",
    color: colors.accent
  },
  noticeCard: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  noticeHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.s16
  },
  noticeTitle: {
    ...typeScale.sectionTitle,
    flex: 1,
    color: colors.text
  },
  noticeBody: {
    gap: spacing.s8,
    paddingHorizontal: spacing.s16,
    paddingBottom: spacing.s16
  },
  // MobileScreen leaves 24 between its direct children; the two buttons belong together.
  actions: {
    gap: spacing.s12
  }
});
