import { StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// The blueprint's "● 招募中": an orange dot and orange label on a pale orange pill.
export function WarmPill({ label }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.pill}>
      <View style={styles.dot} />
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.label}>{label}</Text>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.s8,
    paddingHorizontal: spacing.s12,
    paddingVertical: spacing.s8,
    borderRadius: radii.pill,
    backgroundColor: colors.warmSoft
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warm
  },
  label: {
    ...typeScale.button,
    color: colors.warm
  }
});
