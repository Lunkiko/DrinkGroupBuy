const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

loadLocalEnv(path.resolve(__dirname, "..", "..", ".env"));
loadLocalEnv(path.resolve(__dirname, "..", ".env"));

const DEFAULT_SANDBOX_BASE_URL = "https://sandbox-api-pay.line.me";
const DEFAULT_PRODUCTION_BASE_URL = "https://api-pay.line.me";

// `accountOverrides` (channelId/channelSecret) lets a caller use a specific store's LINE Pay
// credentials instead of the platform-wide LINE_PAY_CHANNEL_ID/SECRET env vars -- see
// backend/payments/linePayService.js, which resolves a store's account before calling any of the
// functions below. Every exported function's `accountOverrides` parameter defaults to `{}`, so a
// call site that never passes it keeps reading the env vars exactly as before.
function getLinePayConfig(accountOverrides = {}) {
  const env = process.env.LINE_PAY_ENV || "sandbox";
  const baseUrl = process.env.LINE_PAY_API_BASE_URL
    || (env === "production" ? DEFAULT_PRODUCTION_BASE_URL : DEFAULT_SANDBOX_BASE_URL);

  return {
    env,
    baseUrl: baseUrl.replace(/\/$/, ""),
    channelId: accountOverrides.channelId ?? process.env.LINE_PAY_CHANNEL_ID,
    channelSecret: accountOverrides.channelSecret ?? process.env.LINE_PAY_CHANNEL_SECRET,
    currency: process.env.LINE_PAY_CURRENCY || "TWD",
    confirmUrl: process.env.LINE_PAY_CONFIRM_URL,
    cancelUrl: process.env.LINE_PAY_CANCEL_URL,
    captureSeparated: isLinePayCaptureSeparatedEnabled()
  };
}

function assertLinePayConfig(config) {
  const missing = [];
  if (!config.channelId) missing.push("LINE_PAY_CHANNEL_ID");
  if (!config.channelSecret) missing.push("LINE_PAY_CHANNEL_SECRET");
  if (!config.confirmUrl) missing.push("LINE_PAY_CONFIRM_URL");
  if (!config.cancelUrl) missing.push("LINE_PAY_CANCEL_URL");

  if (missing.length > 0) {
    throw new Error(`Missing LINE Pay environment variables: ${missing.join(", ")}`);
  }
}

async function requestLinePayPayment(input, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const amount = toPositiveInteger(input.amount, "amount");
  const currency = input.currency || config.currency;
  const backendOrderId = requiredString(input.orderId, "orderId");
  const orderId = requiredString(input.providerOrderId || backendOrderId, "providerOrderId");
  const productName = input.productName || "DrinkGroupBuy preorder";
  const packageName = input.packageName || "DrinkGroupBuy";
  const packageId = input.packageId || orderId;

  const products = Array.isArray(input.products) && input.products.length > 0
    ? input.products.map((product, index) => ({
        name: requiredString(product.name || productName, `products[${index}].name`),
        quantity: toPositiveInteger(product.quantity || 1, `products[${index}].quantity`),
        price: toPositiveInteger(product.price, `products[${index}].price`)
      }))
    : [{ name: productName, quantity: 1, price: amount }];

  const body = {
    amount,
    currency,
    orderId,
    packages: [
      {
        id: packageId,
        amount,
        name: packageName,
        products
      }
    ],
    redirectUrls: {
      confirmUrl: appendQuery(config.confirmUrl, { orderId: backendOrderId }),
      cancelUrl: appendQuery(config.cancelUrl, { orderId: backendOrderId })
    }
  };
  const captureSeparated = input.captureSeparated == null
    ? config.captureSeparated
    : Boolean(input.captureSeparated);
  if (captureSeparated) {
    body.options = {
      payment: {
        capture: false
      }
    };
  }

  return linePayPost("/v3/payments/request", body, config);
}

function isLinePayCaptureSeparatedEnabled() {
  return readBooleanEnv(process.env.LINE_PAY_CAPTURE_SEPARATED, false);
}

async function confirmLinePayPayment(transactionId, input, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const amount = toPositiveInteger(input.amount, "amount");
  const currency = input.currency || config.currency;
  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));

  return linePayPost(`/v3/payments/${encodedTransactionId}/confirm`, { amount, currency }, config);
}

async function captureLinePayPaymentAuthorization(transactionId, input, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const amount = toPositiveInteger(input.amount, "amount");
  const currency = input.currency || config.currency;
  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));

  return linePayPost(`/v3/payments/authorizations/${encodedTransactionId}/capture`, { amount, currency }, config);
}

async function voidLinePayPaymentAuthorization(transactionId, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));

  return linePayPost(`/v3/payments/authorizations/${encodedTransactionId}/void`, null, config);
}

async function refundLinePayPayment(transactionId, input = {}, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));
  const amount = input.refundAmount ?? input.amount;
  const body = amount == null
    ? null
    : { refundAmount: toPositiveInteger(amount, "refundAmount") };

  return linePayPost(`/v3/payments/${encodedTransactionId}/refund`, body, config);
}

async function retrieveLinePayPaymentDetails(transactionId, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);

  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));
  return linePayGet("/v3/payments", `transactionId=${encodedTransactionId}`, config);
}

async function checkLinePayPaymentRequestStatus(transactionId, accountOverrides = {}) {
  const config = getLinePayConfig(accountOverrides);
  assertLinePayConfig(config);
  const encodedTransactionId = encodeURIComponent(requiredString(transactionId, "transactionId"));
  return linePayGet(`/v3/payments/requests/${encodedTransactionId}/check`, "", config,
    ["0000", "0110", "0121", "0122", "0123"]);
}

async function linePayPost(uri, body, config = getLinePayConfig()) {
  const nonce = crypto.randomUUID();
  const bodyText = body == null ? "" : JSON.stringify(body);
  const signature = signLinePayRequest({
    channelSecret: config.channelSecret,
    uri,
    bodyText,
    nonce
  });

  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LINE-ChannelId": config.channelId,
      "X-LINE-Authorization-Nonce": nonce,
      "X-LINE-Authorization": signature
    }
  };
  if (bodyText) {
    requestOptions.body = bodyText;
  }

  const response = await fetch(`${config.baseUrl}${uri}`, requestOptions);

  const payload = await parseLinePayResponse(response);
  if (!response.ok || payload.returnCode !== "0000") {
    const reason = payload.returnMessage || payload.message || response.statusText;
    const error = new Error(`LINE Pay request failed: ${reason}`);
    error.statusCode = response.status || 502;
    error.linePayPayload = payload;
    throw error;
  }

  return payload;
}

async function linePayGet(uri, queryString = "", config = getLinePayConfig(), acceptedCodes = ["0000"]) {
  const nonce = crypto.randomUUID();
  const signature = signLinePayRequest({
    channelSecret: config.channelSecret,
    uri,
    bodyText: queryString,
    nonce
  });
  const requestUrl = `${config.baseUrl}${uri}${queryString ? `?${queryString}` : ""}`;
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-LINE-ChannelId": config.channelId,
      "X-LINE-Authorization-Nonce": nonce,
      "X-LINE-Authorization": signature
    }
  });
  const payload = await parseLinePayResponse(response);
  if (!response.ok || !acceptedCodes.includes(String(payload.returnCode || ""))) {
    const reason = payload.returnMessage || payload.message || response.statusText;
    const error = new Error(`LINE Pay request failed: ${reason}`);
    error.statusCode = response.status || 502;
    error.linePayPayload = payload;
    throw error;
  }
  return payload;
}

async function parseLinePayResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};

  // The digit-quoting rewrite below protects against float-precision loss on LINE Pay's 16+
  // digit transaction IDs, but it has no JSON string-boundary awareness -- it can also match
  // digits that happen to appear after a colon inside an already-quoted string value (e.g. a
  // returnMessage that embeds a long reference number), which corrupts otherwise-valid JSON.
  // Falling back to a plain parse of the unmodified text keeps the real returnCode/returnMessage
  // parseable in that case, at the cost of precision on any huge number inside it -- far better
  // than silently discarding the whole payload as `{}`, which was masking real provider errors.
  try {
    return JSON.parse(text.replace(/:\s*(\d{16,})\b/g, ': "$1"'));
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

function signLinePayRequest({ channelSecret, uri, bodyText, nonce }) {
  const signatureTarget = `${channelSecret}${uri}${bodyText}${nonce}`;
  return crypto
    .createHmac("sha256", channelSecret)
    .update(signatureTarget)
    .digest("base64");
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] != null) continue;

    process.env[key] = stripEnvQuotes(rawValue);
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function toPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return number;
}

function appendQuery(url, query) {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

module.exports = {
  checkLinePayPaymentRequestStatus,
  captureLinePayPaymentAuthorization,
  confirmLinePayPayment,
  getLinePayConfig,
  isLinePayCaptureSeparatedEnabled,
  requestLinePayPayment,
  refundLinePayPayment,
  retrieveLinePayPaymentDetails,
  voidLinePayPaymentAuthorization
};
