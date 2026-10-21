import Constants from "expo-constants";
import { Platform } from "react-native";
import { saveAuthSession } from "./authSession";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { getOrderWriteErrorMessage } from "./orderWriteErrors";
import { describeApiError } from "./apiErrorText";
import { isDemoMode } from "./demoMode";
import { demoCustomerSavings, demoMenu, demoMerchantStatistics } from "../mock/demoContent";
import { createDemoGroupBuyActivity, createDemoMenuItem, getDemoMerchantMenu, updateDemoMenuItem } from "../mock/demoBackend";

// 10.0.2.2 is the Android emulator's alias for the host machine's localhost;
// it only resolves inside the emulator's virtual network, so web/browser
// contexts need a real host instead. Using the page's own hostname (rather
// than hardcoding "localhost") keeps the API call same-origin with however
// the page was actually opened -- e.g. http://127.0.0.1:8083 -- otherwise
// the browser treats "localhost" and "127.0.0.1" as different origins even
// though they're the same machine, and the request can fail as a real
// network/CORS mismatch instead of a same-origin call.
const defaultBackendUrl = Platform.OS === "web"
  ? `http://${typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "localhost"}:3001`
  : "http://10.0.2.2:3001";
// EXPO_PUBLIC_BACKEND_URL (and its app.config.js extra.backendBaseUrl mirror) is a single,
// non-platform-scoped override -- if it's set to the Android-emulator-only 10.0.2.2 alias
// (e.g. left over from testing on an emulator), it would otherwise silently poison the web
// build too, since it's checked before defaultBackendUrl. On web, an override pointing at
// 10.0.2.2 can never be correct, so it's ignored there in favor of defaultBackendUrl.
const isAndroidOnlyOverride = (url) => Platform.OS === "web" && typeof url === "string" && url.includes("10.0.2.2");
const backendBaseUrl = [
  process.env.EXPO_PUBLIC_BACKEND_URL,
  Constants.expoConfig?.extra?.backendBaseUrl,
  Constants.manifest2?.extra?.expoClient?.extra?.backendBaseUrl
].find((url) => url && !isAndroidOnlyOverride(url)) || defaultBackendUrl;
const authMode = process.env.EXPO_PUBLIC_AUTH_MODE
  || Constants.expoConfig?.extra?.authMode
  || Constants.manifest2?.extra?.expoClient?.extra?.authMode
  || "firebase";

const inflightRequests = new Map();
let authToken = null;

export function setAuthToken(token) {
  authToken = token || null;
}

export async function loginWithFirebaseIdToken(idToken) {
  const response = await fetch(`${backendBaseUrl}/api/auth/firebase-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ idToken })
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Firebase login failed");
    error.payload = payload;
    throw error;
  }

  setAuthToken(payload.token);
  saveAuthSession({ token: payload.token, user: payload.user }).catch(() => {});
  return payload;
}

// Not a login -- this only proves the applicant controls a real Google account, so it
// deliberately does not call setAuthToken/saveAuthSession the way the login functions above do.
export async function submitMerchantApplication(input) {
  const response = await fetch(`${backendBaseUrl}/api/merchant-applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idToken: input.idToken,
      storeName: input.storeName,
      address: input.address,
      contactPhone: input.contactPhone
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Merchant application failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function listDevAuthUsers() {
  const response = await fetch(`${backendBaseUrl}/api/auth/dev-users`);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "List dev users failed");
    error.payload = payload;
    throw error;
  }

  return payload.users;
}

export async function loginWithDevUser(userId) {
  const response = await fetch(`${backendBaseUrl}/api/auth/dev-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userId })
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Dev login failed");
    error.payload = payload;
    throw error;
  }

  setAuthToken(payload.token);
  saveAuthSession({ token: payload.token, user: payload.user }).catch(() => {});
  return payload;
}

export async function verifyAuthSession() {
  // Generous timeout (vs. this file's usual 2.5s default): this call runs on every app launch to
  // restore a persisted session, and Azure App Service's free tier can sleep when idle -- a cold
  // start can take several seconds to respond. Without a timeout at all, a plain fetch() here left
  // the launch spinner (AppNavigator.js's sessionRestoreStatus === "checking") stuck indefinitely
  // whenever the request neither resolved nor rejected in a reasonable time, since nothing else
  // ever settles the promise that the session-restore effect's finally block depends on.
  const response = await fetchWithTimeout(`${backendBaseUrl}/api/auth/session`, {
    headers: withAuthHeaders(),
    timeoutMs: 10000,
    timeoutMessage: "登入狀態驗證逾時"
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Session verification failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function getDevBusinessTime() {
  const response = await fetchWithTimeout(`${backendBaseUrl}/api/dev/business-time`, {
    timeoutMs: 2500,
    timeoutMessage: "開發業務時間同步逾時"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message ?? describeApiError(payload.error) ?? "Get dev business time failed");
    error.payload = payload;
    throw error;
  }
  return payload.businessTime;
}

export async function createGroupBuyActivity(input) {
  if (isDemoMode()) return createDemoGroupBuyActivity(input);
  const requestKey = `createGroupBuyActivity:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const idempotencyKey = input.idempotencyKey ?? requestKey;
    const response = await fetch(`${backendBaseUrl}/api/merchant/group-buy-activities`, {
      method: "POST",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify({
        ...input,
        idempotencyKey
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(describeApiError(payload.error) ?? "Create group-buy activity failed");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload.activity;
  });
}

export async function listGroupBuyActivities() {
  const requestKey = "listGroupBuyActivities";
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/group-buy-activities`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(describeApiError(payload.error) ?? "List group-buy activities failed");
    }

    return payload.activities;
  });
}

export async function listStores() {
  const requestKey = "listStores";
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/stores`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(describeApiError(payload.error) ?? "List stores failed");
    }

    return payload.stores;
  });
}

export async function getStoreMenu(storeId) {
  if (isDemoMode()) return demoMenu;
  return getMenuRequest(`/api/stores/${encodeURIComponent(storeId)}/menu`, false);
}

export async function listCustomerOrders(input = {}) {
  return getOrderListRequest("/api/customers/me/orders", input);
}

export async function getCustomerSavings() {
  if (isDemoMode()) return demoCustomerSavings;
  const response = await fetch(`${backendBaseUrl}/api/customers/me/savings`, {
    headers: withAuthHeaders()
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Get customer savings failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.savings;
}

// Registers/repoints this device's Expo push token to whoever is currently logged in. Called
// right after session restore succeeds (see AppStateProvider), not on every screen -- the token
// rarely changes, and the backend upserts on the token itself so calling this again is harmless.
export async function registerPushToken(expoPushToken, platform) {
  const response = await fetch(`${backendBaseUrl}/api/push-tokens`, {
    method: "POST",
    headers: withAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expoPushToken, platform })
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Register push token failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function listMerchantStoreOrders(storeId, input = {}) {
  return getOrderListRequest(`/api/merchant/stores/${encodeURIComponent(storeId)}/orders`, input);
}

async function getOrderListRequest(path, input) {
  const query = new URLSearchParams();
  query.set("scope", input.scope === "history" ? "history" : "active");
  if (input.activityId) query.set("activityId", input.activityId);
  if (input.cursor) query.set("cursor", input.cursor);
  query.set("limit", String(input.limit || 20));
  const response = await fetch(`${backendBaseUrl}${path}?${query}`, { headers: withAuthHeaders() });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Get order list failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function getMerchantStoreStatistics(storeId) {
  if (isDemoMode()) return demoMerchantStatistics;
  const response = await fetch(`${backendBaseUrl}/api/merchant/stores/${encodeURIComponent(storeId)}/statistics`, {
    headers: withAuthHeaders()
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Get merchant statistics failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.statistics;
}

export async function getMerchantStoreMenu(storeId) {
  if (isDemoMode()) return getDemoMerchantMenu();
  return getMenuRequest(`/api/merchant/stores/${encodeURIComponent(storeId)}/menu`, true);
}

export async function createMerchantMenuItem(storeId, input) {
  if (isDemoMode()) return createDemoMenuItem(input);
  return writeMenuItemRequest(
    `/api/merchant/stores/${encodeURIComponent(storeId)}/menu-items`,
    "POST",
    input
  );
}

export async function updateMerchantMenuItem(storeId, menuItemId, input) {
  if (isDemoMode()) return updateDemoMenuItem(menuItemId, input);
  return writeMenuItemRequest(
    `/api/merchant/stores/${encodeURIComponent(storeId)}/menu-items/${encodeURIComponent(menuItemId)}`,
    "PATCH",
    input
  );
}

async function getMenuRequest(path, authenticated) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    headers: authenticated ? withAuthHeaders() : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Get store menu failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function writeMenuItemRequest(path, method, body) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    method,
    headers: withAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Save menu item failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.menuItem;
}

export async function createOrder(input) {
  const requestKey = `createOrder:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/orders`, {
      method: "POST",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(getOrderWriteErrorMessage(payload, "Create order failed"));
      error.payload = payload;
      throw error;
    }

    return payload.order;
  });
}

export async function getOrder(orderId) {
  const requestKey = `getOrder:${orderId}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/orders/${encodeURIComponent(orderId)}`, {
      headers: withAuthHeaders()
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(describeApiError(payload.error) ?? "Get order failed");
    }

    return payload.order;
  });
}

export async function updateOrder(orderId, input) {
  const requestKey = `updateOrder:${orderId}:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(getOrderWriteErrorMessage(payload, "Update order failed"));
      error.payload = payload;
      throw error;
    }

    return payload.order;
  });
}

export async function createOrderRevision(orderId, input) {
  const requestKey = `createOrderRevision:${orderId}:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/orders/${encodeURIComponent(orderId)}/revisions`, {
      method: "POST",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(getOrderWriteErrorMessage(payload, "Create order revision failed"));
      error.payload = payload;
      throw error;
    }

    return payload.revision;
  });
}

export async function cancelOrder(orderId, input) {
  const response = await fetch(`${backendBaseUrl}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
    headers: withAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Cancel order failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.order;
}

export async function cancelMerchantGroupBuyActivity(activityId, input) {
  const response = await fetch(
    `${backendBaseUrl}/api/merchant/group-buy-activities/${encodeURIComponent(activityId)}/cancel`,
    {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Cancel group-buy activity failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function getPickupOverdueRule() {
  const response = await fetch(`${backendBaseUrl}/api/payment-rules/pickup-overdue`, {
    headers: withAuthHeaders()
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Pickup overdue rule load failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.rule;
}

export async function requestLinePayAuthorization(input) {
  const requestKey = `requestLinePayAuthorization:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/payments/line-pay/request`, {
      method: "POST",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(describeApiError(payload.error) ?? "LINE Pay authorization request failed");
      error.payload = payload;
      throw error;
    }

    return payload;
  });
}

export async function requestLinePayRepayment(input) {
  const requestKey = `requestLinePayRepayment:${stableStringify(input)}`;
  return dedupeRequest(requestKey, async () => {
    const response = await fetch(`${backendBaseUrl}/api/payments/line-pay/repay`, {
      method: "POST",
      headers: withAuthHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(describeApiError(payload.error) ?? "LINE Pay repayment request failed");
      error.payload = payload;
      throw error;
    }

    return payload;
  });
}

export async function markGroupBuyActivityReadyForPickup(activityId, orderId) {
  if (orderId !== undefined && (typeof orderId !== "string" || !orderId.trim())) {
    throw new Error("invalid_order_id");
  }
  const orderPath = orderId === undefined ? "" : `/orders/${encodeURIComponent(orderId)}`;
  return postPickupRequest(
    `/api/merchant/group-buy-activities/${encodeURIComponent(activityId)}${orderPath}/ready-for-pickup`
  );
}

export async function lookupPickupCredential(pickupCode) {
  return postPickupRequest("/api/merchant/pickup-credentials/lookup", { pickupCode });
}

export async function redeemPickupCredential(pickupCode) {
  return postPickupRequest("/api/merchant/pickup-credentials/redeem", { pickupCode });
}

export async function getPickupCredential(orderId) {
  const response = await fetch(
    `${backendBaseUrl}/api/orders/${encodeURIComponent(orderId)}/pickup-credential`,
    { headers: withAuthHeaders() }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Get pickup credential failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.credential;
}

export async function createMerchantRefundRequest(orderId, input) {
  const response = await fetch(
    `${backendBaseUrl}/api/merchant/orders/${encodeURIComponent(orderId)}/refund-requests`,
    {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Create refund request failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

// Merchant direct refund: refunds the order at once (capped server-side at its remaining refundable amount).
// `input.idempotencyKey` must stay the same across retries of one confirmed refund so a repeat never refunds twice.
export async function refundMerchantOrder(orderId, input) {
  const response = await fetch(
    `${backendBaseUrl}/api/merchant/orders/${encodeURIComponent(orderId)}/refunds`,
    {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Refund failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function listMerchantRefundRequests(storeId, input = {}) {
  const query = input.status ? `?status=${encodeURIComponent(input.status)}` : "";
  const response = await fetch(
    `${backendBaseUrl}/api/merchant/stores/${encodeURIComponent(storeId)}/refund-requests${query}`,
    { headers: withAuthHeaders() }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "List refund requests failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.refundRequests;
}

async function postPickupRequest(path, body) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    method: "POST",
    headers: withAuthHeaders(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(describeApiError(payload.error) ?? "Pickup request failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function dedupeRequest(key, requestFn) {
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key);
  }

  const requestPromise = requestFn().finally(() => {
    inflightRequests.delete(key);
  });
  inflightRequests.set(key, requestPromise);
  return requestPromise;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withAuthHeaders(headers = {}) {
  return authToken
    ? {
        ...headers,
        Authorization: `Bearer ${authToken}`
      }
    : headers;
}

export function getBackendBaseUrl() {
  return backendBaseUrl;
}

export function getAuthMode() {
  return authMode;
}
