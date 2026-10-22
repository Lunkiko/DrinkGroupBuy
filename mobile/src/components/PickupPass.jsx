import { StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { formatPickupCode } from "../utils/pickupCode";
import { useThemedStyles } from "../theme/ThemeContext";

const MAX_PASS_PEARLS = 10;
const HINT = "到店取餐時，將此代碼提供給店家。";

// The pass a customer shows at the counter. The code is the one thing that has to be read at
// arm's length, so it is the biggest text in the app. One pearl per cup (up to 10) sits under it;
// the exact cup count is always written out.
export function PickupPass({ pickupCode, cupCount, showCups = true }) {
  const styles = useThemedStyles(makeStyles);
  const cups = Number.isInteger(cupCount) && cupCount > 0 ? cupCount : 0;
  const spokenCode = String(pickupCode).split("").join(" ");
  // The card is one focus stop for screen readers, so its label has to carry everything on it.
  const spokenLabel = [`取餐憑證，六位取餐碼 ${spokenCode}`, cups > 0 ? `${cups} 杯` : null, HINT].filter(Boolean).join("，");

  return (
    <View accessible accessibilityLabel={spokenLabel} style={styles.pass}>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.label}>六位取餐碼</Text>
      <Text
        adjustsFontSizeToFit
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        numberOfLines={1}
        style={styles.code}
      >
        {formatPickupCode(pickupCode)}
      </Text>
      {showCups && cups > 0 ? (
        <View style={styles.cupsRow}>
          <View style={styles.pearls}>
            {Array.from({ length: Math.min(cups, MAX_PASS_PEARLS) }, (_, index) => (
              <View key={index} style={styles.pearl} />
            ))}
          </View>
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cups}>{cups} 杯</Text>
        </View>
      ) : null}
      <Text style={styles.hint}>{HINT}</Text>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  pass: {
    alignItems: "center",
    gap: spacing.s12,
    paddingVertical: spacing.s24,
    paddingHorizontal: spacing.s16,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  label: {
    ...typeScale.button,
    color: colors.text
  },
  code: {
    ...typeScale.pickupCode,
    color: colors.accentInk,
    letterSpacing: 4,
    // RN adds the letter spacing after the last digit too; this puts it back in the middle.
    paddingLeft: 4,
    textAlign: "center",
    fontVariant: ["tabular-nums"]
  },
  cupsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  pearls: {
    flexDirection: "row",
    gap: spacing.s4
  },
  pearl: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent
  },
  cups: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  hint: {
    ...typeScale.bodyDense,
    color: colors.text,
    textAlign: "center"
  }
});
