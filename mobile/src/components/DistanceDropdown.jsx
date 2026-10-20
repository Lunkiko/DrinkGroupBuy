import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { RADIUS_OPTIONS } from "../utils/groupBuyActivityMapFilters";
import { Icon } from "./Icon";

// The blueprint's "1 公里內 ⌄" control: the chosen distance with a chevron; tapping it opens the list
// right below (inline, not a floating menu, so it never gets clipped by the scrolling screen).
export function DistanceDropdown({ value = null, onChange, options = RADIUS_OPTIONS }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const triggerLabel = selected.value == null ? "不限距離" : `${selected.label}內`;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityLabel={`距離篩選：${triggerLabel}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.trigger}
      >
        <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.triggerText}>{triggerLabel}</Text>
        <Icon color={colors.textSecondary} name={open ? "chevronUp" : "chevronDown"} size={20} />
      </Pressable>
      {open ? (
        <View accessibilityLabel="距離篩選" style={styles.menu}>
          {options.map((option) => {
            const active = option.value === selected.value;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                key={option.label}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={styles.option}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {option.value == null ? "不限距離" : `${option.label}內`}
                </Text>
                {active ? <Icon color={colors.accent} name="check" size={20} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: {
    alignItems: "flex-end"
  },
  trigger: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s4
  },
  triggerText: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  menu: {
    minWidth: 160,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page,
    overflow: "hidden"
  },
  option: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12,
    paddingHorizontal: spacing.s16
  },
  optionText: {
    ...typeScale.bodyDense,
    color: colors.text
  },
  optionTextActive: {
    color: colors.accentInk,
    fontWeight: typeScale.label.fontWeight
  }
});
