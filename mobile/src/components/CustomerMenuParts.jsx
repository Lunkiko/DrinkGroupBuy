import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "./Card";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";
import { formatCurrency } from "../utils/calculations";

const categoryLabels = {
  coffee: "咖啡",
  fruit_tea: "果茶",
  fruit: "果茶",
  milk_tea: "奶茶",
  tea: "純茶",
  pure_tea: "純茶",
  juice: "果汁",
  smoothie: "冰沙",
  latte: "拿鐵",
  sparkling: "氣泡飲",
  other: "其他飲品"
};

export function getMenuCategoryLabel(category) {
  if (categoryLabels[category]) return categoryLabels[category];
  if (/^[\u3400-\u9FFF\s]+$/.test(category ?? "")) return category.trim();
  return "其他飲品";
}

export function MenuCategoryTabs({ categories, selected, onSelect }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
      {categories.map(({ id, label }) => (
        <Pressable
          key={id}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === id }}
          onPress={() => onSelect(id)}
          style={[styles.category, selected === id && styles.categorySelected]}
        >
          <Text style={[styles.categoryText, selected === id && styles.categoryTextSelected]}>{label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function MenuInfoBanner({ title, detail }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.banner}>
      <View style={styles.infoCircle}><Text style={styles.infoLetter}>i</Text></View>
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>{title}</Text>
        {detail ? <Text style={styles.bannerDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

export function MenuSectionHeading({ title, detail }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionMark} />
      <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
      {detail ? <Text style={styles.sectionDetail}>{detail}</Text> : null}
    </View>
  );
}

export function MenuPhotoPlaceholder({ logo = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.photo, logo && styles.logoPhoto]} accessibilityLabel={logo ? "店家標誌留白" : "飲品圖片留白"}>
      <View style={styles.pictureFrame}>
        <View style={styles.pictureDot} />
        <View style={styles.pictureMountain} />
      </View>
      {logo ? <Text style={styles.logoText}>LOGO</Text> : null}
    </View>
  );
}

export function MenuDrinkCard({ drink, onPress, recommended = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card compact onPress={onPress} style={styles.drinkCard}>
      <MenuPhotoPlaceholder />
      <View style={styles.drinkNameWrap}>
        <Text numberOfLines={2} style={styles.drinkName}>{drink.name}</Text>
        {recommended ? <Text style={styles.recommendTag}>推薦</Text> : null}
      </View>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.price}>{formatCurrency(drink.basePrice)}</Text>
      {onPress ? <Text style={styles.arrow}>›</Text> : null}
    </Card>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  categories: { gap: spacing.s8, paddingVertical: spacing.s4 },
  category: {
    minHeight: sizes.tap,
    minWidth: 68,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.s16,
    borderRadius: radii.pill,
    backgroundColor: colors.recess
  },
  categorySelected: { backgroundColor: colors.accent },
  categoryText: { ...typeScale.bodyDense, fontWeight: "700", color: colors.text },
  categoryTextSelected: { color: colors.onAccent },
  banner: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s16,
    padding: spacing.s16,
    borderRadius: radii.md,
    backgroundColor: colors.recess
  },
  infoCircle: {
    width: 32, height: 32, borderRadius: radii.pill,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.accent
  },
  infoLetter: { ...typeScale.price, color: colors.onAccent },
  bannerText: { flex: 1, gap: spacing.s4 },
  bannerTitle: { ...typeScale.sectionTitle, color: colors.text },
  bannerDetail: { ...typeScale.bodyDense, color: colors.textSecondary },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  sectionMark: { width: 4, height: 23, borderRadius: radii.pill, backgroundColor: colors.warmInk },
  sectionTitle: { ...typeScale.screenTitle, color: colors.text, flex: 1 },
  sectionDetail: { ...typeScale.bodyDense, color: colors.textSecondary },
  photo: {
    width: 54, height: 54, borderRadius: radii.sm,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.recess
  },
  logoPhoto: { width: 76, height: 76, gap: spacing.s4 },
  pictureFrame: {
    width: 30, height: 30, borderWidth: sizes.stroke,
    borderColor: colors.lineInput, borderRadius: radii.xs, overflow: "hidden"
  },
  pictureDot: {
    position: "absolute", top: 4, right: 4, width: 6, height: 6,
    borderRadius: radii.pill, backgroundColor: colors.lineInput
  },
  pictureMountain: {
    position: "absolute", bottom: -5, left: 4, width: 18, height: 18,
    borderTopWidth: sizes.stroke, borderLeftWidth: sizes.stroke,
    borderColor: colors.lineInput, transform: [{ rotate: "45deg" }]
  },
  logoText: { ...typeScale.caption, fontWeight: "700", color: colors.textSecondary },
  drinkCard: {
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    padding: spacing.s8,
    borderRadius: radii.md
  },
  drinkNameWrap: { flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.s8 },
  drinkName: { ...typeScale.button, color: colors.text, flexShrink: 1 },
  recommendTag: {
    ...typeScale.label,
    color: colors.warmInk,
    backgroundColor: colors.progressTrack,
    borderRadius: radii.xs,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s4
  },
  price: { ...typeScale.price, color: colors.text },
  arrow: { ...typeScale.screenTitle, color: colors.accentInk }
});
