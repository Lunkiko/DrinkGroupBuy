// Fake data for EXPO_PUBLIC_DEMO_MODE (see ../utils/demoMode.js). Modeled on the real seeded
// store-001 ("青山手作茶 中科店") and its real menu items (database/production-reference-seed-postgres.sql)
// so the demo looks like genuine content instead of placeholder text -- only the IDs and the group-buy
// activity itself are made up, since there is no real backend behind this mode to own them.

const now = Date.now();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const demoStores = [
  {
    id: "store-001",
    name: "青山手作茶 中科店",
    address: "台中市北區三民路三段 150 號",
    phone: "04-2233-0001",
    businessStatus: "open",
    latitude: 24.1511,
    longitude: 120.6817
  }
];

// Raw, backend-response-shaped object -- fed through normalizeBackendGroupBuyActivity the same way
// a real listGroupBuyActivities() row would be, so AppStateProvider doesn't need a second, separately
//-shaped code path for demo data. Deadline/pickup times are computed relative to "now" (not a fixed
// date) so the demo never opens already-expired.
export const demoRawGroupBuyActivity = {
  id: "demo-activity-001",
  storeId: "store-001",
  store: demoStores[0],
  title: "中科辦公室揪團",
  status: "recruiting",
  startAt: new Date(now - DAY_MS).toISOString(),
  deadlineAt: new Date(now + 2 * DAY_MS).toISOString(),
  pickupStartAt: new Date(now + 2 * DAY_MS + 2 * HOUR_MS).toISOString(),
  pickupEndAt: new Date(now + 2 * DAY_MS + 5 * HOUR_MS).toISOString(),
  tiers: [
    { id: "demo-tier-1", targetCups: 20, discountPercent: 10, sortOrder: 0 },
    { id: "demo-tier-2", targetCups: 40, discountPercent: 15, sortOrder: 1 }
  ],
  authorizedCups: 23,
  participantCount: 12,
  maximumCups: 60,
  // Normally computed server-side from authorizedCups against tiers -- filled in by hand here since
  // there is no backend to compute them. 23 cups has cleared the 20-cup tier but not the 40-cup one.
  currentTierId: "demo-tier-1",
  currentTierTargetCups: 20,
  currentTierDiscountPercent: 10,
  nextTierTargetCups: 40,
  cupsToNextTier: 17
};

// Same shape getStoreMenu() returns from GET /api/stores/:storeId/menu.
export const demoMenu = {
  store: demoStores[0],
  menuItems: [
    {
      id: "drink-001",
      name: "青山烏龍拿鐵",
      category: "milk_tea",
      description: "木質烏龍茶香，搭配濃厚鮮奶",
      basePrice: 65,
      isAvailable: true,
      customizationGroups: [
        {
          optionType: "sweetness",
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "demo-drink-001-sweet-regular", label: "正常糖", priceDelta: 0 },
            { id: "demo-drink-001-sweet-half", label: "半糖", priceDelta: 0 },
            { id: "demo-drink-001-sweet-light", label: "微糖", priceDelta: 0 },
            { id: "demo-drink-001-sweet-none", label: "無糖", priceDelta: 0 }
          ]
        },
        {
          optionType: "ice",
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "demo-drink-001-ice-regular", label: "正常冰", priceDelta: 0 },
            { id: "demo-drink-001-ice-less", label: "少冰", priceDelta: 0 },
            { id: "demo-drink-001-ice-light", label: "微冰", priceDelta: 0 },
            { id: "demo-drink-001-ice-none", label: "去冰", priceDelta: 0 }
          ]
        },
        {
          optionType: "size",
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "demo-drink-001-size-medium", label: "中杯", priceDelta: 0 },
            { id: "demo-drink-001-size-large", label: "大杯", priceDelta: 10 }
          ]
        },
        {
          optionType: "topping",
          minSelections: 0,
          maxSelections: 2,
          options: [
            { id: "demo-drink-001-top-pearl", label: "珍珠", priceDelta: 10 },
            { id: "demo-drink-001-top-coconut", label: "椰果", priceDelta: 10 }
          ]
        }
      ]
    },
    {
      id: "drink-002",
      name: "四季春青茶",
      category: "tea",
      description: "清香茶韻，入口回甘",
      basePrice: 40,
      isAvailable: true,
      customizationGroups: [
        {
          optionType: "sweetness",
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "demo-drink-002-sweet-regular", label: "正常糖", priceDelta: 0 },
            { id: "demo-drink-002-sweet-half", label: "半糖", priceDelta: 0 },
            { id: "demo-drink-002-sweet-light", label: "微糖", priceDelta: 0 },
            { id: "demo-drink-002-sweet-none", label: "無糖", priceDelta: 0 }
          ]
        },
        {
          optionType: "ice",
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "demo-drink-002-ice-regular", label: "正常冰", priceDelta: 0 },
            { id: "demo-drink-002-ice-less", label: "少冰", priceDelta: 0 },
            { id: "demo-drink-002-ice-light", label: "微冰", priceDelta: 0 },
            { id: "demo-drink-002-ice-none", label: "去冰", priceDelta: 0 }
          ]
        }
      ]
    }
  ]
};

// The real menu API puts optionType on every option as well as on its group, and the cart reads the size,
// sweetness and ice labels from the option -- without this the demo cart and orders show empty spec lines.
for (const menuItem of demoMenu.menuItems) {
  for (const group of menuItem.customizationGroups) {
    group.options = group.options.map((option) => ({ ...option, optionType: group.optionType }));
  }
}

// selectRole's userId param -- reuses the app's existing default prototype customer id
// (AppStateProvider's selectedCustomerId initial state / logout() reset) instead of inventing a new
// one, so demo mode doesn't need its own bucket in the cart/order local-storage keying.
export const demoCustomerUserId = "customer-yinji";

export const demoUserProfile = {
  id: "demo-customer-yinji",
  displayName: "展示用顧客",
  email: "demo@example.com",
  roles: ["customer"]
};

// Same shape GET /api/customers/me/savings returns (see ../utils/customerSavings.js).
export const demoCustomerSavings = {
  totalSavedAmount: 420,
  savedOrderCount: 6,
  savedCupCount: 9
};

// Merchant-side demo login -- storeId matches demoStores[0]/demoRawGroupBuyActivity.storeId so the
// merchant dashboard, menu and statistics screens all describe the same one demo store.
export const demoMerchantStoreId = "store-001";

export const demoMerchantUserProfile = {
  id: "demo-merchant-001",
  displayName: "展示用店家帳號",
  email: "demo-merchant@example.com",
  roles: ["merchant"]
};

// 13 weeks ending this week, Monday-start -- same window merchantStatisticsRepository.js's real
// getStoreWeeklyTrendPostgres uses -- generated relative to "now" rather than hardcoded dates so the
// trend never looks stale no matter when the demo is run.
const WEEK_MS = 7 * DAY_MS;
function startOfWeek(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date;
}
const AVERAGE_ORDER_VALUE = 62;
const thisWeekStart = startOfWeek(now).getTime();
const weeklyOrderCounts = [8, 10, 9, 12, 11, 13, 10, 14, 12, 15, 13, 16, 14];
export const demoMerchantWeeklyTrend = weeklyOrderCounts.map((orderCount, index) => {
  const weekStart = new Date(thisWeekStart - (weeklyOrderCounts.length - 1 - index) * WEEK_MS);
  const revenue = orderCount * AVERAGE_ORDER_VALUE;
  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    orderCount,
    revenue,
    discountAmount: Math.round(revenue * 0.08)
  };
});

const demoMerchantOrderCount = weeklyOrderCounts.reduce((sum, count) => sum + count, 0);
const demoMerchantRevenue = demoMerchantWeeklyTrend.reduce((sum, week) => sum + week.revenue, 0);
const demoMerchantDiscount = demoMerchantWeeklyTrend.reduce((sum, week) => sum + week.discountAmount, 0);

// Same shape getMerchantStoreStatistics() returns (merchantStatisticsRepository.js's
// getStoreStatisticsPostgres), minus the refund adjustment real revenue gets -- there is no refund
// concept to fake here.
export const demoMerchantStatistics = {
  totalRevenue: demoMerchantRevenue,
  orderCount: demoMerchantOrderCount,
  discountGivenTotal: demoMerchantDiscount,
  settledActivityCount: 9,
  qualifiedActivityCount: 7,
  qualifiedRate: 7 / 9,
  topDrinks: [
    { name: "青山烏龍拿鐵", cups: 86 },
    { name: "四季春青茶", cups: 54 }
  ],
  weeklyTrend: demoMerchantWeeklyTrend
};
