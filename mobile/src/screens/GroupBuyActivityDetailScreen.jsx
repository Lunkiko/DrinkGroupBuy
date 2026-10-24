import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { Card } from "../components/Card";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { StatusBadge } from "../components/StatusBadge";
import { RecruitingBadge } from "../components/RecruitingBadge";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { getGroupBuyActivityById, isWithdrawalLocked } from "../utils/calculations";
import { formatDealFactorLabel } from "../utils/discountPercentFormat";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { getGroupBuyActivityJoinAction } from "../utils/groupBuyActivityJoinState";
import { getGroupBuyActivityProgress } from "../utils/groupBuyActivityProgress";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useThemedStyles } from "../theme/ThemeContext";

export function GroupBuyActivityDetailScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const styles = useThemedStyles(makeStyles);
  const [notesExpanded, setNotesExpanded] = useState(false);
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
  // groupBuyActivity.targetCups is always the FIRST tier's threshold (see
  // groupBuyActivityReadRepository.js), not a ceiling -- once currentCups passes it, showing
  // "current / targetCups" reads as an impossible overshoot. getGroupBuyActivityProgress (already
  // used the same way on the nearby-activities list) swaps in the next unreached tier, or the
  // highest tier once all are reached.
  const progress = getGroupBuyActivityProgress(groupBuyActivity);
  const nextTier = groupBuyActivity.tiers.find((tier) => Number(tier.cups) === progress.nextTarget);
  const nextDiscount = formatDealFactorLabel(nextTier?.discountPercent);
  const progressLabel = progress.remainingCups > 0 && nextDiscount
    ? `再 ${progress.remainingCups} 杯享 ${nextDiscount}`
    : "已達最高優惠級距";
  const remainingTimeLabel = String(groupBuyActivity.remainingTimeText ?? "").replace(/^剩\s*/, "");
  const showNotes = notesExpanded || withdrawalLocked || Boolean(groupBuyActivity.cancellationReason);

  return (
    <MobileScreen
      title="團購詳情"
      onBack={() => navigation.goBack()}
    >
      <ActivitySyncNotice status={activitySyncStatus} onRetry={retryActivitySync} />
      <Card style={styles.storeCard}>
        <View style={styles.storeGlyph} accessibilityLabel="店家圖示">
          <View style={styles.shopRoof} />
          <View style={styles.shopBody}><View style={styles.shopDoor} /></View>
        </View>
        <View style={styles.storeDetails}>
          <View style={styles.storeHeading}>
            <Text style={styles.storeName}>{store?.name ?? "店家資料未提供"}</Text>
            {groupBuyActivity.status === "recruiting" ? (
              <RecruitingBadge />
            ) : <StatusBadge value={groupBuyActivity.status} />}
          </View>
          <View style={styles.storeInfoRow}><Text style={styles.infoIcon}>●</Text><Text style={styles.storeMeta}>{store?.address || "地址未提供"}</Text></View>
          {store?.phone ? <View style={styles.storeInfoRow}><Text style={styles.infoIcon}>☎</Text><Text style={styles.storeMeta}>{store.phone}</Text></View> : null}
        </View>
      </Card>

      <Section title={groupBuyActivity.title} titleStyle={styles.activityTitle}>
        <Card style={styles.progressCard}>
          <View style={styles.progressTop}>
            <Text style={styles.cardHeading}>目前進度</Text>
            <View style={styles.timeRow}><View style={styles.clock}><View style={styles.clockHand} /></View><Text style={styles.timeText}>剩 {remainingTimeLabel}</Text></View>
          </View>
          <View style={styles.countRow}><Text style={styles.countNumber}>{progress.currentCups} / {progress.nextTarget}</Text><Text style={styles.countUnit}>杯</Text></View>
          <Text style={styles.participants}>{groupBuyActivity.participantCount} 人參與</Text>
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress.progressPercent}%` }]} /></View>
            <Text style={styles.progressPercent}>{progress.progressPercent}%</Text>
          </View>
          <Text style={styles.nextTier}>{progressLabel}</Text>
          <View style={styles.schedule}>
            <View style={styles.scheduleItem}><Text style={styles.scheduleIcon}>▦</Text><Text style={styles.scheduleText}>截止：{groupBuyActivity.endTime}</Text></View>
            <View style={styles.scheduleItem}><Text style={styles.scheduleIcon}>▢</Text><Text style={styles.scheduleText}>取餐：{groupBuyActivity.pickupTime}</Text></View>
          </View>
        </Card>
      </Section>

      <Section title="杯數優惠" titleStyle={styles.tierHeading}>
        <Card style={styles.tiersCard}>
          {groupBuyActivity.tiers.map((tier, index) => (
            <View key={tier.cups} style={[styles.tierRow, index > 0 && styles.tierDivider]}>
              <Text style={styles.tagIcon}>◇</Text>
              <Text style={styles.tierText}>滿 {tier.cups} 杯</Text>
              <Text style={styles.tierValue}>打 {formatDealFactorLabel(tier.discountPercent) || "—"}</Text>
            </View>
          ))}
        </Card>
      </Section>

      <Card style={styles.notesCard}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showNotes }} onPress={() => setNotesExpanded((value) => !value)} style={styles.notesToggle}>
          <Text style={styles.cardHeading}>注意事項</Text><Text style={styles.notesChevron}>{showNotes ? "⌃" : "⌄"}</Text>
        </Pressable>
        {showNotes ? <View style={styles.notes}>
          <Text style={styles.noteText}>· 團購杯數與優惠會持續變動，最終折扣及請款金額以截止結算結果為準。</Text>
          <Text style={styles.noteText}>· 請依訂單明細顯示的取餐時段到店；付款前請閱讀取餐與逾期未取規則。</Text>
          {withdrawalLocked ? <Notice tone="warning" message="目前距截止時間 30 分鐘內：仍可加入，既有訂單只能增加飲料，不能減少或退出。" /> : null}
          {groupBuyActivity.cancellationReason ? <Notice tone="danger" message={`取消原因：${groupBuyActivity.cancellationReason}`} /> : null}
          {groupBuyActivity.notices.map((notice) => <Text key={notice} style={styles.noteText}>· {notice}</Text>)}
        </View> : null}
      </Card>

      <View style={styles.actions}>
        <PrimaryButton
          label={joinAction.label}
          disabled={!joinAction.target}
          onPress={() => {
            if (joinAction.target === "customerOrders") {
              navigation.navigate("OrdersTab", { screen: "customerOrders", params: { orderId: existingOrder.id, historical: false } });
            } else if (joinAction.target === "drinkSelection") {
              navigation.push("drinkSelection", { groupBuyActivityId: groupBuyActivity.id });
            }
          }}
        />
        <PrimaryButton
          label="查看團購進度"
          variant="secondary"
          onPress={() => existingOrder
            ? navigation.navigate("OrdersTab", { screen: "customerOrders", params: { orderId: existingOrder.id, historical: false } })
            : navigation.push("groupProgress", { groupBuyActivityId: groupBuyActivity.id })}
        />
      </View>
    </MobileScreen>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  storeCard: { flexDirection: "row", alignItems: "center", gap: spacing.s16, padding: spacing.s12, borderRadius: radii.md },
  storeGlyph: { width: 68, height: 68, borderRadius: radii.sm, backgroundColor: colors.recess, alignItems: "center", justifyContent: "center" },
  shopRoof: { width: 34, height: 13, borderWidth: sizes.stroke, borderColor: colors.accent, borderTopLeftRadius: 8, borderTopRightRadius: 8, transform: [{ skewX: "-12deg" }] },
  shopBody: { width: 30, height: 24, borderWidth: sizes.stroke, borderColor: colors.accent, borderTopWidth: 0, borderBottomLeftRadius: 5, borderBottomRightRadius: 5, alignItems: "center", justifyContent: "flex-end" },
  shopDoor: { width: 9, height: 14, borderWidth: sizes.stroke, borderBottomWidth: 0, borderColor: colors.accent, borderTopLeftRadius: 5, borderTopRightRadius: 5 },
  storeDetails: { flex: 1, gap: spacing.s4 },
  storeHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s4, flexWrap: "wrap" },
  storeName: { ...typeScale.price, color: colors.text, flexShrink: 1 },
  storeInfoRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.s8 },
  infoIcon: { ...typeScale.body, color: colors.textSecondary, width: 14, textAlign: "center" },
  storeMeta: { ...typeScale.bodyDense, color: colors.textSecondary, flex: 1 },
  activityTitle: { ...typeScale.price },
  progressCard: { gap: spacing.s8, borderRadius: radii.md, padding: spacing.s12 },
  progressTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s8 },
  cardHeading: { ...typeScale.sectionTitle, color: colors.text },
  timeRow: { flexDirection: "row", alignItems: "center", gap: spacing.s8 },
  clock: { width: 19, height: 19, borderWidth: sizes.stroke, borderColor: colors.warmInk, borderRadius: radii.pill, alignItems: "center", justifyContent: "center" },
  clockHand: { width: 5, height: 6, borderLeftWidth: 1, borderBottomWidth: 1, borderColor: colors.warmInk },
  timeText: { ...typeScale.bodyDense, color: colors.textSecondary },
  countRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.s8 },
  countNumber: { ...typeScale.pearlNumber, color: colors.text },
  countUnit: { ...typeScale.body, color: colors.textSecondary },
  participants: { ...typeScale.body, color: colors.textSecondary },
  progressRow: { flexDirection: "row", alignItems: "center", gap: spacing.s8 },
  progressTrack: { flex: 1, height: 14, borderRadius: radii.pill, overflow: "hidden", backgroundColor: colors.progressTrack },
  progressFill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.progress },
  progressPercent: { ...typeScale.bodyDense, color: colors.textSecondary },
  nextTier: { ...typeScale.body, color: colors.text },
  schedule: { borderTopWidth: 1, borderColor: colors.lineRow, paddingTop: spacing.s8, gap: spacing.s4 },
  scheduleItem: { flexDirection: "row", gap: spacing.s8, alignItems: "center" },
  scheduleIcon: { ...typeScale.price, width: 22, color: colors.textSecondary },
  scheduleText: { ...typeScale.bodyDense, color: colors.text, flex: 1 },
  tierHeading: { ...typeScale.price, borderLeftWidth: 4, borderColor: colors.warmInk, paddingLeft: spacing.s12 },
  tiersCard: { gap: 0, paddingVertical: 0, paddingHorizontal: spacing.s12, borderRadius: radii.md },
  tierRow: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  tierDivider: { borderTopWidth: 1, borderColor: colors.lineRow },
  tagIcon: { ...typeScale.price, color: colors.accentInk },
  tierText: { ...typeScale.body, color: colors.text, flex: 1 },
  tierValue: { ...typeScale.price, color: colors.accentInk },
  notesCard: { padding: spacing.s12, borderRadius: radii.md },
  notesToggle: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  notesChevron: { ...typeScale.screenTitle, color: colors.textSecondary },
  notes: { gap: spacing.s8 },
  noteText: { ...typeScale.bodyDense, color: colors.textSecondary },
  actions: { gap: spacing.s8 }
});
