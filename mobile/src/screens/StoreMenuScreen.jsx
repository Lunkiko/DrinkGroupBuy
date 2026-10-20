import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AccentHeading } from "../components/AccentHeading";
import { CategoryChips } from "../components/CategoryChips";
import { DrinkRow } from "../components/DrinkRow";
import { EmptyPanel } from "../components/EmptyPanel";
import { Icon } from "../components/Icon";
import { InfoBanner } from "../components/InfoBanner";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { TonePill } from "../components/TonePill";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { getStoreMenu } from "../utils/apiClient";
import { formatCurrency } from "../utils/calculations";
import { getCategoryLabel } from "../utils/menuCategory";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

const businessStatusLabels = {
  open: "營業中",
  closed: "休息中",
  temporarily_closed: "暫停營業"
};

// Pill tone per business status; an unknown value falls back to neutral and shows its raw text.
const businessStatusTones = {
  open: "success",
  closed: "neutral",
  temporarily_closed: "warning"
};

export function StoreMenuScreen({ navigation, route }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const storeId = route.params?.storeId;
  const [menu, setMenu] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [category, setCategory] = useState("all");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getStoreMenu(storeId)
      .then((result) => {
        if (active) setMenu(result);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "菜單載入失敗。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [storeId]);

  const store = menu?.store;
  const storeDrinks = menu?.menuItems || [];

  if (loading) {
    return (
      <MobileScreen title="店家菜單" onBack={() => navigation.goBack()}>
        <Section title="正在載入"><EmptyPanel>正在讀取店家最新菜單…</EmptyPanel></Section>
      </MobileScreen>
    );
  }

  if (!store) {
    return (
      <MobileScreen
        title="店家菜單"
        onBack={() => navigation.goBack()}
      >
        <Section title="找不到店家">
          <Notice tone="danger" accessibilityRole="alert" message={error || "後端找不到這間店家。"} />
          <PrimaryButton label="返回地圖" variant="secondary" onPress={() => navigation.goBack()} />
        </Section>
      </MobileScreen>
    );
  }

  const categories = [{ id: "all", label: "全部" }, ...[...new Set(storeDrinks.map((item) => item.category))]
    .map((categoryId) => ({ id: categoryId, label: getCategoryLabel(categoryId) }))];
  const visibleDrinks = category === "all" ? storeDrinks : storeDrinks.filter((item) => item.category === category);

  return (
    <MobileScreen
      title="店家菜單"
      onBack={() => navigation.goBack()}
    >
      <View style={styles.storeCard}>
        <View style={styles.storeLogo}>
          <Icon color={colors.accent} name="store" size={44} />
        </View>
        <View style={styles.storeInfo}>
          <View style={styles.storeTop}>
            <Text style={styles.storeName}>{store.name}</Text>
            <TonePill
              tone={businessStatusTones[store.businessStatus] ?? "neutral"}
              label={businessStatusLabels[store.businessStatus] ?? store.businessStatus}
            />
          </View>
          <View style={styles.iconLine}>
            <Icon color={colors.textSecondary} name="pin" size={20} />
            <Text style={styles.meta}>{store.address}</Text>
          </View>
          {store.phone ? (
            <View style={styles.iconLine}>
              <Icon color={colors.textSecondary} name="phone" size={20} />
              <Text style={styles.meta}>{store.phone}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <InfoBanner
        title="目前沒有進行中的團購"
        message="菜單僅供瀏覽，無法加入購物車或建立訂單"
      />

      <View style={styles.listBlock}>
        <View style={styles.headingRow}>
          <AccentHeading title="飲品菜單" />
          <Text style={styles.meta}>僅供瀏覽</Text>
        </View>
        <CategoryChips categories={categories} onChange={setCategory} value={category} />
        {visibleDrinks.length > 0 ? (
          visibleDrinks.map((drink) => (
            <DrinkRow key={drink.id} name={drink.name} priceText={formatCurrency(drink.basePrice)} />
          ))
        ) : (
          <EmptyPanel>{storeDrinks.length === 0 ? "此店家目前沒有上架飲品。" : "此分類目前沒有品項。"}</EmptyPanel>
        )}
      </View>
    </MobileScreen>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  storeCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.s16,
    padding: spacing.s16,
    borderRadius: radii.md,
    borderWidth: sizes.stroke,
    borderColor: colors.lineDecor,
    backgroundColor: colors.page
  },
  storeLogo: {
    width: 76,
    height: 76,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  storeInfo: {
    flex: 1,
    gap: spacing.s8
  },
  storeTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.s8
  },
  storeName: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    flex: 1,
    color: colors.text
  },
  iconLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  meta: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  listBlock: {
    gap: spacing.s12
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s12
  }
});
