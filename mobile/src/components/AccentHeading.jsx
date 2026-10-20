import { StyleSheet, Text, View } from "react-native";
import { spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// Section heading with the blueprint's short orange bar in front.
export function AccentHeading({ title }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.bar} />
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12
  },
  bar: {
    width: 5,
    height: 24,
    borderRadius: 3,
    backgroundColor: colors.warm
  },
  title: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  }
});
