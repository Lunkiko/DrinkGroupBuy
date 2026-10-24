import { StyleSheet, Text, View } from "react-native";
import { useThemedStyles } from "../theme/ThemeContext";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { RecruitingBadge } from "./RecruitingBadge";

export function MapStoreProgress({ active, progressText }) {
  const styles = useThemedStyles(makeStyles);
  if (!active) return <Text style={styles.storeProgress}>目前沒有招募中團購</Text>;

  const cupProgress = /^(\d+\/\d+)\s*杯$/.exec(progressText || "");
  return (
    <View style={styles.storeProgressRow}>
      <RecruitingBadge compact />
      <Text style={styles.progressNumber} numberOfLines={1}>{cupProgress ? cupProgress[1] : progressText}</Text>
      {cupProgress ? <Text style={styles.progressUnit}>杯</Text> : null}
    </View>
  );
}

export function MapFilterGlyph() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.filterGlyph} accessibilityLabel="篩選圖示">
      <View style={styles.filterGlyphRow}>
        <View style={styles.filterDot} />
        <View style={styles.filterLine} />
      </View>
      <View style={styles.filterGlyphRow}>
        <View style={styles.filterLine} />
        <View style={styles.filterDot} />
      </View>
    </View>
  );
}

export function MapUserLocationDot() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View collapsable={false} pointerEvents="none" style={styles.userLocation}>
      <View style={styles.userLocationHalo} />
      <View style={styles.userLocationCore} />
    </View>
  );
}

// Static React Native view inside a map Marker: no bitmap asset or extra icon package.
export function MapCupPin({ selected = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View collapsable={false} pointerEvents="none" style={[styles.cupPin, selected && styles.cupPinSelected]}>
      <View style={[styles.cupPinTail, selected && styles.cupPinTailSelected]} />
      <View style={[styles.cupPinFace, selected && styles.cupPinFaceSelected]}>
        <View style={styles.cupStraw} />
        <View style={styles.cupLid} />
        <View style={styles.cupBody}>
          <View style={styles.cupHighlight} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  storeProgress: { ...typeScale.caption, color: colors.textSecondary },
  storeProgressRow: { flexDirection: "row", alignItems: "center", gap: spacing.s4 },
  progressNumber: { ...typeScale.caption, color: colors.accentInk, fontWeight: "700" },
  progressUnit: { ...typeScale.caption, color: colors.textSecondary, fontWeight: "400" },
  filterGlyph: { gap: spacing.s4 },
  filterGlyphRow: { width: spacing.s24, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  filterLine: { width: spacing.s16, height: sizes.stroke, backgroundColor: colors.accent },
  filterDot: { width: spacing.s8, height: spacing.s8, borderRadius: radii.pill, borderWidth: sizes.stroke, borderColor: colors.accent, backgroundColor: colors.page },
  userLocation: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  userLocationHalo: { position: "absolute", width: 28, height: 28, borderRadius: radii.pill, backgroundColor: colors.accent, opacity: 0.18 },
  userLocationCore: { width: 16, height: 16, borderRadius: radii.pill, borderWidth: sizes.stroke, borderColor: colors.locationRing, backgroundColor: colors.accent },
  cupPin: { width: 28, height: 40, alignItems: "center", justifyContent: "flex-start" },
  cupPinSelected: { width: 34, height: 47 },
  cupPinTail: {
    position: "absolute",
    bottom: 4,
    width: 12,
    height: 12,
    transform: [{ rotate: "45deg" }],
    backgroundColor: colors.page,
    borderRightWidth: sizes.stroke,
    borderBottomWidth: sizes.stroke,
    borderColor: colors.accent
  },
  cupPinTailSelected: { width: 14, height: 14, bottom: 5 },
  cupPinFace: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: sizes.stroke,
    borderColor: colors.accent,
    backgroundColor: colors.page,
    alignItems: "center",
    justifyContent: "center"
  },
  cupPinFaceSelected: { width: 34, height: 34, borderRadius: 17 },
  cupStraw: { position: "absolute", top: 4, left: 15, width: 6, height: sizes.stroke, backgroundColor: colors.accent, transform: [{ rotate: "-18deg" }] },
  cupLid: { position: "absolute", top: 9, width: 15, height: sizes.stroke, borderRadius: radii.pill, backgroundColor: colors.accent },
  cupBody: { width: 11, height: 13, marginTop: 9, borderRadius: radii.xs / 4, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  cupHighlight: { width: 4, height: 6, borderRadius: radii.xs / 4, backgroundColor: colors.page }
});
