import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActivityFilterPanel } from "../components/ActivityFilterPanel";
import { Card } from "../components/Card";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { useActivityMapFilters } from "../hooks/useActivityMapFilters";
import { useDevLocationConfig } from "../hooks/useDevLocationConfig";
import { mapCenter, mapDefaults } from "../mock/mapConfig";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { reportAppliedDevLocation } from "../utils/devLocationControl";
import { buildStoreMapStores, getStoreMapDestination, getStoreMarkerLabel } from "../utils/groupBuyActivityStores";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { DARK_MAP_STYLE, LIGHT_MAP_STYLE } from "../theme/mapStyles";

// This screen mirrors LiveMapScreen.native.jsx so the web preview looks like the app: the same
// red / cyan / yellow teardrop pins, the same name label under each store pin (page-coloured pill with
// a solid or hollow dot), and no points-of-interest clutter. The markers are raw DOM nodes and cannot
// read the StyleSheet, so their looks are spelled out here. Fixed hex values rather than theme tokens,
// like the native pins -- they have to read the same in light and dark mode.
const USER_PIN_COLOR = "#EA4335"; // Google red
const RECRUITING_PIN_COLOR = "#FBC02D"; // yellow
const IDLE_PIN_COLOR = "#00BCD4"; // cyan
const PIN_WIDTH = 27;
const PIN_HEIGHT = 38;

// The native map passes showsPointsOfInterest={false}; the Maps JavaScript API has no such flag, so the
// same result comes from a style rule. Appended last so it also wins over DARK_MAP_STYLE's poi colours.
const HIDE_POI_LABELS_STYLE = { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] };
function getMapStyles(isDark) {
  return [...(isDark ? DARK_MAP_STYLE : LIGHT_MAP_STYLE), HIDE_POI_LABELS_STYLE];
}

export function LiveMapScreen({ navigation, appState, selectedAuthUserId }) {
  const styles = useThemedStyles(makeStyles);
  const { colors, isDark } = useTheme();
  const mapElementRef = useRef(null);
  const lastReportSignatureRef = useRef("");
  // True once a real GPS fix has been received. This effect re-runs on every re-focus of the tab, and
  // while the next fix is pending the last known position is kept instead of jumping back to the
  // fixed fallback location.
  const hasRealFixRef = useRef(false);
  const mapInstanceRef = useRef(null);
  const googleMapsRef = useRef(null);
  const markersRef = useRef([]);
  const markersByStoreIdRef = useRef(new Map());
  const [selectedStoreId, setSelectedStoreId] = useState(null);
  const [mapError, setMapError] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [locationPermission, setLocationPermission] = useState("not_required");
  const [userPosition, setUserPosition] = useState({
    latitude: mapCenter.latitude,
    longitude: mapCenter.longitude
  });
  const { config, enabled: devControlEnabled } = useDevLocationConfig(selectedAuthUserId);

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
  const apiKey = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
    || Constants.expoConfig?.extra?.googleMapsWebApiKey
    || Constants.manifest2?.extra?.expoClient?.extra?.googleMapsWebApiKey
    || "").trim();
  const userMapCenter = useMemo(() => ({
    lat: userPosition.latitude,
    lng: userPosition.longitude
  }), [userPosition.latitude, userPosition.longitude]);
  const hasRealLocation = config.locationMode === "live" && locationPermission === "granted";
  const locationName = hasRealLocation ? "瀏覽器即時位置" : config.fixedLocation.name;

  useEffect(() => {
    if (selectedStoreId && !visibleStoreIds.has(selectedStoreId)) {
      setSelectedStoreId(null);
    }
  }, [visibleStoreIds, selectedStoreId]);

  // useFocusEffect (not useEffect): with react-navigation keeping every tab mounted, a plain
  // useEffect would leave the browser's geolocation watch running forever once started, even
  // while this tab is in the background. This re-runs the same setup on focus and clears the
  // watch on every blur (not just on unmount), matching the native variant's fix.
  useFocusEffect(
    useCallback(() => {
    const fallbackPosition = {
      latitude: config.fixedLocation.latitude,
      longitude: config.fixedLocation.longitude
    };
    let watchId = null;

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

    if (config.locationMode !== "live" || !hasRealFixRef.current) {
      hasRealFixRef.current = false;
      setUserPosition(fallbackPosition);
    }
    if (config.locationMode !== "live") {
      setLocationPermission("not_required");
      reportApplied("not_required");
      return undefined;
    }
    if (!navigator.geolocation) {
      setLocationPermission("unavailable");
      reportApplied("unavailable");
      return undefined;
    }

    setLocationPermission((current) => (current === "granted" ? current : "requesting"));
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserPosition({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        hasRealFixRef.current = true;
        setLocationPermission("granted");
        reportApplied("granted");
      },
      (error) => {
        const permission = error.code === 1 ? "denied" : "error";
        hasRealFixRef.current = false;
        setUserPosition(fallbackPosition);
        setLocationPermission(permission);
        reportApplied(permission);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
    }, [
      config.fixedLocation.latitude,
      config.fixedLocation.longitude,
      config.locationMode,
      config.version,
      devControlEnabled,
      selectedAuthUserId
    ])
  );

  useEffect(() => {
    if (!apiKey || !mapElementRef.current) {
      setMapReady(false);
      setMapError("尚未設定 Web Google Maps API key。");
      return undefined;
    }

    let active = true;
    setMapReady(false);
    setMapError("");

    loadGoogleMaps(apiKey)
      .then((googleMaps) => {
        if (!active || !mapElementRef.current) return;

        const map = new googleMaps.Map(mapElementRef.current, {
          center: userMapCenter,
          zoom: mapDefaults.zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          panControl: false,
          rotateControl: false,
          scaleControl: false,
          cameraControl: false,
          clickableIcons: false,
          gestureHandling: "greedy",
          scrollwheel: true,
          zoomControl: true,
          zoomControlOptions: {
            position: googleMaps.ControlPosition.RIGHT_CENTER
          }
        });

        googleMapsRef.current = googleMaps;
        mapInstanceRef.current = map;
        googleMaps.event.trigger(map, "resize");
        map.setCenter(userMapCenter);
        if (active) setMapReady(true);
      })
      .catch((error) => {
        console.error("Google Maps load failed:", error);
        if (active) {
          setMapReady(false);
          setMapError(`Google Maps 載入失敗：${error?.message ?? "請確認 Maps JavaScript API、Billing 與網站金鑰限制。"}`);
        }
      });

    return () => {
      active = false;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
      markersByStoreIdRef.current.clear();
      mapInstanceRef.current = null;
      googleMapsRef.current = null;
    };
  }, [apiKey]);

  // The night style follows the app theme, also while the map is already on screen.
  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current) return;
    mapInstanceRef.current.setOptions({ styles: getMapStyles(isDark) });
  }, [mapReady, isDark]);

  const recenterOnUser = () => {
    mapInstanceRef.current?.panTo(userMapCenter);
  };

  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current) return;
    recenterOnUser();
  }, [mapReady, userMapCenter]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const googleMaps = googleMapsRef.current;
    if (!mapReady || !map || !googleMaps) return undefined;

    markersRef.current.forEach((marker) => marker.setMap(null));
    markersByStoreIdRef.current.clear();
    const nextMarkers = [];

    // Like the native map, the customer's own pin carries no permanent name label (only a hover title).
    const userMarker = createStoreOverlayMarker({
      colors,
      googleMaps,
      map,
      position: userMapCenter,
      title: locationName,
      pinColor: USER_PIN_COLOR
    });
    nextMarkers.push(userMarker);

    visibleMapStores.forEach((store) => {
      const marker = createStoreOverlayMarker({
        colors,
        googleMaps,
        map,
        position: { lat: store.latitude, lng: store.longitude },
        title: store.name,
        pinColor: store.hasRecruitingGroupBuyActivity ? RECRUITING_PIN_COLOR : IDLE_PIN_COLOR,
        labelText: getStoreMarkerLabel(store),
        labelDotSolid: store.hasRecruitingGroupBuyActivity,
        onPress: () => focusStore(store)
      });
      markersByStoreIdRef.current.set(store.id, marker);
      nextMarkers.push(marker);
    });

    markersRef.current = nextMarkers;

    return () => {
      nextMarkers.forEach((marker) => marker.setMap(null));
      if (markersRef.current === nextMarkers) {
        markersRef.current = [];
        markersByStoreIdRef.current.clear();
      }
    };
  }, [locationName, mapReady, visibleMapStores, userMapCenter, colors]);

  useEffect(() => {
    const mapElement = mapElementRef.current;
    const map = mapInstanceRef.current;
    const googleMaps = googleMapsRef.current;
    if (!mapReady || !mapElement || !map || !googleMaps) return undefined;

    const refreshMapSize = () => {
      googleMaps.event.trigger(map, "resize");
      map.setCenter(map.getCenter() || userMapCenter);
    };

    const frameId = window.requestAnimationFrame(refreshMapSize);
    const timeoutId = window.setTimeout(refreshMapSize, 250);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(refreshMapSize)
      : null;

    resizeObserver?.observe(mapElement);
    window.addEventListener("resize", refreshMapSize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", refreshMapSize);
    };
  }, [mapReady, userMapCenter]);

  const focusStore = (store) => {
    setSelectedStoreId(store.id);
    const nextPosition = { lat: store.latitude, lng: store.longitude };
    mapInstanceRef.current?.panTo(nextPosition);
    mapInstanceRef.current?.setZoom(Math.max(mapInstanceRef.current?.getZoom() ?? mapDefaults.zoom, 17));
  };

  const openSelectedStore = () => {
    if (!selectedStore) return;
    const destination = getStoreMapDestination(selectedStore);
    navigation.push(destination.name, destination.params);
  };

  return (
    <View style={styles.screen}>
      <div ref={mapElementRef} style={styles.map} />

      {!mapReady && !mapError ? (
        <Card compact style={styles.mapStatus}>
          <Text style={styles.loadingText}>Google Maps 載入中...</Text>
        </Card>
      ) : null}

      {mapError ? (
        <View style={styles.mapStatus}>
          <Notice tone="danger" message={mapError} />
        </View>
      ) : null}

      {/* The controls and the store card share one bottom column, so a taller card pushes the
          controls up instead of covering them. box-none keeps the map draggable around them. */}
      <View style={styles.overlay}>
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            onPress={openFilterPanel}
            style={({ pressed }) => [styles.filterButton, pressed && styles.pressed]}
          >
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.filterButtonText}>篩選</Text>
          </Pressable>

          {mapReady ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="回到目前位置"
              onPress={recenterOnUser}
              style={({ pressed }) => [styles.recenterButton, pressed && styles.pressed]}
            >
              <RecenterIcon />
            </Pressable>
          ) : null}
        </View>

        {selectedStore ? (
          <Card compact style={styles.storeCard}>
            <View style={styles.storeInfo}>
              <Text style={styles.storeName}>{selectedStore.name}</Text>
              <Text style={styles.storeMeta} numberOfLines={2}>
                {selectedStore.address || "地址未提供"} · {selectedStore.hasRecruitingGroupBuyActivity ? `團購進行中 ${selectedStore.progressText}` : "目前沒有進行中的團購"}
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

function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.Map) {
    return Promise.resolve(window.google.maps);
  }

  if (window.__drinkGroupBuyGoogleMapsPromise) {
    return window.__drinkGroupBuyGoogleMapsPromise;
  }

  window.__drinkGroupBuyGoogleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = `drinkGroupBuyGoogleMapsLoaded_${Date.now()}`;
    const timeoutId = window.setTimeout(() => {
      delete window[callbackName];
      reject(new Error("Google Maps 載入逾時，請確認 Maps JavaScript API、Billing、API key 網域限制。"));
    }, 7000);

    window[callbackName] = () => {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      if (window.google?.maps) {
        resolve(window.google.maps);
      } else {
        reject(new Error("Google Maps script 已回應，但 window.google.maps 不存在。"));
      }
    };

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: apiKey,
      callback: callbackName,
      v: "weekly"
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      reject(new Error("Google Maps script 載入失敗，可能是網路、API key 或網站限制問題。"));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    window.__drinkGroupBuyGoogleMapsPromise = null;
    throw error;
  });

  return window.__drinkGroupBuyGoogleMapsPromise;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A teardrop pin whose tip is the anchor point, plus (for stores) a name label below it -- the same
// arrangement the native map gets from its default marker and the absolutely-positioned label pill.
// The root has no size and sits exactly on the coordinate; the pin grows up from it, the label hangs
// below it. Only the pin takes clicks, like the native map (its labels are pointerEvents none).
function createStoreOverlayMarker({ colors, googleMaps, map, position, title, pinColor, labelText = "", labelDotSolid = false, onPress }) {
  class StoreOverlayMarker extends googleMaps.OverlayView {
    constructor() {
      super();
      this.position = new googleMaps.LatLng(position.lat, position.lng);
      this.title = title;
      this.pinColor = pinColor;
      this.labelText = labelText;
      this.labelDotSolid = labelDotSolid;
      this.onPress = onPress;
      this.element = null;
      this.pinElement = null;
      this.pinShapeElement = null;
      this.labelElement = null;
      this.labelDotElement = null;
      this.labelTextElement = null;
    }

    onAdd() {
      const root = document.createElement("div");
      root.style.position = "absolute";
      root.style.width = "0";
      root.style.height = "0";
      root.style.pointerEvents = "none";

      const pin = document.createElement("button");
      pin.type = "button";
      pin.title = this.title;
      pin.style.position = "absolute";
      pin.style.left = `${-PIN_WIDTH / 2}px`;
      pin.style.bottom = "0";
      pin.style.width = `${PIN_WIDTH}px`;
      pin.style.height = `${PIN_HEIGHT}px`;
      pin.style.border = "0";
      pin.style.background = "transparent";
      pin.style.padding = "0";
      pin.style.cursor = this.onPress ? "pointer" : "default";
      // An inert pin (the customer's own position) must not swallow map drags that start on it.
      pin.style.pointerEvents = this.onPress ? "auto" : "none";

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 34");
      svg.setAttribute("width", String(PIN_WIDTH));
      svg.setAttribute("height", String(PIN_HEIGHT));
      svg.style.display = "block";
      const pinShape = document.createElementNS(SVG_NS, "path");
      pinShape.setAttribute("d", "M12 .5C5.6.5.5 5.6.5 12c0 8.6 11.5 21.5 11.5 21.5S23.5 20.6 23.5 12C23.5 5.6 18.4.5 12 .5z");
      pinShape.setAttribute("stroke", "rgba(0,0,0,0.28)");
      pinShape.setAttribute("stroke-width", "1");
      const pinHole = document.createElementNS(SVG_NS, "circle");
      pinHole.setAttribute("cx", "12");
      pinHole.setAttribute("cy", "12");
      pinHole.setAttribute("r", "4.5");
      pinHole.setAttribute("fill", "rgba(0,0,0,0.32)");
      svg.append(pinShape, pinHole);
      pin.appendChild(svg);

      if (this.onPress) {
        pin.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.onPress();
        });
      }

      const label = document.createElement("div");
      label.style.position = "absolute";
      label.style.top = `${spacing.s4}px`;
      label.style.left = "0";
      label.style.transform = "translateX(-50%)";
      label.style.maxWidth = "148px";
      label.style.boxSizing = "border-box";
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = `${spacing.s4}px`;
      label.style.borderRadius = `${radii.xs}px`;
      label.style.background = colors.page;
      label.style.color = colors.text;
      label.style.padding = `${spacing.s4}px ${spacing.s8}px`;
      label.style.pointerEvents = "none";

      const labelDot = document.createElement("span");
      labelDot.style.flex = "none";
      labelDot.style.boxSizing = "border-box";
      labelDot.style.width = `${spacing.s12}px`;
      labelDot.style.height = `${spacing.s12}px`;
      labelDot.style.borderRadius = `${radii.pill}px`;
      labelDot.style.border = `${sizes.stroke}px solid ${colors.accent}`;

      const labelTextNode = document.createElement("span");
      labelTextNode.style.minWidth = "0";
      labelTextNode.style.fontSize = `${typeScale.label.fontSize}px`;
      labelTextNode.style.fontWeight = typeScale.label.fontWeight;
      labelTextNode.style.lineHeight = `${typeScale.label.lineHeight}px`;
      labelTextNode.style.whiteSpace = "nowrap";
      labelTextNode.style.overflow = "hidden";
      labelTextNode.style.textOverflow = "ellipsis";

      label.append(labelDot, labelTextNode);
      root.append(pin, label);

      this.element = root;
      this.pinShapeElement = pinShape;
      this.pinElement = pin;
      this.labelElement = label;
      this.labelDotElement = labelDot;
      this.labelTextElement = labelTextNode;
      this.render();
      this.getPanes().overlayMouseTarget.appendChild(root);
    }

    draw() {
      if (!this.element) return;
      const point = this.getProjection().fromLatLngToDivPixel(this.position);
      if (!point) return;
      this.element.style.left = `${point.x}px`;
      this.element.style.top = `${point.y}px`;
    }

    onRemove() {
      this.element?.remove();
      this.element = null;
    }

    update(nextValues) {
      Object.assign(this, nextValues);
      this.render();
    }

    render() {
      if (!this.element || !this.pinShapeElement || !this.labelElement) return;
      this.pinElement.title = this.title;
      this.pinShapeElement.setAttribute("fill", this.pinColor);
      this.labelElement.style.display = this.labelText ? "flex" : "none";
      this.labelDotElement.style.background = this.labelDotSolid ? colors.accent : colors.page;
      this.labelTextElement.textContent = this.labelText;
    }
  }

  const marker = new StoreOverlayMarker();
  marker.setMap(map);
  return marker;
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
  map: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.recess
  },
  // Where the loading / error card floats: a little below the top edge.
  mapStatus: {
    position: "absolute",
    left: spacing.s16,
    right: spacing.s16,
    top: spacing.s32 * 4
  },
  loadingText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  // The bottom offset keeps the map's attribution strip visible under the controls and the card.
  overlay: {
    position: "absolute",
    left: spacing.s16,
    right: spacing.s16,
    bottom: spacing.s32 + spacing.s12,
    gap: spacing.s12,
    pointerEvents: "box-none"
  },
  // column-reverse: the recenter button sits above the filter button while the source order (the
  // order screen readers walk) stays filter, recenter.
  controls: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
    flexDirection: "column-reverse",
    gap: spacing.s12,
    pointerEvents: "box-none"
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
  storeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
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
  }
});
