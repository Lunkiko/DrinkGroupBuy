import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getMenuCategoryLabel, MenuCategoryTabs, MenuDrinkCard, MenuInfoBanner, MenuSectionHeading } from "../components/CustomerMenuParts";
import { ChoiceChip } from "../components/ChoiceChip";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { QuantityStepper } from "../components/QuantityStepper";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { getStoreMenu } from "../utils/apiClient";
import { formatCurrency, getGroupBuyActivityById } from "../utils/calculations";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useThemedStyles } from "../theme/ThemeContext";

export function DrinkSelectionScreen({ navigation, route, appState, actions, selectedCustomerId }) {
  const groupBuyActivity = getGroupBuyActivityById(appState.groupBuyActivities, route.params?.groupBuyActivityId);
  const [menu, setMenu] = useState(null);
  const [loading, setLoading] = useState(Boolean(groupBuyActivity));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!groupBuyActivity) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    getStoreMenu(groupBuyActivity.storeId)
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
  }, [groupBuyActivity?.storeId]);

  if (!groupBuyActivity) {
    return (
      <MobileScreen
        title="選擇飲料"
        onBack={() => navigation.goBack()}
      >
        <Section title="目前沒有可加入的團購">
          <EmptyPanel>團購已清空，或目前尚未有商家建立活動。</EmptyPanel>
          <PrimaryButton label="返回首頁" variant="secondary" onPress={() => goToCustomerHome(navigation)} />
        </Section>
      </MobileScreen>
    );
  }
  if (loading) {
    return (
      <MobileScreen title="選擇飲料" onBack={() => navigation.goBack()}>
        <Section title="正在載入"><EmptyPanel>正在讀取店家最新菜單與價格…</EmptyPanel></Section>
      </MobileScreen>
    );
  }
  if (error || !menu || menu.menuItems.length === 0) {
    return (
      <MobileScreen title="選擇飲料" onBack={() => navigation.goBack()}>
        <Section title="目前沒有可用菜單">
          {error ? (
            <Notice accessibilityRole="alert" message={error} tone="danger" />
          ) : (
            <EmptyPanel>這間店目前沒有上架飲品。</EmptyPanel>
          )}
        </Section>
      </MobileScreen>
    );
  }

  return (
    <DrinkMenuContent
      navigation={navigation}
      route={route}
      appState={appState}
      actions={actions}
      selectedCustomerId={selectedCustomerId}
      groupBuyActivity={groupBuyActivity}
      menu={menu}
    />
  );
}

function DrinkMenuContent({ navigation, route, appState, actions, selectedCustomerId, groupBuyActivity, menu }) {
  const styles = useThemedStyles(makeStyles);
  const scrollRef = useRef(null);
  const store = menu.store;
  const storeDrinks = menu.menuItems;

  const editOrderItem = route.params?.editOrderItem;
  const editOrderId = route.params?.editOrderId;
  const editOrder = editOrderId ? appState.orders.find((order) => order.id === editOrderId) : null;
  const initialDrinkId = storeDrinks.find((item) => item.id === editOrderItem?.drinkId)?.id ?? storeDrinks[0]?.id;
  const [drinkId, setDrinkId] = useState(initialDrinkId);
  const drink = storeDrinks.find((item) => item.id === drinkId) || storeDrinks[0];
  const [selectedOptionIds, setSelectedOptionIds] = useState(() => buildInitialSelections(drink, editOrderItem));
  const [quantity, setQuantity] = useState(editOrderItem?.quantity ?? 1);
  const [submitted, setSubmitted] = useState(false);
  const [customizing, setCustomizing] = useState(Boolean(editOrderItem));
  useEffect(() => {
    if (!submitted) return undefined;
    const timer = setTimeout(() => setSubmitted(false), 2400);
    return () => clearTimeout(timer);
  }, [submitted]);
  const cartItemsForGroupBuyActivity = (appState.cartItems ?? []).filter((item) => (
    item.groupBuyActivityId === groupBuyActivity.id && (!item.customerId || item.customerId === selectedCustomerId)
  ));
  const cartQuantity = cartItemsForGroupBuyActivity.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = cartItemsForGroupBuyActivity.reduce((sum, item) => sum + item.subtotal, 0);
  useEffect(() => {
    if (!submitted || cartQuantity === 0) return undefined;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 100);
    return () => clearTimeout(timer);
  }, [submitted, cartQuantity]);

  const selectedOptions = drink.customizationGroups
    .flatMap((group) => group.options.map((option) => ({ ...option, optionType: group.optionType })))
    .filter((option) => selectedOptionIds.includes(option.id));
  const unitPrice = drink.basePrice + selectedOptions.reduce((sum, option) => sum + option.priceDelta, 0);
  const subtotal = unitPrice * quantity;
  const categories = [{ id: "recommended", label: "全部" }, ...[...new Set(storeDrinks.map((item) => item.category))]
    .map((categoryId) => ({ id: categoryId, label: getMenuCategoryLabel(categoryId) }))];
  const [category, setCategory] = useState("recommended");
  const filteredDrinks = category === "recommended"
    ? storeDrinks
    : storeDrinks.filter((item) => item.category === category);
  const displayedDrinks = customizing ? [drink] : filteredDrinks;
  const customizationGroups = [...drink.customizationGroups].sort((left, right) => (
    ({ size: 0, sweetness: 1, ice: 2, topping: 3 }[left.optionType] ?? 4)
      - ({ size: 0, sweetness: 1, ice: 2, topping: 3 }[right.optionType] ?? 4)
  ));
  const drinkCards = displayedDrinks.length ? displayedDrinks.map((item) => (
    <MenuDrinkCard
      drink={item}
      key={item.id}
      recommended={item.id === storeDrinks[0]?.id && !customizing}
      onPress={customizing ? undefined : () => {
        setDrinkId(item.id);
        setSelectedOptionIds(buildInitialSelections(item, null));
        setSubmitted(false);
        setCustomizing(true);
      }}
    />
  )) : <EmptyPanel>此分類目前沒有品項。</EmptyPanel>;

  return (
    <View style={styles.screenWrap}>
      <MobileScreen
        title={editOrderItem ? "修改飲料" : customizing ? "客製化飲品" : store?.name ?? "選擇飲料"}
        onBack={() => customizing && !editOrderItem ? setCustomizing(false) : navigation.goBack()}
        scrollRef={scrollRef}
      >
      {!customizing ? <View style={styles.groupBuyRow}>
        <View style={styles.groupBuyIcon}>
          <View style={styles.groupBuyHeadLeft} /><View style={styles.groupBuyHeadRight} />
          <View style={styles.groupBuyBodyLeft} /><View style={styles.groupBuyBodyRight} />
        </View>
        <Text style={styles.groupBuyActivityName}>{groupBuyActivity.title}</Text>
      </View> : null}
      {!customizing ? <MenuInfoBanner title="先選擇飲料，再設定甜度、冰塊與加料" /> : null}
      {!customizing ? <View style={styles.menuHeader}>
        <MenuSectionHeading title="飲品菜單" />
        <MenuCategoryTabs categories={categories} selected={category} onSelect={setCategory} />
      </View> : null}

      {customizing ? (
        <View style={styles.drinkHero}>
          <View style={styles.drinkImageSlot} accessibilityLabel="飲品圖片留白" />
          <View style={styles.drinkHeroText}>
            <Text style={styles.drinkHeroName}>{drink.name}</Text>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.drinkHeroPrice}>{formatCurrency(drink.basePrice)}</Text>
            {drink.description ? <Text style={styles.drinkHeroDescription}>{drink.description}</Text> : null}
          </View>
        </View>
      ) : <View style={styles.menuList}>{drinkCards}</View>}

      {customizing ? (
        <>
          {customizationGroups.map((group) => (
            <Section key={group.optionType} title={getGroupTitle(group.optionType)} titleStyle={styles.optionHeading}>
              {group.options.length === 0 || group.maxSelections === 0 ? (
                <EmptyPanel>{`此飲品不提供${getGroupTitle(group.optionType)}選項。`}</EmptyPanel>
              ) : (
                <View style={styles.optionWrap}>
                  {group.options.map((option) => (
                    <OptionButton
                      key={option.id}
                      active={selectedOptionIds.includes(option.id)}
                      label={`${option.label}${option.priceDelta ? ` +${formatCurrency(option.priceDelta)}` : ""}`}
                      onPress={() => setSelectedOptionIds((current) => toggleOption(current, option.id, group))}
                    />
                  ))}
                </View>
              )}
              {group.optionType === "topping" && group.maxSelections > 0 ? (
                <Text style={styles.meta}>最多可選 {group.maxSelections} 種加料。</Text>
              ) : null}
            </Section>
          ))}

          <Section title="數量" titleStyle={styles.optionHeading}>
            <QuantityStepper
              decreaseLabel="減少一杯"
              increaseLabel="增加一杯"
              onDecrease={() => setQuantity((value) => Math.max(1, value - 1))}
              onIncrease={() => setQuantity((value) => value + 1)}
              value={quantity}
            />
          </Section>

          <Section title="小計" titleStyle={styles.optionHeading}>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.subtotal}>{formatCurrency(subtotal)}</Text>
          </Section>

          <View style={styles.actionBlock}>
            <PrimaryButton
              label={editOrderItem ? "儲存修改" : editOrderId ? "加入訂單並重新預授權" : "加入購物車"}
              onPress={() => {
                if (submitted) return;
                const orderItem = buildCartItem({
                  drink,
                  store,
                  groupBuyActivity,
                  quantity,
                  unitPrice,
                  subtotal,
                  selectedOptions,
                  selectedOptionIds
                });
                if (editOrderItem) {
                  // route.params must stay JSON-serializable, so the caller (CustomerOrdersScreen)
                  // passes editOrderId instead of a save callback; the merge-and-replace logic that
                  // used to live in that callback happens here instead, against the order's current
                  // items looked up fresh from appState.
                  const updatedItem = { ...editOrderItem, ...orderItem };
                  const nextItems = (editOrder?.items ?? []).map((current) => (
                    current.id === updatedItem.id ? updatedItem : current
                  ));
                  actions.updateOrderItems(editOrderId, nextItems);
                  navigation.goBack();
                  return;
                }
                if (editOrderId) {
                  actions.addToCart({
                    ...orderItem,
                    targetOrderId: editOrderId,
                  });
                  setCustomizing(false);
                  setQuantity(1);
                  return;
                }
                actions.addToCart({
                  ...orderItem
                });
                setSubmitted(true);
              }}
            />
          </View>
        </>
      ) : <Text style={styles.menuHint}>點選飲品，設定客製化選項</Text>}
      {cartQuantity > 0 ? <View style={styles.cartSpacer} /> : null}
      </MobileScreen>
      {cartQuantity > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.push("cart", { groupBuyActivityId: groupBuyActivity.id })}
          style={({ pressed }) => [styles.floatingCart, pressed && styles.pressed]}
        >
          <View style={styles.cartBadge}>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cartBadgeText}>{cartQuantity}</Text>
          </View>
          <View style={styles.floatingCartTextGroup}>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.floatingCartTitle}>購物車</Text>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.floatingCartMeta}>{formatCurrency(cartTotal)}</Text>
          </View>
          <View style={styles.floatingCartArrow} />
        </Pressable>
      ) : null}
      {submitted ? <View style={styles.successToast}><Notice message="已加入購物車。" tone="success" /></View> : null}
    </View>
  );
}

function buildInitialSelections(drink, editOrderItem) {
  const existingIds = new Set(editOrderItem?.customizationOptionIds || []);
  const selected = [];
  for (const group of drink.customizationGroups) {
    const matchingById = group.options.filter((option) => existingIds.has(option.id));
    const matchingByLabel = group.options.filter((option) => {
      if (group.optionType === "topping") return editOrderItem?.toppings?.includes(option.label);
      return editOrderItem?.[group.optionType] === option.label;
    });
    const matches = matchingById.length ? matchingById : matchingByLabel;
    if (matches.length) {
      selected.push(...matches.slice(0, group.maxSelections));
    } else if (group.minSelections > 0 && group.options[0]) {
      selected.push(group.options[0]);
    }
  }
  return selected.map((option) => option.id);
}

function toggleOption(current, optionId, group) {
  const groupIds = new Set(group.options.map((option) => option.id));
  const activeGroupIds = current.filter((id) => groupIds.has(id));
  if (activeGroupIds.includes(optionId)) {
    if (activeGroupIds.length <= group.minSelections) return current;
    return current.filter((id) => id !== optionId);
  }
  if (group.maxSelections === 1) {
    return [...current.filter((id) => !groupIds.has(id)), optionId];
  }
  if (activeGroupIds.length >= group.maxSelections) return current;
  return [...current, optionId];
}

function buildCartItem({ drink, store, groupBuyActivity, quantity, unitPrice, subtotal, selectedOptions, selectedOptionIds }) {
  const labelFor = (optionType) => selectedOptions.find((option) => option.optionType === optionType)?.label || "";
  return {
    groupBuyActivityId: groupBuyActivity.id,
    drinkId: drink.id,
    storeName: store.name,
    name: drink.name,
    itemName: drink.name,
    size: labelFor("size"),
    quantity,
    sweetness: labelFor("sweetness"),
    ice: labelFor("ice"),
    toppings: selectedOptions.filter((option) => option.optionType === "topping").map((option) => option.label),
    customizationOptionIds: selectedOptionIds,
    unitPrice,
    subtotal
  };
}

function getGroupTitle(optionType) {
  return { size: "尺寸", sweetness: "甜度", ice: "冰塊", topping: "加料" }[optionType] || optionType;
}

function OptionButton({ active, label, onPress }) {
  return <ChoiceChip label={label} onPress={onPress} selected={active} />;
}

const makeStyles = (colors) => StyleSheet.create({
  screenWrap: {
    flex: 1
  },
  groupBuyRow: { flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  groupBuyIcon: { width: 27, height: 25 },
  groupBuyHeadLeft: { position: "absolute", top: 1, left: 3, width: 9, height: 9, borderWidth: sizes.stroke, borderColor: colors.textSecondary, borderRadius: radii.pill },
  groupBuyHeadRight: { position: "absolute", top: 1, right: 3, width: 9, height: 9, borderWidth: sizes.stroke, borderColor: colors.textSecondary, borderRadius: radii.pill },
  groupBuyBodyLeft: { position: "absolute", bottom: 1, left: 0, width: 15, height: 11, borderWidth: sizes.stroke, borderColor: colors.textSecondary, borderBottomWidth: 0, borderTopLeftRadius: radii.pill, borderTopRightRadius: radii.pill },
  groupBuyBodyRight: { position: "absolute", bottom: 1, right: 0, width: 15, height: 11, borderWidth: sizes.stroke, borderColor: colors.textSecondary, borderBottomWidth: 0, borderTopLeftRadius: radii.pill, borderTopRightRadius: radii.pill },
  groupBuyActivityName: {
    ...typeScale.sectionTitle,
    color: colors.text
  },
  menuHeader: { gap: spacing.s12 },
  menuList: { gap: spacing.s8 },
  menuHint: { ...typeScale.bodyDense, color: colors.textSecondary },
  drinkHero: {
    minHeight: 150,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s16,
    paddingBottom: spacing.s24,
    borderBottomWidth: 1,
    borderColor: colors.lineRow
  },
  drinkImageSlot: {
    width: 104,
    height: 124,
    borderRadius: radii.md,
    backgroundColor: colors.recess
  },
  drinkHeroText: { flex: 1, gap: spacing.s12 },
  drinkHeroName: { ...typeScale.screenTitle, color: colors.text },
  drinkHeroPrice: { ...typeScale.amount, color: colors.text },
  drinkHeroDescription: { ...typeScale.bodyDense, color: colors.textSecondary },
  optionHeading: { ...typeScale.price },
  optionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s8
  },
  subtotal: {
    ...typeScale.amount,
    color: colors.text
  },
  meta: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  actionBlock: {
    gap: spacing.s12
  },
  // Keeps the last content clear of the floating cart button (only rendered while that button shows).
  cartSpacer: {
    height: sizes.buttonHeight + spacing.s32 * 2
  },
  successToast: {
    position: "absolute",
    right: spacing.s20,
    bottom: sizes.buttonHeight + spacing.s32,
    left: spacing.s20,
    zIndex: 2
  },
  pressed: {
    opacity: 0.8
  },
  // Floats over the content, so it keeps an Android elevation (docs/ui-style-guide.md, principle 3).
  floatingCart: {
    position: "absolute",
    right: spacing.s20,
    bottom: spacing.s16,
    minHeight: sizes.buttonHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    paddingVertical: spacing.s8,
    paddingLeft: spacing.s8,
    paddingRight: spacing.s20,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    elevation: 8
  },
  cartBadge: {
    minWidth: spacing.s32,
    minHeight: spacing.s32,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.s8,
    borderRadius: radii.pill,
    backgroundColor: colors.text
  },
  cartBadgeText: {
    ...typeScale.button,
    color: colors.onDark
  },
  floatingCartTextGroup: {
    flexShrink: 1
  },
  floatingCartTitle: {
    ...typeScale.button,
    color: colors.onAccent
  },
  floatingCartMeta: {
    ...typeScale.caption,
    color: colors.onAccent
  },
  // A right-pointing chevron drawn like the back arrow in MobileScreen (a 10px corner, rotated).
  floatingCartArrow: {
    width: 10,
    height: 10,
    borderColor: colors.onAccent,
    borderTopWidth: sizes.stroke,
    borderRightWidth: sizes.stroke,
    transform: [{ rotate: "45deg" }]
  }
});
