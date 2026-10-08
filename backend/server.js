const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { promises: fs } = require("node:fs");
const {
  cancelGroupBuyActivity,
  cancelCustomerOrderInDatabase,
  cancelMerchantOrderInDatabase,
  getMerchantGroupBuyActivityForCancellation,
  listEligibleOrdersForMerchantCancellation,
  cancelPendingLinePayAuthorizationInDatabase,
  createGroupBuyActivity,
  createOrder,
  createOrderRevision,
  getCustomerOrderCancellationEligibility,
  getOrderDetail,
  getOrderPaymentContext,
  getOrderRevisionById,
  getOrderRevisionPaymentContext,
  getLatestLinePayAuthorizationForOrder,
  getLatestLinePayAuthorizationForOrderRevision,
  createPendingLinePayAuthorization,
  getLinePayAuthorizationContext,
  authorizeLinePayPaymentInDatabase,
  getUserAuthProfileByFirebaseUid: getSqliteUserAuthProfileByFirebaseUid,
  getUserAuthProfileById: getSqliteUserAuthProfileById,
  listDevAuthUsers: listSqliteDevAuthUsers,
  listCustomerOrders,
  listGroupBuyActivities,
  listPaymentReliabilityAlerts,
  listMerchantStoreOrders,
  listPublicStores,
  listRefundRequestsForAdmin,
  listRefundRequestsForStore,
  listStoreMenu,
  recordLinePayVoidFailureInDatabase,
  saveMerchantMenuItem,
  updatePendingOrder,
  voidLinePayAuthorizationInDatabase,
  captureLinePayAuthorizationInDatabase,
  claimPaymentReliabilityJobs,
  completeGroupBuySettlement,
  completePaymentReliabilityJob,
  createGroupBuySettlementPlan,
  enqueuePaymentReliabilityJob,
  getLinePayCaptureRetryState,
  listDueGroupBuyActivitiesForSettlement,
  recordLinePayCaptureFailureInDatabase,
  recordOrderRuleConsentInDatabase,
  reschedulePaymentReliabilityJob,
  expireGroupBuyPickupWindow,
  listDueGroupBuyActivitiesForPickupExpiration,
  completeLinePayRefundInDatabase,
  createPendingLinePayRefundInDatabase,
  failLinePayRefundInDatabase,
  getLatestPaymentProviderEventPayload,
  getOrderStoreId,
  approveRefundRequestInDatabase,
  createRefundRequestInDatabase,
  getRefundRequestById,
  rejectRefundRequestInDatabase,
  getManualLinePayRepaymentContext,
  completeManualLinePayRepaymentInDatabase,
  listPendingLinePayAuthorizations
} = require("./db");
const { createAuthToken, getBearerToken, safeEqual, verifyAuthToken } = require("./auth");
const { verifyFirebaseIdToken } = require("./firebaseAuth");
const { shouldBlockAdminSurface } = require("./adminSurfaceGuard");
const {
  PaymentServiceError,
  cancelLinePayAuthorization,
  clearPendingLinePayAuthorizationsForOrderUpdate,
  confirmLinePayAuthorization,
  requestManualLinePayRepayment,
  requestLinePayAuthorization,
  refundLinePayPayment,
  voidLinePayAuthorization
} = require("./payments/linePayService");
const { getPickupOverdueRule } = require("./payments/orderRuleConsent");
const {
  approveRefundRequest,
  createMerchantRefundRequest,
  rejectRefundRequest
} = require("./payments/refundRequestService");
const {
  approveMerchantApplication,
  rejectMerchantApplication,
  submitMerchantApplication
} = require("./merchants/merchantApplicationService");
const {
  listAdminAccounts,
  setAdminAccountRole
} = require("./accounts/adminAccountRoleService");
const {
  settleGroupBuyActivity,
  startDeadlineSettlementScheduler
} = require("./payments/settlementService");
const {
  cancelMerchantGroupBuyActivity
} = require("./payments/merchantActivityCancelService");
const {
  startLinePayReconciliationScheduler
} = require("./payments/reliabilityService");
const {
  OperationLeaseError,
  withOperationLease
} = require("./reliability/operationLease");
const {
  getPickupCredentialForOrder,
  lookupPickupCode,
  markGroupBuyActivityReadyForPickup,
  redeemPickupCode
} = require("./pickup/credentialService");
const { startPickupExpirationScheduler } = require("./pickup/expirationService");
const {
  loadDevConsoleState,
  getDevConsoleState,
  getCustomerConfig: getDevConsoleCustomerConfig,
  updateCustomerConfig: updateDevConsoleCustomerConfig,
  resetCustomerConfig: resetDevConsoleCustomerConfig,
  recordAppReport: recordDevConsoleAppReport,
  recordBusinessTimeUpdate: recordDevConsoleBusinessTimeUpdate,
  toConsoleAccount,
  normalizeCustomerId: normalizeDevConsoleCustomerId
} = require("./devConsole/devConsoleState");
const {
  createStoreMenuReadRepository
} = require("./database/repositories/storeMenuReadRepository");
const {
  createStoreDirectoryReadRepository
} = require("./database/repositories/storeDirectoryReadRepository");
const {
  createGroupBuyActivityReadRepository
} = require("./database/repositories/groupBuyActivityReadRepository");
const {
  createAuthProfileReadRepository
} = require("./database/repositories/authProfileReadRepository");
const {
  createGroupBuyActivityWriteRepository
} = require("./database/repositories/groupBuyActivityWriteRepository");
const {
  createMerchantMenuRepository
} = require("./database/repositories/merchantMenuRepository");
const {
  createCustomerOrderWriteRepository
} = require("./database/repositories/customerOrderWriteRepository");
const {
  createCustomerOrderReadRepository
} = require("./database/repositories/customerOrderReadRepository");
const {
  createPaymentAuthorizationRequestRepository
} = require("./database/repositories/paymentAuthorizationRequestRepository");
const {
  createPaymentAuthorizationConfirmRepository
} = require("./database/repositories/paymentAuthorizationConfirmRepository");
const {
  createPaymentAuthorizationCancelRepository
} = require("./database/repositories/paymentAuthorizationCancelRepository");
const {
  createCustomerOrderCancelRepository
} = require("./database/repositories/customerOrderCancelRepository");
const {
  createMerchantGroupBuyActivityCancelRepository
} = require("./database/repositories/merchantGroupBuyActivityCancelRepository");
const {
  createPaymentCaptureRepository
} = require("./database/repositories/paymentCaptureRepository");
const {
  createGroupBuySettlementRepository
} = require("./database/repositories/groupBuySettlementRepository");
const {
  createPickupCredentialRepository
} = require("./database/repositories/pickupCredentialRepository");
const {
  createPaymentRefundRepository
} = require("./database/repositories/paymentRefundRepository");
const {
  createMerchantApplicationRepository
} = require("./database/repositories/merchantApplicationRepository");
const {
  createMerchantMenuImportRepository
} = require("./database/repositories/merchantMenuImportRepository");
const {
  createCustomerRegistrationRepository,
  EMAIL_REGISTRATION_DISABLED_ERROR
} = require("./database/repositories/customerRegistrationRepository");
const {
  createAdminAccountRoleRepository
} = require("./database/repositories/adminAccountRoleRepository");
const {
  createAdminStatisticsRepository
} = require("./database/repositories/adminStatisticsRepository");
const {
  createCustomerSavingsRepository
} = require("./database/repositories/customerSavingsRepository");
const {
  createMerchantStatisticsRepository
} = require("./database/repositories/merchantStatisticsRepository");
const {
  createOrderRevisionRepository
} = require("./database/repositories/orderRevisionRepository");
const {
  createManualLinePayRepaymentRepository
} = require("./database/repositories/manualLinePayRepaymentRepository");
const {
  createPaymentReliabilityJobRepository
} = require("./database/repositories/paymentReliabilityJobRepository");
const {
  createPushTokenRepository
} = require("./database/repositories/pushTokenRepository");
const { businessClock } = require("./time/businessClock");

const port = Number(process.env.PORT ?? 3000);
const storeMenuReadRepository = createStoreMenuReadRepository({ sqliteReader: listStoreMenu });
const storeDirectoryReadRepository = createStoreDirectoryReadRepository({
  sqliteReader: listPublicStores,
});
const groupBuyActivityReadRepository = createGroupBuyActivityReadRepository({
  sqliteReader: listGroupBuyActivities,
});
const authProfileReadRepository = createAuthProfileReadRepository({
  sqliteReaders: {
    getByFirebaseUid: getSqliteUserAuthProfileByFirebaseUid,
    getById: getSqliteUserAuthProfileById,
    listDevUsers: listSqliteDevAuthUsers,
  },
});
const groupBuyActivityWriteRepository = createGroupBuyActivityWriteRepository({
  sqliteWriter: createGroupBuyActivity,
});
const merchantMenuRepository = createMerchantMenuRepository({
  sqliteReader: listStoreMenu,
  sqliteWriter: saveMerchantMenuItem,
});
const customerOrderWriteRepository = createCustomerOrderWriteRepository({
  sqliteWriter: createOrder,
  sqliteUpdater: updatePendingOrder,
});
const customerOrderReadRepository = createCustomerOrderReadRepository({
  sqliteReaders: {
    getOrderDetail,
    getOrderPaymentContext,
    listCustomerOrders,
    listMerchantStoreOrders,
  },
});
const paymentAuthorizationRequestRepository = createPaymentAuthorizationRequestRepository({
  sqliteGateway: {
    getOrderPaymentContext,
    getLatestAuthorizationForOrder: getLatestLinePayAuthorizationForOrder,
    getLatestAuthorizationForOrderRevision: getLatestLinePayAuthorizationForOrderRevision,
    recordRuleConsent: recordOrderRuleConsentInDatabase,
    createPendingAuthorization: createPendingLinePayAuthorization,
  },
});
const paymentAuthorizationConfirmRepository = createPaymentAuthorizationConfirmRepository({
  sqliteGateway: {
    getAuthorizationContext: getLinePayAuthorizationContext,
    confirmAuthorization: authorizeLinePayPaymentInDatabase,
  },
});
const paymentAuthorizationCancelRepository = createPaymentAuthorizationCancelRepository({
  sqliteGateway: {
    getAuthorizationContext: getLinePayAuthorizationContext,
    cancelPendingAuthorization: cancelPendingLinePayAuthorizationInDatabase,
    voidAuthorization: voidLinePayAuthorizationInDatabase,
    recordVoidFailure: recordLinePayVoidFailureInDatabase,
  },
});
const customerOrderCancelRepository = createCustomerOrderCancelRepository({
  sqliteGateway: {
    getEligibility: getCustomerOrderCancellationEligibility,
    cancelOrder: cancelCustomerOrderInDatabase,
  },
});
const merchantGroupBuyActivityCancelRepository = createMerchantGroupBuyActivityCancelRepository({
  sqliteGateway: {
    getActivityForCancellation: getMerchantGroupBuyActivityForCancellation,
    listEligibleOrders: listEligibleOrdersForMerchantCancellation,
    cancelOrder: cancelMerchantOrderInDatabase,
    cancelActivityStatus: cancelGroupBuyActivity,
  },
});
const paymentCaptureRepository = createPaymentCaptureRepository({
  sqliteGateway: {
    getAuthorizationContext: getLinePayAuthorizationContext,
    captureAuthorization: captureLinePayAuthorizationInDatabase,
    recordCaptureFailure: recordLinePayCaptureFailureInDatabase,
  },
});
const groupBuySettlementRepository = createGroupBuySettlementRepository({
  sqliteGateway: {
    createPlan: (value) => createGroupBuySettlementPlan(value.activityId, value),
    getCaptureRetryState: getLinePayCaptureRetryState,
    completeSettlement: (value) => completeGroupBuySettlement(value.activityId, value),
    listDueActivities: listDueGroupBuyActivitiesForSettlement,
    enqueueJob: enqueuePaymentReliabilityJob,
    claimJobs: claimPaymentReliabilityJobs,
    completeJob: completePaymentReliabilityJob,
    rescheduleJob: reschedulePaymentReliabilityJob,
  },
});
const pickupCredentialRepository = createPickupCredentialRepository({
  sqliteGateway: {
    markReady: (value) => markGroupBuyActivityReadyForPickup(value.activityId, value),
    getCredentialForOrder: (value) => getPickupCredentialForOrder(value.orderId, value),
    lookupCode: (value) => lookupPickupCode(value),
    redeemCode: (value) => redeemPickupCode(value),
    listDueActivities: (value) => listDueGroupBuyActivitiesForPickupExpiration(value),
    expireWindow: (value) => expireGroupBuyPickupWindow(value.activityId, value),
  },
});
const paymentRefundRepository = createPaymentRefundRepository({
  sqliteGateway: {
    createPendingRefund: (value) => createPendingLinePayRefundInDatabase(value),
    completeRefund: (value) => completeLinePayRefundInDatabase(value),
    failRefund: (value) => failLinePayRefundInDatabase(value),
    createRefundRequest: (value) => createRefundRequestInDatabase(value),
    approveRefundRequest: (value) => approveRefundRequestInDatabase(value),
    rejectRefundRequest: (value) => rejectRefundRequestInDatabase(value),
    getRefundRequestById: (value) => getRefundRequestById(value.requestId),
    listRefundRequestsForStore: (value) => listRefundRequestsForStore(value.storeId, { status: value.status }),
    listRefundRequestsForAdmin: (value) => listRefundRequestsForAdmin({ status: value.status }),
    getOrderStoreId: (value) => getOrderStoreId(value.orderId),
    getLatestAuthorizationForOrder: (value) => getLatestLinePayAuthorizationForOrder(value.orderId),
    getLatestProviderEventPayload: (value) => getLatestPaymentProviderEventPayload(value),
  },
});
// Postgres-only, no sqliteGateway -- see merchantApplicationRepository.js's module comment.
const merchantApplicationRepository = createMerchantApplicationRepository({});
// Postgres-only, no sqliteGateway -- see merchantMenuImportRepository.js's module comment.
const merchantMenuImportRepository = createMerchantMenuImportRepository({});
// Postgres-only, no sqliteGateway -- see customerRegistrationRepository.js's module comment.
const customerRegistrationRepository = createCustomerRegistrationRepository({});
// Postgres-only: roles are authoritative in the deployed runtime and must change atomically.
const adminAccountRoleRepository = createAdminAccountRoleRepository({});
// Postgres-only: read-only reporting, no reason to maintain a SQLite fallback for it.
const adminStatisticsRepository = createAdminStatisticsRepository({});
// Postgres-only: read-only per-customer summary, same reasoning as the admin statistics above.
const customerSavingsRepository = createCustomerSavingsRepository({});
// Postgres-only: read-only per-store figures for the merchant statistics screen.
const merchantStatisticsRepository = createMerchantStatisticsRepository({});
// Postgres-only: no SQLite install has ever needed push notifications.
const pushTokenRepository = createPushTokenRepository({});
// The cancel notification needs each order's customer_user_id, which only the Postgres
// listEligibleOrders returns -- so it is wired the same way the other push call sites are.
const activityCancelPushTokenRepository = merchantGroupBuyActivityCancelRepository.kind === "postgres"
  ? pushTokenRepository
  : undefined;
const orderRevisionRepository = createOrderRevisionRepository({
  sqliteGateway: {
    createRevision: (value) => createOrderRevision(value),
    getRevisionById: (value) => getOrderRevisionById(value.orderRevisionId),
    getRevisionPaymentContext: (value) => getOrderRevisionPaymentContext(value.orderRevisionId),
  },
});
const manualRepaymentRepository = createManualLinePayRepaymentRepository({
  sqliteGateway: {
    getRepaymentContext: (orderId, query) => getManualLinePayRepaymentContext(orderId, query),
    completeRepayment: (value) => completeManualLinePayRepaymentInDatabase(value),
  },
});
const reliabilityJobRepository = createPaymentReliabilityJobRepository({
  sqliteGateway: {
    enqueueJob: (value) => enqueuePaymentReliabilityJob(value),
    claimJobs: (value) => claimPaymentReliabilityJobs(value),
    completeJob: (value) => completePaymentReliabilityJob(value),
    rescheduleJob: (value) => reschedulePaymentReliabilityJob(value),
    listPendingLinePayAuthorizations: (value) => listPendingLinePayAuthorizations(value),
    listAlerts: (value) => listPaymentReliabilityAlerts(value),
  },
});
if (
  groupBuyActivityWriteRepository.kind === "postgres"
  || merchantMenuRepository.kind === "postgres"
  || customerOrderWriteRepository.kind === "postgres"
  || customerOrderReadRepository.kind === "postgres"
  || paymentAuthorizationRequestRepository.kind === "postgres"
  || paymentAuthorizationConfirmRepository.kind === "postgres"
  || paymentAuthorizationCancelRepository.kind === "postgres"
  || customerOrderCancelRepository.kind === "postgres"
  || merchantGroupBuyActivityCancelRepository.kind === "postgres"
) {
  const requiredPostgresRepositories = [
    authProfileReadRepository,
    storeMenuReadRepository,
    groupBuyActivityReadRepository,
    groupBuyActivityWriteRepository,
    merchantMenuRepository,
    customerOrderWriteRepository,
    customerOrderReadRepository,
    paymentAuthorizationRequestRepository,
    paymentAuthorizationConfirmRepository,
    paymentAuthorizationCancelRepository,
    customerOrderCancelRepository,
    merchantGroupBuyActivityCancelRepository,
  ];
  if (requiredPostgresRepositories.some((repository) => repository.kind !== "postgres")) {
    throw new Error(
      "PostgreSQL write slices require AUTH_PROFILE_READ_RUNTIME, "
      + "STORE_MENU_READ_RUNTIME, GROUP_BUY_ACTIVITY_READ_RUNTIME, "
      + "GROUP_BUY_ACTIVITY_WRITE_RUNTIME, MERCHANT_MENU_RUNTIME, "
      + "CUSTOMER_ORDER_WRITE_RUNTIME, CUSTOMER_ORDER_READ_RUNTIME, "
      + "PAYMENT_AUTHORIZATION_REQUEST_RUNTIME, PAYMENT_AUTHORIZATION_CONFIRM_RUNTIME, "
      + "PAYMENT_AUTHORIZATION_CANCEL_RUNTIME, CUSTOMER_ORDER_CANCEL_RUNTIME, "
      + "and MERCHANT_ACTIVITY_CANCEL_RUNTIME to be postgres"
    );
  }
}

// PostgreSQL capture/settlement is a separate, later-added tier on top of the order-write
// stack above: it reads/writes the same orders/authorizations rows, so it can only be
// postgres when that whole stack already is. Kept as its own guard (rather than folded into
// requiredPostgresRepositories) so existing postgres order-write deployments that predate
// capture/settlement support don't start throwing at boot.
const settlementPostgresReady = paymentCaptureRepository.kind === "postgres"
  && groupBuySettlementRepository.kind === "postgres";
if (paymentCaptureRepository.kind === "postgres" || groupBuySettlementRepository.kind === "postgres") {
  if (!settlementPostgresReady) {
    throw new Error(
      "PAYMENT_CAPTURE_RUNTIME and GROUP_BUY_SETTLEMENT_RUNTIME must both be postgres "
      + "together, or both left as sqlite."
    );
  }
  if (customerOrderWriteRepository.kind !== "postgres") {
    throw new Error(
      "PostgreSQL capture/settlement requires the full PostgreSQL order-write stack "
      + "(CUSTOMER_ORDER_WRITE_RUNTIME and its dependent *_RUNTIME flags) to be postgres too, "
      + "since settlement reads and writes the same orders/authorizations rows."
    );
  }
  // Production auto-capture is deliberately its own manual approval step, separate from
  // just enabling this for Sandbox validation (see docs/AI-current-progress.md).
  const linePayEnv = String(process.env.LINE_PAY_ENV || "sandbox").toLowerCase();
  const allowPostgresCaptureInProduction = readBooleanEnv(
    process.env.PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION,
    false
  );
  if (linePayEnv === "production" && !allowPostgresCaptureInProduction) {
    throw new Error(
      "PostgreSQL capture/settlement in production requires an explicit, separate opt-in: "
      + "set PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION=true."
    );
  }
}

// Same reasoning as settlement above: pickup reads/writes the same orders/activities rows,
// so it can only be postgres once the order-write stack already is. No production-specific
// gate here (unlike capture/settlement) since redeeming a pickup code doesn't move money.
const pickupPostgresReady = pickupCredentialRepository.kind === "postgres";
if (pickupPostgresReady && customerOrderWriteRepository.kind !== "postgres") {
  throw new Error(
    "PostgreSQL pickup credentials require the full PostgreSQL order-write stack "
    + "(CUSTOMER_ORDER_WRITE_RUNTIME and its dependent *_RUNTIME flags) to be postgres too, "
    + "since pickup reads and writes the same orders/activities rows."
  );
}

// Refund reads and writes payment_captures rows directly (remaining-refundable-amount checks),
// so a postgres refund runtime is meaningless unless capture already writes to the same
// PostgreSQL table -- a capture made on the SQLite side would simply never be visible to it.
// This is a one-directional dependency (capture postgres does NOT require refund postgres),
// so it's deliberately not folded into the symmetric settlementPostgresReady pairing above.
const refundPostgresReady = paymentRefundRepository.kind === "postgres";
if (refundPostgresReady) {
  if (paymentCaptureRepository.kind !== "postgres") {
    throw new Error(
      "PostgreSQL refunds require PAYMENT_CAPTURE_RUNTIME to be postgres too, since refunds "
      + "read and write the same payment_captures rows captures are recorded in."
    );
  }
  if (customerOrderWriteRepository.kind !== "postgres") {
    throw new Error(
      "PostgreSQL refunds require the full PostgreSQL order-write stack "
      + "(CUSTOMER_ORDER_WRITE_RUNTIME and its dependent *_RUNTIME flags) to be postgres too, "
      + "since refunds read and write the same orders rows."
    );
  }
  // Refunds move money just like capture, so they share capture's explicit production
  // opt-in rather than getting their own -- by the time refund-postgres is reachable at
  // all, capture-postgres is already required above, which already demands this same flag.
  const linePayEnv = String(process.env.LINE_PAY_ENV || "sandbox").toLowerCase();
  const allowPostgresCaptureInProduction = readBooleanEnv(
    process.env.PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION,
    false
  );
  if (linePayEnv === "production" && !allowPostgresCaptureInProduction) {
    throw new Error(
      "PostgreSQL refunds in production requires an explicit, separate opt-in: "
      + "set PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION=true."
    );
  }
}

// Order revisions read and write orders/order_items directly, and are applied through the
// same confirm/cancel authorization flow captured above -- so, like pickup, this only needs
// the order-write stack (which already guarantees request/confirm/cancel are postgres too
// via requiredPostgresRepositories). No production-specific gate: creating or applying a
// revision doesn't move money by itself -- the resulting authorization's capture is what
// does, and that's already gated separately above.
const orderRevisionPostgresReady = orderRevisionRepository.kind === "postgres";
if (orderRevisionPostgresReady && customerOrderWriteRepository.kind !== "postgres") {
  throw new Error(
    "PostgreSQL order revisions require the full PostgreSQL order-write stack "
    + "(CUSTOMER_ORDER_WRITE_RUNTIME and its dependent *_RUNTIME flags) to be postgres too, "
    + "since revisions read and write the same orders/order_items rows."
  );
}

// Manual LINE Pay repayment directly captures a payment (writes payment_captures/orders, the
// same rows PAYMENT_CAPTURE_RUNTIME writes), so it needs the same order-write stack and the
// same explicit production opt-in as capture/settlement above.
const manualRepaymentPostgresReady = manualRepaymentRepository.kind === "postgres";
if (manualRepaymentPostgresReady) {
  if (customerOrderWriteRepository.kind !== "postgres") {
    throw new Error(
      "PostgreSQL manual LINE Pay repayment requires the full PostgreSQL order-write stack "
      + "(CUSTOMER_ORDER_WRITE_RUNTIME and its dependent *_RUNTIME flags) to be postgres too, "
      + "since manual repayment reads and writes the same orders/payment_authorizations rows."
    );
  }
  const manualRepaymentLinePayEnv = String(process.env.LINE_PAY_ENV || "sandbox").toLowerCase();
  const allowPostgresManualRepaymentInProduction = readBooleanEnv(
    process.env.PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION,
    false
  );
  if (manualRepaymentLinePayEnv === "production" && !allowPostgresManualRepaymentInProduction) {
    throw new Error(
      "PostgreSQL manual LINE Pay repayment in production requires an explicit, separate opt-in: "
      + "set PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION=true."
    );
  }
}

// The LINE Pay reconciliation background scheduler reads/writes authorizations, cancels stale
// ones, and completes manual repayments -- it can only run against PostgreSQL once every
// repository it touches is also PostgreSQL, or it would silently read one runtime and write
// another. Checked both directions: reliabilityJobRepository=postgres with a dependency still on
// sqlite, and a dependency=postgres with reliabilityJobRepository left on sqlite (the latter
// doesn't throw on its own -- it just silently disables the scheduler -- so it's easy to miss
// when migrating the other flags but forgetting PAYMENT_RELIABILITY_JOB_RUNTIME).
const reconciliationRepositoriesAnyPostgres = reliabilityJobRepository.kind === "postgres"
  || paymentAuthorizationConfirmRepository.kind === "postgres"
  || paymentAuthorizationCancelRepository.kind === "postgres"
  || manualRepaymentPostgresReady;
const reconciliationPostgresReady = reliabilityJobRepository.kind === "postgres"
  && paymentAuthorizationConfirmRepository.kind === "postgres"
  && paymentAuthorizationCancelRepository.kind === "postgres"
  && manualRepaymentPostgresReady;
if (reconciliationRepositoriesAnyPostgres && !reconciliationPostgresReady) {
  throw new Error(
    "PostgreSQL payment reliability jobs require PAYMENT_RELIABILITY_JOB_RUNTIME, "
    + "PAYMENT_AUTHORIZATION_CONFIRM_RUNTIME, PAYMENT_AUTHORIZATION_CANCEL_RUNTIME, and "
    + "MANUAL_LINE_PAY_REPAYMENT_RUNTIME to all be postgres too, since reconciliation reads and "
    + "writes the same payment_authorizations rows."
  );
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, null);
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);

    // ADMIN_WEB_LOOPBACK_ONLY=true (school VM: public IP, plain HTTP) -- the admin console, dev console and admin
    // API answer only the machine itself and look like "not found" to everyone else. See adminSurfaceGuard.js.
    if (shouldBlockAdminSurface({
      pathname: url.pathname,
      loopbackOnly: readBooleanEnv(process.env.ADMIN_WEB_LOOPBACK_ONLY, false),
      isLoopback: isLoopbackRequest(request)
    })) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/payment-rules/pickup-overdue") {
      sendJson(response, 200, { rule: getPickupOverdueRule() });
      return;
    }

    if (
      customerOrderWriteRepository.kind === "postgres"
      && isSqliteOrderDependentRoute(request.method, url.pathname)
      && !isSettlementRouteReadyForPostgres(request.method, url.pathname)
    ) {
      // /admin/* is the server-rendered web console (browser navigation, not fetch), so it needs
      // an HTML response here -- the JSON error below would otherwise replace the whole page with
      // an unstyled blob instead of the console's normal error banner. Still gated on admin login
      // like every other /admin route -- requireAdminWebUser redirects to /admin/login itself.
      if (url.pathname.startsWith("/admin")) {
        const adminUser = await requireAdminWebUser(request, response);
        if (!adminUser) return;
        sendHtml(response, 503, renderAdminPage({
          title: "系統維護中",
          bodyHtml: renderAdminNotice({ type: "error", text: "後端資料庫遷移尚未完成，這個功能暫時無法使用，請稍後再試。" }),
          activeNav: null
        }));
        return;
      }
      sendJson(response, 503, {
        error: "customer_order_runtime_mismatch",
        message: "This order follow-up route still requires the SQLite order runtime."
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "drink-group-buy-backend" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/firebase-session") {
      const body = await readJsonBody(request);
      if (!body.idToken) {
        sendJson(response, 400, { error: "idToken is required" });
        return;
      }

      let firebaseUser;
      try {
        firebaseUser = await verifyFirebaseIdToken(body.idToken);
      } catch (error) {
        console.error("Firebase ID token verification failed:", {
          code: error.code,
          message: error.message,
          stack: error.stack
        });
        sendJson(response, 401, {
          error: "Invalid Firebase ID token",
          ...(process.env.NODE_ENV !== "production"
            ? { debug: { code: error.code, message: error.message } }
            : {})
        });
        return;
      }

      const user = await authProfileReadRepository.getByFirebaseUid(firebaseUser.uid);
      if (user) {
        const token = createAuthToken(user);
        sendJson(response, 200, { token, user: toPublicUserResponse(user) });
        return;
      }

      // First time this Firebase account has ever signed in -- register it as a customer.
      // Identity fields come only from the verified token above, never from the request body.
      // email_verified comes from Firebase itself (Google-provider sign-ins always carry it as
      // true), not anything the client asserts -- checked before calling resolveOrRegisterCustomer
      // so an unverified address always fails for that reason first, matching the admin login
      // route (POST /admin/login/firebase), which validates email_verified unconditionally.
      if (!firebaseUser.email_verified) {
        sendJson(response, 403, { error: "email_not_verified" });
        return;
      }

      // The Google-only self-registration policy itself lives inside resolveOrRegisterCustomer
      // (see customerRegistrationRepository.js), not here, so every caller of it inherits the same
      // rule automatically -- this route just passes along which provider was actually used.
      const registration = await customerRegistrationRepository.resolveOrRegisterCustomer({
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email || null,
        displayName: deriveDisplayNameFromFirebaseUser(firebaseUser),
        signInProvider: firebaseUser.firebase?.sign_in_provider,
        now: businessClock.nowIso()
      });
      if (registration.error === "account_disabled") {
        sendJson(response, 403, { error: "This account is disabled" });
        return;
      }
      if (registration.error === "email_already_registered") {
        sendJson(response, 409, {
          error: "This email is already linked to another account. Please contact the administrator."
        });
        return;
      }
      if (registration.error === EMAIL_REGISTRATION_DISABLED_ERROR) {
        sendJson(response, 403, { error: EMAIL_REGISTRATION_DISABLED_ERROR });
        return;
      }

      const registeredUser = await authProfileReadRepository.getById(registration.userId);
      const token = createAuthToken(registeredUser);
      sendJson(response, 200, { token, user: toPublicUserResponse(registeredUser) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/merchant-applications") {
      const body = await readJsonBody(request);
      const result = await submitMerchantApplication({
        idToken: body.idToken,
        body,
        merchantApplicationRepository,
        now: businessClock.nowIso()
      });
      sendJson(response, 201, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/dev-users") {
      if (!isDevAuthModeEnabled()) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      sendJson(response, 200, { users: await authProfileReadRepository.listDevUsers() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/dev-session") {
      if (!isDevAuthModeEnabled()) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const body = await readJsonBody(request);
      if (!body.userId) {
        sendJson(response, 400, { error: "userId is required" });
        return;
      }

      const user = await authProfileReadRepository.getById(body.userId);
      if (!user) {
        sendJson(response, 404, { error: "Dev user not found" });
        return;
      }

      const token = createAuthToken(user);
      sendJson(response, 200, { token, user: toPublicUserResponse(user) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/dev/business-time") {
      if (!isDevAuthModeEnabled()) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      sendJson(response, 200, { businessTime: businessClock.getSnapshot() });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/dev/business-time") {
      if (!isDevAuthModeEnabled()) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: "Business time can only be changed from the backend host." });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const businessTime = businessClock.configure(body, { nodeEnv: process.env.NODE_ENV });
        console.warn("[dev-business-time] setting changed", {
          mode: businessTime.mode,
          offsetMinutes: businessTime.offsetMinutes,
          fixedNow: businessTime.fixedNow,
          effectiveNow: businessTime.effectiveNow,
          realNow: businessTime.realNow,
        });
        sendJson(response, 200, { businessTime });
      } catch (error) {
        sendJson(response, 400, { error: error.code || "business_time_invalid", message: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      // Mobile calls this once at app startup to check whether a token it restored from local
      // storage (see mobile/src/utils/authSession.js) is still valid, without needing to guess
      // from the first unrelated API call's error shape. Deliberately returns the same current
      // user data as login, so the client can re-derive its role/route the same way it does
      // right after a fresh login instead of trusting stale cached profile fields.
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      sendJson(response, 200, { user: toPublicUserResponse(authUser) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/group-buy-activities") {
      sendJson(response, 200, {
        activities: await groupBuyActivityReadRepository.listActivities(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stores") {
      sendJson(response, 200, { stores: await storeDirectoryReadRepository.listPublicStores() });
      return;
    }


    const publicStoreMenuMatch = url.pathname.match(/^\/api\/stores\/([^/]+)\/menu$/);
    if (request.method === "GET" && publicStoreMenuMatch) {
      const menu = await storeMenuReadRepository.getPublicStoreMenu(publicStoreMenuMatch[1]);
      if (!menu) {
        sendJson(response, 404, { error: "Store not found" });
        return;
      }
      sendJson(response, 200, menu);
      return;
    }

    const merchantStoreMenuMatch = url.pathname.match(/^\/api\/merchant\/stores\/([^/]+)\/menu$/);
    if (request.method === "GET" && merchantStoreMenuMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantStoreMenuMatch[1])) {
        sendJson(response, 403, { error: "Store access denied" });
        return;
      }
      const menu = await merchantMenuRepository.getStoreMenu(merchantStoreMenuMatch[1]);
      sendJson(response, 200, menu);
      return;
    }

    const merchantMenuItemsMatch = url.pathname.match(/^\/api\/merchant\/stores\/([^/]+)\/menu-items$/);
    if (request.method === "POST" && merchantMenuItemsMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantMenuItemsMatch[1])) {
        sendJson(response, 403, { error: "Store access denied" });
        return;
      }
      const body = await readJsonBody(request);
      const validationError = validateMenuItemInput(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      const result = await merchantMenuRepository.saveMenuItem({
        ...body,
        storeId: merchantMenuItemsMatch[1],
        actorUserId: authUser.id
      });
      if (result.error === "store_not_found") {
        sendJson(response, 404, result);
        return;
      }
      if (result.error === "store_access_denied") {
        sendJson(response, 403, result);
        return;
      }
      if (result.error) {
        sendJson(response, 409, result);
        return;
      }
      sendJson(response, 201, result);
      return;
    }

    const merchantMenuItemMatch = url.pathname.match(
      /^\/api\/merchant\/stores\/([^/]+)\/menu-items\/([^/]+)$/
    );
    if (request.method === "PATCH" && merchantMenuItemMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantMenuItemMatch[1])) {
        sendJson(response, 403, { error: "Store access denied" });
        return;
      }
      const body = await readJsonBody(request);
      const validationError = validateMenuItemInput(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      const result = await merchantMenuRepository.saveMenuItem({
        ...body,
        storeId: merchantMenuItemMatch[1],
        menuItemId: merchantMenuItemMatch[2],
        actorUserId: authUser.id
      });
      if (result.error === "menu_item_not_found") {
        sendJson(response, 404, result);
        return;
      }
      if (result.error === "store_access_denied") {
        sendJson(response, 403, result);
        return;
      }
      if (result.error) {
        sendJson(response, 409, result);
        return;
      }
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/merchant/group-buy-activities") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant")) {
        sendJson(response, 403, { error: "Merchant role required" });
        return;
      }

      const body = await readJsonBody(request);
      const validationError = validateCreateActivity(body, businessClock.nowIso());
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      if (!canManageStore(authUser, body.storeId)) {
        sendJson(response, 403, { error: "Store access denied" });
        return;
      }

      const activity = await groupBuyActivityWriteRepository.createActivity({
        ...body,
        pickupEndAt: computeActivityPickupEndAt(body.pickupStartAt),
        createdByUserId: authUser.id,
        now: businessClock.nowIso()
      });
      if (activity?.error === "store_access_denied") {
        sendJson(response, 403, { error: "Store access denied" });
        return;
      }
      if (activity?.error) {
        sendJson(response, 409, activity);
        return;
      }
      sendJson(response, 201, { activity });
      return;
    }

    const merchantReadyForPickupMatch = url.pathname.match(
      /^\/api\/merchant\/group-buy-activities\/([^/]+)(?:\/orders\/([^/]+))?\/ready-for-pickup$/
    );
    if (request.method === "POST" && merchantReadyForPickupMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant")) {
        sendJson(response, 403, { error: "Merchant role required" });
        return;
      }

      const body = await readJsonBody(request);
      if (!body || Array.isArray(body) || typeof body !== "object"
        || (Object.hasOwn(body, "orderId")
          && (typeof body.orderId !== "string" || !body.orderId.trim()))) {
        sendJson(response, 400, { error: "invalid_order_id" });
        return;
      }

      const result = await markGroupBuyActivityReadyForPickup(
        merchantReadyForPickupMatch[1],
        {
          orderId: merchantReadyForPickupMatch[2] ?? body.orderId,
          actorUserId: authUser.id,
          now: businessClock.nowIso(),
          pickupCredentialRepository: pickupPostgresReady ? pickupCredentialRepository : undefined,
          pushTokenRepository: pickupPostgresReady ? pushTokenRepository : undefined
        }
      );
      sendPickupServiceResult(response, result);
      return;
    }

    const merchantCancelActivityMatch = url.pathname.match(
      /^\/api\/merchant\/group-buy-activities\/([^/]+)\/cancel$/
    );
    if (request.method === "POST" && merchantCancelActivityMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant")) {
        sendJson(response, 403, { error: "Merchant role required" });
        return;
      }

      const body = await readJsonBody(request);
      if (!String(body.reason || "").trim()) {
        sendJson(response, 400, { error: "reason is required" });
        return;
      }

      try {
        const result = await cancelMerchantGroupBuyActivity({
          activityId: merchantCancelActivityMatch[1],
          reason: String(body.reason).trim(),
          actorUserId: authUser.id,
          now: businessClock.nowIso(),
          canManageStore: (storeId) => canManageStore(authUser, storeId),
          merchantGroupBuyActivityCancelRepository,
          paymentAuthorizationCancelRepository,
          pushTokenRepository: activityCancelPushTokenRepository
        });
        if (result.error) {
          const statusByError = {
            activity_not_found: 404,
            store_access_denied: 403,
            activity_locked_by_deadline: 409,
            activity_not_cancellable: 409
          };
          sendJson(response, statusByError[result.error] || 409, result);
          return;
        }
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "POST"
      && url.pathname === "/api/merchant/pickup-credentials/lookup") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant")) {
        sendJson(response, 403, { error: "Merchant role required" });
        return;
      }

      const body = await readJsonBody(request);
      const result = await lookupPickupCode({
        actorUserId: authUser.id,
        pickupCode: body.pickupCode,
        now: businessClock.nowIso(),
        pickupCredentialRepository: pickupPostgresReady ? pickupCredentialRepository : undefined
      });
      sendPickupServiceResult(response, result);
      return;
    }

    if (request.method === "POST"
      && url.pathname === "/api/merchant/pickup-credentials/redeem") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("merchant")) {
        sendJson(response, 403, { error: "Merchant role required" });
        return;
      }

      const body = await readJsonBody(request);
      const result = await redeemPickupCode({
        actorUserId: authUser.id,
        pickupCode: body.pickupCode,
        now: businessClock.nowIso(),
        pickupCredentialRepository: pickupPostgresReady ? pickupCredentialRepository : undefined
      });
      sendPickupServiceResult(response, result);
      return;
    }

    const orderPickupCredentialMatch = url.pathname.match(
      /^\/api\/orders\/([^/]+)\/pickup-credential$/
    );
    if (request.method === "GET" && orderPickupCredentialMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const order = await customerOrderReadRepository.getOrderDetail(
        orderPickupCredentialMatch[1],
        { now: businessClock.nowIso() }
      );
      if (!order) {
        sendJson(response, 404, { error: "Order not found" });
        return;
      }
      if (!canAccessOrder(authUser, order)) {
        sendJson(response, 403, { error: "Order access denied" });
        return;
      }

      const credential = await getPickupCredentialForOrder(order.id, {
        now: businessClock.nowIso(),
        pickupCredentialRepository: pickupPostgresReady ? pickupCredentialRepository : undefined
      });
      sendJson(response, 200, { credential });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/customers/me/orders") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("customer")) return sendJson(response, 403, { error: "Customer role required" });
      sendJson(
        response,
        200,
        await customerOrderReadRepository.listCustomerOrders(
          authUser.id,
          { ...readOrderListQuery(url), now: businessClock.nowIso() }
        )
      );
      return;
    }

    // The customer id always comes from the verified token, never from the URL or query string,
    // so a customer can only ever read their own totals.
    if (request.method === "GET" && url.pathname === "/api/customers/me/savings") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("customer")) return sendJson(response, 403, { error: "Customer role required" });
      sendJson(response, 200, {
        savings: await customerSavingsRepository.getSavingsSummary(authUser.id)
      });
      return;
    }

    // Registers/repoints this device's Expo push token to whoever is currently logged in -- any
    // authenticated role, not just customer, since a merchant or admin's own device can register
    // too. The userId always comes from the verified token, never the request body.
    if (request.method === "POST" && url.pathname === "/api/push-tokens") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });

      const body = await readJsonBody(request);
      const expoPushToken = typeof body.expoPushToken === "string" ? body.expoPushToken.trim() : "";
      if (!expoPushToken || expoPushToken.length > 512) {
        return sendJson(response, 400, { error: "invalid_expo_push_token" });
      }
      if (!["ios", "android"].includes(body.platform)) {
        return sendJson(response, 400, { error: "invalid_platform" });
      }

      await pushTokenRepository.upsertPushToken({
        userId: authUser.id,
        expoPushToken,
        platform: body.platform
      });
      sendJson(response, 200, { success: true });
      return;
    }

    const merchantOrdersMatch = url.pathname.match(/^\/api\/merchant\/stores\/([^/]+)\/orders$/);
    if (request.method === "GET" && merchantOrdersMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantOrdersMatch[1])) {
        return sendJson(response, 403, { error: "Store access denied" });
      }
      sendJson(
        response,
        200,
        await customerOrderReadRepository.listMerchantStoreOrders(
          merchantOrdersMatch[1],
          { ...readOrderListQuery(url), now: businessClock.nowIso() }
        )
      );
      return;
    }

    // Same guard as the store orders route above: the store in the URL must be one the verified
    // token's merchant account manages, so a merchant can only read their own store's figures.
    const merchantStatisticsMatch = url.pathname.match(/^\/api\/merchant\/stores\/([^/]+)\/statistics$/);
    if (request.method === "GET" && merchantStatisticsMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantStatisticsMatch[1])) {
        return sendJson(response, 403, { error: "Store access denied" });
      }
      // getStoreStatistics is the core figures this endpoint exists for; getStoreWeeklyTrend is the
      // newer, secondary trend chart. A transient failure in just the trend query shouldn't also
      // fail the core statistics that used to be this endpoint's only dependency -- degrade to a
      // missing trend (mobile's normalizeMerchantStatistics sets weeklyTrendUnavailable, and
      // MerchantStatisticsScreen shows that as its own distinct notice) instead of failing the whole
      // response.
      const [statistics, weeklyTrend] = await Promise.all([
        merchantStatisticsRepository.getStoreStatistics(merchantStatisticsMatch[1]),
        // null (not []) on failure: getStoreWeeklyTrend now always returns a full zero-filled array
        // on success, so an empty result can only mean "the query failed" -- catching to [] here
        // would make that failure indistinguishable from a store that genuinely has no orders yet.
        // The mobile client (mobile/src/utils/merchantStatistics.js) treats null as "couldn't load
        // trend" and shows that distinctly, while still rendering the rest of this store's figures.
        merchantStatisticsRepository.getStoreWeeklyTrend(merchantStatisticsMatch[1]).catch((error) => {
          console.error("getStoreWeeklyTrend failed:", error.message);
          return null;
        }),
      ]);
      sendJson(response, 200, { statistics: { ...statistics, weeklyTrend } });
      return;
    }

    const merchantRefundRequestsMatch = url.pathname.match(/^\/api\/merchant\/stores\/([^/]+)\/refund-requests$/);
    if (request.method === "GET" && merchantRefundRequestsMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("merchant") || !canManageStore(authUser, merchantRefundRequestsMatch[1])) {
        return sendJson(response, 403, { error: "Store access denied" });
      }
      const listInput = {
        storeId: merchantRefundRequestsMatch[1],
        status: url.searchParams.get("status") || undefined
      };
      const refundRequests = refundPostgresReady
        ? await paymentRefundRepository.listRefundRequestsForStore(listInput)
        : listRefundRequestsForStore(listInput.storeId, { status: listInput.status });
      sendJson(response, 200, { refundRequests });
      return;
    }

    const createMerchantRefundRequestMatch = url.pathname.match(/^\/api\/merchant\/orders\/([^/]+)\/refund-requests$/);
    if (request.method === "POST" && createMerchantRefundRequestMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await createMerchantRefundRequest({
          authUser,
          orderId: createMerchantRefundRequestMatch[1],
          body,
          paymentRefundRepository: refundPostgresReady ? paymentRefundRepository : undefined
        });
        sendJson(response, 201, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/orders") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("customer")) {
        sendJson(response, 403, { error: "Customer role required" });
        return;
      }

      const body = await readJsonBody(request);
      const validationError = validateCreateOrder(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const result = await customerOrderWriteRepository.createOrder({
        ...body,
        customerUserId: authUser.id,
        now: businessClock.nowIso()
      });
      if (sendOrderItemValidationError(response, result)) return;
      if (result?.error === "activity_not_found") {
        sendJson(response, 404, { error: "Group-buy activity not found" });
        return;
      }
      if (result?.error === "customer_not_found") {
        sendJson(response, 404, { error: "Customer not found" });
        return;
      }
      if (result?.error === "order_already_exists") {
        sendJson(response, 409, {
          error: "Customer already has an active order for this group-buy activity",
          orderId: result.orderId
        });
        return;
      }
      if (result?.error === "activity_not_joinable") {
        sendJson(response, 409, { error: "Group-buy activity is not joinable", status: result.status });
        return;
      }
      if (result?.error === "capacity_exceeded") {
        sendJson(response, 409, {
          error: "Group-buy activity capacity exceeded",
          maximumCups: result.maximumCups,
          authorizedCups: result.authorizedCups,
          requestedCups: result.requestedCups
        });
        return;
      }

      sendJson(response, 201, { order: result.order });
      return;
    }

    const orderRevisionMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/revisions$/);
    if (request.method === "POST" && orderRevisionMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("customer")) {
        sendJson(response, 403, { error: "Customer role required" });
        return;
      }

      const body = await readJsonBody(request);
      const validationError = validateUpdateOrder(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const revisionInput = {
        ...body,
        orderId: orderRevisionMatch[1],
        customerUserId: authUser.id,
        now: businessClock.nowIso()
      };
      const result = orderRevisionPostgresReady
        ? await orderRevisionRepository.createRevision(revisionInput)
        : createOrderRevision(revisionInput);
      if (sendOrderItemValidationError(response, result)) return;
      if (result?.error === "order_not_found") {
        sendJson(response, 404, { error: "Order not found" });
        return;
      }
      if (result?.error === "order_access_denied") {
        sendJson(response, 403, { error: "Order access denied" });
        return;
      }
      if (result?.error === "order_not_revisable") {
        sendJson(response, 409, {
          error: "Order is not revisable after authorization",
          status: result.status,
          paymentStatus: result.paymentStatus,
          authorizationStatus: result.authorizationStatus
        });
        return;
      }
      if (result?.error === "activity_not_joinable") {
        sendJson(response, 409, { error: "Group-buy activity is not joinable", status: result.status });
        return;
      }
      if (result?.error === "order_locked_by_deadline") {
        sendJson(response, 409, {
          error: "Order is locked by deadline",
          deadlineAt: result.deadlineAt,
          lockMinutes: result.lockMinutes
        });
        return;
      }
      if (result?.error === "order_revision_already_pending") {
        sendJson(response, 409, {
          error: "Order already has a pending revision",
          orderRevisionId: result.orderRevisionId
        });
        return;
      }
      if (result?.error === "order_authorization_missing") {
        sendJson(response, 409, { error: "Order authorization is missing" });
        return;
      }
      if (result?.error === "capacity_exceeded") {
        sendJson(response, 409, {
          error: "Group-buy activity capacity exceeded",
          maximumCups: result.maximumCups,
          authorizedCups: result.authorizedCups,
          requestedCups: result.requestedCups
        });
        return;
      }

      sendJson(response, 201, { revision: result.revision });
      return;
    }

    const orderCancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    if (request.method === "POST" && orderCancelMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("customer")) return sendJson(response, 403, { error: "Customer role required" });
      const body = await readJsonBody(request);
      if (!String(body.idempotencyKey || "").trim()) {
        return sendJson(response, 400, { error: "idempotencyKey is required" });
      }
      const order = await customerOrderReadRepository.getOrderDetail(
        orderCancelMatch[1],
        { now: businessClock.nowIso() }
      );
      if (!order) return sendJson(response, 404, { error: "Order not found" });
      if (!canAccessOrder(authUser, order)) return sendJson(response, 403, { error: "Order access denied" });
      const requestedAt = businessClock.nowIso();
      const cancelOperation = async () => {
        const lockedOrder = await customerOrderReadRepository.getOrderDetail(
          order.id,
          { now: requestedAt }
        );
        if (!lockedOrder) return sendJson(response, 404, { error: "Order not found" });
        const eligibility = await customerOrderCancelRepository.getEligibility({
          orderId: lockedOrder.id,
          customerUserId: authUser.id,
          now: requestedAt
        });
        if (eligibility.error) {
          return sendJson(response, eligibility.error === "order_not_found" ? 404 : 409, eligibility);
        }
        if (lockedOrder.paymentStatus === "authorized") {
          try {
            await voidLinePayAuthorization({
              orderId: lockedOrder.id,
              provider: lockedOrder.latestLinePayAuthorization?.provider || "line_pay",
              reason: "customer_cancelled_order",
              authorizationCancelRepository: paymentAuthorizationCancelRepository,
              operationLockHeld: paymentAuthorizationCancelRepository.kind === "postgres"
            });
          } catch (error) {
            if (error instanceof PaymentServiceError) return sendJson(response, error.statusCode, error.payload);
            throw error;
          }
        }
        const result = await customerOrderCancelRepository.cancelOrder({
          orderId: lockedOrder.id,
          customerUserId: authUser.id,
          idempotencyKey: String(body.idempotencyKey),
          reason: body.reason || "customer_withdrawal",
          now: requestedAt
        });
        if (result.error) return sendJson(response, result.error === "order_not_found" ? 404 : 409, result);
        result.order = await customerOrderReadRepository.getOrderDetail(
          lockedOrder.id,
          { now: requestedAt }
        );
        sendJson(response, 200, result);
      };
      try {
        if (paymentAuthorizationCancelRepository.kind === "postgres") {
          await paymentAuthorizationCancelRepository.withOperationLock({
            orderId: order.id,
            leaseMs: 300_000
          }, cancelOperation);
        } else {
          await withOperationLease({
            lockKey: `order:${order.id}:payment-lifecycle`,
            leaseMs: 300_000
          }, cancelOperation);
        }
      } catch (error) {
        if (error instanceof OperationLeaseError || error?.code === "operation_locked") {
          sendJson(response, 409, {
            error: "operation_locked",
            status: "retry_later",
            lockKey: error.lock.lockKey,
            lockedUntil: error.lock.lockedUntil
          });
          return;
        }
        throw error;
      }
      return;
    }

    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (request.method === "PATCH" && orderMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("customer")) {
        sendJson(response, 403, { error: "Customer role required" });
        return;
      }

      const body = await readJsonBody(request);
      const validationError = validateUpdateOrder(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const result = await customerOrderWriteRepository.updateOrder({
        ...body,
        orderId: orderMatch[1],
        customerUserId: authUser.id,
        now: businessClock.nowIso()
      });
      if (sendOrderItemValidationError(response, result)) return;
      if (result?.error === "order_not_found") {
        sendJson(response, 404, { error: "Order not found" });
        return;
      }
      if (result?.error === "order_access_denied") {
        sendJson(response, 403, { error: "Order access denied" });
        return;
      }
      if (result?.error === "order_not_editable") {
        sendJson(response, 409, {
          error: "Order is not editable before authorization",
          status: result.status,
          paymentStatus: result.paymentStatus
        });
        return;
      }
      if (result?.error === "customer_not_found") {
        sendJson(response, 404, { error: "Customer not found" });
        return;
      }
      if (result?.error === "activity_not_found") {
        sendJson(response, 404, { error: "Group-buy activity not found" });
        return;
      }
      if (result?.error === "activity_not_joinable") {
        sendJson(response, 409, { error: "Group-buy activity is not joinable", status: result.status });
        return;
      }
      if (result?.error === "capacity_exceeded") {
        sendJson(response, 409, {
          error: "Group-buy activity capacity exceeded",
          maximumCups: result.maximumCups,
          authorizedCups: result.authorizedCups,
          requestedCups: result.requestedCups
        });
        return;
      }

      clearPendingLinePayAuthorizationsForOrderUpdate(
        orderMatch[1],
        result.failedAuthorizations || []
      );

      sendJson(response, 200, { order: result.order });
      return;
    }

    if (request.method === "GET" && orderMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const order = await customerOrderReadRepository.getOrderDetail(
        orderMatch[1],
        { now: businessClock.nowIso() }
      );
      if (!order) {
        sendJson(response, 404, { error: "Order not found" });
        return;
      }
      if (!canAccessOrder(authUser, order)) {
        sendJson(response, 403, { error: "Order access denied" });
        return;
      }

      sendJson(response, 200, { order });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/payments/line-pay/request") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await requestLinePayAuthorization({
          authUser,
          body,
          now: businessClock.nowIso(),
          authorizationRequestRepository: paymentAuthorizationRequestRepository,
          authorizationCancelRepository: paymentAuthorizationCancelRepository,
          orderRevisionRepository,
          reliabilityJobRepository
        });
        sendJson(response, 201, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/payments/line-pay/repay") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await requestManualLinePayRepayment({
          authUser,
          body,
          now: businessClock.nowIso(),
          manualRepaymentRepository,
          paymentCaptureRepository,
          authorizationCancelRepository: paymentAuthorizationCancelRepository,
          authorizationRequestRepository: paymentAuthorizationRequestRepository,
          reliabilityJobRepository
        });
        sendJson(response, 201, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/payments/line-pay/refund") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await refundLinePayPayment({
          authUser,
          body,
          paymentRefundRepository: refundPostgresReady ? paymentRefundRepository : undefined
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/payments/line-pay/confirm") {
      const transactionId = url.searchParams.get("transactionId");
      const orderId = url.searchParams.get("orderId");
      let result;
      try {
        result = await confirmLinePayAuthorization({
          transactionId,
          orderId,
          now: businessClock.nowIso(),
          authorizationConfirmRepository: paymentAuthorizationConfirmRepository,
          authorizationCancelRepository: paymentAuthorizationCancelRepository,
          manualRepaymentRepository
        });
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          // Every other branch in this route builds the HTML result page + app deep link; this
          // browser redirect is the customer's only way back into the app, so a PaymentServiceError
          // (e.g. 409 payment_operation_locked from the reconciliation scheduler polling the same
          // transaction) must not fall through to the generic JSON error handler.
          sendHtml(response, error.statusCode, buildLinePayResultPage({
            title: "LINE Pay 預授權無法完成",
            message: error.statusCode === 409
              ? "這筆付款正在處理中，請稍後回到 App 查看結果。"
              : "處理這筆付款時發生錯誤，請回到 App 重新確認訂單狀態。",
            detail: error.payload?.error,
            appReturnUrl: buildLinePayAppReturnUrl({
              orderId,
              transactionId,
              status: "failed",
              error: error.payload?.error
            })
          }));
          return;
        }
        throw error;
      }

      if (result?.error === "capacity_exceeded") {
        const voidStatus = result.voidResult?.status
          || (result.voidError ? `void_failed: ${result.voidError.message}` : "void_not_attempted");
        sendHtml(response, 409, buildLinePayResultPage({
          title: "LINE Pay 預授權無法完成",
          message: "團購已達杯數上限，這筆訂單沒有加入團購。",
          detail: `Maximum cups: ${result.maximumCups} / Authorized cups: ${result.authorizedCups} / Requested cups: ${result.requestedCups} / Void: ${voidStatus}`,
          appReturnUrl: buildLinePayAppReturnUrl({
            orderId: result.pendingPayment?.orderId || orderId,
            transactionId,
            status: "failed",
            paymentFlow: result.paymentFlow,
            error: result.error
          })
        }));
        return;
      }

      if (result?.error) {
        sendHtml(response, 409, buildLinePayResultPage({
          title: result.paymentFlow === "direct_repayment"
            ? "LINE Pay 重新付款無法完成"
            : "LINE Pay 預授權無法完成",
          message: result.error,
          detail: result.authorization ? `Authorization status: ${result.authorization.status}` : undefined,
          appReturnUrl: buildLinePayAppReturnUrl({
            orderId: result.pendingPayment?.orderId || orderId,
            transactionId,
            status: "failed",
            paymentFlow: result.paymentFlow,
            error: result.error
          })
        }));
        return;
      }

      if (!result) {
        sendHtml(response, 409, buildLinePayResultPage({
          title: "LINE Pay 預授權無法完成",
          message: "找不到待確認的付款資料。請回到 App 重新發起預授權。",
          appReturnUrl: buildLinePayAppReturnUrl({
            orderId,
            transactionId,
            status: "failed",
            error: "pending_payment_not_found"
          })
        }));
        return;
      }

      sendHtml(response, 200, buildLinePayResultPage({
        title: result.paymentFlow === "direct_repayment"
          ? "LINE Pay 重新付款完成"
          : "LINE Pay 預授權完成",
        message: result.paymentFlow === "direct_repayment"
          ? "付款已完成，訂單已進入製作流程。請回到 App 查看訂單。"
          : "目前僅完成授權，尚未正式請款。請回到 App 查看團購進度。",
        detail: `Order ID: ${result.pendingPayment.orderId}${result.authorization ? ` / Authorization: ${result.authorization.status}` : ""}`,
        rawCode: result.payload.returnCode,
        appReturnUrl: buildLinePayAppReturnUrl({
          orderId: result.pendingPayment.orderId,
          transactionId,
          status: result.paymentFlow === "direct_repayment" ? "captured" : "authorized",
          paymentFlow: result.paymentFlow
        })
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/payments/line-pay/cancel") {
      const transactionId = url.searchParams.get("transactionId");
      const orderId = url.searchParams.get("orderId");
      let cancelled;
      try {
        cancelled = await cancelLinePayAuthorization({
          transactionId,
          orderId,
          authorizationCancelRepository: paymentAuthorizationCancelRepository
        });
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendHtml(response, error.statusCode, buildLinePayResultPage({
            title: "LINE Pay 預授權取消失敗",
            message: error.statusCode === 409
              ? "這筆付款正在處理中，請稍後回到 App 查看結果。"
              : "處理這筆取消時發生錯誤，請回到 App 重新確認訂單狀態。",
            detail: error.payload?.error,
            appReturnUrl: buildLinePayAppReturnUrl({
              orderId,
              transactionId,
              status: "failed",
              error: error.payload?.error
            })
          }));
          return;
        }
        throw error;
      }
      const directRepayment = cancelled.authorization?.paymentFlow === "direct_repayment"
        || cancelled.pendingPayment?.paymentFlow === "direct_repayment";

      sendHtml(response, 200, buildLinePayResultPage({
        title: directRepayment ? "LINE Pay 重新付款已取消" : "LINE Pay 預授權已取消",
        message: directRepayment
          ? "你可以在付款期限前回到 App 再次付款。"
          : "你可以回到 App 重新發起預授權。",
        appReturnUrl: buildLinePayAppReturnUrl({
          orderId: cancelled.orderId || orderId,
          transactionId: cancelled.transactionId || transactionId,
          status: "cancelled",
          paymentFlow: directRepayment ? "direct_repayment" : "authorization"
        })
      }));
      return;
    }

    const adminSettleActivityMatch = url.pathname.match(/^\/api\/admin\/group-buy-activities\/([^/]+)\/settle$/);
    if (request.method === "GET" && url.pathname === "/api/admin/payment-reliability/alerts") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("admin")) {
        sendJson(response, 403, { error: "Admin role required" });
        return;
      }
      const jobType = url.searchParams.get("jobType") || null;
      const status = url.searchParams.get("status") || null;
      const limit = Number(url.searchParams.get("limit") || 50);
      const validJobTypes = new Set(["reconcile_line_pay_request", "settle_group_buy_activity"]);
      const validStatuses = new Set(["failed"]);
      if (jobType && !validJobTypes.has(jobType)) {
        sendJson(response, 400, { error: "Invalid jobType filter" });
        return;
      }
      if ((status && !validStatuses.has(status)) || !Number.isInteger(limit) || limit <= 0) {
        sendJson(response, 400, { error: "Invalid status or limit filter" });
        return;
      }
      const alerts = await reliabilityJobRepository.listAlerts({
        jobType,
        status,
        limit
      });
      sendJson(response, 200, {
        alerts,
        count: alerts.length,
        filters: {
          jobType,
          status
        }
      });
      return;
    }

    if (request.method === "POST" && adminSettleActivityMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("admin")) {
        sendJson(response, 403, { error: "Admin role required" });
        return;
      }

      const body = await readJsonBody(request);
      const result = await settleGroupBuyActivity({
        activityId: adminSettleActivityMatch[1],
        actorUserId: authUser.id,
        force: Boolean(body.force),
        now: businessClock.nowIso(),
        settlementRepository: settlementPostgresReady ? groupBuySettlementRepository : undefined,
        paymentCaptureRepository: settlementPostgresReady ? paymentCaptureRepository : undefined,
        authorizationCancelRepository: settlementPostgresReady ? paymentAuthorizationCancelRepository : undefined,
        pushTokenRepository: settlementPostgresReady ? pushTokenRepository : undefined
      });

      if (!result) {
        sendJson(response, 404, { error: "Group-buy activity not found" });
        return;
      }
      sendSettlementResult(response, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/refund-requests") {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) return sendJson(response, 401, { error: "Authentication required" });
      if (!authUser.roles.includes("admin")) {
        return sendJson(response, 403, { error: "Admin role required" });
      }
      const listInput = { status: url.searchParams.get("status") || undefined };
      const refundRequests = refundPostgresReady
        ? await paymentRefundRepository.listRefundRequestsForAdmin(listInput)
        : listRefundRequestsForAdmin(listInput);
      sendJson(response, 200, { refundRequests });
      return;
    }

    const approveRefundRequestMatch = url.pathname.match(/^\/api\/admin\/refund-requests\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveRefundRequestMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await approveRefundRequest({
          authUser,
          requestId: approveRefundRequestMatch[1],
          body,
          paymentRefundRepository: refundPostgresReady ? paymentRefundRepository : undefined
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    const rejectRefundRequestMatch = url.pathname.match(/^\/api\/admin\/refund-requests\/([^/]+)\/reject$/);
    if (request.method === "POST" && rejectRefundRequestMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }

      const body = await readJsonBody(request);
      try {
        const result = await rejectRefundRequest({
          authUser,
          requestId: rejectRefundRequestMatch[1],
          body,
          paymentRefundRepository: refundPostgresReady ? paymentRefundRepository : undefined
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    const adminActivityMatch = url.pathname.match(/^\/api\/admin\/group-buy-activities\/([^/]+)$/);
    if (request.method === "DELETE" && adminActivityMatch) {
      const authUser = await getAuthenticatedUser(request);
      if (!authUser) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!authUser.roles.includes("admin")) {
        sendJson(response, 403, { error: "Admin role required" });
        return;
      }

      const body = await readJsonBody(request);
      // Reuses the same validated cascade logic as merchant self-cancel (2026-08-20 --
      // the direct cancelGroupBuyActivity() call used here previously only flipped the
      // activity's own status and left its orders/payment authorizations dangling, a known
      // data-integrity gap logged in docs/AI-security-review-log.md on 2026-08-17).
      // canManageStore always returns true: admin can cancel any store's activity, not just
      // ones they personally manage. actionType is passed through to preserve this route's
      // original, distinct audit-log action type.
      try {
        const result = await cancelMerchantGroupBuyActivity({
          activityId: adminActivityMatch[1],
          reason: (body.reason && String(body.reason).trim()) || "Cancelled by admin action.",
          actorUserId: authUser.id,
          now: businessClock.nowIso(),
          canManageStore: () => true,
          actionType: "admin_cancel_group_buy_activity",
          unconditional: true,
          merchantGroupBuyActivityCancelRepository,
          paymentAuthorizationCancelRepository,
          pushTokenRepository: activityCancelPushTokenRepository
        });
        if (result.error) {
          const statusByError = {
            activity_not_found: 404,
            activity_locked_by_deadline: 409,
            activity_not_cancellable: 409
          };
          sendJson(response, statusByError[result.error] || 409, result);
          return;
        }
        // Forward the full cascade result (not just { activity }) -- a partial failure (e.g.
        // one order's provider void call fails) still leaves the activity itself cancelled,
        // and the admin needs cancelledOrderCount/failedOrderIds to know follow-up is needed
        // instead of seeing an indistinguishable-from-success 200.
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof PaymentServiceError) {
          sendJson(response, error.statusCode, error.payload);
          return;
        }
        throw error;
      }
      return;
    }

    // Dev-only test console (formerly a separate process at local-dev-console/, port 3100 --
    // merged here on 2026-08-23 so it's one tool instead of two). Controls simulated customer
    // GPS location and the global simulated business clock for local testing; never modifies
    // accounts, roles, or store permissions. Gated on isDevAuthModeEnabled() (its own account
    // list already needs AUTH_DEV_MODE) AND isLoopbackRequest -- the original process only ever
    // bound to 127.0.0.1, so this preserves that exact reachability boundary (works from the web
    // preview and from an Android *emulator*, which maps 10.0.2.2 back to host loopback; a real
    // phone over LAN still can't reach it).
    // On top of that, as of 2026-08-24 this console is treated as part of the /admin backend
    // (same nav, same session) -- the human-facing page and its control API also require the
    // same /admin login, not just loopback. The two app-facing routes below are the exception:
    // the mobile app itself calls them directly (no browser, no admin session) to simulate
    // location during dev testing, so they stay reachable on the loopback+dev-mode gate alone.
    if (url.pathname === "/dev-console" || url.pathname.startsWith("/dev-console/") || url.pathname === "/admin/dev-console") {
      if (!isDevAuthModeEnabled() || !isLoopbackRequest(request)) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const isAppFacingDevConsoleRoute = (request.method === "GET" && url.pathname === "/dev-console/api/app/config")
        || (request.method === "POST" && url.pathname === "/dev-console/api/app/report");
      if (!isAppFacingDevConsoleRoute) {
        const adminUser = await requireAdminWebUser(request, response);
        if (!adminUser) return;
      }

      // This is the one real page for the console -- rendered inside the admin sidebar shell so
      // clicking the sidebar link behaves like every other admin page (content changes on the
      // right, sidebar stays). Wrapped in a "shell" div so devConsole/public/styles.css's
      // page-scoped rules (.shell a, .shell h1, etc.) apply to this content without also
      // restyling the admin shell's own elements (the sidebar, its own page-title) that this
      // content now shares a document with.
      if (request.method === "GET" && url.pathname === "/admin/dev-console") {
        sendHtml(response, 200, renderAdminPage({
          title: "本機測試控制台",
          bodyHtml: `<div class="shell">${renderDevConsoleBody()}</div>`,
          activeNav: "devConsole",
        }));
        return;
      }

      // /dev-console itself used to be a full standalone page (its own <html>, no admin sidebar);
      // now that both routes require the exact same login (the comment above), keeping two
      // separately-maintained copies of this page's outer chrome had nothing left protecting it
      // from drifting out of sync with each other, so a plain redirect replaces it -- any old
      // bookmark or direct link still lands on the one real page instead of a second, easy-to-forget
      // copy of it.
      if (request.method === "GET" && (url.pathname === "/dev-console" || url.pathname === "/dev-console/")) {
        response.writeHead(302, { Location: "/admin/dev-console" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/dev-console/styles.css") {
        const content = await fs.readFile(path.join(__dirname, "devConsole", "public", "styles.css"));
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
        response.end(content);
        return;
      }
      if (request.method === "GET" && url.pathname === "/dev-console/app.js") {
        const content = await fs.readFile(path.join(__dirname, "devConsole", "public", "app.js"));
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        response.end(content);
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/status") {
        const devConsoleState = getDevConsoleState();
        sendJson(response, 200, {
          console: { ok: true, localOnly: true },
          backend: { ok: true, statusCode: 200, service: "drink-group-buy-backend", error: null },
          configVersion: getDevConsoleCustomerConfig(normalizeDevConsoleCustomerId(devConsoleState.appReport?.user?.id)).version,
          appReport: devConsoleState.appReport
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/accounts") {
        try {
          const users = await authProfileReadRepository.listDevUsers();
          sendJson(response, 200, { ok: true, statusCode: 200, error: null, accounts: users.map(toConsoleAccount) });
        } catch (error) {
          sendJson(response, 200, { ok: false, accounts: [], statusCode: null, error: error.message });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/business-time") {
        sendJson(response, 200, { businessTime: businessClock.getSnapshot() });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/dev-console/api/business-time") {
        try {
          const body = await readJsonBody(request);
          const businessTime = businessClock.configure(body, { nodeEnv: process.env.NODE_ENV });
          await recordDevConsoleBusinessTimeUpdate(businessTime);
          sendJson(response, 200, { businessTime });
        } catch (error) {
          sendJson(response, 400, { error: error.code || "business_time_invalid", message: error.message });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/config") {
        const devConsoleState = getDevConsoleState();
        sendJson(response, 200, { config: devConsoleState.config, customerConfigs: devConsoleState.customerConfigs });
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/app/config") {
        const userId = normalizeDevConsoleCustomerId(url.searchParams.get("userId"));
        sendJson(response, 200, { userId, config: getDevConsoleCustomerConfig(userId) });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/dev-console/api/config") {
        try {
          const body = await readJsonBody(request);
          sendJson(response, 200, await updateDevConsoleCustomerConfig(body));
        } catch (error) {
          if (error instanceof PaymentServiceError) {
            sendJson(response, error.statusCode, error.payload);
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/dev-console/api/config/reset") {
        try {
          const body = await readJsonBody(request);
          sendJson(response, 200, await resetDevConsoleCustomerConfig(body));
        } catch (error) {
          if (error instanceof PaymentServiceError) {
            sendJson(response, error.statusCode, error.payload);
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/dev-console/api/events") {
        sendJson(response, 200, { events: getDevConsoleState().events });
        return;
      }

      if (request.method === "POST" && url.pathname === "/dev-console/api/app/report") {
        try {
          const body = await readJsonBody(request);
          sendJson(response, 200, { appReport: await recordDevConsoleAppReport(body) });
        } catch (error) {
          if (error instanceof PaymentServiceError) {
            sendJson(response, error.statusCode, error.payload);
            return;
          }
          throw error;
        }
        return;
      }

      sendJson(response, 404, { error: "Not found" });
      return;
    }

    // Server-rendered admin web console. Plain HTML/forms, no build step -- see
    // docs/AI-architecture.md for why this replaced the mobile app's dev-only admin screens.
    // Session is a cookie holding the same signed token createAuthToken() issues for the
    // mobile API, so every mutation below reuses the exact service functions (and therefore
    // the exact audit-log / idempotency / role-check behavior) the JSON admin API already had.
    if (request.method === "GET" && url.pathname === "/admin/login") {
      const existingAdminUser = await getAdminWebUser(request);
      if (existingAdminUser) {
        response.writeHead(302, { Location: "/admin" });
        response.end();
        return;
      }

      const lockoutRemainingMs = getAdminLoginLockoutRemainingMs(request);
      const loginError = lockoutRemainingMs > 0
        ? `登入失敗次數過多，請於 ${formatLockoutMinutes(lockoutRemainingMs)} 分鐘後再試。`
        : url.searchParams.get("error") === "1" ? "密碼錯誤，請再試一次。" : null;
      sendHtml(response, 200, renderAdminLoginPage({
        error: loginError,
        showLocalDevAutoLogin: isDevAuthModeEnabled() && isLoopbackRequest(request)
      }));
      return;
    }

    // Local-dev convenience: same loopback+dev-mode boundary already used to gate /dev-console
    // (see isDevAuthModeEnabled/isLoopbackRequest below) -- a request that could only have come
    // from this machine skips typing ADMIN_WEB_PASSWORDS back in, since it's already sitting in
    // this machine's own .env. Deliberately a POST the person on this machine has to click a
    // button for, not something GET /admin/login does automatically: a plain GET has no user
    // gesture behind it, so any passively-loaded cross-origin resource (an <img>, a background
    // fetch on some other page the developer happens to have open) could silently trigger it and
    // authenticate the browser without anyone asking for that. Requiring a real click here means
    // an attacker's page would need to run script inside this exact origin to fire it, which the
    // Same-Origin Policy already prevents.
    if (request.method === "POST" && url.pathname === "/admin/login/local-dev") {
      if (!isDevAuthModeEnabled() || !isLoopbackRequest(request)) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const session = await resolveAdminWebSessionCookie();
      if (!session.cookie) {
        sendJson(response, 500, { error: session.error || "local_dev_login_failed" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": session.cookie
      });
      response.end(JSON.stringify({ redirectTo: "/admin" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/login") {
      const lockoutRemainingMs = getAdminLoginLockoutRemainingMs(request);
      if (lockoutRemainingMs > 0) {
        sendHtml(response, 429, renderAdminLoginPage({
          error: `登入失敗次數過多，請於 ${formatLockoutMinutes(lockoutRemainingMs)} 分鐘後再試。`
        }));
        return;
      }

      const body = await readFormBody(request);
      if (!verifyAdminWebPassword(body.password)) {
        recordAdminLoginFailure(request);
        response.writeHead(302, { Location: "/admin/login?error=1" });
        response.end();
        return;
      }
      clearAdminLoginFailures(request);

      const session = await resolveAdminWebSessionCookie();
      if (session.error) {
        sendHtml(response, 500, renderAdminLoginPage({ error: session.error }));
        return;
      }

      response.writeHead(302, {
        "Set-Cookie": session.cookie,
        Location: "/admin"
      });
      response.end();
      return;
    }

    // Per-admin email+password login (Firebase-backed), alongside the shared ADMIN_WEB_PASSWORDS
    // above as a fallback. Reuses the exact same Firebase verification and customer
    // auto-registration pipeline as /api/auth/firebase-session -- a first-time sign-in here still
    // becomes an ordinary customer row, since identity creation by itself grants no privilege.
    // Only an account whose user_roles already contains an active "admin" row (granted out of
    // band via scripts/grant-admin-role.js, never self-service) is allowed past this point.
    if (request.method === "POST" && url.pathname === "/admin/login/firebase") {
      const lockoutRemainingMs = getAdminLoginLockoutRemainingMs(request);
      if (lockoutRemainingMs > 0) {
        sendJson(response, 429, { error: "locked" });
        return;
      }

      const body = await readJsonBody(request);
      if (!body.idToken || typeof body.idToken !== "string") {
        sendJson(response, 400, { error: "idToken is required" });
        return;
      }

      let firebaseUser;
      try {
        firebaseUser = await verifyFirebaseIdToken(body.idToken);
      } catch (error) {
        recordAdminLoginFailure(request);
        sendJson(response, 401, { error: "invalid_token" });
        return;
      }

      // email_verified comes from Firebase's own verified ID token claim, not anything the
      // client asserts -- an unverified address could belong to someone other than the person who
      // typed it in. The customer/merchant Firebase login (POST /api/auth/firebase-session) has
      // the same check, for the same reason; kept as two separate checks since the two routes
      // don't share a request path, not because only one of them needs it.
      if (!firebaseUser.email_verified) {
        recordAdminLoginFailure(request);
        sendJson(response, 403, { error: "email_not_verified" });
        return;
      }

      let user = await authProfileReadRepository.getByFirebaseUid(firebaseUser.uid);
      if (!user) {
        // The Google-only self-registration policy lives inside resolveOrRegisterCustomer (see
        // customerRegistrationRepository.js), so it applies here the same way it applies to
        // POST /api/auth/firebase-session -- an admin account is always pre-bound by
        // scripts/bind-seed-firebase-account.js or scripts/grant-admin-role.js before its first
        // login, so it never reaches this branch; this only stops a brand-new email/password
        // sign-in from creating a stray customer row.
        const registration = await customerRegistrationRepository.resolveOrRegisterCustomer({
          firebaseUid: firebaseUser.uid,
          email: firebaseUser.email || null,
          displayName: deriveDisplayNameFromFirebaseUser(firebaseUser),
          signInProvider: firebaseUser.firebase?.sign_in_provider,
          now: businessClock.nowIso()
        });
        if (registration.error) {
          recordAdminLoginFailure(request);
          sendJson(response, 403, { error: registration.error });
          return;
        }
        user = await authProfileReadRepository.getById(registration.userId);
      }

      if (!user.roles.includes("admin")) {
        recordAdminLoginFailure(request);
        sendJson(response, 403, { error: "not_admin" });
        return;
      }

      clearAdminLoginFailures(request);
      const token = createAuthToken(user);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": buildAdminSessionCookie(token)
      });
      response.end(JSON.stringify({ redirectTo: "/admin" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/logout") {
      response.writeHead(302, {
        "Set-Cookie": buildAdminSessionClearCookie(),
        Location: "/admin/login"
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const activities = await groupBuyActivityReadRepository.listActivities();
      const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
      const bodyHtml = renderAdminDashboardBody({
        activities,
        notice: readAdminNoticeFromQuery(url),
        csrfToken
      });
      sendHtml(response, 200, renderAdminPage({ title: "全平台團購", bodyHtml, activeNav: "dashboard" }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/statistics") {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      // getBasicStatistics is the page's core content, so a failure there still fails the whole
      // request like before -- but the other three are each their own section further down the
      // page, and a query-specific failure in just one of them (e.g. the retention CTEs) shouldn't
      // take basic stats, top stores, and the other two sections down with it. Each fallback matches
      // the shape its section renders as "no data" on success -- but since a fallback is now
      // indistinguishable from genuine emptiness by shape alone, each catch also records which
      // query actually failed, so renderAdminStatisticsBody can show "查詢失敗" instead of quietly
      // implying the platform just had zero activity (the same distinction the merchant-facing
      // getStoreWeeklyTrend fault-isolation above already makes via weeklyTrendUnavailable).
      const failedQueries = [];
      const [statistics, weeklyTrend, peakHours, retention] = await Promise.all([
        adminStatisticsRepository.getBasicStatistics(),
        adminStatisticsRepository.getWeeklyTrend().catch((error) => {
          console.error("admin getWeeklyTrend failed:", error.message);
          failedQueries.push("weeklyTrend");
          return [];
        }),
        adminStatisticsRepository.getPeakHours().catch((error) => {
          console.error("admin getPeakHours failed:", error.message);
          failedQueries.push("peakHours");
          return Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: 0 }));
        }),
        adminStatisticsRepository.getCustomerRetention().catch((error) => {
          console.error("admin getCustomerRetention failed:", error.message);
          failedQueries.push("retention");
          return { repeatPurchaseRate: null, totalCustomers: 0, repeatCustomers: 0, weeklyReturning: [] };
        }),
      ]);
      const bodyHtml = renderAdminStatisticsBody({
        ...statistics, weeklyTrend, peakHours, retention,
        weeklyTrendFailed: failedQueries.includes("weeklyTrend"),
        peakHoursFailed: failedQueries.includes("peakHours"),
        retentionFailed: failedQueries.includes("retention"),
      });
      sendHtml(response, 200, renderAdminPage({ title: "數據統計", bodyHtml, activeNav: "statistics" }));
      return;
    }

    const adminStoreStatisticsMatch = url.pathname.match(/^\/admin\/stores\/([^/]+)\/statistics$/);
    if (request.method === "GET" && adminStoreStatisticsMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const storeId = adminStoreStatisticsMatch[1];
      const store = await storeDirectoryReadRepository.getStoreById(storeId);
      if (!store) {
        sendHtml(response, 404, renderAdminPage({
          title: "店家不存在",
          bodyHtml: `<section class="empty">找不到這間店家。<a href="/admin/statistics">返回數據統計</a></section>`,
          activeNav: "statistics"
        }));
        return;
      }
      const [statistics, weeklyTrend] = await Promise.all([
        merchantStatisticsRepository.getStoreStatistics(storeId),
        merchantStatisticsRepository.getStoreWeeklyTrend(storeId),
      ]);
      const bodyHtml = renderAdminStoreStatisticsBody({ store, statistics, weeklyTrend });
      sendHtml(response, 200, renderAdminPage({ title: `${store.name} 數據統計`, bodyHtml, activeNav: "statistics" }));
      return;
    }

    const adminWebCancelActivityMatch = url.pathname.match(/^\/admin\/group-buy-activities\/([^/]+)\/cancel$/);
    if (request.method === "POST" && adminWebCancelActivityMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      try {
        // Mirrors the JSON DELETE /api/admin/group-buy-activities/:id route above exactly --
        // same cascade service, same canManageStore: () => true (admin can cancel any store's
        // activity), same actionType for the audit trail.
        const result = await cancelMerchantGroupBuyActivity({
          activityId: adminWebCancelActivityMatch[1],
          reason: (body.reason && String(body.reason).trim()) || "Cancelled by admin web console.",
          actorUserId: adminUser.id,
          now: businessClock.nowIso(),
          canManageStore: () => true,
          actionType: "admin_cancel_group_buy_activity",
          unconditional: true,
          merchantGroupBuyActivityCancelRepository,
          paymentAuthorizationCancelRepository,
          pushTokenRepository: activityCancelPushTokenRepository
        });
        // A non-empty failedOrderIds means the activity itself cancelled but some orders' LINE
        // Pay void calls failed (result has no top-level `.error` for this case) -- must
        // not show plain success or the admin has no way to know a payment is still live and
        // needs manual follow-up.
        const redirectNotice = result.error
          ? { type: "error", text: describeAdminCancelActivityError(result.error) }
          : result.failedOrderIds?.length > 0
            ? {
                type: "warning",
                text: `團購已取消，但有 ${result.failedOrderIds.length} 筆訂單的付款作廢失敗，需要人工檢查：${result.failedOrderIds.join("、")}`
              }
            : { type: "success", text: "已取消團購。" };
        response.writeHead(302, { Location: buildAdminRedirectLocation("/admin", redirectNotice) });
        response.end();
      } catch (error) {
        response.writeHead(302, {
          Location: buildAdminRedirectLocation("/admin", { type: "error", text: `取消失敗：${error.message}` })
        });
        response.end();
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/refund-requests") {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const refundRequests = refundPostgresReady
        ? await paymentRefundRepository.listRefundRequestsForAdmin({})
        : listRefundRequestsForAdmin({});
      const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
      const bodyHtml = renderAdminRefundRequestsBody({
        pendingRequests: refundRequests.filter((item) => item.status === "pending"),
        reviewedRequests: refundRequests.filter((item) => item.status !== "pending"),
        notice: readAdminNoticeFromQuery(url),
        csrfToken
      });
      sendHtml(response, 200, renderAdminPage({ title: "退款審核", bodyHtml, activeNav: "refunds" }));
      return;
    }

    const adminWebApproveRefundMatch = url.pathname.match(/^\/admin\/refund-requests\/([^/]+)\/approve$/);
    if (request.method === "POST" && adminWebApproveRefundMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      await handleAdminRefundDecision(response, {
        serviceFn: approveRefundRequest,
        adminUser,
        requestId: adminWebApproveRefundMatch[1],
        serviceBody: {},
        successText: "已核准並執行退款。"
      });
      return;
    }

    const adminWebRejectRefundMatch = url.pathname.match(/^\/admin\/refund-requests\/([^/]+)\/reject$/);
    if (request.method === "POST" && adminWebRejectRefundMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      await handleAdminRefundDecision(response, {
        serviceFn: rejectRefundRequest,
        adminUser,
        requestId: adminWebRejectRefundMatch[1],
        serviceBody: { reason: body.reason },
        successText: "已駁回這筆退款申請。"
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/accounts") {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const search = url.searchParams.get("q") || "";
      const category = ADMIN_ACCOUNT_CATEGORIES.has(url.searchParams.get("category"))
        ? url.searchParams.get("category")
        : "all";
      const accounts = await listAdminAccounts({
        authUser: adminUser,
        search,
        adminAccountRoleRepository,
      });
      const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
      const bodyHtml = renderAdminAccountsBody({
        accounts,
        search,
        category,
        notice: readAdminNoticeFromQuery(url),
        csrfToken,
      });
      sendHtml(response, 200, renderAdminPage({
        title: "帳號角色",
        bodyHtml,
        activeNav: "accounts",
      }));
      return;
    }

    const adminWebAccountRoleMatch = url.pathname.match(/^\/admin\/accounts\/([^/]+)\/role$/);
    if (request.method === "POST" && adminWebAccountRoleMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      try {
        const result = await setAdminAccountRole({
          authUser: adminUser,
          userId: decodeURIComponent(adminWebAccountRoleMatch[1]),
          body,
          adminAccountRoleRepository,
          now: businessClock.nowIso(),
        });
        const roleLabel = result.activeRole === "merchant" ? "商家" : "顧客";
        const text = result.changed
          ? `已切換為${roleLabel}介面；原帳號與歷史資料均保留。`
          : `這個帳號目前已經是${roleLabel}介面。`;
        response.writeHead(302, {
          Location: buildAdminRedirectLocation("/admin/accounts", { type: "success", text }),
        });
        response.end();
      } catch (error) {
        response.writeHead(302, {
          Location: buildAdminRedirectLocation("/admin/accounts", {
            type: "error",
            text: extractAdminWebErrorMessage(error),
          }),
        });
        response.end();
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/merchant-applications") {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const applications = await merchantApplicationRepository.listApplicationsForAdmin({});
      const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
      const bodyHtml = renderAdminMerchantApplicationsBody({
        pendingApplications: applications.filter((item) => item.status === "pending"),
        reviewedApplications: applications.filter((item) => item.status !== "pending"),
        notice: readAdminNoticeFromQuery(url),
        csrfToken
      });
      sendHtml(response, 200, renderAdminPage({ title: "商家申請審核", bodyHtml, activeNav: "merchantApplications" }));
      return;
    }

    const adminWebApproveMerchantApplicationMatch = url.pathname.match(/^\/admin\/merchant-applications\/([^/]+)\/approve$/);
    if (request.method === "POST" && adminWebApproveMerchantApplicationMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      await handleAdminMerchantApplicationDecision(response, {
        serviceFn: approveMerchantApplication,
        adminUser,
        applicationId: adminWebApproveMerchantApplicationMatch[1],
        serviceBody: { latitude: body.latitude, longitude: body.longitude },
        successText: "已核准這筆商家申請。"
      });
      return;
    }

    const adminWebRejectMerchantApplicationMatch = url.pathname.match(/^\/admin\/merchant-applications\/([^/]+)\/reject$/);
    if (request.method === "POST" && adminWebRejectMerchantApplicationMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      await handleAdminMerchantApplicationDecision(response, {
        serviceFn: rejectMerchantApplication,
        adminUser,
        applicationId: adminWebRejectMerchantApplicationMatch[1],
        serviceBody: { reason: body.reason },
        successText: "已駁回這筆商家申請。"
      });
      return;
    }

    // First-time bulk menu import for a brand-new store (see merchantMenuImportRepository.js --
    // deliberately refuses once the store already has any menu item). Meant for the one moment a
    // newly-approved store has 50-60 items to enter at once; ordinary day-to-day menu edits stay
    // on the merchant's own /api/merchant/stores/:storeId/menu-items self-service screen.
    const adminMenuImportMatch = url.pathname.match(/^\/admin\/stores\/([^/]+)\/import-menu$/);
    if (request.method === "GET" && adminMenuImportMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const storeId = adminMenuImportMatch[1];
      const existingMenu = await merchantMenuRepository.getStoreMenu(storeId);
      if (!existingMenu) {
        sendHtml(response, 404, renderAdminPage({
          title: "匯入菜單",
          activeNav: "merchantApplications",
          bodyHtml: `<section class="empty">找不到這間店，請確認網址裡的店家 ID（${escapeHtml(storeId)}）正確。</section>`
        }));
        return;
      }
      const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
      const allStores = await storeDirectoryReadRepository.listAllStoresForAdmin();
      sendHtml(response, 200, renderAdminPage({
        title: "匯入菜單",
        activeNav: "merchantApplications",
        bodyHtml: renderAdminMenuImportBody({
          storeId,
          allStores,
          existingItemCount: existingMenu.menuItems.length,
          csrfToken,
          notice: readAdminNoticeFromQuery(url),
          errors: [],
          prefill: { menuItemsCsv: "", optionsCsv: "" }
        })
      }));
      return;
    }

    if (request.method === "POST" && adminMenuImportMatch) {
      const adminUser = await requireAdminWebUser(request, response);
      if (!adminUser) return;

      const storeId = adminMenuImportMatch[1];
      const body = await readCsrfVerifiedAdminFormBody(request, response);
      if (!body) return;

      const existingMenu = await merchantMenuRepository.getStoreMenu(storeId);
      if (!existingMenu) {
        sendHtml(response, 404, renderAdminPage({
          title: "匯入菜單",
          activeNav: "merchantApplications",
          bodyHtml: `<section class="empty">找不到這間店，請確認網址裡的店家 ID（${escapeHtml(storeId)}）正確。</section>`
        }));
        return;
      }
      const existingItemCount = existingMenu.menuItems.length;
      const prefill = { menuItemsCsv: body.menuItemsCsv || "", optionsCsv: body.optionsCsv || "" };
      const allStores = await storeDirectoryReadRepository.listAllStoresForAdmin();

      function rerenderWithErrors(errors) {
        const csrfToken = buildAdminCsrfToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
        sendHtml(response, 200, renderAdminPage({
          title: "匯入菜單",
          activeNav: "merchantApplications",
          bodyHtml: renderAdminMenuImportBody({ storeId, allStores, existingItemCount, csrfToken, notice: null, errors, prefill })
        }));
      }

      if (existingItemCount > 0 && body.confirmReplace !== "on") {
        rerenderWithErrors([`這間店目前已經有 ${existingItemCount} 項菜單品項，請勾選下面的確認框後再送出，避免不小心取代到還在使用中的菜單。`]);
        return;
      }

      const parsed = buildMenuImportItemsFromCsv(prefill.menuItemsCsv, prefill.optionsCsv);
      if (parsed.errors) {
        rerenderWithErrors(parsed.errors);
        return;
      }

      const result = await merchantMenuImportRepository.importMenuItems({
        storeId,
        actorUserId: adminUser.id,
        items: parsed.items,
        now: businessClock.nowIso()
      });

      if (result.error) {
        const errorText = result.error === "store_not_found"
          ? "找不到這間店，請確認網址裡的店家 ID 正確。"
          : result.error === "menu_discount_conflict"
            ? "這次的價格會讓這間店目前正在進行的團購優惠級距失效（例如新價格低於某個折扣後的最低售價），請調整價格或先處理該團購後再匯入。"
            : "匯入失敗，請稍後再試。";
        rerenderWithErrors([errorText]);
        return;
      }

      const successText = result.retiredCount > 0
        ? `已成功匯入 ${result.menuItemIds.length} 筆菜單品項，並下架原本的 ${result.retiredCount} 筆舊品項。`
        : `已成功匯入 ${result.menuItemIds.length} 筆菜單品項。`;
      response.writeHead(302, {
        Location: buildAdminRedirectLocation(`/admin/stores/${encodeURIComponent(storeId)}/import-menu`, {
          type: "success",
          text: successText
        })
      });
      response.end();
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof PaymentServiceError) {
      sendJson(response, error.statusCode, error.payload);
      return;
    }
    sendJson(response, 500, { error: error.message });
  }
});

let deadlineSettlementScheduler;
let linePayReconciliationScheduler;
let pickupExpirationScheduler;
// LINE Pay reconciliation has no PostgreSQL path at all yet (unlike settlement/capture/
// pickup below), so it stays gated on order-write runtime alone, independent of how much
// of the rest of the postgres stack has since become ready.
const controlledPostgresOrderRuntime = customerOrderWriteRepository.kind === "postgres";
const schedulerEnvironment = {
  ...process.env,
  SETTLEMENT_SCHEDULER_ENABLED: controlledPostgresOrderRuntime && !settlementPostgresReady
    ? "false"
    : process.env.SETTLEMENT_SCHEDULER_ENABLED,
  PICKUP_EXPIRATION_SCHEDULER_ENABLED: controlledPostgresOrderRuntime && !pickupPostgresReady
    ? "false"
    : process.env.PICKUP_EXPIRATION_SCHEDULER_ENABLED
};

loadDevConsoleState().then(() => {
server.listen(port, () => {
  console.log(`DrinkGroupBuy backend listening on http://localhost:${port}`);
  linePayReconciliationScheduler = startLinePayReconciliationScheduler({
    enabled: controlledPostgresOrderRuntime && !reconciliationPostgresReady ? false : undefined,
    reliabilityJobRepository,
    authorizationConfirmRepository: paymentAuthorizationConfirmRepository,
    authorizationCancelRepository: paymentAuthorizationCancelRepository,
    manualRepaymentRepository
  });
  if (linePayReconciliationScheduler.enabled) {
    console.log(
      `LINE Pay reconciliation scheduler enabled (${linePayReconciliationScheduler.intervalMs}ms interval)`
    );
  } else {
    console.log(
      `LINE Pay reconciliation scheduler disabled: ${linePayReconciliationScheduler.reason}`
    );
  }


  deadlineSettlementScheduler = startDeadlineSettlementScheduler({
    env: schedulerEnvironment,
    nowProvider: () => businessClock.nowIso(),
    settlementRepository: settlementPostgresReady ? groupBuySettlementRepository : undefined,
    paymentCaptureRepository: settlementPostgresReady ? paymentCaptureRepository : undefined,
    authorizationCancelRepository: settlementPostgresReady ? paymentAuthorizationCancelRepository : undefined,
    pushTokenRepository: settlementPostgresReady ? pushTokenRepository : undefined
  });
  if (deadlineSettlementScheduler.enabled) {
    console.log(`Deadline settlement scheduler enabled (${deadlineSettlementScheduler.intervalMs}ms interval)`);
  } else {
    console.log(`Deadline settlement scheduler disabled: ${deadlineSettlementScheduler.reason}`);
  }

  pickupExpirationScheduler = startPickupExpirationScheduler({
    env: schedulerEnvironment,
    nowProvider: () => businessClock.nowIso(),
    pickupCredentialRepository: pickupPostgresReady ? pickupCredentialRepository : undefined,
    pushTokenRepository: pickupPostgresReady ? pushTokenRepository : undefined
  });
  if (pickupExpirationScheduler.enabled) {
    console.log(`Pickup expiration scheduler enabled (${pickupExpirationScheduler.intervalMs}ms interval)`);
  } else {
    console.log(`Pickup expiration scheduler disabled: ${pickupExpirationScheduler.reason}`);
  }
});
}).catch((error) => {
  console.error("Failed to load dev console state:", error.message);
  process.exit(1);
});

function sendPickupServiceResult(response, result) {
  if (!result?.error) {
    sendJson(response, 200, result);
    return;
  }

  const statusByError = {
    activity_not_found: 404,
    credential_not_found: 404,
    activity_access_denied: 403,
    pickup_code_invalid: 400
  };
  sendJson(response, statusByError[result.error] || 409, result);
}

function sendSettlementResult(response, result) {
  if (!result?.error) {
    sendJson(response, 200, result);
    return;
  }
  if (result.error === "settlement_not_due") {
    sendJson(response, 409, {
      error: "Group-buy activity deadline has not passed",
      deadlineAt: result.deadlineAt,
      now: result.now
    });
    return;
  }
  if (result.error === "activity_already_settled") {
    sendJson(response, 200, result);
    return;
  }

  const statusByError = {
    settlement_retry_pending: 202,
    settlement_payment_failures: 409
  };
  sendJson(response, statusByError[result.error] || 409, result);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8"
  });

  if (statusCode === 204) {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(html);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(text);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      try {
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

// The /admin web console's forms post application/x-www-form-urlencoded, not JSON.
function readFormBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      resolve(Object.fromEntries(new URLSearchParams(rawBody)));
    });
    request.on("error", reject);
  });
}

const ADMIN_SESSION_COOKIE_NAME = "admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // matches auth.js TOKEN_TTL_SECONDS
// The one seeded operations/remediation identity (database/seed-dev.sql, database/migrations/
// 002_seed_dev_postgres.sql) that POST /admin/login resolves ADMIN_WEB_PASSWORDS to.
const ADMIN_WEB_USER_ID = "user-admin-001";

function parseCookies(request) {
  const header = request.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) return null;
        const name = part.slice(0, separatorIndex).trim();
        if (!name) return null;
        return [name, decodeURIComponent(part.slice(separatorIndex + 1).trim())];
      })
      .filter(Boolean)
  );
}

// This cookie carries the same signed token accepted as a Bearer token by the full JSON admin
// API, so a network-position attacker who captures it gets full admin access -- Secure (over
// production TLS) stops it going out in cleartext. Conditional on NODE_ENV, matching the pattern
// already used elsewhere in this file, since local dev has no TLS in front of the backend.
function adminCookieSecureAttribute() {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

// Path=/ (not /admin) so the same session also covers /dev-console, which is now treated as
// part of the admin backend and requires this same login (see the /dev-console route gate).
function buildAdminSessionCookie(token) {
  return `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}${adminCookieSecureAttribute()}`;
}

function buildAdminSessionClearCookie() {
  return `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${adminCookieSecureAttribute()}`;
}

async function getAdminWebUser(request) {
  const user = await getUserFromToken(parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]);
  return user?.roles.includes("admin") ? user : null;
}

// Shared by the real password login (POST /admin/login) and the local-dev auto-login below --
// both end up issuing the exact same signed session cookie for the one seeded admin identity,
// they just differ in how they decide the caller is allowed to have it.
async function resolveAdminWebSessionCookie() {
  const adminUser = await authProfileReadRepository.getById(ADMIN_WEB_USER_ID);
  if (!adminUser || !adminUser.roles.includes("admin")) {
    return { error: `系統找不到管理員身份（${ADMIN_WEB_USER_ID}），請確認資料庫已正確 seed。` };
  }
  const token = createAuthToken(adminUser);
  return { cookie: buildAdminSessionCookie(token) };
}

// Guard clause for every protected /admin/* route: redirects to the login page and returns
// null on failure so the caller can `if (!adminUser) return;` immediately.
async function requireAdminWebUser(request, response) {
  const adminUser = await getAdminWebUser(request);
  if (adminUser) return adminUser;
  response.writeHead(302, { Location: "/admin/login" });
  response.end();
  return null;
}

function getAdminWebPasswords() {
  return (process.env.ADMIN_WEB_PASSWORDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function verifyAdminWebPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const candidates = getAdminWebPasswords();
  // Compares against every configured password (not short-circuiting on the first match) so a
  // submitted password's comparison time doesn't reveal which one, if any, it matched.
  return candidates.reduce((matched, candidate) => safeEqual(password, candidate) || matched, false);
}

// In-memory login lockout for /admin/login -- proportional to this project's actual scale (one
// App Service instance, a small classroom audience, no existing rate-limiting infrastructure to
// build on). Resets on process restart; that's an acceptable tradeoff here, not a gap worth a
// database table and migration for this project's size. Keyed by client IP since
// ADMIN_WEB_PASSWORDS has no per-admin identity to key on instead.
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const adminLoginAttemptsByIp = new Map();

function getAdminLoginClientIp(request) {
  // App Service sits behind Azure's front-end proxy, so the real client IP arrives via
  // X-Forwarded-For (first entry is the original client); local dev has no proxy in front, so
  // request.socket.remoteAddress is the right fallback there.
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.socket?.remoteAddress || "unknown";
}

function getAdminLoginLockoutRemainingMs(request) {
  const ip = getAdminLoginClientIp(request);
  const record = adminLoginAttemptsByIp.get(ip);
  if (!record?.lockedUntil) return 0;
  const remaining = record.lockedUntil - Date.now();
  if (remaining <= 0) {
    adminLoginAttemptsByIp.delete(ip);
    return 0;
  }
  return remaining;
}

function recordAdminLoginFailure(request) {
  const ip = getAdminLoginClientIp(request);
  const now = Date.now();
  const existing = adminLoginAttemptsByIp.get(ip);
  const withinWindow = existing && now - existing.firstAttemptAt < ADMIN_LOGIN_FAILURE_WINDOW_MS;
  const record = withinWindow
    ? { ...existing, count: existing.count + 1 }
    : { count: 1, firstAttemptAt: now, lockedUntil: null };
  if (record.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = now + ADMIN_LOGIN_LOCKOUT_MS;
  }
  adminLoginAttemptsByIp.set(ip, record);
}

function clearAdminLoginFailures(request) {
  adminLoginAttemptsByIp.delete(getAdminLoginClientIp(request));
}

function formatLockoutMinutes(remainingMs) {
  return Math.max(1, Math.ceil(remainingMs / 60000));
}

// Derived from the session token itself (HMAC'd with the same secret createAuthToken() uses)
// instead of a second server-side session store -- an attacker who doesn't already have the
// session cookie can't compute this, and SameSite=Lax on that cookie already blocks the cookie
// from riding along on a cross-site POST, so this is defense in depth for the mutation routes.
function buildAdminCsrfToken(sessionToken) {
  if (!sessionToken) return null;
  return crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET).update(sessionToken).digest("base64url");
}

function verifyAdminCsrfToken(cookies, formBody) {
  const expected = buildAdminCsrfToken(cookies[ADMIN_SESSION_COOKIE_NAME]);
  const provided = typeof formBody.csrfToken === "string" ? formBody.csrfToken : "";
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}

// Reads a form body already verified against the admin session's CSRF token, replying 403 and
// returning null on failure -- shared by every mutating /admin/* POST route so the guard is
// defined once instead of copy-pasted per route.
async function readCsrfVerifiedAdminFormBody(request, response) {
  const body = await readFormBody(request);
  if (!verifyAdminCsrfToken(parseCookies(request), body)) {
    sendText(response, 403, "CSRF token 驗證失敗，請重新整理頁面再試一次。");
    return null;
  }
  return body;
}

function readAdminNoticeFromQuery(url) {
  const message = url.searchParams.get("message");
  if (!message) return null;
  return { text: message, type: url.searchParams.get("type") === "error" ? "error" : "success" };
}

function buildAdminRedirectLocation(path, notice) {
  if (!notice) return path;
  return `${path}?${new URLSearchParams({ message: notice.text, type: notice.type }).toString()}`;
}

function formatAdminCurrency(amount) {
  return `NT$${(Number(amount) || 0).toLocaleString("zh-TW")}`;
}

// weekStart is already a plain "YYYY-MM-DD" string (see getWeeklyTrendPostgres) -- sliced, not
// parsed through Date, so this never risks a timezone-driven off-by-one day.
function formatAdminWeekLabel(weekStart) {
  return weekStart.slice(5).replace("-", "/");
}

function renderAdminNotice(notice) {
  if (!notice) return "";
  const noticeClass = ["success", "error", "warning"].includes(notice.type) ? notice.type : "success";
  return `<div class="notice ${noticeClass}">${escapeHtml(notice.text)}</div>`;
}

const ADMIN_CANCEL_ACTIVITY_ERROR_LABELS = {
  activity_not_found: "找不到這個團購活動。",
  activity_locked_by_deadline: "已進入截止前 30 分鐘鎖定窗口，無法取消。",
  activity_not_cancellable: "這個團購目前的狀態無法取消。"
};

function describeAdminCancelActivityError(errorCode) {
  return ADMIN_CANCEL_ACTIVITY_ERROR_LABELS[errorCode] || `取消失敗：${errorCode}`;
}

// Refund approve/reject both throw PaymentServiceError on failure; the one case worth
// translating specially is the concurrent-double-review race (409, "Refund request is already
// approved/rejected") -- mirrors the friendly message the deleted AdminRefundRequestsScreen.jsx
// used to show instead of the raw backend string.
function extractAdminWebErrorMessage(error) {
  if (!(error instanceof PaymentServiceError)) return error.message;
  const accountRoleErrorLabels = {
    account_not_found: "找不到這個帳號。",
    account_disabled: "停用中的帳號不能切換角色。",
    admin_account_protected: "管理員帳號不能在這個頁面變更角色。",
    merchant_profile_required: "這個帳號尚未建立商家與門市資料，請先完成商家申請審核。",
    merchant_profile_disabled: "這個帳號所屬的商家資料已停用，不能切換到商家介面。",
  };
  if (accountRoleErrorLabels[error.payload?.status]) {
    return accountRoleErrorLabels[error.payload.status];
  }
  const code = error.payload?.error;
  if (typeof code === "string" && (
    code.startsWith("Refund request is already") || code.startsWith("Merchant application is already")
  )) {
    return "這筆申請已經被其他人審核過了，請重新整理。";
  }
  return code || "審核失敗";
}

// Shared by the approve and reject routes below -- same guard/CSRF shape, same
// {authUser, requestId, body, paymentRefundRepository} service-call shape, same
// success/error redirect pattern. The cancel-activity route is deliberately NOT folded in here:
// it calls a differently-shaped service and reports failure via a `result.error` field instead
// of throwing, so sharing this helper would need its own internal branch just to paper over
// that mismatch.
async function handleAdminRefundDecision(response, { serviceFn, adminUser, requestId, serviceBody, successText }) {
  try {
    await serviceFn({
      authUser: adminUser,
      requestId,
      body: serviceBody,
      paymentRefundRepository: refundPostgresReady ? paymentRefundRepository : undefined
    });
    response.writeHead(302, {
      Location: buildAdminRedirectLocation("/admin/refund-requests", { type: "success", text: successText })
    });
    response.end();
  } catch (error) {
    response.writeHead(302, {
      Location: buildAdminRedirectLocation("/admin/refund-requests", { type: "error", text: extractAdminWebErrorMessage(error) })
    });
    response.end();
  }
}

// Same shape as handleAdminRefundDecision, for the merchant-application approve/reject routes.
async function handleAdminMerchantApplicationDecision(response, { serviceFn, adminUser, applicationId, serviceBody, successText }) {
  try {
    await serviceFn({
      authUser: adminUser,
      applicationId,
      body: serviceBody,
      merchantApplicationRepository
    });
    response.writeHead(302, {
      Location: buildAdminRedirectLocation("/admin/merchant-applications", { type: "success", text: successText })
    });
    response.end();
  } catch (error) {
    response.writeHead(302, {
      Location: buildAdminRedirectLocation("/admin/merchant-applications", { type: "error", text: extractAdminWebErrorMessage(error) })
    });
    response.end();
  }
}

// Also the color source for backend/devConsole/public/styles.css (see its own comment) -- that
// stylesheet deliberately has no :root of its own and relies on this block instead, since it's
// only ever loaded by /admin/dev-console, which always renders this block first. One definition,
// so /admin and the dev console (now the same tool, not two visually unrelated pages glued
// together) can't drift into different themes.
const ADMIN_THEME_VARIABLES = `
  :root {
    color-scheme: dark;
    --background: #050505;
    --surface: #0b0b0b;
    --surface-strong: #111111;
    --text: #f5f5f5;
    --muted: #a6a6a6;
    --line: #3a3a3a;
    --line-strong: #eeeeee;
    --success: #8ef0b0;
    --warning: #ffd479;
    --error: #ff8c8c;
    --radius: 12px;
    --radius-sm: 8px;
    font-family: "Microsoft JhengHei", "Noto Sans TC", Arial, sans-serif;
  }
`;

// Monoline inline SVG icons for the admin sidebar -- no icon font or external request, matching
// these pages' existing zero-dependency approach. All 20x20, currentColor, so they inherit the
// surrounding link's text color (including the active/hover states) with no extra styling.
const ADMIN_SIDEBAR_ICON_ATTRS = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ADMIN_ICON_DASHBOARD = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></svg>`;
const ADMIN_ICON_CHART = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><rect x="3" y="10" width="4" height="10"></rect><rect x="10" y="4" width="4" height="16"></rect><rect x="17" y="13" width="4" height="7"></rect></svg>`;
const ADMIN_ICON_REFUND = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><polyline points="9 14 4 9 9 4"></polyline><path d="M4 9h9a6 6 0 0 1 0 12h-1"></path></svg>`;
const ADMIN_ICON_STORE = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><path d="M3 9l1-5h16l1 5"></path><path d="M4 9v10h16V9"></path><path d="M9 19v-6h6v6"></path></svg>`;
const ADMIN_ICON_ACCOUNTS = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"></path></svg>`;
const ADMIN_ICON_CONSOLE = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"></rect><polyline points="7 9 11 12 7 15"></polyline><line x1="13" y1="15" x2="17" y2="15"></line></svg>`;
const ADMIN_ICON_LOGOUT = `<svg ${ADMIN_SIDEBAR_ICON_ATTRS}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`;

function renderAdminPage({ title, bodyHtml, activeNav }) {
  const sidebarLinkClass = (key) => (key === activeNav ? "sidebar-link active" : "sidebar-link");
  const sidebarLinks = [
    { key: "dashboard", href: "/admin", label: "全平台團購", icon: ADMIN_ICON_DASHBOARD },
    { key: "statistics", href: "/admin/statistics", label: "數據統計", icon: ADMIN_ICON_CHART },
    { key: "refunds", href: "/admin/refund-requests", label: "退款審核", icon: ADMIN_ICON_REFUND },
    { key: "merchantApplications", href: "/admin/merchant-applications", label: "商家申請審核", icon: ADMIN_ICON_STORE },
    { key: "accounts", href: "/admin/accounts", label: "帳號角色", icon: ADMIN_ICON_ACCOUNTS },
    // Same isDevAuthModeEnabled() gate the footer link used before -- /dev-console itself is DEV
    // ONLY (also loopback-restricted, checked separately by that route), so this entry stays out of
    // the sidebar entirely on a real deployment instead of linking to a page that would just refuse
    // the request.
    ...(isDevAuthModeEnabled()
      ? [{ key: "devConsole", href: "/admin/dev-console", label: "本機測試控制台", icon: ADMIN_ICON_CONSOLE }]
      : []),
  ].map((link) => `
    <a class="${sidebarLinkClass(link.key)}" href="${link.href}">${link.icon}<span>${link.label}</span></a>`).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · 揪飲 JOIN 管理後台</title>
<style>
${ADMIN_THEME_VARIABLES}
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--background); color: var(--text); }
  .admin-shell { display: flex; height: 100vh; }
  .admin-sidebar { width: 240px; flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 18px 12px; overflow-y: auto; }
  .sidebar-brand { padding: 4px 8px 18px; }
  .brand-title { font-size: 14px; font-weight: 700; line-height: 1.3; }
  .brand-subtitle { font-size: 11px; color: var(--muted); }
  .sidebar-nav { display: flex; flex-direction: column; gap: 2px; }
  .sidebar-link, .sidebar-footer button { display: flex; align-items: center; gap: 12px; padding: 10px 10px; border-radius: var(--radius-sm); color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 700; width: 100%; border: none; background: none; cursor: pointer; text-align: left; font-family: inherit; }
  .sidebar-link:hover, .sidebar-footer button:hover { background: var(--surface-strong); color: var(--text); }
  .sidebar-link.active { background: var(--surface-strong); color: var(--text); }
  .sidebar-link svg, .sidebar-footer svg { flex-shrink: 0; }
  .sidebar-footer { margin-top: auto; display: flex; flex-direction: column; gap: 2px; padding-top: 10px; border-top: 1px solid var(--line); }
  .sidebar-footer form { margin: 0; }
  .admin-main { flex: 1; min-width: 0; overflow-y: auto; }
  .admin-content { max-width: 1100px; margin: 0 auto; padding: 28px 32px; }
  .page-title { font-size: 24px; margin: 0 0 20px; letter-spacing: -0.01em; }
  .notice { border: 1px solid; background: transparent; border-radius: var(--radius); padding: 10px 14px; margin-bottom: 16px; font-size: 13px; font-weight: 700; }
  .notice.success { border-color: var(--success); color: var(--success); }
  .notice.error { border-color: var(--error); color: var(--error); }
  .notice.warning { border-color: var(--warning); color: var(--warning); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }
  .card h2 { margin: 0 0 6px; font-size: 15px; }
  .meta { color: var(--muted); font-size: 12px; margin: 2px 0; }
  .meta a { color: var(--muted); }
  .meta a:hover { color: var(--text); }
  .badge { display: inline-block; border: 1px solid var(--text); border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 700; vertical-align: middle; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
  button, .btn { border: 1px solid var(--text); border-radius: 999px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; background: transparent; color: var(--text); }
  button:hover:not(:disabled), .btn:hover { filter: invert(1); }
  .btn-danger { border-color: var(--error); color: var(--error); }
  .btn-primary { background: var(--text); color: var(--background); }
  .btn-secondary { background: transparent; color: var(--text); }
  input[type="text"], input[type="search"] { border: 1px solid #666666; border-radius: var(--radius-sm); background: var(--background); color: var(--text); padding: 8px 10px; font-size: 13px; font-family: inherit; }
  input[type="text"]:focus, input[type="search"]:focus { outline: none; border-color: var(--line-strong); box-shadow: 0 0 0 1px var(--line-strong); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  section.empty { color: var(--muted); font-size: 13px; padding: 10px 0; }
  h3.section-title { font-size: 13px; color: var(--muted); margin: 22px 0 8px; }
  h3.section-title.chart-title { font-size: 16px; color: var(--text); font-weight: 700; }
  .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
  .two-col-grid h3.section-title { margin-top: 0; }
  @media (max-width: 720px) { .two-col-grid { grid-template-columns: 1fr; } }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
  .stat-card .stat-value { font-size: 24px; font-weight: 700; }
  .stat-card .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
  table.stats-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  table.stats-table th, table.stats-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
  table.stats-table th { color: var(--muted); font-weight: 700; position: sticky; top: 0; background: var(--background); z-index: 1; }
  table.stats-table td a { color: var(--text); font-weight: 700; text-decoration: none; }
  table.stats-table td a:hover { text-decoration: underline; }
  table.stats-table tbody tr:nth-child(even) { background: var(--surface); }
  table.stats-table tbody tr:hover { background: var(--surface-strong); }
  .bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 140px; margin: 10px 0 20px; }
  .bar-chart .bar-col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
  .bar-chart .bar { width: 100%; background: var(--text); min-height: 1px; border-radius: 3px 3px 0 0; }
  .bar-chart .bar-value { font-size: 10px; color: var(--muted); margin-bottom: 3px; }
  .bar-chart .bar-label { font-size: 10px; color: var(--muted); margin-top: 4px; white-space: nowrap; }
  .line-chart { position: relative; height: 140px; }
  .line-chart svg { width: 100%; height: 100%; display: block; }
  .line-chart-dot { position: absolute; width: 6px; height: 6px; border-radius: 999px; background: var(--text); transform: translate(-50%, -50%); }
  .line-chart-row { display: flex; }
  .line-chart-row > div { flex: 1; min-width: 0; text-align: center; font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line-chart-row:first-of-type { margin-bottom: 4px; }
  .line-chart-row:last-of-type { margin-top: 20px; }
  .tabs { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
  .tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 2px 10px; font-size: 13px; font-weight: 700; color: var(--muted); text-decoration: none; background: none; }
  .tab:hover { color: var(--text); }
  .tab.active { background: none; color: var(--text); border-bottom-color: var(--text); }
  @media (max-width: 720px) {
    .admin-sidebar { width: 64px; padding: 18px 8px; }
    .sidebar-brand { display: none; }
    .sidebar-link span, .sidebar-footer span { display: none; }
    .sidebar-link, .sidebar-footer button { justify-content: center; }
    .admin-content { padding: 20px 16px; }
  }
</style>
</head>
<body>
<div class="admin-shell">
  <aside class="admin-sidebar">
    <div class="sidebar-brand">
      <div class="brand-title">揪飲 JOIN</div>
      <div class="brand-subtitle">管理後台</div>
    </div>
    <nav class="sidebar-nav">
      ${sidebarLinks}
    </nav>
    <div class="sidebar-footer">
      <form method="POST" action="/admin/logout">
        <button type="submit">${ADMIN_ICON_LOGOUT}<span>登出</span></button>
      </form>
    </div>
  </aside>
  <main class="admin-main">
    <div class="admin-content">
      <h1 class="page-title">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </main>
</div>
</body>
</html>`;
}

// Ported from what used to be backend/devConsole/public/index.html (a static file) so this page's
// structure is generated the same way every other admin page already is -- a template string in
// this file -- instead of the standalone HTML file getting read off disk and sliced apart with a
// regex to build the admin-embedded version below. That regex approach worked, but coupled the
// embedded route's correctness to index.html's exact markup shape with nothing to catch drift if
// someone edited one without the other; a single source of truth removes that risk entirely.
// styles.css/app.js stay their own static files under devConsole/public/ (unlike the HTML, they
// have no such duplication to resolve, and inlining ~300 lines of client JS into a template string
// would only hurt readability) -- the route below still loads them the same way.
// No user-controlled data is interpolated here: every value a visitor actually sees (account
// names, business-time figures, event log text) is filled in client-side by app.js's own fetch
// calls after load, so nothing here needs escapeHtml.
// Only ever rendered inside the admin shell now (see the /admin/dev-console route) -- the bare
// /dev-console URL is a redirect to that route, not a second copy of this page's chrome, so there's
// no "standalone" variant left to branch on: renderAdminPage's own <h1 class="page-title"> already
// reads "本機測試控制台", and the sidebar is the way back to /admin, so this fragment skips both.
function renderDevConsoleBody() {
  return `
    <link rel="stylesheet" href="/dev-console/styles.css" />
    <header class="hero">
      <div></div>
      <div class="header-actions">
        <button id="refreshButton" class="button button-secondary" type="button">重新檢查</button>
      </div>
    </header>

    <section class="status-grid" aria-label="系統狀態">
      <article class="status-card">
        <div class="status-label">控制伺服器</div>
        <div id="consoleStatus" class="status-value">檢查中</div>
        <div id="consoleMeta" class="status-meta">—</div>
      </article>
      <article class="status-card">
        <div class="status-label">主 Backend</div>
        <div id="backendStatus" class="status-value">檢查中</div>
        <div id="backendMeta" class="status-meta">—</div>
      </article>
      <article class="status-card">
        <div class="status-label">App 同步</div>
        <div id="appStatus" class="status-value">尚未串接</div>
        <div id="appMeta" class="status-meta">等待 Mobile 回報</div>
      </article>
    </section>

    <div id="message" class="message" role="status" aria-live="polite" hidden></div>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-number">01</div>
          <h2>所有測試帳號</h2>
        </div>
        <span id="accountCount" class="version-badge">— 個帳號</span>
      </div>
      <p class="panel-description">資料來自主 Backend 的 dev-only 帳號清單。顧客可各自設定定位；角色與店家權限維持唯讀。</p>
      <div id="accountsMessage" class="empty-state">正在讀取測試帳號</div>
      <div id="accountsTableWrap" class="table-wrap" hidden>
        <table class="accounts-table">
          <thead>
            <tr>
              <th>模擬帳號名稱</th>
              <th>帳號資料</th>
              <th>權限</th>
              <th>商家店家</th>
              <th>顧客定位方式</th>
            </tr>
          </thead>
          <tbody id="accountsTableBody"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-number">02</div>
          <h2>全域業務時間</h2>
        </div>
        <span id="businessTimeBadge" class="version-badge">讀取中</span>
      </div>
      <p class="panel-description">所有測試帳號共用，後端用它判斷訂單截止、取消與取餐時限。只限開發模式；不改電腦時間、Firebase 或金流簽章時間。</p>
      <form id="businessTimeForm" class="business-time-form">
        <fieldset class="mode-selector business-time-modes">
          <legend>時間方式</legend>
          <label class="mode-option">
            <input type="radio" name="businessTimeMode" value="real" checked />
            <span><strong>真實時間</strong><small>與後端主機現在時間一致</small></span>
          </label>
          <label class="mode-option">
            <input type="radio" name="businessTimeMode" value="offset" />
            <span><strong>快轉／倒退</strong><small>跟著真實時間走，最多前後 7 天</small></span>
          </label>
          <label class="mode-option">
            <input type="radio" name="businessTimeMode" value="fixed" />
            <span><strong>固定時間</strong><small>停在指定時刻，最多前後 7 天</small></span>
          </label>
        </fieldset>
        <div class="business-time-fields">
          <label id="offsetField" class="field" hidden>
            <span>位移分鐘（正數快轉、負數倒退）</span>
            <input id="offsetMinutes" type="number" min="-10080" max="10080" step="1" value="60" />
          </label>
          <label id="fixedField" class="field" hidden>
            <span>固定日期時間（台灣本機時間）</span>
            <input id="fixedNow" type="datetime-local" />
          </label>
        </div>
        <div class="business-time-summary">
          <div><span>後端業務時間</span><strong id="effectiveBusinessTime">—</strong></div>
          <div><span>真實伺服器時間</span><strong id="realBusinessTime">—</strong></div>
        </div>
        <div class="actions">
          <button class="button button-primary" type="submit">套用時間設定</button>
          <button id="resetBusinessTimeButton" class="button button-secondary" type="button">恢復真實時間</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-number">03</div>
          <h2>操作紀錄</h2>
        </div>
      </div>
      <ol id="eventList" class="event-list">
        <li class="empty-state">讀取中</li>
      </ol>
    </section>

    <footer>
      <strong>本機限定：</strong>目前只監聽 127.0.0.1。尚未加入 Mobile 配對驗證前，不開放區域網路存取。
    </footer>
    <script src="/dev-console/app.js" defer></script>`;
}

function getFirebaseWebConfig() {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const authDomain = process.env.FIREBASE_WEB_AUTH_DOMAIN;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const appId = process.env.FIREBASE_WEB_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

// Escapes "</" so a trusted server-side config object can't be misread as closing the <script>
// tag it's embedded in -- these values come from this server's own env, not user input, but
// costs nothing to do properly.
function toInlineScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderAdminLoginPage({ error, showLocalDevAutoLogin = false } = {}) {
  const firebaseWebConfig = getFirebaseWebConfig();
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>管理後台登入 · 揪飲 JOIN</title>
<style>
${ADMIN_THEME_VARIABLES}
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--background); }
  .loginCard { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px 26px; width: 300px; }
  h1 { font-size: 16px; margin: 0 0 18px; color: var(--text); }
  h2 { font-size: 13px; margin: 0 0 10px; color: var(--muted); font-weight: 700; }
  input { width: 100%; border: 1px solid #666666; border-radius: var(--radius-sm); background: var(--background); color: var(--text); padding: 10px 12px; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; }
  input:focus { outline: none; border-color: var(--line-strong); box-shadow: 0 0 0 1px var(--line-strong); }
  button { width: 100%; border: 1px solid var(--text); border-radius: 999px; padding: 10px; font-size: 14px; font-weight: 700; background: var(--text); color: var(--background); cursor: pointer; }
  button:hover { filter: invert(1); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  p.error { color: var(--error); font-size: 12px; font-weight: 700; margin: 0 0 12px; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 22px 0; color: var(--muted); font-size: 12px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .textLink { width: 100%; background: none; border: none; color: var(--text); text-decoration: underline; font-size: 12px; font-weight: 700; padding: 8px 0 0; cursor: pointer; }
  .textLink:hover { filter: none; opacity: 0.75; }
  p.status { font-size: 12px; font-weight: 700; margin: 0 0 12px; min-height: 15px; color: var(--muted); }
</style>
</head>
<body>
<div class="loginCard">
  <h1>揪飲 JOIN 管理後台</h1>
  <form method="POST" action="/admin/login">
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <input type="password" name="password" placeholder="密碼" ${firebaseWebConfig ? "" : "autofocus"} required />
    <button type="submit">登入</button>
  </form>
  ${showLocalDevAutoLogin ? `
  <p class="status" id="localDevLoginStatus"></p>
  <button type="button" id="localDevLoginButton">本機開發模式：一鍵登入</button>
  <script>
    document.getElementById("localDevLoginButton").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const statusEl = document.getElementById("localDevLoginStatus");
      button.disabled = true;
      try {
        const response = await fetch("/admin/login/local-dev", { method: "POST" });
        if (!response.ok) {
          statusEl.textContent = "本機自動登入失敗，請改用密碼登入。";
          button.disabled = false;
          return;
        }
        window.location.href = "/admin";
      } catch (error) {
        statusEl.textContent = "本機自動登入失敗，請改用密碼登入。";
        button.disabled = false;
      }
    });
  </script>
  ` : ""}
  ${firebaseWebConfig ? `
  <div class="divider">或</div>
  <h2 id="firebaseLoginHeading">用信箱登入</h2>
  <form id="firebaseLoginForm">
    <p class="status" id="firebaseLoginStatus"></p>
    <input type="email" id="firebaseLoginEmail" placeholder="信箱" autocomplete="username" autofocus required />
    <input type="password" id="firebaseLoginPassword" placeholder="密碼" autocomplete="current-password" required minlength="6" />
    <button type="submit" id="firebaseLoginSubmit">登入</button>
    <button type="button" class="textLink" id="firebaseLoginToggle">第一次使用，建立帳號</button>
  </form>
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
    import {
      getAuth,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
      sendEmailVerification
    } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

    const firebaseConfig = ${toInlineScriptJson(firebaseWebConfig)};
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);

    const formEl = document.getElementById("firebaseLoginForm");
    const statusEl = document.getElementById("firebaseLoginStatus");
    const emailEl = document.getElementById("firebaseLoginEmail");
    const passwordEl = document.getElementById("firebaseLoginPassword");
    const submitEl = document.getElementById("firebaseLoginSubmit");
    const toggleEl = document.getElementById("firebaseLoginToggle");
    const headingEl = document.getElementById("firebaseLoginHeading");
    let mode = "signin";

    toggleEl.addEventListener("click", () => {
      mode = mode === "signin" ? "signup" : "signin";
      headingEl.textContent = mode === "signin" ? "用信箱登入" : "建立信箱帳號";
      submitEl.textContent = mode === "signin" ? "登入" : "建立帳號";
      toggleEl.textContent = mode === "signin" ? "第一次使用，建立帳號" : "已經有帳號，改用登入";
      statusEl.textContent = "";
    });

    formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusEl.textContent = "";
      submitEl.disabled = true;
      const email = emailEl.value.trim();
      const password = passwordEl.value;
      try {
        if (mode === "signup") {
          const credential = await createUserWithEmailAndPassword(auth, email, password);
          await sendEmailVerification(credential.user);
          statusEl.textContent = "帳號已建立，請到信箱點擊驗證連結；驗證後請聯絡系統管理員開通管理員權限，再回來登入。";
          return;
        }
        const credential = await signInWithEmailAndPassword(auth, email, password);
        const idToken = await credential.user.getIdToken(true);
        const response = await fetch("/admin/login/firebase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          statusEl.textContent = describeBackendError(payload.error);
          return;
        }
        window.location.href = "/admin";
      } catch (error) {
        statusEl.textContent = describeFirebaseError(error);
      } finally {
        submitEl.disabled = false;
      }
    });

    // Keep in sync with mobile/src/screens/RoleSelectScreen.jsx's getLoginErrorMessage -- same
    // Firebase/backend error codes, translated independently here because this runs as a plain
    // script in a server-rendered HTML page and that one ships in the React Native bundle, with
    // no shared module system between the two runtimes.
    function describeBackendError(code) {
      if (code === "email_not_verified") return "信箱尚未驗證，請先點擊驗證信裡的連結。";
      if (code === "${EMAIL_REGISTRATION_DISABLED_ERROR}") return "這個信箱密碼帳號尚未被授予管理員權限，請聯絡已有權限的管理員用 scripts/grant-admin-role.js 綁定。";
      if (code === "not_admin") return "這個帳號目前沒有管理員權限，請聯絡系統管理員開通。";
      if (code === "account_disabled") return "這個帳號已被停用。";
      if (code === "locked") return "登入失敗次數過多，請稍後再試。";
      return "登入失敗，請確認帳號密碼是否正確。";
    }

    function describeFirebaseError(error) {
      const code = error && error.code;
      if (code === "auth/email-already-in-use") return "這個信箱已經註冊過，請改用登入。";
      if (code === "auth/weak-password") return "密碼至少需要 6 碼。";
      if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        return "帳號或密碼不正確。";
      }
      if (code === "auth/too-many-requests") return "嘗試次數過多，請稍後再試。";
      if (code === "auth/invalid-email") return "信箱格式不正確。";
      return "發生錯誤，請稍後再試。";
    }
  </script>
  ` : ""}
</div>
</body>
</html>`;
}

// Matches docs/AI-status-candidates.md's group_buy_activity state machine: completed/failed/
// cancelled are terminal (no further transitions out), everything else (draft/recruiting/
// confirmed/ordering/ready_for_pickup) is still an active, in-progress state.
const HISTORICAL_ACTIVITY_STATUSES = new Set(["completed", "failed", "cancelled"]);

function renderAdminActivityCard(activity, csrfToken) {
  const isCancelled = activity.status === "cancelled";
  const cancelForm = isCancelled ? "" : `
    <form class="row" method="POST" action="/admin/group-buy-activities/${encodeURIComponent(activity.id)}/cancel" onsubmit="return confirm('確定要取消這個團購嗎？此動作會取消尚未請款的訂單並撤銷付款授權；已完成請款的訂單不受影響，如需退款請至退款審核處理。');">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
      <input type="text" name="reason" placeholder="取消原因（選填）" style="flex:1; min-width:160px;" />
      <button type="submit" class="btn-danger">取消團購</button>
    </form>`;
  return `
    <div class="card">
      <h2>${escapeHtml(activity.title)} <span class="badge">${escapeHtml(activity.status)}</span></h2>
      <p class="meta">店家：${escapeHtml(activity.store?.name || activity.storeId)}</p>
      <p class="meta">杯數：${activity.currentCups} / ${activity.targetCups} 杯・參加人數：${activity.participantCount}</p>
      ${activity.cancellationReason ? `<p class="meta" style="color:#b91c1c;">取消原因：${escapeHtml(activity.cancellationReason)}</p>` : ""}
      ${cancelForm}
    </div>`;
}

function renderAdminDashboardBody({ activities, notice, csrfToken }) {
  const noticeHtml = renderAdminNotice(notice);
  if (activities.length === 0) {
    return `${noticeHtml}<section class="empty">目前沒有團購。</section>`;
  }

  const inProgressActivities = activities.filter((activity) => !HISTORICAL_ACTIVITY_STATUSES.has(activity.status));
  const historicalActivities = activities.filter((activity) => HISTORICAL_ACTIVITY_STATUSES.has(activity.status));

  const inProgressHtml = inProgressActivities.length === 0
    ? `<section class="empty">目前沒有進行中的團購。</section>`
    : inProgressActivities.map((activity) => renderAdminActivityCard(activity, csrfToken)).join("\n");
  const historicalHtml = historicalActivities.length === 0
    ? `<section class="empty">目前沒有歷史團購。</section>`
    : historicalActivities.map((activity) => renderAdminActivityCard(activity, csrfToken)).join("\n");

  return `${noticeHtml}
  <div class="two-col-grid">
    <div>
      <h3 class="section-title">進行中團購（${inProgressActivities.length} 筆）</h3>
      ${inProgressHtml}
    </div>
    <div>
      <h3 class="section-title">歷史團購（${historicalActivities.length} 筆）</h3>
      ${historicalHtml}
    </div>
  </div>`;
}

// Shared by every admin-statistics bar chart below: `items` is [{ value, valueLabel, label }],
// bar heights are relative to the largest value in the set (not a fixed scale) so each chart uses
// its own full height regardless of the numbers involved.
function renderBarChart(items) {
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  const barsHtml = items.map((item) => `
      <div class="bar-col">
        <div class="bar-value">${escapeHtml(item.valueLabel ?? String(item.value))}</div>
        <div class="bar" style="height:${Math.round((item.value / maxValue) * 100)}%"></div>
        <div class="bar-label">${escapeHtml(item.label)}</div>
      </div>`).join("\n");
  return `<div class="bar-chart">${barsHtml}\n    </div>`;
}

// Same `items` shape as renderBarChart, for trends where a connected line reads better than bars.
// The line itself is one SVG polyline over a 0-100 viewBox stretched to fill the container (a
// little non-uniform stroke distortion from that stretch is fine for a thin line) -- but the point
// markers are separate absolutely-positioned HTML dots, not SVG circles, because a circle drawn in
// those same stretched viewBox units would render as an ellipse. Value/label rows use the same
// N-column flex layout as the dots' left% math (index+0.5)/n so text lines up under each point.
// Evenly spaced across the same 10-90 vertical band pointFor() plots into, so the gridlines always
// line up with where a point WOULD be at that fraction of maxValue, whatever maxValue is this call.
const LINE_CHART_GRID_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

function renderLineChart(items) {
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  const count = items.length;
  const pointFor = (item, index) => ({
    xPercent: ((index + 0.5) / count) * 100,
    yPercent: 10 + (1 - item.value / maxValue) * 80,
  });
  const points = items.map(pointFor);
  const polylinePoints = points.map((point) => `${point.xPercent},${point.yPercent}`).join(" ");
  const gridLinesHtml = LINE_CHART_GRID_FRACTIONS.map((fraction) => {
    const yPercent = 10 + (1 - fraction) * 80;
    return `<line x1="0" y1="${yPercent}" x2="100" y2="${yPercent}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"></line>`;
  }).join("\n");
  const dotsHtml = points.map((point) => `
      <div class="line-chart-dot" style="left:${point.xPercent}%; top:${point.yPercent}%"></div>`).join("\n");
  const valuesHtml = items.map((item) => `<div>${escapeHtml(item.valueLabel ?? String(item.value))}</div>`).join("\n");
  const labelsHtml = items.map((item) => `<div>${escapeHtml(item.label)}</div>`).join("\n");
  return `
    <div class="line-chart-row">${valuesHtml}</div>
    <div class="line-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        ${gridLinesHtml}
        <polyline points="${polylinePoints}" fill="none" stroke="var(--text)" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline>
      </svg>
      ${dotsHtml}
    </div>
    <div class="line-chart-row">${labelsHtml}</div>`;
}

// renderLineChart's own .line-chart-row siblings rely on :first-of-type/:last-of-type (this file's
// <style> block) to space themselves from whatever sits next to them -- that only matches correctly
// when each chart is the only run of .line-chart-row divs under its parent. Wrapping each call's
// output in its own div resets that scope per chart, so stacking more than one line chart in the
// same section (e.g. renderAdminStoreStatisticsBody's order-count + revenue pair below) doesn't leave
// an earlier chart's labels row losing its margin to a later chart's.
function renderWeeklyTrendLineChart(weeklyTrend, valueKey, formatValue) {
  return `<div>${renderLineChart(weeklyTrend.map((week) => ({
    value: week[valueKey],
    valueLabel: formatValue(week[valueKey]),
    label: formatAdminWeekLabel(week.weekStart),
  })))}</div>`;
}

function renderAdminStatisticsBody({
  activities, orders, topStores, weeklyTrend, peakHours, retention,
  weeklyTrendFailed = false, peakHoursFailed = false, retentionFailed = false,
}) {
  const successRateText = activities.successRate == null
    ? "尚無資料"
    : `${Math.round(activities.successRate * 100)}%`;
  // retentionFailed specifically (not just "repeatPurchaseRate == null"): a genuine "no qualifying
  // customers yet" also has repeatPurchaseRate == null, so without this the two cases would render
  // the same reassuring "尚無資料" for what's actually a broken query.
  const repeatPurchaseRateText = retentionFailed
    ? "查詢失敗"
    : retention.repeatPurchaseRate == null
      ? "尚無資料"
      : `${Math.round(retention.repeatPurchaseRate * 100)}%`;
  const repeatPurchaseLabel = retention.totalCustomers > 0
    ? `顧客回購率（${retention.repeatCustomers} / ${retention.totalCustomers} 位有 2 筆以上有效訂單）`
    : "顧客回購率";

  const statCardsHtml = [
    { label: "團購總場次", value: activities.totalCount },
    { label: "已有結果的團購中，成功比例", value: successRateText },
    { label: "訂單總數", value: orders.totalOrders },
    { label: "已請款訂單數", value: orders.capturedOrders },
    { label: "總營收（已請款）", value: formatAdminCurrency(orders.totalRevenue) },
    { label: "平均客單價（已請款）", value: formatAdminCurrency(orders.averageOrderValue) },
    { label: repeatPurchaseLabel, value: repeatPurchaseRateText },
  ].map((card) => `
    <div class="stat-card">
      <div class="stat-value">${escapeHtml(String(card.value))}</div>
      <div class="stat-label">${escapeHtml(card.label)}</div>
    </div>`).join("\n");

  const topStoresHtml = topStores.length === 0
    ? `<section class="empty">目前沒有店家有團購資料。</section>`
    : `
    <table class="stats-table">
      <thead>
        <tr>
          <th>店家</th>
          <th>團購場次</th>
          <th>已請款訂單數</th>
          <th>營收</th>
        </tr>
      </thead>
      <tbody>
        ${topStores.map((store) => `
        <tr>
          <td><a href="/admin/stores/${encodeURIComponent(store.id)}/statistics">${escapeHtml(store.name)}</a></td>
          <td>${store.activityCount}</td>
          <td>${store.capturedOrderCount}</td>
          <td>${formatAdminCurrency(store.revenue)}</td>
        </tr>`).join("\n")}
      </tbody>
    </table>`;

  const weeklyTrendHtml = weeklyTrendFailed
    ? `<section class="notice error">查詢失敗，請稍後再試。</section>`
    : weeklyTrend.length === 0
    ? `<section class="empty">近期沒有訂單資料。</section>`
    : `
    ${renderLineChart(weeklyTrend.map((week) => ({
      value: week.orderCount,
      valueLabel: String(week.orderCount),
      label: formatAdminWeekLabel(week.weekStart),
    })))}
    <table class="stats-table">
      <thead>
        <tr>
          <th>週別（一為週首）</th>
          <th>已請款訂單數</th>
          <th>營收</th>
          <th>折扣金額</th>
          <th>折扣佔原價比例</th>
        </tr>
      </thead>
      <tbody>
        ${weeklyTrend.map((week) => {
          const originalTotal = week.revenue + week.discountAmount;
          const discountRateText = originalTotal > 0
            ? `${Math.round((week.discountAmount / originalTotal) * 100)}%`
            : "—";
          return `
        <tr>
          <td>${formatAdminWeekLabel(week.weekStart)}</td>
          <td>${week.orderCount}</td>
          <td>${formatAdminCurrency(week.revenue)}</td>
          <td>${formatAdminCurrency(week.discountAmount)}</td>
          <td>${discountRateText}</td>
        </tr>`;
        }).join("\n")}
      </tbody>
    </table>`;

  const peakHoursHtml = peakHoursFailed
    ? `<section class="notice error">查詢失敗，請稍後再試。</section>`
    : peakHours.every((hour) => hour.orderCount === 0)
    ? `<section class="empty">目前沒有訂單資料。</section>`
    : renderBarChart(peakHours.map((hour) => ({
      value: hour.orderCount,
      valueLabel: String(hour.orderCount),
      label: String(hour.hour).padStart(2, "0"),
    })));

  const returningRateHtml = retentionFailed
    ? `<section class="notice error">查詢失敗，請稍後再試。</section>`
    : retention.weeklyReturning.length === 0
    ? `<section class="empty">近期沒有顧客下單資料。</section>`
    : renderLineChart(retention.weeklyReturning.map((week) => ({
      value: week.returningRate,
      valueLabel: `${Math.round(week.returningRate * 100)}%`,
      label: formatAdminWeekLabel(week.weekStart),
    })));

  return `
    <div class="stat-grid">${statCardsHtml}</div>
    <div class="two-col-grid">
      <div>
        <h3 class="section-title chart-title">熱門店家排行（依營收排序，最多 10 間）</h3>
        ${topStoresHtml}
      </div>
      <div>
        <h3 class="section-title chart-title">訂單與營收趨勢（近 8 週，已請款訂單）</h3>
        ${weeklyTrendHtml}
      </div>
    </div>
    <div class="two-col-grid">
      <div>
        <h3 class="section-title chart-title">顧客下單活躍時段（依小時統計，全部歷史訂單，台灣時間）</h3>
        ${peakHoursHtml}
      </div>
      <div>
        <h3 class="section-title chart-title">每週回頭客佔比趨勢（近 8 週，回頭客＝更早之前就下過有效訂單）</h3>
        ${returningRateHtml}
      </div>
    </div>`;
}

// The single-store drill-down reached by clicking a row in renderAdminStatisticsBody's top-stores
// table. Reuses merchantStatisticsRepository's getStoreStatistics/getStoreWeeklyTrend -- the same
// figures and "which orders count" definition the merchant's own MerchantStatisticsScreen shows,
// so an admin looking at a store here and the store's own merchant looking at their dashboard never
// see different numbers for the same thing.
function renderAdminStoreStatisticsBody({ store, statistics, weeklyTrend }) {
  const qualifiedRateText = statistics.qualifiedRate == null
    ? "尚無資料"
    : `${Math.round(statistics.qualifiedRate * 100)}%`;

  const statCardsHtml = [
    { label: "已請款訂單數", value: statistics.orderCount },
    { label: "總營收（已扣退款）", value: formatAdminCurrency(statistics.totalRevenue) },
    { label: "折扣金額", value: formatAdminCurrency(statistics.discountGivenTotal) },
    { label: "已結算團購中，成團比例", value: qualifiedRateText },
  ].map((card) => `
    <div class="stat-card">
      <div class="stat-value">${escapeHtml(String(card.value))}</div>
      <div class="stat-label">${escapeHtml(card.label)}</div>
    </div>`).join("\n");

  const weeklyTrendHtml = weeklyTrend.length === 0
    ? `<section class="empty">近期沒有訂單資料。</section>`
    : `
    <p class="meta">每週訂單數</p>
    ${renderWeeklyTrendLineChart(weeklyTrend, "orderCount", String)}
    <p class="meta">每週營收</p>
    ${renderWeeklyTrendLineChart(weeklyTrend, "revenue", formatAdminCurrency)}
    <table class="stats-table">
      <thead>
        <tr>
          <th>週別（一為週首）</th>
          <th>訂單數</th>
          <th>營收</th>
          <th>折扣金額</th>
        </tr>
      </thead>
      <tbody>
        ${weeklyTrend.map((week) => `
        <tr>
          <td>${formatAdminWeekLabel(week.weekStart)}</td>
          <td>${week.orderCount}</td>
          <td>${formatAdminCurrency(week.revenue)}</td>
          <td>${formatAdminCurrency(week.discountAmount)}</td>
        </tr>`).join("\n")}
      </tbody>
    </table>`;

  const topDrinksHtml = statistics.topDrinks.length === 0
    ? `<section class="empty">目前沒有飲品銷售資料。</section>`
    : `
    <table class="stats-table">
      <thead>
        <tr>
          <th>飲品</th>
          <th>銷售杯數</th>
        </tr>
      </thead>
      <tbody>
        ${statistics.topDrinks.map((drink) => `
        <tr>
          <td>${escapeHtml(drink.name)}</td>
          <td>${drink.cups}</td>
        </tr>`).join("\n")}
      </tbody>
    </table>`;

  return `
    <p class="meta"><a href="/admin/statistics">← 返回數據統計總覽</a></p>
    <p class="meta">店家 ID：${escapeHtml(store.id)}・${escapeHtml(ADMIN_STORE_STATUS_LABELS[store.businessStatus] || store.businessStatus)}</p>
    <div class="stat-grid">${statCardsHtml}</div>
    <h3 class="section-title chart-title">訂單與營收趨勢（近 2 個月）</h3>
    ${weeklyTrendHtml}
    <h3 class="section-title chart-title">熱賣飲品（累計銷售杯數前 3 名）</h3>
    ${topDrinksHtml}`;
}

function renderAdminRefundRequestsBody({ pendingRequests, reviewedRequests, notice, csrfToken }) {
  const noticeHtml = renderAdminNotice(notice);

  const pendingHtml = pendingRequests.length === 0
    ? `<section class="empty">目前沒有待審核的退款申請。</section>`
    : pendingRequests.map((request) => `
    <div class="card">
      <h2>${formatAdminCurrency(request.requestedAmount)} <span class="badge">${escapeHtml(request.status)}</span></h2>
      <p class="meta">店家：${escapeHtml(request.storeId)}・訂單：${escapeHtml(request.orderId)}</p>
      <p class="meta">申請原因：${escapeHtml(request.reason || "")}</p>
      <div class="row">
        <form method="POST" action="/admin/refund-requests/${encodeURIComponent(request.id)}/approve" onsubmit="return confirm('確定要核准並執行退款嗎？');">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <button type="submit" class="btn-primary">核准並退款</button>
        </form>
        <form class="row" method="POST" action="/admin/refund-requests/${encodeURIComponent(request.id)}/reject" style="flex:1;">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <input type="text" name="reason" placeholder="駁回原因" required style="flex:1; min-width:120px;" />
          <button type="submit" class="btn-secondary">駁回</button>
        </form>
      </div>
    </div>`).join("\n");

  const reviewedHtml = reviewedRequests.length === 0
    ? `<section class="empty">目前沒有已審核的退款申請。</section>`
    : reviewedRequests.map((request) => `
    <div class="card">
      <h2>${formatAdminCurrency(request.requestedAmount)} <span class="badge">${escapeHtml(request.status)}</span></h2>
      <p class="meta">店家：${escapeHtml(request.storeId)}・訂單：${escapeHtml(request.orderId)}</p>
      ${request.status === "rejected" && request.rejectionReason ? `<p class="meta" style="color:#b91c1c;">駁回原因：${escapeHtml(request.rejectionReason)}</p>` : ""}
    </div>`).join("\n");

  return `${noticeHtml}
  <h3 class="section-title">待審核（${pendingRequests.length} 筆）</h3>
  ${pendingHtml}
  <h3 class="section-title">審核紀錄（${reviewedRequests.length} 筆）</h3>
  ${reviewedHtml}`;
}

// Keys accepted in ?category= -- "all" plus one entry per group renderAdminAccountsBody can show.
const ADMIN_ACCOUNT_CATEGORIES = new Set(["all", "merchant", "customer", "admin", "test", "other"]);
const ADMIN_ACCOUNT_CATEGORY_LABELS = {
  all: "全部分類",
  merchant: "商家帳號",
  customer: "顧客帳號",
  admin: "管理員帳號",
  test: "測試帳號（seed／開發測試用，非真實使用者）",
  other: "其他帳號（目前沒有啟用中的角色）",
};
// Short labels for the tab bar -- the full descriptive labels above stay on each section's own
// heading, where there's room to explain what "測試帳號"/"其他帳號" actually means.
const ADMIN_ACCOUNT_CATEGORY_TAB_LABELS = {
  all: "全部",
  merchant: "商家",
  customer: "顧客",
  admin: "管理員",
  test: "測試帳號",
  other: "其他",
};

function renderAdminAccountsBody({ accounts, search, category, notice, csrfToken }) {
  const noticeHtml = renderAdminNotice(notice);
  const tabsHtml = `
    <div class="tabs">
      ${[...ADMIN_ACCOUNT_CATEGORIES].map((value) => {
        const href = `/admin/accounts?${new URLSearchParams({ ...(search ? { q: search } : {}), category: value }).toString()}`;
        return `<a class="tab ${value === category ? "active" : ""}" href="${escapeHtml(href)}">${escapeHtml(ADMIN_ACCOUNT_CATEGORY_TAB_LABELS[value])}</a>`;
      }).join("")}
    </div>`;
  const searchHtml = `
    <form class="row" method="GET" action="/admin/accounts" style="margin-bottom:18px;">
      <input
        type="search"
        name="q"
        value="${escapeHtml(search)}"
        placeholder="搜尋姓名、Email、帳號 ID 或店名"
        maxlength="100"
        style="flex:1; min-width:240px;"
      />
      <input type="hidden" name="category" value="${escapeHtml(category)}" />
      <button type="submit" class="btn-secondary">搜尋</button>
      ${search || category !== "all" ? '<a class="btn" href="/admin/accounts">清除</a>' : ""}
    </form>`;

  const testAccounts = accounts.filter(isTestSeedAccount);
  const realAccounts = accounts.filter((account) => !isTestSeedAccount(account));
  const groupsByCategory = {
    merchant: () => renderAdminAccountGroup(ADMIN_ACCOUNT_CATEGORY_LABELS.merchant, realAccounts.filter((account) => account.activeRole === "merchant"), csrfToken),
    customer: () => renderAdminAccountGroup(ADMIN_ACCOUNT_CATEGORY_LABELS.customer, realAccounts.filter((account) => account.activeRole === "customer"), csrfToken),
    admin: () => renderAdminAccountGroup(ADMIN_ACCOUNT_CATEGORY_LABELS.admin, realAccounts.filter((account) => account.activeRole === "admin"), csrfToken),
    other: () => renderAdminAccountGroup(
      ADMIN_ACCOUNT_CATEGORY_LABELS.other,
      realAccounts.filter((account) => !["merchant", "customer", "admin"].includes(account.activeRole)),
      csrfToken
    ),
    test: () => renderAdminAccountGroup(ADMIN_ACCOUNT_CATEGORY_LABELS.test, testAccounts, csrfToken),
  };
  const categoriesToRender = category === "all" ? Object.keys(groupsByCategory) : [category];
  const renderedGroupsHtml = categoriesToRender.map((key) => groupsByCategory[key]()).join("\n");
  const groupsHtml = accounts.length === 0
    ? `<section class="empty">${search ? "找不到符合條件的帳號。" : "目前沒有可管理的顧客或商家帳號。"}</section>`
    : renderedGroupsHtml.trim() === ""
      ? `<section class="empty">這個分類目前沒有符合的帳號。</section>`
      : renderedGroupsHtml;

  return `${noticeHtml}
  <div class="card">
    <h2>帳號角色管理</h2>
    <p class="meta">此頁列出資料庫保留的所有已註冊帳號，包含啟用、停用、已刪除及管理員身份。只有啟用中的一般帳號可切換顧客／商家角色；管理員與非啟用帳號只供查看。</p>
    <p class="meta">切換只改變目前可使用的介面與權限，不會刪除顧客資料、訂單、商家、門市或歷史紀錄。後端權限立即生效；使用者登出重登，或完全關閉 App 後重新開啟，即會進入新角色介面。</p>
  </div>
  ${tabsHtml}
  ${searchHtml}
  ${groupsHtml}`;
}

// Distinguishes real, organically-created accounts from one-time SQL seed data and ad-hoc test
// signups accumulated over development (e.g. the 7 demo merchants, the seed admin, and various
// "@a.test" customer fixtures) -- both signals were confirmed against this project's real data:
// every account created through an actual runtime path (customerRegistrationRepository.js,
// merchantApplicationRepository.js) gets `user-${randomUUID()}`, while every seed account was
// hand-assigned a readable id like "user-merchant-001"; RFC 2606 reserves .test/example.com as
// non-routable placeholder domains, which is exactly what this project's seed data uses.
const REAL_ACCOUNT_ID_PATTERN = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_EMAIL_DOMAIN_PATTERN = /@([a-z0-9-]+\.)*(test|example\.(com|org|net))$/i;

function isTestSeedAccount(account) {
  if (!REAL_ACCOUNT_ID_PATTERN.test(account.id)) return true;
  if (account.email && TEST_EMAIL_DOMAIN_PATTERN.test(account.email)) return true;
  return false;
}

function renderAdminAccountGroup(title, groupAccounts, csrfToken) {
  if (groupAccounts.length === 0) return "";
  return `
  <h3 class="section-title">${escapeHtml(title)}（${groupAccounts.length} 筆）</h3>
  ${groupAccounts.map((account) => renderAdminAccountCard(account, csrfToken)).join("\n")}`;
}

function renderAdminAccountCard(account, csrfToken) {
  const roleLabel = account.activeRole === "admin"
    ? "管理員"
    : account.activeRole === "merchant"
      ? "商家"
      : account.activeRole === "customer"
        ? "顧客"
        : "未設定";
  const statusLabels = { active: "啟用", disabled: "停用", deleted: "已刪除" };
  const statusLabel = statusLabels[account.status] || account.status;
  const accountInactive = account.status !== "active";
  const accountProtected = account.protectedAdmin;
  const merchantUnavailable = !account.merchantProfileAvailable;
  const action = `/admin/accounts/${encodeURIComponent(account.id)}/role`;
  return `
    <div class="card">
      <h2>${escapeHtml(account.displayName || account.email || account.id)}
        <span class="badge">目前：${escapeHtml(roleLabel)}</span>
      </h2>
      <p class="meta">Email：${escapeHtml(account.email || "未提供")}</p>
      <p class="meta">帳號 ID：${escapeHtml(account.id)}</p>
      <p class="meta">帳號狀態：${escapeHtml(statusLabel)}</p>
      ${accountProtected
        ? '<p class="meta" style="color:var(--warning);">管理員是受保護身份：可以在清單查看，但不能在一般角色頁改成顧客或商家。</p>'
        : account.merchantStore
        ? `<p class="meta">保留的商家資料：${escapeHtml(account.merchantStore.name || account.merchantStore.id)}（${escapeHtml(account.merchantStore.id)}）
          ・<a href="/admin/stores/${encodeURIComponent(account.merchantStore.id)}/import-menu">匯入菜單</a></p>`
        : '<p class="meta">尚無商家／門市資料；必須先完成商家申請審核，才能切換到商家介面。</p>'}
      ${accountInactive && !accountProtected ? '<p class="meta" style="color:var(--warning);">非啟用帳號只能查看，不能切換角色。</p>' : ""}
      <div class="row">
        <form method="POST" action="${action}" onsubmit="return confirm('確定切換為顧客介面嗎？商家與門市資料會保留，但這個帳號將暫時不能使用商家功能。');">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="targetRole" value="customer" />
          <button type="submit" class="btn-secondary" ${accountProtected || accountInactive || account.activeRole === "customer" ? "disabled" : ""}>切換為顧客</button>
        </form>
        <form method="POST" action="${action}" onsubmit="return confirm('確定切換為商家介面嗎？顧客資料與訂單歷史會保留，但這個帳號將暫時看不到顧客介面。');">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="targetRole" value="merchant" />
          <button type="submit" class="btn-primary" ${accountProtected || accountInactive || merchantUnavailable || account.activeRole === "merchant" ? "disabled" : ""}>切換為商家</button>
        </form>
      </div>
    </div>`;
}

// v1 keeps storeName/address/contactPhone read-only at approval -- the admin only supplies the
// two fields nothing else in this codebase can derive (latitude/longitude); an editable-override
// UI can be added later if approval-time typo correction turns out to matter.
function renderAdminMerchantApplicationsBody({ pendingApplications, reviewedApplications, notice, csrfToken }) {
  const noticeHtml = renderAdminNotice(notice);

  const pendingHtml = pendingApplications.length === 0
    ? `<section class="empty">目前沒有待審核的商家申請。</section>`
    : pendingApplications.map((application) => `
    <div class="card">
      <h2>${escapeHtml(application.storeName)} <span class="badge">${escapeHtml(application.status)}</span></h2>
      <p class="meta">地址：${escapeHtml(application.address)}</p>
      <p class="meta">聯絡電話：${escapeHtml(application.contactPhone)}</p>
      <p class="meta">申請人：${escapeHtml(application.applicantDisplayName || application.applicantEmail || application.applicantFirebaseUid)}</p>
      <div class="row">
        <form class="row" method="POST" action="/admin/merchant-applications/${encodeURIComponent(application.id)}/approve" style="flex:1;" onsubmit="return confirm('確定要核准這筆商家申請嗎？請先確認緯度／經度已正確填寫。');">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <input type="text" name="latitude" placeholder="緯度，例如 24.1505" required style="width:140px;" />
          <input type="text" name="longitude" placeholder="經度，例如 120.6839" required style="width:140px;" />
          <button type="submit" class="btn-primary">核准並建立商家</button>
        </form>
      </div>
      <div class="row">
        <form class="row" method="POST" action="/admin/merchant-applications/${encodeURIComponent(application.id)}/reject" style="flex:1;">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
          <input type="text" name="reason" placeholder="駁回原因" required style="flex:1; min-width:120px;" />
          <button type="submit" class="btn-secondary">駁回</button>
        </form>
      </div>
    </div>`).join("\n");

  const reviewedHtml = reviewedApplications.length === 0
    ? `<section class="empty">目前沒有已審核的商家申請。</section>`
    : reviewedApplications.map((application) => `
    <div class="card">
      <h2>${escapeHtml(application.storeName)} <span class="badge">${escapeHtml(application.status)}</span></h2>
      <p class="meta">地址：${escapeHtml(application.address)}</p>
      ${application.status === "rejected" && application.rejectionReason ? `<p class="meta" style="color:#b91c1c;">駁回原因：${escapeHtml(application.rejectionReason)}</p>` : ""}
      ${application.status === "approved" ? `<p class="meta">已建立商家：${escapeHtml(application.resultingMerchantId)}・門市：${escapeHtml(application.resultingStoreId)}
        ・<a href="/admin/stores/${encodeURIComponent(application.resultingStoreId)}/import-menu">匯入菜單</a></p>` : ""}
    </div>`).join("\n");

  return `${noticeHtml}
  <h3 class="section-title">待審核（${pendingApplications.length} 筆）</h3>
  ${pendingHtml}
  <h3 class="section-title">審核紀錄（${reviewedApplications.length} 筆）</h3>
  ${reviewedHtml}`;
}

// Chinese column headers a non-technical admin can type straight from a spreadsheet, mapped to
// this app's internal option-type identifiers (customization_options.option_type's CHECK
// constraint in database/schema.sql only allows these four English values).
const MENU_IMPORT_OPTION_TYPE_LABELS = { "甜度": "sweetness", "冰量": "ice", "尺寸": "size", "加料": "topping" };
// Matches MerchantMenuManagementScreen.jsx's own rule for a merchant manually building this same
// shape one item at a time: sweetness/ice/size are "pick exactly one" once any option exists for
// that type; topping is "pick any number up to however many are listed" (no separate cap column
// in the CSV -- the imported list's length becomes the cap, since only the merchant's own
// self-service screen currently exposes a way to set a smaller custom cap).
const MENU_IMPORT_SINGLE_CHOICE_TYPES = new Set(["sweetness", "ice", "size"]);

const ADMIN_STORE_STATUS_LABELS = { open: "營業中", closed: "已關閉", temporarily_closed: "暫停營業" };

function renderAdminMenuImportBody({ storeId, allStores, existingItemCount, csrfToken, notice, errors, prefill }) {
  const noticeHtml = renderAdminNotice(notice);
  const storeSwitcherHtml = `
    <label>切換店家</label>
    <select onchange="if (this.value) location.href = '/admin/stores/' + this.value + '/import-menu';" style="width:100%; margin-bottom:10px;">
      ${allStores.map((store) => `<option value="${escapeHtml(store.id)}" ${store.id === storeId ? "selected" : ""}>${escapeHtml(store.name)}（${escapeHtml(store.id)}・${escapeHtml(ADMIN_STORE_STATUS_LABELS[store.businessStatus] || store.businessStatus)}）</option>`).join("")}
    </select>`;
  const errorsHtml = errors.length > 0 ? `
    <div class="notice error">
      <p>匯入前發現 ${errors.length} 個問題，請修正後重新送出（下面已保留你剛才貼的內容）：</p>
      <ul>${errors.map((message) => `<li>${escapeHtml(message)}</li>`).join("\n")}</ul>
    </div>` : "";
  const replaceWarningHtml = existingItemCount > 0 ? `
    <div class="notice warning">
      <p>這間店目前已經有 ${existingItemCount} 項菜單品項。匯入後，這些現有品項會被下架（不會刪除，避免影響已經下單過的歷史訂單），顧客之後只看得到你這次貼上的新清單。</p>
      <label style="display:flex; align-items:center; gap:8px; font-weight:400;">
        <input type="checkbox" name="confirmReplace" form="menu-import-form" />
        我了解，繼續匯入並取代目前的菜單
      </label>
    </div>` : "";

  return `${noticeHtml}
  ${errorsHtml}
  ${replaceWarningHtml}
  <section class="card">
    <h2>店家 ID：${escapeHtml(storeId)}</h2>
    ${storeSwitcherHtml}
    <p class="meta">用在幫店家一次貼上整份菜單：全新店家可以直接匯入；已經有菜單的店家再次匯入，會把舊菜單整批換成這次貼上的新清單（舊品項下架，不刪除）。</p>
    <p class="meta">
      表一「菜單品項」欄位：品名、分類、價格、說明（選填）、是否上架（選填，預設是）。<br />
      表二「客製化選項」欄位：品名（需對應表一）、選項類型（甜度／冰量／尺寸／加料其中之一）、選項名稱、加價。<br />
      甜度／冰量／尺寸只要有列出來，顧客就必須從裡面選一個；加料則是可選 0 個到全部都選。<br />
      從 Excel／Google 試算表整段選取複製，直接貼進下面對應的欄位即可（欄位用逗號或 Tab 都可以）。
    </p>
    <form id="menu-import-form" method="POST" action="/admin/stores/${encodeURIComponent(storeId)}/import-menu">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
      <label>表一：菜單品項</label>
      <textarea name="menuItemsCsv" rows="10" style="width:100%; font-family:monospace;">${escapeHtml(prefill.menuItemsCsv)}</textarea>
      <p class="meta" style="font-family:monospace; white-space:pre;">範例（第一列是標題，貼上時連標題一起貼）：
品名,分類,價格,說明,是否上架
珍珠奶茶,奶茶類,55,,</p>
      <label>表二：客製化選項</label>
      <textarea name="optionsCsv" rows="10" style="width:100%; font-family:monospace;">${escapeHtml(prefill.optionsCsv)}</textarea>
      <p class="meta" style="font-family:monospace; white-space:pre;">範例（第一列是標題，貼上時連標題一起貼）：
品名,選項類型,選項名稱,加價
珍珠奶茶,甜度,正常糖,0</p>
      <button type="submit" class="btn-primary">開始匯入</button>
    </form>
  </section>`;
}

// Small hand-rolled CSV reader (handles quoted fields with embedded commas/newlines/doubled
// quotes) instead of a dependency -- this project has no CSV/file-upload library anywhere else,
// and a real parser is one screen of code, not worth a new dependency for one admin form.
function parseCsvRows(text) {
  const normalized = String(text || "").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === "\"") {
        if (normalized[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
    } else if (char === "," || char === "\t") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsvTable(text) {
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, (row[index] || "").trim()])));
}

function isMenuImportFalseValue(text) {
  return ["否", "no", "false", "0", "n"].includes(text.trim().toLowerCase());
}

// Parses the two pasted CSV tables into the exact shape validateMenuItemInput (this file's
// existing single-item validator, shared with the merchant self-service API) already checks --
// reused as-is here rather than duplicated, so a bulk-imported item is held to the same rules a
// merchant's own manually-entered item is.
function buildMenuImportItemsFromCsv(menuItemsCsvText, optionsCsvText) {
  const errors = [];
  const itemRecords = parseCsvTable(menuItemsCsvText);
  if (itemRecords.length === 0) {
    return { errors: ["菜單品項表沒有任何資料列，請確認第一列是標題（品名、分類、價格...），下面至少要有一列真的資料。"] };
  }

  const itemsByName = new Map();
  const orderedItems = [];
  itemRecords.forEach((record, index) => {
    const rowNumber = index + 2;
    const name = record["品名"] || "";
    if (!name) { errors.push(`菜單品項表第 ${rowNumber} 列：品名不能空白`); return; }
    if (itemsByName.has(name)) { errors.push(`菜單品項表第 ${rowNumber} 列：品名「${name}」重複出現`); return; }
    const category = record["分類"] || "";
    if (!category) { errors.push(`菜單品項表第 ${rowNumber} 列（${name}）：分類不能空白`); return; }
    const basePrice = Number(record["價格"]);
    if (!Number.isInteger(basePrice) || basePrice < 0) {
      errors.push(`菜單品項表第 ${rowNumber} 列（${name}）：價格必須是不小於 0 的整數，目前是「${record["價格"] || ""}」`);
      return;
    }
    const item = {
      name,
      category,
      basePrice,
      description: record["說明"] || null,
      isAvailable: !isMenuImportFalseValue(record["是否上架"] || ""),
      optionsByType: { sweetness: [], ice: [], size: [], topping: [] }
    };
    itemsByName.set(name, item);
    orderedItems.push(item);
  });

  const optionRecords = parseCsvTable(optionsCsvText);
  optionRecords.forEach((record, index) => {
    const rowNumber = index + 2;
    const name = record["品名"] || "";
    const item = itemsByName.get(name);
    if (!item) {
      errors.push(`客製化選項表第 ${rowNumber} 列：品名「${name}」在菜單品項表裡找不到，請確認兩份表的品名完全一致`);
      return;
    }
    const optionTypeZh = record["選項類型"] || "";
    const optionType = MENU_IMPORT_OPTION_TYPE_LABELS[optionTypeZh];
    if (!optionType) {
      errors.push(`客製化選項表第 ${rowNumber} 列（${name}）：選項類型「${optionTypeZh}」必須是甜度、冰量、尺寸或加料其中之一`);
      return;
    }
    const label = record["選項名稱"] || "";
    if (!label) { errors.push(`客製化選項表第 ${rowNumber} 列（${name}）：選項名稱不能空白`); return; }
    if (item.optionsByType[optionType].some((option) => option.label === label)) {
      errors.push(`客製化選項表第 ${rowNumber} 列（${name}）：${optionTypeZh}裡「${label}」重複出現`);
      return;
    }
    const priceDeltaText = record["加價"] || "0";
    const priceDelta = Number(priceDeltaText || "0");
    if (!Number.isInteger(priceDelta) || priceDelta < 0) {
      errors.push(`客製化選項表第 ${rowNumber} 列（${name}）：加價必須是不小於 0 的整數，目前是「${priceDeltaText}」`);
      return;
    }
    item.optionsByType[optionType].push({ label, priceDelta, isAvailable: true });
  });

  if (errors.length > 0) return { errors };

  const items = orderedItems.map((item) => ({
    name: item.name,
    category: item.category,
    basePrice: item.basePrice,
    description: item.description,
    isAvailable: item.isAvailable,
    customizationGroups: Object.entries(item.optionsByType)
      .filter(([, options]) => options.length > 0)
      .map(([optionType, options]) => ({
        optionType,
        minSelections: MENU_IMPORT_SINGLE_CHOICE_TYPES.has(optionType) ? 1 : 0,
        maxSelections: MENU_IMPORT_SINGLE_CHOICE_TYPES.has(optionType) ? 1 : options.length,
        options
      }))
  }));

  const shapeErrors = items
    .map((item) => ({ name: item.name, message: validateMenuItemInput(item) }))
    .filter((entry) => entry.message)
    .map((entry) => `「${entry.name}」：${entry.message}`);
  if (shapeErrors.length > 0) return { errors: shapeErrors };

  return { items };
}

const MINIMUM_ACTIVITY_DURATION_MS = 30 * 60 * 1000;
const ACTIVITY_START_AT_PAST_TOLERANCE_MS = 60 * 1000;

function validateCreateActivity(body, now) {
  const requiredFields = [
    "storeId",
    "title",
    "startAt",
    "deadlineAt",
    "pickupStartAt"
  ];
  const missingField = requiredFields.find((field) => !body[field]);
  if (missingField) return `Missing required field: ${missingField}`;

  const startTime = Date.parse(body.startAt);
  const deadlineTime = Date.parse(body.deadlineAt);
  const pickupStartTime = Date.parse(body.pickupStartAt);
  if (Number.isNaN(startTime)) return "startAt must be a valid datetime";
  if (Number.isNaN(deadlineTime)) return "deadlineAt must be a valid datetime";
  if (Number.isNaN(pickupStartTime)) return "pickupStartAt must be a valid datetime";
  // The mobile create screen always sends the current time as startAt (there's no scheduling
  // UI to pick a future one), so this mainly guards against someone calling the API directly
  // with an arbitrary past value. The small tolerance absorbs ordinary request latency between
  // the app reading "now" and this request actually arriving.
  const nowTime = Date.parse(now);
  if (!Number.isNaN(nowTime) && startTime < nowTime - ACTIVITY_START_AT_PAST_TOLERANCE_MS) {
    return "startAt must not be in the past";
  }
  if (deadlineTime <= startTime) return "deadlineAt must be after startAt";
  if (deadlineTime - startTime < MINIMUM_ACTIVITY_DURATION_MS) {
    return "deadlineAt must be at least 30 minutes after startAt";
  }
  if (deadlineTime - startTime > 24 * 60 * 60 * 1000) {
    return "deadlineAt must be within 24 hours of startAt";
  }
  if (pickupStartTime - deadlineTime < 30 * 60 * 1000) {
    return "pickupStartAt must be at least 30 minutes after deadlineAt";
  }

  if (body.tiers != null && !Array.isArray(body.tiers)) {
    return "tiers must be an array";
  }

  return null;
}

// Pickup end time is not merchant-configurable: it's fixed to 3 hours after pickup start,
// matching the pickup-credential validity window (backend/db.js's calculatePickupExpirationAt).
// TODO: once store business hours exist in the schema, cap this at the store's closing time
// too (see docs/open-questions.md's pickup-credential-expiry entry -- that half of the rule
// was decided but never had data to back it, so it was never actually enforced anywhere).
function computeActivityPickupEndAt(pickupStartAt) {
  return new Date(Date.parse(pickupStartAt) + 3 * 60 * 60 * 1000).toISOString();
}

function validateCreateOrder(body) {
  if (!body.activityId) return "Missing required field: activityId";
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return "items must be a non-empty array";
  }
  if (
    body.fallbackPurchasePreference != null
    && !["decline_original_price", "accept_original_price"].includes(body.fallbackPurchasePreference)
  ) {
    return "fallbackPurchasePreference is invalid";
  }
  return null;
}

function validateUpdateOrder(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return "items must be a non-empty array";
  }
  if (
    body.fallbackPurchasePreference != null
    && !["decline_original_price", "accept_original_price"].includes(body.fallbackPurchasePreference)
  ) {
    return "fallbackPurchasePreference is invalid";
  }
  return null;
}

function validateMenuItemInput(body) {
  if (!String(body.name || "").trim()) return "name is required";
  if (!String(body.category || "").trim()) return "category is required";
  if (!Number.isInteger(Number(body.basePrice)) || Number(body.basePrice) < 0) {
    return "basePrice must be a non-negative integer";
  }
  if (typeof body.isAvailable !== "boolean") return "isAvailable must be a boolean";
  if (!Array.isArray(body.customizationGroups)) return "customizationGroups must be an array";

  const allowedTypes = new Set(["sweetness", "ice", "topping", "size"]);
  const seenTypes = new Set();
  for (const group of body.customizationGroups) {
    if (!allowedTypes.has(group.optionType)) return "customization group optionType is invalid";
    if (seenTypes.has(group.optionType)) return "customization group optionType must be unique";
    seenTypes.add(group.optionType);
    const minSelections = Number(group.minSelections);
    const maxSelections = Number(group.maxSelections);
    if (!Number.isInteger(minSelections) || minSelections < 0) {
      return "customization group minSelections must be a non-negative integer";
    }

    if (!Number.isInteger(maxSelections) || maxSelections < minSelections) {
      return "customization group maxSelections must be an integer greater than or equal to minSelections";
    }
    if (!Array.isArray(group.options)) return "customization group options must be an array";
    if (maxSelections > group.options.filter((option) => option.isAvailable !== false).length) {
      return "customization group maxSelections cannot exceed available option count";
    }
    const labels = new Set();
    for (const option of group.options) {
      const label = String(option.label || "").trim();
      if (!label) return "customization option label is required";
      if (labels.has(label)) return "customization option labels must be unique within a group";
      labels.add(label);
      if (!Number.isInteger(Number(option.priceDelta)) || Number(option.priceDelta) < 0) {
        return "customization option priceDelta must be a non-negative integer";
      }
      if (typeof option.isAvailable !== "boolean") return "customization option isAvailable must be a boolean";
    }
  }
  return null;
}

function sendOrderItemValidationError(response, result) {
  if (result?.error === "order_items_invalid") {
    sendJson(response, 409, result);
    return true;
  }
  if (result?.error === "order_price_changed" || result?.error === "order_discount_conflict") {
    sendJson(response, 409, result);
    return true;
  }
  return false;
}

function readOrderListQuery(url) {
  const limit = Number(url.searchParams.get("limit") || 20);
  return {
    scope: url.searchParams.get("scope") === "history" ? "history" : "active",
    activityId: url.searchParams.get("activityId") || undefined,
    cursor: url.searchParams.get("cursor") || undefined,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
  };
}

// Shared by the mobile JSON API's Authorization-header session (getAuthenticatedUser) and the
// admin web console's cookie session (getAdminWebUser) -- they only differ in where the token
// comes from, not in how it's verified or resolved to a user.
async function getUserFromToken(token) {
  const payload = verifyAuthToken(token);
  if (!payload?.sub) return null;
  return authProfileReadRepository.getById(payload.sub);
}

async function getAuthenticatedUser(request) {
  return getUserFromToken(getBearerToken(request));
}

function canAccessOrder(user, order) {
  if (user.roles.includes("admin")) return true;
  return order.customerUserId === user.id;
}

function canManageStore(user, storeId) {
  if (!storeId) return false;
  return user.merchantStores.some((store) => store.id === storeId);
}


function isSqliteOrderDependentRoute(method, pathname) {
  if (method === "POST" && pathname === "/api/orders") return false;
  if (method === "PATCH" && /^\/api\/orders\/[^/]+$/.test(pathname)) return false;
  if (method === "GET" && pathname === "/api/customers/me/orders") return false;
  if (method === "GET" && /^\/api\/merchant\/stores\/[^/]+\/orders$/.test(pathname)) return false;
  if (method === "GET" && /^\/api\/orders\/[^/]+$/.test(pathname)) return false;
  if (method === "POST" && pathname === "/api/payments/line-pay/request") return false;
  if (method === "GET" && pathname === "/api/payments/line-pay/confirm") return false;
  if (method === "GET" && pathname === "/api/payments/line-pay/cancel") return false;
  if (method === "POST" && /^\/api\/orders\/[^/]+\/cancel$/.test(pathname)) return false;
  return pathname.startsWith("/api/orders/")
    || pathname.startsWith("/api/payments/")
    || pathname.startsWith("/api/pickup-credentials/")
    || pathname.startsWith("/api/merchant/pickup-credentials/")
    || /^\/api\/merchant\/group-buy-activities\/[^/]+(?:\/orders\/[^/]+)?\/ready-for-pickup$/.test(pathname)
    || /^\/api\/admin\/group-buy-activities\/[^/]+\/settle$/.test(pathname)
    || /^\/api\/merchant\/orders\/[^/]+\/refund-requests$/.test(pathname)
    || /^\/api\/merchant\/stores\/[^/]+\/refund-requests$/.test(pathname)
    || pathname === "/api/admin/refund-requests"
    || /^\/api\/admin\/refund-requests\/[^/]+\/(approve|reject)$/.test(pathname)
    || pathname === "/admin/refund-requests"
    || /^\/admin\/refund-requests\/[^/]+\/(approve|reject)$/.test(pathname);
}

// NOTE: despite the name, this covers every postgres-gated follow-up domain (settlement,
// pickup, refund), not just settlement -- kept as one function since it's one boolean the
// request handler needs, and each branch already names the domain it exempts.
function isSettlementRouteReadyForPostgres(method, pathname) {
  if (
    method === "POST"
    && groupBuySettlementRepository.kind === "postgres"
    && /^\/api\/admin\/group-buy-activities\/[^/]+\/settle$/.test(pathname)
  ) {
    return true;
  }
  if (
    pickupCredentialRepository.kind === "postgres"
    && (
      pathname.startsWith("/api/pickup-credentials/")
      || pathname.startsWith("/api/merchant/pickup-credentials/")
      || (method === "GET" && /^\/api\/orders\/[^/]+\/pickup-credential$/.test(pathname))
      || (method === "POST" && /^\/api\/merchant\/group-buy-activities\/[^/]+(?:\/orders\/[^/]+)?\/ready-for-pickup$/.test(pathname))
    )
  ) {
    return true;
  }
  if (
    paymentRefundRepository.kind === "postgres"
    && (
      (method === "POST" && pathname === "/api/payments/line-pay/refund")
      || (method === "POST" && /^\/api\/merchant\/orders\/[^/]+\/refund-requests$/.test(pathname))
      || (method === "GET" && /^\/api\/merchant\/stores\/[^/]+\/refund-requests$/.test(pathname))
      || (method === "GET" && pathname === "/api/admin/refund-requests")
      || (method === "POST" && /^\/api\/admin\/refund-requests\/[^/]+\/(approve|reject)$/.test(pathname))
      // Same underlying actions as the JSON routes above, just reached from the server-rendered
      // /admin web console (see the bottom of the request handler) instead of the mobile app --
      // must stay behind the same PostgreSQL-readiness gate since they read/call the same
      // repository and service.
      || (method === "GET" && pathname === "/admin/refund-requests")
      || (method === "POST" && /^\/admin\/refund-requests\/[^/]+\/(approve|reject)$/.test(pathname))
    )
  ) {
    return true;
  }
  if (
    orderRevisionRepository.kind === "postgres"
    && method === "POST"
    && /^\/api\/orders\/[^/]+\/revisions$/.test(pathname)
  ) {
    return true;
  }
  if (
    method === "POST"
    && pathname === "/api/payments/line-pay/repay"
    && manualRepaymentRepository.kind === "postgres"
    && paymentCaptureRepository.kind === "postgres"
    && paymentAuthorizationCancelRepository.kind === "postgres"
    && paymentAuthorizationRequestRepository.kind === "postgres"
    && reliabilityJobRepository.kind === "postgres"
  ) {
    return true;
  }
  return false;
}

function isDevAuthModeEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  return readBooleanEnv(process.env.AUTH_DEV_MODE, false);
}

function isLoopbackRequest(request) {
  const remoteAddress = request.socket?.remoteAddress;
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function readBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function deriveDisplayNameFromFirebaseUser(firebaseUser) {
  const name = typeof firebaseUser.name === "string" ? firebaseUser.name.trim() : "";
  if (name) return name;

  const email = typeof firebaseUser.email === "string" ? firebaseUser.email : "";
  const localPart = email.split("@")[0]?.trim();
  return localPart || "Google 使用者";
}

function toPublicUserResponse(user) {
  return {
    id: user.id,
    loginName: user.loginName,
    phoneNumber: user.phoneNumber,
    email: user.email,
    displayName: user.displayName,
    surname: user.surname,
    roles: user.roles,
    merchantStores: user.merchantStores
  };
}

function buildLinePayResultPage({ title, message, detail, rawCode, providerCodeLabel = "LINE Pay returnCode", appReturnUrl }) {
  const autoReturnScript = appReturnUrl
    ? `<script>
  window.setTimeout(function () {
    window.location.href = ${toSafeScriptString(appReturnUrl)};
  }, 900);
</script>`
    : "";

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f1f5f9;
      color: #0f172a;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      border-radius: 24px;
      background: white;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.16);
      padding: 28px;
    }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 8px 0; line-height: 1.6; color: #334155; }
    .code { color: #2563eb; font-weight: 800; }
    .button {
      display: block;
      margin-top: 18px;
      border-radius: 14px;
      background: #2563eb;
      color: white;
      font-weight: 900;
      padding: 14px 16px;
      text-align: center;
      text-decoration: none;
    }
    .hint { font-size: 13px; color: #64748b; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detail ? `<p class="code">${escapeHtml(detail)}</p>` : ""}
    ${rawCode ? `<p>${escapeHtml(providerCodeLabel)}: ${escapeHtml(rawCode)}</p>` : ""}
    ${appReturnUrl ? `<a class="button" href="${escapeHtml(appReturnUrl)}">返回 App 查看訂單</a>` : ""}
    ${appReturnUrl ? '<p class="hint">若沒有自動返回 App，請點選上方按鈕。</p>' : ""}
  </main>
  ${autoReturnScript}
</body>
</html>`;
}

function buildLinePayAppReturnUrl({ orderId, transactionId, status, paymentFlow, error, source = "line_pay" }) {
  const baseUrl = process.env.LINE_PAY_APP_RETURN_URL || "drinkgroupbuy://payment/result";
  try {
    const appUrl = new URL(baseUrl);
    appUrl.searchParams.set("source", source);
    if (orderId) appUrl.searchParams.set("orderId", orderId);
    if (transactionId) appUrl.searchParams.set("transactionId", transactionId);
    if (status) appUrl.searchParams.set("status", status);
    if (paymentFlow) appUrl.searchParams.set("paymentFlow", paymentFlow);
    if (error) appUrl.searchParams.set("error", error);
    return appUrl.toString();
  } catch {
    return null;
  }
}

function toSafeScriptString(value) {
  return JSON.stringify(String(value)).replaceAll("<", "\\u003c");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
