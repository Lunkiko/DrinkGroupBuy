import { StyleSheet, Text, View } from "react-native";
import { radii, spacing, typeScale } from "../theme/tokens";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { Icon } from "./Icon";

// The blueprint's soft-blue hint box: a blue "i" disc, an optional bold title and a message.
export function InfoBanner({ title, message }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.box}>
      <Icon color={colors.accent} cutout={colors.onAccent} name="info" size={30} />
      <View style={styles.content}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {message ? <Text style={title ? styles.message : styles.title}>{message}</Text> : null}
      </View>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    paddingVertical: spacing.s16,
    paddingHorizontal: spacing.s16,
    borderRadius: radii.md,
    backgroundColor: colors.recess
  },
  content: {
    flex: 1,
    gap: spacing.s4
  },
  title: {
    ...typeScale.price,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text
  },
  message: {
    ...typeScale.body,
    color: colors.textSecondary
  }
});
