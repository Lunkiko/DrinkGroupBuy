"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSecurityHeaders, applySecurityHeaders } = require("./securityHeaders");

test("every response asks browsers not to sniff content types, not to be framed, and to keep referrers on our own site", () => {
  const headers = buildSecurityHeaders({});
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "same-origin");
});

test("the content security policy blocks framing, <base> hijacking, plugins and cross-site form posts", () => {
  const policy = buildSecurityHeaders({})["Content-Security-Policy"];
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'self'/);
});

test("the policy does not restrict scripts, styles or connections, because the admin pages use inline ones", () => {
  const policy = buildSecurityHeaders({})["Content-Security-Policy"];
  assert.doesNotMatch(policy, /script-src|style-src|default-src|connect-src|img-src/);
});

test("HSTS is sent only on Azure App Service, which serves HTTPS; the plain-HTTP school VM and local machines get none", () => {
  assert.match(buildSecurityHeaders({ WEBSITE_SITE_NAME: "app" })["Strict-Transport-Security"], /^max-age=\d+$/);
  assert.equal(buildSecurityHeaders({})["Strict-Transport-Security"], undefined);
  assert.equal(buildSecurityHeaders({ ADMIN_WEB_LOOPBACK_ONLY: "true" })["Strict-Transport-Security"], undefined);
});

test("HSTS does not extend to subdomains or the preload list, since azurewebsites.net is a shared domain", () => {
  const value = buildSecurityHeaders({ WEBSITE_SITE_NAME: "app" })["Strict-Transport-Security"];
  assert.doesNotMatch(value, /includeSubDomains|preload/i);
});

test("applySecurityHeaders sets them on the response and leaves headers written later alone", () => {
  const stored = new Map();
  const response = { setHeader: (name, value) => stored.set(name, value) };
  applySecurityHeaders(response, { WEBSITE_SITE_NAME: "app" });
  assert.equal(stored.get("X-Frame-Options"), "DENY");
  assert.ok(stored.has("Strict-Transport-Security"));
  assert.equal(stored.has("Content-Type"), false);
});
