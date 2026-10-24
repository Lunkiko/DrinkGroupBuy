import { Pressable, StyleSheet, Text, View } from "react-native";
import { StackActions } from "@react-navigation/native";
import { maxFontSizeMultiplier, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

// Label for every tab a bottom-tab navigator can show (keyed by the TAB's own route name, e.g.
// "HomeTab" -- not the screen name inside its nested stack, e.g. "nearby", which stays distinct on
// purpose so react-navigation never has to guess whether a `navigate("nearby")` call means "switch
// tab" or "push this screen in whichever stack is currently active"). CustomerTabs and MerchantTabs
// each register only their own tabs, so `state.routes` below never mixes customer and merchant items --
// no role filtering needed here any more.
const TAB_INFO = {
  HomeTab: { label: "首頁" },
  LiveMapTab: { label: "即時地圖" },
  OrdersTab: { label: "我的訂單" },
  ProfileTab: { label: "個人中心" },
  MerchantDashboardTab: { label: "首頁" },
  MerchantCreateTab: { label: "開團" },
  MerchantMenuTab: { label: "菜單" },
  MerchantStatisticsTab: { label: "分析" }
};

// react-navigation's own tabBar prop shape ({ state, descriptors, navigation }); passed as
// tabBar={(props) => <BottomNav {...props} />} to CustomerTabs' / MerchantTabs' Tab.Navigator.
// Each tab is a dot and a label (docs/ui-style-guide.md).
export function BottomNav({ state, navigation }) {
  const styles = useThemedStyles(makeStyles);

  // Re-enter a customer tab at its first screen, even when its nested stack was left on a detail page.
  // Tapping the active tab still uses React Navigation's built-in tabPress pop-to-top behavior.
  const handleTabPress = (route, active) => {
    const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (!active && !event.defaultPrevented) {
      if (["HomeTab", "LiveMapTab", "OrdersTab", "ProfileTab"].includes(route.name) && route.state?.index > 0) {
        navigation.dispatch({ ...StackActions.popToTop(), target: route.state.key });
      }
      navigation.navigate(route.name);
    }
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
            <View style={[styles.dot, active && styles.dotActive]} />
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.label, active && styles.labelActive]}>
              {info.label}
            </Text>
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
