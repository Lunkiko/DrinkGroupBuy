// A tiny in-memory stand-in for the two merchant write flows demo mode still lets someone operate
// (create a group-buy activity, add/edit a menu item) -- module-level mutable state, not React
// state, so it survives whichever component happens to be mounted and resets on a full page reload
// (same lifetime as everything else in demo mode; see ../utils/demoMode.js). Nothing here is
// persisted or ever reaches a real backend.
import { demoMenu, demoRawGroupBuyActivity } from "./demoContent";

let nextDemoId = 1;
function createDemoId(prefix) {
  nextDemoId += 1;
  return `${prefix}-${Date.now()}-${nextDemoId}`;
}

const demoMenuItems = demoMenu.menuItems.map((item) => ({ ...item }));

export function getDemoMerchantMenu() {
  return { store: demoMenu.store, menuItems: demoMenuItems };
}

export function createDemoMenuItem(input) {
  const item = {
    id: createDemoId("demo-menu-item"),
    ...input
  };
  demoMenuItems.push(item);
  return item;
}

export function updateDemoMenuItem(menuItemId, input) {
  const index = demoMenuItems.findIndex((item) => item.id === menuItemId);
  if (index === -1) {
    const error = new Error("Menu item not found");
    error.status = 404;
    throw error;
  }
  const updated = { ...demoMenuItems[index], ...input, id: menuItemId };
  demoMenuItems[index] = updated;
  return updated;
}

// Returns the same raw, backend-response shape createGroupBuyActivity() does -- the caller
// (AppStateProvider's addMerchantGroupBuyActivityFromApi) runs it through
// normalizeBackendGroupBuyActivity exactly like a real response.
export function createDemoGroupBuyActivity(input) {
  const pickupStartAt = new Date(input.pickupStartAt);
  const pickupEndAt = new Date(pickupStartAt.getTime() + 3 * 60 * 60 * 1000);
  return {
    id: createDemoId("demo-activity"),
    storeId: input.storeId,
    store: demoRawGroupBuyActivity.store,
    title: input.title,
    status: "recruiting",
    startAt: input.startAt,
    deadlineAt: input.deadlineAt,
    pickupStartAt: input.pickupStartAt,
    pickupEndAt: pickupEndAt.toISOString(),
    tiers: input.tiers.map((tier, index) => ({
      id: createDemoId("demo-tier"),
      targetCups: tier.targetCups,
      discountPercent: tier.discountPercent,
      sortOrder: index
    })),
    authorizedCups: 0,
    participantCount: 0,
    maximumCups: input.tiers[input.tiers.length - 1]?.targetCups ?? 0,
    currentTierId: null,
    currentTierTargetCups: null,
    currentTierDiscountPercent: 0,
    nextTierTargetCups: input.tiers[0]?.targetCups ?? null,
    cupsToNextTier: input.tiers[0]?.targetCups ?? 0
  };
}

// code -> { orderId, orderSnapshot, groupBuyActivity, status }. Populated by
// createDemoPickupReadyResult (merchant "標記可取餐"), read by lookup/redeem (merchant "取餐核銷").
const demoPickupCredentials = new Map();

function createDemoPickupCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

// Mirrors markGroupBuyActivityReadyForPickup()'s { status, credentials } shape. `orders`/
// `groupBuyActivity` are passed in (not imported) since they live in AppStateProvider's React state,
// not this module's own fake data.
export function createDemoPickupReadyResult(orders, groupBuyActivity, orderId) {
  const targetOrders = orderId
    ? orders.filter((order) => order.id === orderId)
    : orders.filter((order) => order.groupBuyActivityId === groupBuyActivity.id && order.pickupStatus !== "ready");
  const credentials = targetOrders.map((order) => {
    const code = createDemoPickupCode();
    demoPickupCredentials.set(code, { orderId: order.id, orderSnapshot: order, groupBuyActivity, status: "active" });
    return { orderId: order.id, code, status: "active" };
  });
  return { status: "ready_for_pickup", credentials };
}

// Same flat shape lookupPickupCredential() returns (the credential's own fields at top level).
export function lookupDemoPickupCredential(code) {
  const entry = demoPickupCredentials.get(code);
  if (!entry) {
    const error = new Error("找不到這組取餐碼，請確認後再試一次。");
    error.status = 404;
    throw error;
  }
  const { orderSnapshot, groupBuyActivity, status } = entry;
  return {
    customerDisplayName: "展示用顧客",
    activity: { id: groupBuyActivity.id, title: groupBuyActivity.title },
    totalCups: orderSnapshot.quantity,
    finalAmount: orderSnapshot.subtotal,
    items: orderSnapshot.items ?? [],
    status
  };
}

// Same { credential, activityCompleted } shape redeemPickupCredential() returns.
export function redeemDemoPickupCredential(code) {
  const entry = demoPickupCredentials.get(code);
  if (!entry) {
    const error = new Error("找不到這組取餐碼，請確認後再試一次。");
    error.status = 404;
    throw error;
  }
  if (entry.status === "redeemed") {
    const error = new Error("這組取餐碼已經核銷過了。");
    error.status = 409;
    throw error;
  }
  entry.status = "redeemed";
  return {
    credential: {
      orderId: entry.orderId,
      orderStatus: "completed",
      pickupStatus: "picked_up",
      activity: { id: entry.groupBuyActivity.id }
    },
    activityCompleted: false
  };
}
