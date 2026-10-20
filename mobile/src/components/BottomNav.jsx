import { Pressable, StyleSheet, Text, View } from "react-native";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { Icon } from "./Icon";

// Label for every tab a bottom-tab navigator can show (keyed by the TAB's own route name, e.g.
// "HomeTab" -- not the screen name inside its nested stack, e.g. "nearby", which stays distinct on
// purpose so react-navigation never has to guess whether a `navigate("nearby")` call means "switch
// tab" or "push this screen in whichever stack is currently active"). CustomerTabs and MerchantTabs
// each register only their own tabs, so `state.routes` below never mixes customer and merchant items --
// no role filtering needed here any more.
// The customer tabs carry a line icon (2026-10 designer blueprint); the merchant tabs have no icon design
// yet and keep the dot.
const TAB_INFO = {
  HomeTab: { label: "首頁", icon: "home" },
  LiveMapTab: { label: "即時地圖", icon: "pin" },
  OrdersTab: { label: "我的訂單", icon: "orders" },
  ProfileTab: { label: "個人中心", icon: "profile" },
  MerchantDashboardTab: { label: "首頁" },
  MerchantCreateTab: { label: "開團" },
  MerchantMenuTab: { label: "菜單" },
  MerchantStatisticsTab: { label: "分析" }
};

// react-navigation's own tabBar prop shape ({ state, descriptors, navigation }); passed as
// tabBar={(props) => <BottomNav {...props} />} to CustomerTabs' / MerchantTabs' Tab.Navigator.
// A tab with an icon sits in a soft pill while selected; a tab without one is a dot and a label.
export function BottomNav({ state, navigation }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();

  // Emitting tabPress lets the tab's own native-stack pop back to its root when the already-active tab
  // is tapped again (native-stack listens for it); tapping a different tab just switches to it and
  // keeps that tab's history.
  const handleTabPress = (route, active) => {
    const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (!active && !event.defaultPrevented) navigation.navigate(route.name);
  };

  return (
    <View style={styles.nav}>
      {state.routes.map((route, index) => {
        const info = TAB_INFO[route.name];
        const active = state.index === index;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={route.key}
            onPress={() => handleTabPress(route, active)}
            style={styles.item}
          >
            {info.icon ? (
              <View style={[styles.pill, active && styles.pillActive]}>
                <Icon
                  color={active ? colors.accent : colors.textSecondary}
                  cutout={colors.recess}
                  filled={active}
                  name={info.icon}
                  size={26}
                />
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.label, active && styles.labelActive]}>
                  {info.label}
                </Text>
              </View>
            ) : (
              <>
                <View style={[styles.dot, active && styles.dotActive]} />
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.label, active && styles.labelActive]}>
                  {info.label}
                </Text>
              </>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  nav: {
    flexDirection: "row",
    minHeight: 64,
    borderTopWidth: sizes.stroke,
    borderTopColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  item: {
    flex: 1,
    minHeight: sizes.tap,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s4
  },
  pill: {
    alignSelf: "stretch",
    marginHorizontal: spacing.s8,
    alignItems: "center",
    gap: spacing.s4,
    paddingVertical: spacing.s8,
    borderRadius: radii.lg
  },
  pillActive: {
    backgroundColor: colors.recess
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: sizes.stroke,
    borderColor: colors.textSecondary
  },
  dotActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  label: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  labelActive: {
    color: colors.accentInk,
    fontWeight: typeScale.label.fontWeight
  }
});
