"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isAdminSurfacePath, shouldBlockAdminSurface } = require("./adminSurfaceGuard");

test("admin console, dev console and admin API paths are operator-only surfaces", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/login", "/admin/accounts", "/dev-console", "/dev-console/app.js", "/api/admin/group-buy-activities/activity-1"]) {
    assert.equal(isAdminSurfacePath(pathname), true, pathname);
  }
});

test("customer, merchant, payment-redirect and health paths are not operator-only", () => {
  for (const pathname of [
    "/health",
    "/api/stores",
    "/api/auth/firebase-session",
    "/api/payments/line-pay/confirm",
    "/api/payments/line-pay/cancel",
    "/api/merchant/stores/store-001/statistics",
    "/administrator",
    "/api/administrators",
    "/"
  ]) {
    assert.equal(isAdminSurfacePath(pathname), false, pathname);
  }
});

test("with the flag off nothing is blocked", () => {
  assert.equal(shouldBlockAdminSurface({ pathname: "/admin/login", loopbackOnly: false, isLoopback: false }), false);
  assert.equal(shouldBlockAdminSurface({ pathname: "/admin/login", loopbackOnly: undefined, isLoopback: false }), false);
});

test("with the flag on, a remote request to an admin path is blocked and a local one is not", () => {
  assert.equal(shouldBlockAdminSurface({ pathname: "/admin/login", loopbackOnly: true, isLoopback: false }), true);
  assert.equal(shouldBlockAdminSurface({ pathname: "/api/admin/x", loopbackOnly: true, isLoopback: false }), true);
  assert.equal(shouldBlockAdminSurface({ pathname: "/admin/login", loopbackOnly: true, isLoopback: true }), false);
});

test("with the flag on, remote requests to customer and payment-redirect paths still go through", () => {
  assert.equal(shouldBlockAdminSurface({ pathname: "/api/stores", loopbackOnly: true, isLoopback: false }), false);
  assert.equal(shouldBlockAdminSurface({ pathname: "/api/payments/line-pay/confirm", loopbackOnly: true, isLoopback: false }), false);
  assert.equal(shouldBlockAdminSurface({ pathname: "/health", loopbackOnly: true, isLoopback: false }), false);
});
