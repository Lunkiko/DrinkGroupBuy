import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AccentHeading } from "../components/AccentHeading";
import { CategoryChips } from "../components/CategoryChips";
import { ChoiceChip } from "../components/ChoiceChip";
import { DrinkRow } from "../components/DrinkRow";
import { EmptyPanel } from "../components/EmptyPanel";
import { Icon } from "../components/Icon";
import { InfoBanner } from "../components/InfoBanner";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { QuantityStepper } from "../components/QuantityStepper";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";
import { getStoreMenu } from "../utils/apiClient";
import { formatCurrency, getGroupBuyActivityById } from "../utils/calculations";
import { getCategoryLabel } from "../utils/menuCategory";
import { goToCustomerHome } from "../navigation/goToCustomerHome";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";

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

// One screen with two views, matching the blueprint's two pictures: the menu list, and (after tapping a drink)
// the customising view whose back arrow returns to the list. Editing an existing order's item opens straight
// on the customising view and its back arrow leaves the screen.
function DrinkMenuContent({ navigation, route, appState, actions, selectedCustomerId, groupBuyActivity, menu }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
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
  const cartItemsForGroupBuyActivity = (appState.cartItems ?? []).filter((item) => (
    item.groupBuyActivityId === groupBuyActivity.id && (!item.customerId || item.customerId === selectedCustomerId)
  ));
  const cartQuantity = cartItemsForGroupBuyActivity.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = cartItemsForGroupBuyActivity.reduce((sum, item) => sum + item.subtotal, 0);

  const selectedOptions = drink.customizationGroups
    .flatMap((group) => group.options)
    .filter((option) => selectedOptionIds.includes(option.id));
  const unitPrice = drink.basePrice + selectedOptions.reduce((sum, option) => sum + option.priceDelta, 0);
  const subtotal = unitPrice * quantity;
  const categories = [{ id: "recommended", label: "全部" }, ...[...new Set(storeDrinks.map((item) => item.category))]
    .map((categoryId) => ({ id: categoryId, label: getCategoryLabel(categoryId) }))];
  const [category, setCategory] = useState("recommended");
  const filteredDrinks = category === "recommended"
    ? storeDrinks
    : storeDrinks.filter((item) => item.category === category);

  const addToCart = () => {
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
      setSubmitted(true);
      navigation.goBack();
      return;
    }
    if (editOrderId) {
      actions.addToCart({
        ...orderItem,
        targetOrderId: editOrderId,
      });
    } else {
      actions.addToCart({
        ...orderItem
      });
    }
    // Stay on the customising view (the blueprint shows the "已加入購物車" banner there) and reset the count.
    setSubmitted(true);
    setQuantity(1);
  };

  const title = customizing
    ? (editOrderItem ? "修改飲料" : "客製化飲品")
    : (store?.name ?? "選擇飲料");

  return (
    <View style={styles.screenWrap}>
      <MobileScreen
        title={title}
        onBack={customizing && !editOrderItem ? () => setCustomizing(false) : () => navigation.goBack()}
      >
        {customizing ? (
          <>
            <View style={styles.hero}>
              <View style={styles.heroPhoto}>
                <Icon color={colors.textSecondary} name="image" size={48} />
              </View>
              <View style={styles.heroText}>
                <Text style={styles.heroName}>{drink.name}</Text>
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.heroPrice}>{formatCurrency(drink.basePrice)}</Text>
                {drink.description ? <Text style={styles.heroDescription}>{drink.description}</Text> : null}
              </View>
            </View>
            <View style={styles.divider} />

            {sortGroupsForDisplay(drink.customizationGroups).map((group) => (
              <View key={group.optionType} style={styles.group}>
                <Text accessibilityRole="header" style={styles.groupTitle}>{getGroupTitle(group.optionType)}</Text>
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
              </View>
            ))}

            <View style={styles.group}>
              <Text accessibilityRole="header" style={styles.groupTitle}>數量</Text>
              <QuantityStepper
                decreaseLabel="減少一杯"
                increaseLabel="增加一杯"
                onDecrease={() => setQuantity((value) => Math.max(1, value - 1))}
                onIncrease={() => setQuantity((value) => value + 1)}
                value={quantity}
              />
            </View>

            <View style={styles.group}>
              <Text accessibilityRole="header" style={styles.groupTitle}>小計</Text>
              <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.subtotal}>{formatCurrency(subtotal)}</Text>
            </View>

            <View style={styles.actionBlock}>
              <PrimaryButton
                label={editOrderItem ? "儲存修改" : editOrderId ? "加入訂單並重新預授權" : "加入購物車"}
                onPress={addToCart}
              />
              {submitted ? <Notice message="已加入購物車。" tone="success" /> : null}
            </View>
          </>
        ) : (
          <>
            <View style={styles.subtitleRow}>
              <Icon color={colors.textSecondary} name="people" size={26} />
              <Text style={styles.subtitle}>{groupBuyActivity.title}</Text>
            </View>

            <InfoBanner message="先選擇飲料，再設定甜度、冰塊與加料" />

            <View style={styles.listBlock}>
              <AccentHeading title="飲品菜單" />
              <CategoryChips categories={categories} onChange={setCategory} value={category} />
            </View>

            <View style={styles.listBlock}>
              <Text accessibilityRole="header" style={styles.groupTitle}>人氣推薦</Text>
              {filteredDrinks.length ? filteredDrinks.map((item) => (
                <DrinkRow
                  key={item.id}
                  name={item.name}
                  onPress={() => {
                    setDrinkId(item.id);
                    setSelectedOptionIds(buildInitialSelections(item, null));
                    setSubmitted(false);
                    setCustomizing(true);
                  }}
                  priceText={formatCurrency(item.basePrice)}
                  recommended={item.id === storeDrinks[0]?.id}
                />
              )) : (
                <EmptyPanel>此分類目前沒有品項。</EmptyPanel>
              )}
              <Text style={styles.meta}>點選飲品，設定客製化選項</Text>
            </View>
          </>
        )}
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
          <Icon color={colors.onAccent} name="chevronRight" size={24} />
        </Pressable>
      ) : null}
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

// Display order only (size, sweetness, ice, topping), whatever order the menu data lists the groups in.
const GROUP_DISPLAY_ORDER = ["size", "sweetness", "ice", "topping"];

function sortGroupsForDisplay(groups) {
  const rank = (optionType) => {
    const index = GROUP_DISPLAY_ORDER.indexOf(optionType);
    return index === -1 ? GROUP_DISPLAY_ORDER.length : index;
  };
  return [...groups].sort((left, right) => rank(left.optionType) - rank(right.optionType));
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
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8
  },
  subtitle: {
    ...typeScale.button,
    fontSize: 17,
    color: colors.text
  },
  listBlock: {
    gap: spacing.s12
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s16
  },
  heroPhoto: {
    width: 128,
    height: 160,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recess
  },
  heroText: {
    flex: 1,
    gap: spacing.s8
  },
  heroName: {
    ...typeScale.screenTitle,
    color: colors.text
  },
  heroPrice: {
    ...typeScale.amount,
    color: colors.text
  },
  heroDescription: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  divider: {
    height: 2,
    backgroundColor: colors.lineRow
  },
  group: {
    gap: spacing.s12
  },
  groupTitle: {
    ...typeScale.sectionTitle,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text
  },
  optionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s8
  },
  subtotal: {
    ...typeScale.amount,
    fontSize: 32,
    lineHeight: 38,
    color: colors.text
  },
  meta: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  actionBlock: {
    gap: spacing.s12
  },
  // Keeps the last content clear of the floating cart button (only rendered while that button shows).
  cartSpacer: {
    height: sizes.buttonHeight
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
    paddingRight: spacing.s16,
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
  }
});
