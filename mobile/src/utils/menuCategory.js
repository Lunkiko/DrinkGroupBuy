// The four category slugs the seed menus use, shown in the Chinese names the blueprint uses. Anything else
// (merchants type their own categories, e.g. "鮮奶茶類") is shown as typed.
const CATEGORY_LABELS = { coffee: "咖啡", fruit: "果茶", milk_tea: "奶茶", tea: "純茶" };

export function getCategoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}
