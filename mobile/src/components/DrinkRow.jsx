import { Pressable, StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { Icon } from "./Icon";

// One drink in a menu list: photo placeholder, name (with an optional orange "推薦" tag), price, and a chevron
// when the row can be tapped. There is no photo field in the menu data yet, so the tile is a picture frame.
export function DrinkRow({ name, priceText, recommended = false, onPress }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const body = (
    <>
      <View style={styles.thumb}>
        <Icon color={colors.textSecondary} name="image" size={30} />
      </View>
      <View style={styles.nameRow}>
        <Text style={styles.name}>{name}</Text>
        {recommended ? (
          <View style={styles.tag}>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.tagText}>推薦</Text>
          </View>
        ) : null}
      </View>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.price}>{priceText}</Text>
      {onPress ? <Icon color={colors.accent} name="chevronRight" size={26} /> : null}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    minHeight: 80,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    padding: spacing.s12,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  pressed: {
    opacity: 0.8
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  nameRow: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.s8
  },
  name: {
    ...typeScale.price,
    fontSize: 19,
    color: colors.text
  },
  tag: {
    paddingHorizontal: spacing.s8,
    paddingVertical: 2,
    borderRadius: radii.xs,
    backgroundColor: colors.warmSoft
  },
  tagText: {
    ...typeScale.label,
    color: colors.warm
  },
  price: {
    ...typeScale.price,
    fontSize: 20,
    color: colors.text
  }
});
