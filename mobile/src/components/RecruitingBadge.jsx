import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/ThemeContext";
import { maxFontSizeMultiplier, radii, spacing, typeScale } from "../theme/tokens";

export function RecruitingBadge({ compact = false }) {
  const { colors } = useTheme();

  return (
    <View style={[styles.badge, !compact && styles.regular, { backgroundColor: colors.progressTrack }]}>
      <View style={[styles.dot, { backgroundColor: colors.progress }]} />
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[compact ? styles.compactText : styles.text, { color: colors.warmInk }]}>招募中</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.s4, paddingHorizontal: spacing.s8, borderRadius: radii.pill },
  regular: { minHeight: 28, paddingVertical: spacing.s4 },
  dot: { width: spacing.s8, height: spacing.s8, borderRadius: radii.pill },
  text: { ...typeScale.label },
  compactText: { ...typeScale.caption, fontWeight: "700" }
});
