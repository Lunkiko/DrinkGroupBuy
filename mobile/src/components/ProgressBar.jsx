import { StyleSheet, View } from "react-native";
import { radii } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// The blueprint's amber progress bar (replaces the pearl strip on the customer home card).
export function ProgressBar({ percent }) {
  const styles = useThemedStyles(makeStyles);
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={styles.track}
    >
      {clamped > 0 ? <View style={[styles.fill, { width: `${clamped}%` }]} /> : null}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  track: {
    height: 14,
    borderRadius: radii.pill,
    overflow: "hidden",
    backgroundColor: colors.progressTrack
  },
  fill: {
    height: "100%",
    borderRadius: radii.pill,
    backgroundColor: colors.progressFill
  }
});
