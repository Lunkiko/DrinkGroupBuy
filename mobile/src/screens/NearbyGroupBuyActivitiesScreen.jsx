import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ActivitySyncNotice } from "../components/ActivitySyncNotice";
import { DistanceDropdown } from "../components/DistanceDropdown";
import { Icon } from "../components/Icon";
import { MobileScreen } from "../components/MobileScreen";
import { PrimaryButton } from "../components/PrimaryButton";
import { ProgressBar } from "../components/ProgressBar";
import { useDevLocationConfig } from "../hooks/useDevLocationConfig";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { groupBuyActivityStatusLabels } from "../types/prototypeTypes";
import { formatDealFactorLabel } from "../utils/discountPercentFormat";
import { calculateDistanceKm, formatDistanceKm } from "../utils/distance";
import { getGroupBuyActivityStore } from "../utils/groupBuyActivityStores";
import { getGroupBuyActivityDiscountInfo, getGroupBuyActivityProgress } from "../utils/groupBuyActivityProgress";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

export function NearbyGroupBuyActivitiesScreen({ navigation, appState, actions, currentUserProfile, selectedCustomerId, selectedAuthUserId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { groupBuyActivities, orders } = appState;
  const activitySyncStatus = appState.groupBuyActivitySyncStatus ?? "idle";
  const [radiusKm, setRadiusKm] = useState(null);
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
  const activeStore = getGroupBuyActivityStore(activeGroupBuyActivity);
  const activeProgress = activeGroupBuyActivity ? getGroupBuyActivityProgress(activeGroupBuyActivity) : null;

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
          <Text accessibilityRole="header" style={styles.sectionTitle}>進行中的團購</Text>
          {activeGroupBuyActivity ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("OrdersTab")}
              style={styles.viewAllLink}
            >
              <Text style={styles.viewAllText}>查看全部</Text>
              <Icon color={colors.accentInk} name="chevronRight" size={20} />
            </Pressable>
          ) : null}
        </View>

        {activeGroupBuyActivity && activeProgress ? (
          <ActiveGroupBuyCard
            groupBuyActivity={activeGroupBuyActivity}
            onOpen={() => navigation.push("groupBuyActivityDetail", { groupBuyActivityId: activeGroupBuyActivity.id })}
            progress={activeProgress}
            storeName={activeStore?.name ?? "店家資料未提供"}
          />
        ) : (
          <EmptyCard
            description="加入團購後，進行中的訂單會顯示在這裡。"
            icon="bag"
            title="目前沒有進行中的團購"
          />
        )}
      </View>

      <View style={styles.sectionBlock}>
        <View style={styles.nearbyHeader}>
          <View style={styles.nearbyTitleWrap}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>附近的團購</Text>
          </View>
          <DistanceDropdown onChange={setRadiusKm} value={radiusKm} />
        </View>

        {recruitingGroupBuyActivitiesWithDistance.length === 0 ? (
          <EmptyCard
            description={radiusKm != null ? "試試調整距離，看看附近的活動" : undefined}
            icon="pin"
            title="目前沒有招募中的團購"
          />
        ) : (
          <View>
            {recruitingGroupBuyActivitiesWithDistance.map(({ groupBuyActivity, distanceKm }, index) => {
              const store = getGroupBuyActivityStore(groupBuyActivity);
              const progress = getGroupBuyActivityProgress(groupBuyActivity);
              const distanceText = formatDistanceKm(distanceKm);
              const nextTier = findTierByCups(groupBuyActivity, progress.nextTarget);
              const metaText = [
                distanceText ? `距離 ${distanceText}` : null,
                progress.remainingCups > 0 ? `尚差 ${progress.remainingCups} 杯` : null
              ].filter(Boolean).join(" · ");
              const isLast = index === recruitingGroupBuyActivitiesWithDistance.length - 1;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={groupBuyActivity.id}
                  onPress={() => navigation.push("groupBuyActivityDetail", { groupBuyActivityId: groupBuyActivity.id })}
                  style={({ pressed }) => [styles.nearbyRow, !isLast && styles.nearbyRowDivider, pressed && styles.pressed]}
                >
                  <View style={styles.logoTile}>
                    <Text style={styles.logoText}>{(store?.name ?? "店").slice(0, 1)}</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text numberOfLines={1} style={styles.nearbyStore}>{store?.name ?? "店家資料未提供"}</Text>
                    {metaText ? <Text numberOfLines={1} style={styles.nearbyMeta}>{metaText}</Text> : null}
                    {nextTier ? (
                      <Text numberOfLines={1} style={styles.nearbyOffer}>
                        滿 {progress.nextTarget} 杯享 {formatDealWithSpace(nextTier.discountPercent)}
                      </Text>
                    ) : null}
                  </View>
                  <Icon color={colors.textSecondary} name="chevronRight" size={26} />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </MobileScreen>
  );
}

// The "in progress" card: store and countdown, title and status, cups and discount, the amber progress
// bar with a hint line, and one button. A closed activity swaps the red countdown for a grey "已截止".
function ActiveGroupBuyCard({ groupBuyActivity, progress, storeName, onOpen }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  // "已成團" (confirmed) still takes orders until the deadline, so "open" is not just status === recruiting.
  const isOpen = ["recruiting", "confirmed"].includes(groupBuyActivity.status) && groupBuyActivity.canJoin !== false;
  const isRecruiting = isOpen && groupBuyActivity.status === "recruiting";
  const pickupReady = groupBuyActivity.status === "ready_for_pickup";
  const discount = getGroupBuyActivityDiscountInfo(groupBuyActivity);
  const nextTier = findTierByCups(groupBuyActivity, progress.nextTarget);
  const statusLabel = groupBuyActivityStatusLabels[groupBuyActivity.status] ?? groupBuyActivity.status;

  let hint = null;
  if (isOpen && nextTier && progress.remainingCups > 0) {
    hint = `再 ${progress.remainingCups} 杯解鎖 ${formatDealWithSpace(nextTier.discountPercent)}`;
  } else if (isOpen) {
    hint = "已達最高優惠級距";
  } else if (pickupReady) {
    hint = "團購已截止，飲品已備妥";
  } else {
    hint = "團購已截止";
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <Text numberOfLines={1} style={[styles.storeName, styles.flex]}>{storeName}</Text>
        {isOpen && groupBuyActivity.remainingTimeText ? (
          <View style={styles.inline}>
            <Icon color={colors.alert} name="clock" size={22} />
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.countdownText}>{groupBuyActivity.remainingTimeText}</Text>
          </View>
        ) : null}
        {!isOpen ? (
          <View style={styles.inline}>
            <Icon color={colors.textSecondary} name="clock" size={22} />
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.closedText}>已截止</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.cardRow}>
        <Text style={[styles.activityTitle, styles.flex]}>{groupBuyActivity.title}</Text>
        {isRecruiting ? (
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.recruitingText}>{statusLabel}</Text>
        ) : (
          <View style={styles.inline}>
            {pickupReady || (isOpen && !isRecruiting) ? <Icon color={colors.accent} name="check" size={22} /> : null}
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.stateText}>{statusLabel}</Text>
          </View>
        )}
      </View>

      <View style={styles.cardRow}>
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cupCount}>
          {progress.currentCups} / {progress.nextTarget} 杯
        </Text>
        {discount.isQualified ? (
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.discountText}>
            {discount.isEstimated ? "預估享" : "最終享"} {formatDealWithSpace(discount.currentTierDiscountPercent)}
          </Text>
        ) : (
          <Text style={styles.noDiscountText}>尚未達到優惠門檻</Text>
        )}
      </View>

      <ProgressBar percent={progress.progressPercent} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      <PrimaryButton label="查看團購" onPress={onOpen} />
    </View>
  );
}

// Centred card with a soft-blue disc holding a line picture, for "nothing here yet".
function EmptyCard({ icon, title, description }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyDisc}>
        <Icon color={colors.accent} name={icon} size={44} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.emptyDescription}>{description}</Text> : null}
    </View>
  );
}

function findTierByCups(groupBuyActivity, cups) {
  return (groupBuyActivity.tiers ?? []).find((tier) => Number(tier.cups ?? tier.targetCups) === Number(cups)) ?? null;
}

// "9折" -> "9 折", "8.5折" -> "8.5 折": the blueprint puts a space before 折.
function formatDealWithSpace(discountPercent) {
  const label = formatDealFactorLabel(discountPercent);
  return label ? label.replace(/折$/, " 折") : "—";
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
    gap: spacing.s16,
    paddingTop: spacing.s32
  },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  avatarText: {
    ...typeScale.screenTitle,
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
    ...typeScale.body,
    color: colors.textSecondary
  },
  sectionBlock: {
    gap: spacing.s12
  },
  sectionHeader: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: {
    ...typeScale.screenTitle,
    color: colors.text
  },
  viewAllLink: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s4,
    paddingLeft: spacing.s12
  },
  viewAllText: {
    ...typeScale.button,
    color: colors.accentInk
  },
  card: {
    gap: spacing.s12,
    padding: spacing.s20,
    borderRadius: radii.lg,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  storeName: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  countdownText: {
    ...typeScale.button,
    color: colors.text
  },
  closedText: {
    ...typeScale.button,
    color: colors.textSecondary
  },
  activityTitle: {
    ...typeScale.screenTitle,
    fontSize: 22,
    lineHeight: 30,
    color: colors.text
  },
  recruitingText: {
    ...typeScale.price,
    color: colors.warm
  },
  stateText: {
    ...typeScale.price,
    color: colors.accent
  },
  cupCount: {
    ...typeScale.body,
    fontSize: 20,
    lineHeight: 28,
    color: colors.textSecondary
  },
  discountText: {
    ...typeScale.price,
    color: colors.warm
  },
  noDiscountText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  hint: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  pressed: {
    opacity: 0.8
  },
  flex: {
    flex: 1
  },
  nearbyHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.s12
  },
  nearbyTitleWrap: {
    minHeight: sizes.tap,
    justifyContent: "center"
  },
  nearbyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s16,
    paddingVertical: spacing.s12
  },
  nearbyRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow
  },
  logoTile: {
    width: 76,
    height: 76,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  logoText: {
    ...typeScale.pearlNumber,
    color: colors.accent
  },
  nearbyStore: {
    ...typeScale.price,
    color: colors.text
  },
  nearbyMeta: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  nearbyOffer: {
    ...typeScale.price,
    color: colors.text
  },
  emptyCard: {
    alignItems: "center",
    gap: spacing.s12,
    paddingVertical: spacing.s24,
    paddingHorizontal: spacing.s20,
    borderRadius: radii.lg,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  emptyDisc: {
    width: 86,
    height: 86,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  emptyTitle: {
    ...typeScale.screenTitle,
    fontSize: 20,
    lineHeight: 28,
    textAlign: "center",
    color: colors.text
  },
  emptyDescription: {
    ...typeScale.body,
    textAlign: "center",
    color: colors.textSecondary
  }
});
