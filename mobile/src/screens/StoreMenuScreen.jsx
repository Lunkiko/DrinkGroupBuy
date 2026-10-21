import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { getMenuCategoryLabel, MenuCategoryTabs, MenuDrinkCard, MenuInfoBanner, MenuPhotoPlaceholder, MenuSectionHeading } from "../components/CustomerMenuParts";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { TonePill } from "../components/TonePill";
import { spacing, typeScale } from "../theme/tokens";
import { getStoreMenu } from "../utils/apiClient";
import { useThemedStyles } from "../theme/ThemeContext";

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
  const categories = [{ id: "all", label: "全部" }, ...[...new Set(storeDrinks.map((item) => item.category))]
    .map((id) => ({ id, label: getMenuCategoryLabel(id) }))];
  const displayedDrinks = category === "all" ? storeDrinks : storeDrinks.filter((item) => item.category === category);

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

  return (
    <MobileScreen
      title="店家菜單"
      onBack={() => navigation.goBack()}
    >
      <Card style={styles.storeCard}>
        <MenuPhotoPlaceholder logo />
        <View style={styles.storeDetails}>
          <View style={styles.storeHeader}>
            <Text style={styles.storeName}>{store.name}</Text>
            <TonePill tone={businessStatusTones[store.businessStatus] ?? "neutral"} label={businessStatusLabels[store.businessStatus] ?? store.businessStatus} />
          </View>
          {store.address ? <Text style={styles.meta}>●  {store.address}</Text> : null}
          {store.phone ? <Text style={styles.meta}>☎  {store.phone}</Text> : null}
        </View>
      </Card>

      <MenuInfoBanner title="目前沒有進行中的團購" detail="菜單僅供瀏覽，無法加入購物車或建立訂單" />

      <View style={styles.menuContent}>
        <MenuSectionHeading title="飲品菜單" detail="僅供瀏覽" />
        <MenuCategoryTabs categories={categories} selected={category} onSelect={setCategory} />
        <View style={styles.drinkList}>
          {displayedDrinks.length > 0
            ? displayedDrinks.map((drink) => <MenuDrinkCard key={drink.id} drink={drink} />)
            : <EmptyPanel>{storeDrinks.length ? "此分類目前沒有品項。" : "此店家目前沒有上架飲品。"}</EmptyPanel>}
        </View>
      </View>
    </MobileScreen>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  storeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    padding: spacing.s12
  },
  storeDetails: {
    flex: 1,
    gap: spacing.s4
  },
  storeHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.s4
  },
  storeName: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  meta: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  menuContent: { gap: spacing.s12 },
  drinkList: { gap: spacing.s8 }
});
