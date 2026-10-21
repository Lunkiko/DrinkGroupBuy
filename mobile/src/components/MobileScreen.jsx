import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// The page every screen sits in: an optional header row (back arrow, title, something on the right) above
// scrolling content (docs/ui-style-guide.md).
export function MobileScreen({ title, subtitle, children, onBack, backLabel = "返回", headerRight = null, scrollRef = null }) {
  const styles = useThemedStyles(makeStyles);
  const hasHeader = Boolean(onBack || title || subtitle || headerRight);

  return (
    <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}>
      {hasHeader ? (
        <View style={styles.header}>
          <View style={styles.titleRow}>
            {onBack ? (
              <Pressable
                accessibilityLabel={backLabel}
                accessibilityRole="button"
                onPress={onBack}
                style={({ pressed }) => [styles.back, pressed && styles.pressed]}
              >
                <View style={styles.arrow} />
              </Pressable>
            ) : null}
            <View style={styles.titleWrap}>
              {title ? (
                <Text accessibilityRole="header" maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.title}>
                  {title}
                </Text>
              ) : null}
            </View>
            {headerRight ? <View style={styles.headerRight}>{headerRight}</View> : null}
          </View>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}

export function Section({ title, children, titleStyle, headerRight = null }) {
  const styles = useThemedStyles(makeStyles);
  const titleNode = (
    <Text accessibilityRole="header" style={[styles.sectionTitle, headerRight && styles.sectionHeaderTitle, titleStyle]}>
      {title}
    </Text>
  );
  return (
    <View style={styles.section}>
      {headerRight ? <View style={styles.sectionHeader}>{titleNode}{headerRight}</View> : titleNode}
      {children}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: {
    backgroundColor: colors.page
  },
  content: {
    gap: spacing.s24,
    paddingHorizontal: spacing.s20,
    paddingTop: spacing.s8,
    paddingBottom: spacing.s20
  },
  header: {
    gap: spacing.s4
  },
  titleRow: {
    minHeight: sizes.tap,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  back: {
    width: sizes.tap,
    height: sizes.tap,
    marginLeft: -spacing.s12,
    alignItems: "center",
    justifyContent: "center"
  },
  arrow: {
    width: 10,
    height: 10,
    borderColor: colors.text,
    borderTopWidth: sizes.stroke,
    borderRightWidth: sizes.stroke,
    transform: [{ rotate: "-135deg" }]
  },
  pressed: {
    opacity: 0.75
  },
  titleWrap: {
    flex: 1
  },
  // Pills and other small controls size themselves with alignSelf: flex-start; without this wrapper
  // they would sit at the top of the row instead of level with the title.
  headerRight: {
    alignSelf: "center"
  },
  title: {
    ...typeScale.screenTitle,
    color: colors.text
  },
  subtitle: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  section: {
    gap: spacing.s12
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  sectionHeaderTitle: {
    flex: 1
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: colors.text
  }
});
