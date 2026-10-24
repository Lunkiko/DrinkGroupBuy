import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { Card } from "../components/Card";
import { DistanceRadiusFilter } from "../components/DistanceRadiusFilter";
import { MobileScreen, Section } from "../components/MobileScreen";
import { StatusBadge } from "../components/StatusBadge";
import { useDevLocationConfig } from "../hooks/useDevLocationConfig";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { formatDealFactorLabel } from "../utils/discountPercentFormat";
import { calculateDistanceKm, formatDistanceKm } from "../utils/distance";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { getGroupBuyActivityDiscountInfo, getGroupBuyActivityProgress } from "../utils/groupBuyActivityProgress";
import { useThemedStyles } from "../theme/ThemeContext";

export function NearbyGroupBuyActivitiesScreen({ navigation, appState, actions, currentUserProfile, selectedCustomerId, selectedAuthUserId }) {
  const styles = useThemedStyles(makeStyles);
  const { groupBuyActivities, orders } = appState;
  const activitySyncStatus = appState.groupBuyActivitySyncStatus ?? "idle";
  const [radiusKm, setRadiusKm] = useState(1);
  const [radiusMenuOpen, setRadiusMenuOpen] = useState(false);
  const { config: locationConfig } = useDevLocationConfig(selectedAuthUserId);
  const [userPosition, setUserPosition] = useState(locationConfig.fixedLocation);

  // useFocusEffect (not useEffect): tabs stay mounted, so a plain effect would keep GPS watching
  // after this tab loses focus. Watching starts on focus and is torn down on every blur.
  useFocusEffect(useCallback(() => {
    const fallbackPosition = locationConfig.fixedLocation;
    // In live mode the previous position is kept while waiting for a new fix (this effect re-runs on
    // every re-focus of the tab); only the cases that will never produce a fix fall back to the fixed
    // location, so returning to this screen doesn't briefly jump to the default position.
    if (locationConfig.locationMode !== "live") {
      setUserPosition(fallbackPosition);
      return undefined;
    }

    if (Platform.OS === "web") {
      if (!navigator.geolocation) {
        setUserPosition(fallbackPosition);
        return undefined;
      }
      const watchId = navigator.geolocation.watchPosition(
        (position) => setUserPosition({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        () => setUserPosition(fallbackPosition),
        { enableHighAccuracy: false }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }

    let active = true;
    let locationSubscription = null;
    (async () => {
      const Location = await import("expo-location");
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!active) return;
      if (permission.status !== "granted") {
        setUserPosition(fallbackPosition);
        return;
      }
      const currentPosition = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!active) return;
      setUserPosition({ latitude: currentPosition.coords.latitude, longitude: currentPosition.coords.longitude });
      locationSubscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 3000 },
        (nextPosition) => {
          if (!active) return;
          setUserPosition({ latitude: nextPosition.coords.latitude, longitude: nextPosition.coords.longitude });
        }
      );
      if (!active) locationSubscription.remove();
    })().catch(() => setUserPosition(fallbackPosition));
    return () => {
      active = false;
      locationSubscription?.remove();
    };
  }, [locationConfig.locationMode, locationConfig.fixedLocation.latitude, locationConfig.fixedLocation.longitude]));

  const referencePosition = userPosition;
  const recruitingGroupBuyActivitiesWithDistance = useMemo(() => {
    const withDistance = groupBuyActivities
      .filter(isVisibleRecruitingGroupBuyActivity)
      .map((groupBuyActivity) => {
        const store = getGroupBuyActivityStore(groupBuyActivity);
        return { groupBuyActivity, distanceKm: calculateDistanceKm(referencePosition, store) };
      });
    withDistance.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
    return radiusKm == null
      ? withDistance
      : withDistance.filter((item) => item.distanceKm != null && item.distanceKm <= radiusKm);
  }, [groupBuyActivities, radiusKm, referencePosition.latitude, referencePosition.longitude]);
  const joinedGroupBuyActivityIds = new Set(
    (orders ?? [])
      .filter((order) => order.customerId === selectedCustomerId && isActiveJoinedOrder(order))
      .map((order) => order.groupBuyActivityId)
  );
  const activeGroupBuyActivity = groupBuyActivities.find((groupBuyActivity) => joinedGroupBuyActivityIds.has(groupBuyActivity.id) && isOngoingJoinedGroupBuyActivity(groupBuyActivity)) ?? null;
  const activeOrder = activeGroupBuyActivity
    ? orders.find((order) => order.customerId === selectedCustomerId && order.groupBuyActivityId === activeGroupBuyActivity.id && isActiveJoinedOrder(order))
    : null;
  const activeStore = getGroupBuyActivityStore(activeGroupBuyActivity);
  const activeProgress = activeGroupBuyActivity ? getGroupBuyActivityProgress(activeGroupBuyActivity) : null;
  const activeDiscount = activeGroupBuyActivity ? getGroupBuyActivityDiscountInfo(activeGroupBuyActivity) : null;
  const hasNearbyActivities = recruitingGroupBuyActivitiesWithDistance.length > 0;

  return (
    <MobileScreen>
      <View style={styles.memberRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(currentUserProfile?.displayName || "會").slice(0, 1)}</Text>
        </View>
        <View style={styles.memberInfo}>
          <Text numberOfLines={1} style={styles.memberName}>{currentUserProfile?.displayName || "顧客"}</Text>
          {currentUserProfile?.email ? (
            <Text numberOfLines={1} style={styles.memberSubtitle}>{currentUserProfile.email}</Text>
          ) : null}
        </View>
      </View>

      <ActivitySyncNotice
        status={activitySyncStatus}
        onRetry={() => actions.syncGroupBuyActivities().catch(() => {})}
      />

      <View style={styles.sectionBlock}>
        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, styles.featureTitle]}>進行中的團購</Text>
          {activeGroupBuyActivity ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("OrdersTab", { screen: "customerOrders", params: { orderId: activeOrder.id, historical: false } })}
              style={styles.manageLink}
            >
              <Text style={styles.manageLinkText}>查看進度 ›</Text>
            </Pressable>
          ) : null}
        </View>

        {activeGroupBuyActivity && activeProgress ? (
          <Card
            onPress={() => navigation.push("groupBuyActivityDetail", { groupBuyActivityId: activeGroupBuyActivity.id })}
            style={styles.activeCard}
          >
            <View style={styles.activeTopRow}>
              <Text style={styles.activeStore} numberOfLines={1}>{activeStore?.name ?? "店家資料未提供"}</Text>
              {activeGroupBuyActivity.remainingTimeText ? (
                <View style={styles.activeTimeWrap}>
                  <View style={styles.clockIcon}><View style={styles.clockHand} /></View>
                  <Text style={styles.activeTime}>{activeGroupBuyActivity.remainingTimeText}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.activeTitleRow}>
              <Text style={styles.activityTitle}>{activeGroupBuyActivity.title}</Text>
              {activeGroupBuyActivity.status === "recruiting"
                ? <Text style={styles.recruitingLabel}>招募中</Text>
                : <StatusBadge owner="groupBuyActivity" value={activeGroupBuyActivity.status} />}
            </View>
            <View style={styles.activeProgressRow}>
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cupCount}>
                {activeProgress.currentCups} / {activeProgress.nextTarget} 杯
              </Text>
              <Text style={styles.activeDiscount}>
                {activeDiscount?.isQualified
                  ? `${activeDiscount.isEstimated ? "預估享" : "已享"} ${formatDealFactorLabel(activeDiscount.currentTierDiscountPercent)}`
                  : "尚未達優惠門檻"}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${activeProgress.progressPercent}%` }]} />
            </View>
            <Text style={styles.meta}>
              {getTargetSummary(activeGroupBuyActivity, activeProgress.nextTarget)}・還差 {activeProgress.remainingCups} 杯
            </Text>
            <View style={styles.activeAction}>
              <Text style={styles.activeActionText}>查看團購</Text>
            </View>
          </Card>
        ) : (
          <HomeEmptyCard
            kind="bag"
            title="目前沒有進行中的團購"
            description="加入團購後，進行中的訂單會顯示在這裡。"
          />
        )}
      </View>

      <Section
        title="附近的團購"
        titleStyle={styles.featureTitle}
        headerRight={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="選擇附近團購距離"
            onPress={() => setRadiusMenuOpen((open) => !open)}
            style={styles.radiusButton}
          >
            <Text style={styles.radiusButtonText}>
              {radiusKm == null ? "不限距離" : radiusKm < 1 ? "500 公尺內" : `${radiusKm} 公里內`}⌄
            </Text>
          </Pressable>
        )}
      >
        {radiusMenuOpen ? (
          <DistanceRadiusFilter
            onChange={(nextRadius) => { setRadiusKm(nextRadius); setRadiusMenuOpen(false); }}
            value={radiusKm}
          />
        ) : null}
        <View style={styles.recommendList}>
          {recruitingGroupBuyActivitiesWithDistance.map(({ groupBuyActivity, distanceKm }, index) => {
            const store = getGroupBuyActivityStore(groupBuyActivity);
            const progress = getGroupBuyActivityProgress(groupBuyActivity);
            const distanceText = formatDistanceKm(distanceKm);
            return (
              <Card
                compact
                key={groupBuyActivity.id}
                onPress={() => navigation.push("groupBuyActivityDetail", { groupBuyActivityId: groupBuyActivity.id })}
                style={styles.recommendRow}
              >
                <Image
                  source={index % 2 === 0
                    ? require("../../assets/store-leaf-demo.png")
                    : require("../../assets/store-orange-demo.png")}
                  style={styles.storeImage}
                />
                <View style={styles.recommendText}>
                  <Text style={styles.recommendStore}>{store?.name ?? "店家資料未提供"}</Text>
                  <Text style={styles.recommendTitle}>
                    {distanceText ? `距離 ${distanceText} · ` : ""}還差 {progress.remainingCups} 杯
                  </Text>
                  <Text style={styles.recommendOffer}>{getTargetSummary(groupBuyActivity, progress.nextTarget)}</Text>
                </View>
                <Text style={styles.recommendArrow}>›</Text>
              </Card>
            );
          })}
          {!hasNearbyActivities ? (
            <HomeEmptyCard
              kind="pin"
              title="目前沒有招募中的團購"
              description="試試調整距離，看看附近的活動"
            />
          ) : null}
        </View>
      </Section>
    </MobileScreen>
  );
}

function HomeEmptyCard({ kind, title, description }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyIconCircle} accessibilityLabel={kind === "bag" ? "購物袋圖示" : "地點圖示"}>
        {kind === "bag" ? (
          <View style={styles.bagIcon}>
            <View style={styles.bagHandle} />
            <View style={styles.bagBody} />
          </View>
        ) : (
          <View style={styles.pinIcon}>
            <View style={styles.pinRing}><View style={styles.pinDot} /></View>
            <View style={styles.pinPoint} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={styles.emptyTitle}>{title}</Text>
      <Text numberOfLines={1} style={styles.emptyDescription}>{description}</Text>
    </View>
  );
}

function getTargetSummary(groupBuyActivity, targetCups) {
  const tier = (groupBuyActivity.tiers ?? []).find((item) => Number(item.cups ?? item.targetCups) === Number(targetCups));
  const discountPercent = tier?.discountPercent ?? groupBuyActivity.tiers?.[0]?.discountPercent ?? 0;
  return `滿 ${targetCups} 杯享 ${formatDealFactorLabel(discountPercent) || "—"}`;
}

function isVisibleRecruitingGroupBuyActivity(groupBuyActivity) {
  return ["recruiting", "confirmed"].includes(groupBuyActivity.status)
    && groupBuyActivity.canJoin !== false
    && !groupBuyActivity.cancellationReason;
}

function isActiveJoinedOrder(order) {
  return !["cancelled", "completed"].includes(order.status);
}

function isOngoingJoinedGroupBuyActivity(groupBuyActivity) {
  return !["cancelled", "completed", "failed"].includes(groupBuyActivity.status)
    && !groupBuyActivity.cancellationReason;
}

const makeStyles = (colors) => StyleSheet.create({
  // This screen has no title row, so without the extra top padding the avatar sat 8px from the top
  // edge (MobileScreen's own top padding); the merchant home has a header row above its store row.
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    paddingTop: spacing.s32
  },
  avatar: {
    width: sizes.tap,
    height: sizes.tap,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  avatarText: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  memberInfo: {
    flex: 1
  },
  memberName: {
    ...typeScale.screenTitle,
    color: colors.text
  },
  memberSubtitle: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  sectionBlock: {
    gap: spacing.s12
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  featureTitle: {
    ...typeScale.screenTitle
  },
  manageLink: {
    minHeight: sizes.tap,
    justifyContent: "center",
    paddingLeft: spacing.s12
  },
  manageLinkText: {
    ...typeScale.bodyDense,
    fontWeight: "700",
    color: colors.accentInk
  },
  emptyCard: {
    minHeight: 208,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s12,
    paddingHorizontal: spacing.s16,
    paddingVertical: spacing.s20,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  emptyIconCircle: {
    width: 88,
    height: 88,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  bagIcon: { width: 46, height: 54 },
  bagHandle: {
    position: "absolute", top: 2, left: 12, width: 22, height: 26,
    borderWidth: 3, borderColor: colors.accent, borderRadius: radii.pill
  },
  bagBody: {
    position: "absolute", top: 20, width: 46, height: 32,
    borderWidth: 3, borderColor: colors.accent, borderRadius: radii.xs,
    backgroundColor: colors.recess
  },
  pinIcon: { width: 44, height: 55, alignItems: "center" },
  pinRing: {
    width: 42, height: 42, borderRadius: radii.pill,
    borderWidth: 3, borderColor: colors.accent,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.recess
  },
  pinDot: { width: 12, height: 12, borderRadius: radii.pill, borderWidth: 3, borderColor: colors.accent },
  pinPoint: {
    position: "absolute", top: 36,
    borderLeftWidth: 11, borderRightWidth: 11, borderTopWidth: 17,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: colors.accent
  },
  emptyTitle: { ...typeScale.price, color: colors.text, textAlign: "center" },
  emptyDescription: { ...typeScale.caption, color: colors.textSecondary, textAlign: "center" },
  activeCard: {
    gap: spacing.s16
  },
  activeTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  activeStore: {
    ...typeScale.body,
    color: colors.textSecondary,
    flex: 1
  },
  activeTimeWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  clockIcon: {
    width: spacing.s20,
    height: spacing.s20,
    borderWidth: sizes.stroke,
    borderColor: colors.warmInk,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center"
  },
  clockHand: {
    width: spacing.s4,
    height: spacing.s8,
    borderLeftWidth: sizes.stroke,
    borderBottomWidth: sizes.stroke,
    borderColor: colors.warmInk,
    transform: [{ translateX: 1 }, { translateY: -1 }]
  },
  activeTime: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  activeTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  activityTitle: {
    ...typeScale.screenTitle,
    color: colors.text,
    flex: 1
  },
  recruitingLabel: {
    ...typeScale.button,
    color: colors.warmInk
  },
  activeProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  cupCount: {
    ...typeScale.price,
    color: colors.textSecondary
  },
  activeDiscount: {
    ...typeScale.button,
    color: colors.warmInk
  },
  progressTrack: {
    height: spacing.s12,
    borderRadius: radii.pill,
    backgroundColor: colors.progressTrack,
    overflow: "hidden"
  },
  progressFill: {
    height: "100%",
    borderRadius: radii.pill,
    backgroundColor: colors.progress
  },
  activeAction: {
    minHeight: sizes.buttonHeight,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: sizes.buttonRadius,
    backgroundColor: colors.accent
  },
  activeActionText: {
    ...typeScale.button,
    color: colors.onAccent
  },
  meta: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  recommendList: {
    gap: 0
  },
  radiusButton: {
    minHeight: sizes.tap,
    justifyContent: "center",
    paddingLeft: spacing.s8
  },
  radiusButtonText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  recommendRow: {
    minHeight: 104,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    paddingHorizontal: 0,
    borderWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow,
    borderRadius: 0
  },
  storeImage: {
    width: 72,
    height: 72,
    borderRadius: radii.sm,
    backgroundColor: colors.recess
  },
  recommendText: {
    flex: 1,
    gap: spacing.s4
  },
  recommendStore: {
    ...typeScale.button,
    color: colors.text
  },
  recommendTitle: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  recommendOffer: {
    ...typeScale.bodyDense,
    color: colors.text,
    fontWeight: "700"
  },
  recommendArrow: {
    ...typeScale.screenTitle,
    color: colors.textSecondary
  }
});
