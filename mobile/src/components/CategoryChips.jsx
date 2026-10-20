import { Pressable, StyleSheet, Text, View } from "react-native";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// The blueprint's category row: soft-blue pills, the picked one solid blue. Same text weight in both states
// (bold is wider and would shift the neighbours, see ChoiceChip). `categories` is [{ id, label }].
export function CategoryChips({ categories, value, onChange }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityLabel="飲品分類" style={styles.row}>
      {categories.map((item) => {
        const selected = item.id === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={item.id}
            onPress={() => onChange(item.id)}
            style={({ pressed }) => [styles.chip, selected && styles.selected, pressed && styles.pressed]}
          >
            <Text style={[styles.label, selected && styles.selectedLabel]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s8
  },
  chip: {
    minHeight: sizes.tap,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.s20,
    borderRadius: radii.pill,
    backgroundColor: colors.recess
  },
  selected: {
    backgroundColor: colors.accent
  },
  pressed: {
    opacity: 0.8
  },
  label: {
    ...typeScale.body,
    color: colors.text
  },
  selectedLabel: {
    color: colors.onAccent
  }
});
