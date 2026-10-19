"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isDevAuthModeEnabled, devAuthModeBlockedReason } = require("./devAuthMode");

test("is off unless AUTH_DEV_MODE is explicitly on", () => {
  assert.equal(isDevAuthModeEnabled({}), false);
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "false" }), false);
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "" }), false);
});

test("is on for a plain local machine with AUTH_DEV_MODE=true", () => {
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "true" }), true);
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: " TRUE " }), true);
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "1", NODE_ENV: "development" }), true);
});

test("is always off in production", () => {
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "true", NODE_ENV: "production" }), false);
});

test("is always off on Azure App Service, even if NODE_ENV was never set to production", () => {
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "true", WEBSITE_SITE_NAME: "drinkgroupbuy-demo-api" }), false);
});

test("names the reason when something other than the AUTH_DEV_MODE flag keeps dev mode off", () => {
  assert.match(devAuthModeBlockedReason({ NODE_ENV: "production" }), /NODE_ENV=production/);
  assert.match(devAuthModeBlockedReason({ WEBSITE_SITE_NAME: "app" }), /Azure/);
  assert.match(devAuthModeBlockedReason({ ADMIN_WEB_LOOPBACK_ONLY: "true" }), /ADMIN_WEB_LOOPBACK_ONLY/);
  assert.equal(devAuthModeBlockedReason({}), null);
  assert.equal(devAuthModeBlockedReason({ AUTH_DEV_MODE: "true" }), null);
});

test("is always off on a host that serves the admin console to the machine itself only (the school VM)", () => {
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "true", ADMIN_WEB_LOOPBACK_ONLY: "true" }), false);
  assert.equal(isDevAuthModeEnabled({ AUTH_DEV_MODE: "true", ADMIN_WEB_LOOPBACK_ONLY: "false" }), true);
});
