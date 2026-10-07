import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import * as Location from "expo-location";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { ActivityFilterPanel } from "../components/ActivityFilterPanel";
import { Card } from "../components/Card";
import { PrimaryButton } from "../components/PrimaryButton";
import { useActivityMapFilters } from "../hooks/useActivityMapFilters";
import { useDevLocationConfig } from "../hooks/useDevLocationConfig";
import { mapCenter, mapDefaults, markerLabelSettleMs } from "../mock/mapConfig";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { reportAppliedDevLocation } from "../utils/devLocationControl";
import { buildStoreMapStores, getStoreMapDestination, getStoreMarkerLabel } from "../utils/groupBuyActivityStores";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { DARK_MAP_STYLE, LIGHT_MAP_STYLE } from "../theme/mapStyles";

// Android turns pinColor into a hue only (react-native-maps: Color.colorToHSV -> defaultMarker(hue)),
// so these are each just the hue of the named colour, not an exact match to it. Fixed values per
// explicit user decision, not theme tokens like colors.accent/colors.text (which these used to be)
// -- they need to read the same in light and dark mode. The recruiting/no-recruiting difference is
// always also drawn on the label under the pin (solid vs hollow dot), so pin colour was already a
// secondary signal, free to pick for contrast rather than theme consistency.
const RECRUITING_PIN_COLOR = "yellow";
const IDLE_PIN_COLOR = "cyan";

export function LiveMapScreen({ navigation, appState, selectedAuthUserId }) {
  const styles = useThemedStyles(makeStyles);
  const { isDark } = useTheme();
  const mapRef = useRef(null);
  const lastReportSignatureRef = useRef("");
  // True once a real GPS fix has been received. This effect re-runs on every re-focus of the tab, and
  // while the next fix is pending the last known position is kept instead of jumping back to the
  // fixed fallback location.
  const hasRealFixRef = useRef(false);
  const zoom = mapDefaults.zoom;
  // Store-name labels are rendered as plain absolutely-positioned Views on top of the map, not as
  // Marker children -- react-native-maps' custom-marker-content path is known to be unreliable on
  // Android under the New Architecture (this project hit a related blank-map bug upgrading to Expo
  // SDK 57, see PROGRESS.md 2026-08-19). Positions come from mapRef.pointForCoordinate(), the same
  // projection API the plain overlay buttons below already rely on implicitly via screen layout.
  const [markerLabelPositions, setMarkerLabelPositions] = useState({});
  // True while the camera is moving. The labels are plain Views placed from projected coordinates, so
  // while the map is dragged they would trail the pins; Google's own labels are drawn inside the map
  // engine and cannot trail, ours can. So the labels are hidden for the duration of a move and shown again
  // at the new position once the camera settles (same behaviour on the web preview).
  const [isMapMoving, setIsMapMoving] = useState(false);
  const settleTimerRef = useRef(null);
  const [selectedStoreId, setSelectedStoreId] = useState(null);
  const [filteredOutStoreName, setFilteredOutStoreName] = useState(null);
  const [locationPermission, setLocationPermission] = useState("not_required");
  const [userPosition, setUserPosition] = useState({
    latitude: mapCenter.latitude,
    longitude: mapCenter.longitude
  });
  const { config, enabled: devControlEnabled } = useDevLocationConfig(selectedAuthUserId);
  // Dev builds keep using the console's config exactly as before; everywhere else, always try
  // for the real device position -- Android/iOS already show their own native "allow location"
  // prompt, so there's no need for an extra in-app explanation screen ahead of it. If the person
  // denies, the banner below (driven by locationPermission) is what nudges them to go turn it on.
  const effectiveLocationMode = devControlEnabled ? config.locationMode : "live";
  const mapStores = useMemo(
    () => buildStoreMapStores(appState?.stores, appState?.groupBuyActivities),
    [appState?.stores, appState?.groupBuyActivities]
  );
  const {
    filters,
    visibleMapStores,
    visibleStoreIds,
    filterPanelVisible,
    openFilterPanel,
    closeFilterPanel,
    applyFilters
  } = useActivityMapFilters(mapStores, userPosition);
  const selectedStore = mapStores.find((store) => store.id === selectedStoreId);
  const hasRealLocation = effectiveLocationMode === "live" && locationPermission === "granted";
  const locationName = hasRealLocation ? "手機即時位置" : config.fixedLocation.name;

  useEffect(() => {
    if (selectedStoreId && !visibleStoreIds.has(selectedStoreId)) {
      setFilteredOutStoreName(mapStores.find((store) => store.id === selectedStoreId)?.name ?? null);
      setSelectedStoreId(null);
    }
  }, [visibleStoreIds, selectedStoreId, mapStores]);

  // useFocusEffect (not useEffect): with react-navigation keeping every tab mounted, a plain
  // useEffect would leave GPS watching running forever once started, even while this tab is in
  // the background -- a battery drain that didn't exist under the old navigator, which unmounted
  // screens on tab switch. This re-runs the same setup on focus and tears the subscription down
  // (not just on unmount, but on every blur) so watching only happens while the map is on screen.
  useFocusEffect(
    useCallback(() => {
    let active = true;
    let locationSubscription = null;
    const fallbackPosition = {
      latitude: config.fixedLocation.latitude,
      longitude: config.fixedLocation.longitude
    };

    const reportApplied = (permission) => {
      if (!devControlEnabled || !selectedAuthUserId) return;
      const signature = `${selectedAuthUserId}:${config.version}:${permission}`;
      if (lastReportSignatureRef.current === signature) return;
      lastReportSignatureRef.current = signature;
      reportAppliedDevLocation({
        userId: selectedAuthUserId,
        config,
        locationPermission: permission
      }).catch(() => {});
    };

    async function applyLocationConfig() {
      if (effectiveLocationMode !== "live" || !hasRealFixRef.current) {
        hasRealFixRef.current = false;
        setUserPosition(fallbackPosition);
      }
      if (effectiveLocationMode !== "live") {
        setLocationPermission("not_required");
        reportApplied("not_required");
        return;
      }

      setLocationPermission((current) => (current === "granted" ? current : "requesting"));
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!active) return;
        if (permission.status !== "granted") {
          hasRealFixRef.current = false;
          setUserPosition(fallbackPosition);
          setLocationPermission("denied");
          reportApplied("denied");
          return;
        }

        const currentPosition = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!active) return;
        setUserPosition({ latitude: currentPosition.coords.latitude, longitude: currentPosition.coords.longitude });
        hasRealFixRef.current = true;
        setLocationPermission("granted");
        reportApplied("granted");

        locationSubscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 3000 },
          (nextPosition) => {
            if (!active) return;
            setUserPosition({ latitude: nextPosition.coords.latitude, longitude: nextPosition.coords.longitude });
          }
        );
        if (!active) locationSubscription.remove();
      } catch {
        if (!active) return;
        setLocationPermission("error");
        reportApplied("error");
      }
    }

    applyLocationConfig();
    return () => {
      active = false;
      locationSubscription?.remove();
    };
    }, [
      config.fixedLocation.latitude,
      config.fixedLocation.longitude,
      config.version,
      devControlEnabled,
      effectiveLocationMode,
      selectedAuthUserId
    ])
  );

  const recenterOnUser = () => {
    mapRef.current?.animateCamera({ center: userPosition, zoom }, { duration: 350 });
  };

  useEffect(() => {
    recenterOnUser();
  }, [userPosition, zoom]);

  const recomputeMarkerLabelPositions = async () => {
    if (!mapRef.current) return;
    const results = await Promise.all(
      visibleMapStores.map((store) => (
        mapRef.current
          .pointForCoordinate({ latitude: store.latitude, longitude: store.longitude })
          .then((point) => [store.id, point])
          .catch(() => null)
      ))
    );
    const next = {};
    for (const result of results) {
      if (!result) continue;
      const [storeId, point] = result;
      next[storeId] = point;
    }
    setMarkerLabelPositions(next);
  };

  const showLabelsAtSettledPositions = async () => {
    clearTimeout(settleTimerRef.current);
    await recomputeMarkerLabelPositions();
    setIsMapMoving(false);
  };

  // Called at the start of a move and on every continuous camera update. The timer is the safety net for
  // a gesture that starts but never changes the bounds: Android then skips onRegionChangeComplete, and
  // without this the labels would stay hidden. It is re-armed by every update, so it only fires once the
  // camera has been still for a moment.
  const hideLabelsWhileMoving = () => {
    setIsMapMoving(true);
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(showLabelsAtSettledPositions, markerLabelSettleMs);
  };

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  // Re-project labels whenever the visible store set changes or the map camera settles after a
  // pan/zoom/recenter. onRegionChangeComplete already fires for animateCamera (recenterOnUser)
  // too, so a separate effect keyed on userPosition isn't needed.
  useEffect(() => {
    recomputeMarkerLabelPositions();
  }, [visibleMapStores]);

  const openSelectedStore = () => {
    if (!selectedStore) return;
    const destination = getStoreMapDestination(selectedStore);
    navigation.push(destination.name, destination.params);
  };

  return (
    <View style={styles.screen}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFillObject}
        initialCamera={{
          center: mapCenter,
          pitch: 0,
          heading: 0,
          altitude: 0,
          zoom
        }}
        rotateEnabled={false}
        pitchEnabled={false}
        showsCompass={false}
        toolbarEnabled={false}
        mapType="standard"
        customMapStyle={isDark ? DARK_MAP_STYLE : LIGHT_MAP_STYLE}
        onMapReady={recomputeMarkerLabelPositions}
        onRegionChangeStart={hideLabelsWhileMoving}
        onRegionChange={hideLabelsWhileMoving}
        onRegionChangeComplete={showLabelsAtSettledPositions}
      >
        {/* No pinColor: omitting it gives Android's own default marker (Google's native red) --
            passing a red hex through the hue-only conversion above is a less direct way to ask
            for the same thing. */}
        <Marker
          coordinate={userPosition}
          title={locationName}
          description={effectiveLocationMode === "live" ? "顧客即時 GPS；失敗時使用固定備援位置" : "控制台指定的顧客固定位置"}
        />
        {visibleMapStores.map((store) => {
          const hasRecruitingGroupBuyActivity = store.hasRecruitingGroupBuyActivity;
          return (
            <Marker
              key={store.id}
              coordinate={{ latitude: store.latitude, longitude: store.longitude }}
              title={getStoreMarkerLabel(store)}
              description={hasRecruitingGroupBuyActivity ? "有招募中的團購" : "目前沒有招募中團購"}
              onPress={() => {
                setFilteredOutStoreName(null);
                setSelectedStoreId(store.id);
              }}
              pinColor={hasRecruitingGroupBuyActivity ? RECRUITING_PIN_COLOR : IDLE_PIN_COLOR}
            />
          );
        })}
      </MapView>

      {!isMapMoving && visibleMapStores.map((store) => {
        const point = markerLabelPositions[store.id];
        if (!point) return null;
        return (
          <View
            key={`label-${store.id}`}
            pointerEvents="none"
            style={[styles.markerLabel, { left: point.x, top: point.y + 4 }]}
          >
            <View style={styles.markerLabelPill}>
              <View style={[styles.markerDot, store.hasRecruitingGroupBuyActivity && styles.markerDotSolid]} />
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} numberOfLines={1} style={styles.markerLabelText}>{store.name}</Text>
            </View>
          </View>
        );
      })}

      {/* The controls and the cards share one bottom column, so a taller card pushes the controls up
          instead of covering them. box-none keeps the map draggable around them. */}
      <View pointerEvents="box-none" style={styles.overlay}>
        <View pointerEvents="box-none" style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            onPress={openFilterPanel}
            style={({ pressed }) => [styles.filterButton, pressed && styles.pressed]}
          >
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.filterButtonText}>篩選</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="回到目前位置"
            onPress={recenterOnUser}
            style={({ pressed }) => [styles.recenterButton, pressed && styles.pressed]}
          >
            <RecenterIcon />
          </Pressable>
        </View>

        {!devControlEnabled && locationPermission === "denied" ? (
          <Card compact style={styles.floatingCard}>
            <Text style={styles.cardTitle}>請開啟定位權限</Text>
            <Text style={styles.cardBody}>
              開啟定位後，地圖會顯示你目前的位置，才能使用距離篩選找到附近的店家。目前顯示的是預設位置。
            </Text>
            <View style={styles.cardActions}>
              <PrimaryButton label="前往設定開啟" onPress={() => Linking.openSettings()} />
            </View>
          </Card>
        ) : null}

        {!selectedStore && filteredOutStoreName ? (
          <Card compact style={styles.storeCard}>
            <View style={styles.storeInfo}>
              <Text style={styles.cardBody}>
                {filteredOutStoreName} 已不符合目前的篩選條件，卡片已自動關閉。
              </Text>
            </View>
            <PrimaryButton label="知道了" onPress={() => setFilteredOutStoreName(null)} />
          </Card>
        ) : null}

        {selectedStore ? (
          <Card compact style={styles.storeCard}>
            <View style={styles.storeInfo}>
              <Text style={styles.storeName}>{selectedStore.name}</Text>
              <Text style={styles.storeMeta} numberOfLines={2}>
                {selectedStore.address || "地址未提供"} · {selectedStore.hasRecruitingGroupBuyActivity ? `招募中的團購 ${selectedStore.progressText}` : "目前沒有招募中團購"}
              </Text>
            </View>
            <PrimaryButton
              label={selectedStore.joinableGroupBuyActivities.length > 1
                ? "活動列表"
                : selectedStore.hasRecruitingGroupBuyActivity ? "查看活動" : "查看菜單"}
              onPress={openSelectedStore}
            />
          </Card>
        ) : null}
      </View>

      <ActivityFilterPanel
        visible={filterPanelVisible}
        filters={filters}
        onApply={applyFilters}
        onClose={closeFilterPanel}
        hasLocation={hasRealLocation}
        onOpenLocationSettings={!devControlEnabled ? () => Linking.openSettings() : null}
      />
    </View>
  );
}

// The "my location" crosshair, drawn with views instead of a font glyph.
function RecenterIcon() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.crosshair}>
      <View style={styles.crosshairRing} />
      <View style={styles.crosshairDot} />
      <View style={[styles.crosshairTick, styles.tickTop]} />
      <View style={[styles.crosshairTick, styles.tickBottom]} />
      <View style={[styles.crosshairTick, styles.tickLeft]} />
      <View style={[styles.crosshairTick, styles.tickRight]} />
    </View>
  );
}

const ICON_SIZE = spacing.s24;
const CROSSHAIR_RING = spacing.s16 - sizes.stroke;
const CROSSHAIR_TICK = spacing.s8 - sizes.stroke;

const makeStyles = (colors) => StyleSheet.create({
  screen: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: colors.recess
  },
  markerLabel: {
    position: "absolute",
    width: 148,
    marginLeft: -74,
    alignItems: "center"
  },
  markerLabelPill: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s4,
    borderRadius: radii.xs,
    backgroundColor: colors.page,
    paddingHorizontal: spacing.s8,
    paddingVertical: spacing.s4
  },
  markerLabelText: {
    flexShrink: 1,
    ...typeScale.label,
    color: colors.text
  },
  // Solid = the store has a group to join, hollow = it has none (the web markers use the same idea).
  markerDot: {
    width: spacing.s12,
    height: spacing.s12,
    borderRadius: radii.pill,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    backgroundColor: colors.page
  },
  markerDotSolid: {
    backgroundColor: colors.accent
  },
  // Bottom offset keeps the map's attribution strip visible under the controls and the cards.
  overlay: {
    position: "absolute",
    left: spacing.s16,
    right: spacing.s16,
    bottom: spacing.s32 + spacing.s12,
    gap: spacing.s12
  },
  // column-reverse: the recenter button sits above the filter button while the source order (the
  // order screen readers walk) stays filter, recenter.
  controls: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
    flexDirection: "column-reverse",
    gap: spacing.s12
  },
  filterButton: {
    minWidth: sizes.tap,
    minHeight: sizes.tap,
    borderRadius: radii.pill,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.page,
    paddingHorizontal: spacing.s16
  },
  filterButtonText: {
    ...typeScale.button,
    color: colors.accentInk
  },
  pressed: {
    opacity: 0.8
  },
  recenterButton: {
    minWidth: sizes.tap,
    minHeight: sizes.tap,
    borderRadius: radii.pill,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.page
  },
  crosshair: {
    width: ICON_SIZE,
    height: ICON_SIZE
  },
  crosshairRing: {
    position: "absolute",
    top: (ICON_SIZE - CROSSHAIR_RING) / 2,
    left: (ICON_SIZE - CROSSHAIR_RING) / 2,
    width: CROSSHAIR_RING,
    height: CROSSHAIR_RING,
    borderRadius: radii.pill,
    borderWidth: sizes.stroke,
    borderColor: colors.accent
  },
  crosshairDot: {
    position: "absolute",
    top: (ICON_SIZE - spacing.s4) / 2,
    left: (ICON_SIZE - spacing.s4) / 2,
    width: spacing.s4,
    height: spacing.s4,
    borderRadius: radii.pill,
    backgroundColor: colors.accent
  },
  crosshairTick: {
    position: "absolute",
    backgroundColor: colors.accent
  },
  tickTop: {
    top: 0,
    left: (ICON_SIZE - sizes.stroke) / 2,
    width: sizes.stroke,
    height: CROSSHAIR_TICK
  },
  tickBottom: {
    bottom: 0,
    left: (ICON_SIZE - sizes.stroke) / 2,
    width: sizes.stroke,
    height: CROSSHAIR_TICK
  },
  tickLeft: {
    left: 0,
    top: (ICON_SIZE - sizes.stroke) / 2,
    width: CROSSHAIR_TICK,
    height: sizes.stroke
  },
  tickRight: {
    right: 0,
    top: (ICON_SIZE - sizes.stroke) / 2,
    width: CROSSHAIR_TICK,
    height: sizes.stroke
  },
  // The cards float over the map, so they keep Android elevation (their 2px outline is very light).
  floatingCard: {
    gap: spacing.s8,
    elevation: 6
  },
  storeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    elevation: 6
  },
  storeInfo: {
    flex: 1,
    gap: spacing.s4
  },
  storeName: {
    ...typeScale.button,
    color: colors.text
  },
  storeMeta: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  cardTitle: {
    ...typeScale.button,
    color: colors.text
  },
  cardBody: {
    ...typeScale.bodyDense,
    color: colors.text
  },
  cardActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s8
  }
});
