import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "./Card";
import { OrderDetailIcon } from "./OrderDetailIcon";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";
import { formatDealFactorLabel } from "../utils/discountPercentFormat";

const STEPS = ["等待成團", "製作中", "可取餐", "已完成"];

export function getOrderStage(order) {
  if (order.status === "completed" || order.pickupStatus === "picked_up") return 3;
  if (order.pickupStatus === "ready") return 2;
  if (order.pickupStatus === "preparing" || order.paymentStatus === "captured") return 1;
  return 0;
}

export function OrderJourneyCard({ order, historical, activity, historyReason }) {
  const styles = useThemedStyles(makeStyles);
  const stage = getOrderStage(order);
  const headline = historical && stage !== 3 ? historyReason : order.paymentStatus === "pending" ? "尚待完成付款授權。"
    : order.paymentStatus === "failed" ? "付款未完成，請查看付款狀態。"
      : ["已完成付款授權，正在等待團購截止。", "已成團，店家製作中。", "前往店家並出示取餐碼取餐。", "已取餐，訂單完成。"][stage];
  return (
    <Card style={styles.journeyCard}>
      <View style={styles.journeyTitleRow}>
        <View style={styles.storeIcon}><OrderDetailIcon name="store" size={32} /></View>
        <Text style={styles.journeyTitle}>{headline}</Text>
      </View>
      {(!historical || stage === 3) ? <View style={styles.steps}>
        {STEPS.map((label, index) => (
          <View key={label} style={styles.step}>
            <View style={styles.stepTrack}>
              {index > 0 ? <View style={[styles.lineBefore, index <= stage && styles.lineDone]} /> : null}
              <View style={[styles.stepCircle, (index < stage || stage === 3) && styles.stepDone, index === stage && stage !== 3 && styles.stepCurrent]}>
                <Text style={[styles.stepMark, (index < stage || stage === 3) && styles.stepMarkDone]}>{index < stage || stage === 3 ? "✓" : index === stage ? "●" : ""}</Text>
              </View>
            </View>
            <Text style={[styles.stepLabel, index === stage && styles.stepLabelCurrent]}>{label}</Text>
          </View>
        ))}
      </View> : null}
      {historical && activity?.pickupTime ? (
        <Text style={styles.historyMeta}>取餐時段：{activity.pickupTime}</Text>
      ) : null}
    </Card>
  );
}

export function OrderStoreCard({ store, onDetailPress }) {
  const styles = useThemedStyles(makeStyles);
  const address = store?.address;
  const phone = store?.phone;
  return (
    <Card style={styles.storeCard}>
      {store?.name?.includes("青山手作茶") ? (
        <Image source={require("../../assets/store-leaf-demo.png")} style={styles.storeImage} resizeMode="cover" />
      ) : <View style={styles.storeImagePlaceholder}><OrderDetailIcon name="store" size={30} /></View>}
      <View style={styles.storeText}>
        <Text numberOfLines={2} style={styles.storeName}>{store?.name ?? "店家資料"}</Text>
        {address ? <View style={styles.storeMetaRow}><OrderDetailIcon name="pin" size={16} /><Text numberOfLines={2} style={styles.storeMeta}>{address}</Text></View> : null}
        {phone ? <View style={styles.storeMetaRow}><OrderDetailIcon name="phone" size={16} /><Text style={styles.storeMeta}>{phone}</Text></View> : null}
        {onDetailPress ? <Pressable accessibilityRole="button" onPress={onDetailPress}><Text style={styles.detailLink}>團購詳情 ›</Text></Pressable> : null}
      </View>
      <View style={styles.storeActions}>
        <Pressable accessibilityRole="button" disabled={!address} onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`)} style={styles.storeAction}>
          <OrderDetailIcon name="pin" size={20} /><Text style={styles.actionLabel}>地圖導航</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!phone} onPress={() => Linking.openURL(`tel:${phone}`)} style={styles.storeAction}>
          <OrderDetailIcon name="phone" size={20} /><Text style={styles.actionLabel}>聯絡店家</Text>
        </Pressable>
      </View>
    </Card>
  );
}

export function OrderProgressCard({ activity, progress, stage }) {
  const styles = useThemedStyles(makeStyles);
  if (!activity) return null;
  const waiting = stage === 0;
  const settlement = activity.settlement;
  const cups = settlement?.authorizedCups ?? progress?.currentCups ?? 0;
  const nextTier = (activity.tiers ?? [])
    .map((tier) => Number(tier.cups ?? tier.targetCups))
    .filter((target) => target > cups)
    .sort((a, b) => a - b)[0];
  const deadlineTime = Date.parse(activity.deadlineAt);
  const minutes = Number.isFinite(deadlineTime) ? Math.max(0, Math.ceil((deadlineTime - Date.now()) / 60000)) : null;
  return (
    <Card style={styles.progressCard}>
      {waiting ? (
        <>
          <Text style={styles.cardTitle}>團購進度</Text>
          <View style={styles.progressRow}><Text style={styles.progressCount}>{cups} / {progress?.nextTarget ?? cups} 杯</Text><Text style={styles.progressPercent}>{progress?.progressPercent ?? 0}%</Text></View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress?.progressPercent ?? 0}%` }]} /></View>
          {nextTier ? <Text style={styles.meta}>再 {nextTier - cups} 杯達成下一階優惠門檻</Text> : null}
          <View style={styles.divider} />
          {minutes != null ? <View style={styles.iconTextRow}><View style={styles.smallIconBadge}><OrderDetailIcon name="clock" size={20} /></View><Text style={styles.meta}>剩餘 {minutes} 分鐘</Text></View> : null}
        </>
      ) : stage === 1 ? (
        <>
          <View style={styles.keyValue}><Text style={styles.cardTitle}>最終團購杯數</Text><Text style={styles.keyValueText}>{cups} 杯</Text></View>
          <View style={styles.divider} />
          <View style={styles.keyValue}><Text style={styles.cardTitle}>最終優惠</Text><Text style={styles.keyValueText}>{formatDealFactorLabel(settlement?.discountPercent) || "待結算"}</Text></View>
          <View style={styles.divider} />
        </>
      ) : null}
      <View style={styles.pickupTimeRow}>
        <View style={styles.smallIconBadge}><OrderDetailIcon name="calendar" size={20} /></View>
        <View style={styles.pickupTimeContent}>
          <Text style={styles.pickupTimeLabel}>{stage === 2 ? "取餐時間" : "預計取餐"}</Text>
          <Text style={styles.pickupTime}>{activity.pickupTime ?? "時間待確認"}</Text>
        </View>
      </View>
      {stage <= 1 ? <Text style={styles.meta}>店家備妥飲品後，將在此顯示取餐代碼。</Text> : null}
    </Card>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  journeyCard: { gap: spacing.s20 },
  journeyTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.s16 },
  storeIcon: { width: 52, height: 52, borderRadius: radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.recess },
  journeyTitle: { ...typeScale.sectionTitle, color: colors.text, flex: 1 },
  steps: { flexDirection: "row" },
  step: { flex: 1, alignItems: "center", gap: spacing.s8 },
  stepTrack: { height: 30, width: "100%", alignItems: "center", justifyContent: "center" },
  lineBefore: { position: "absolute", left: "-50%", right: "50%", height: sizes.stroke, backgroundColor: colors.lineInput },
  lineDone: { backgroundColor: colors.accent },
  stepCircle: { width: 26, height: 26, borderRadius: radii.pill, borderWidth: sizes.stroke, borderColor: colors.lineInput, backgroundColor: colors.page, alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  stepCurrent: { borderColor: colors.accent },
  stepMark: { ...typeScale.caption, color: colors.accentInk, lineHeight: 18 },
  stepMarkDone: { color: colors.onAccent },
  stepLabel: { ...typeScale.caption, color: colors.textSecondary, textAlign: "center" },
  stepLabelCurrent: { color: colors.text, fontWeight: "700" },
  historyMeta: { ...typeScale.bodyDense, color: colors.accentInk, borderTopWidth: 1, borderTopColor: colors.lineRow, paddingTop: spacing.s12 },
  storeCard: { flexDirection: "row", alignItems: "center", gap: spacing.s8, padding: spacing.s12 },
  storeImage: { width: 62, height: 62, borderRadius: radii.sm },
  storeImagePlaceholder: { width: 62, height: 62, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.recess },
  storeText: { flex: 1, minWidth: 0, gap: spacing.s4 },
  storeName: { ...typeScale.bodyDense, fontWeight: "700", color: colors.text },
  storeMetaRow: { flexDirection: "row", alignItems: "center", gap: spacing.s4 },
  storeMeta: { ...typeScale.caption, color: colors.textSecondary, flexShrink: 1 },
  detailLink: { ...typeScale.caption, color: colors.textSecondary, textDecorationLine: "underline" },
  storeActions: { width: 92, alignItems: "flex-end", gap: spacing.s4, borderLeftWidth: 1, borderLeftColor: colors.lineRow, paddingLeft: spacing.s4 },
  storeAction: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: spacing.s4 },
  actionLabel: { ...typeScale.bodyDense, color: colors.text },
  progressCard: { gap: spacing.s12 },
  cardTitle: { ...typeScale.sectionTitle, color: colors.text },
  progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  progressCount: { ...typeScale.screenTitle, color: colors.text },
  progressPercent: { ...typeScale.body, color: colors.textSecondary },
  progressTrack: { height: 10, borderRadius: radii.pill, backgroundColor: colors.recess, overflow: "hidden" },
  progressFill: { height: 10, borderRadius: radii.pill, backgroundColor: colors.accent },
  divider: { height: 1, backgroundColor: colors.lineRow },
  iconTextRow: { flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  pickupTimeRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.s12 },
  smallIconBadge: { width: 32, height: 32, borderRadius: radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.recess, flexShrink: 0 },
  pickupTimeContent: { flex: 1, minWidth: 0 },
  pickupTimeLabel: { ...typeScale.bodyDense, color: colors.textSecondary },
  meta: { ...typeScale.bodyDense, color: colors.textSecondary },
  keyValue: { flexDirection: "row", justifyContent: "space-between", gap: spacing.s12 },
  keyValueText: { ...typeScale.sectionTitle, color: colors.text },
  pickupTime: { ...typeScale.body, color: colors.accentInk, flexShrink: 1 }
});
