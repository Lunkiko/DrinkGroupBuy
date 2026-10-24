import { StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, spacing, typeScale } from "../theme/tokens";
import { useTheme } from "../theme/ThemeContext";
import { StatusMark } from "./StatusMark";
import { RecruitingBadge } from "./RecruitingBadge";

// A status-style pill: tone colours from theme/tokens.js, a drawn mark, and always the label text.
export function TonePill({ tone = "neutral", label }) {
  const { tones } = useTheme();
  const { bg, fg, mark } = tones[tone] ?? tones.neutral;

  if (label === "招募中") return <RecruitingBadge />;

  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <StatusMark mark={mark} color={fg} />
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.label, { color: fg }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.s8,
    minHeight: 28,
    paddingHorizontal: spacing.s12,
    borderRadius: radii.pill
  },
  label: {
    ...typeScale.label
  }
});
