"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveClientAddress } = require("./clientAddress");

const onAzure = { WEBSITE_SITE_NAME: "drinkgroupbuy-demo-api" };
const notOnAzure = {};

test("on Azure, the entry the platform appended wins over anything the client put in front of it", () => {
  const address = resolveClientAddress({
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9:51234" },
    socketAddress: "10.0.0.4",
    env: onAzure,
  });
  assert.equal(address, "203.0.113.9");
});

test("on Azure, changing the forged first entry does not change the address that gets counted", () => {
  const first = resolveClientAddress({ headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.9:1" }, socketAddress: "10.0.0.4", env: onAzure });
  const second = resolveClientAddress({ headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3, 203.0.113.9:2" }, socketAddress: "10.0.0.4", env: onAzure });
  assert.equal(first, second);
});

test("on Azure, a single appended entry is used as is, and a missing port is fine", () => {
  assert.equal(resolveClientAddress({ headers: { "x-forwarded-for": "203.0.113.9:443" }, socketAddress: "10.0.0.4", env: onAzure }), "203.0.113.9");
  assert.equal(resolveClientAddress({ headers: { "x-forwarded-for": "203.0.113.9" }, socketAddress: "10.0.0.4", env: onAzure }), "203.0.113.9");
});

test("IPv6 callers are counted by their /64 network: a changing port or a rotating host part cannot dodge the lockout", () => {
  const key = (entry) => resolveClientAddress({ headers: { "x-forwarded-for": entry }, socketAddress: "10.0.0.4", env: onAzure });
  const sameNetwork = [
    "[2001:db8:1:2::1]:51234",
    "[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:60000",
    "2001:db8:1:2::9",
    "2001:db8:1:2::1:51234", // unbracketed with a port: the port cannot be told apart from the address
    "2001:DB8:1:2:0:0:0:7",
  ];
  for (const entry of sameNetwork) assert.equal(key(entry), "2001:db8:1:2", entry);
  assert.notEqual(key("[2001:db8:1:3::1]:1"), key("[2001:db8:1:2::1]:1"));
});

test("a spoofed first entry still cannot change an IPv6 caller's key", () => {
  const a = resolveClientAddress({ headers: { "x-forwarded-for": "9.9.9.9, [2001:db8:1:2::1]:1" }, env: onAzure });
  const b = resolveClientAddress({ headers: { "x-forwarded-for": "8.8.8.8, 7.7.7.7, [2001:db8:1:2::1]:2" }, env: onAzure });
  assert.equal(a, b);
});

test("off Azure, X-Forwarded-For is ignored completely and the connection address is used", () => {
  const address = resolveClientAddress({
    headers: { "x-forwarded-for": "6.6.6.6" },
    socketAddress: "192.168.0.50",
    env: notOnAzure,
  });
  assert.equal(address, "192.168.0.50");
});

test("on Azure with no usable header, it falls back to the connection address", () => {
  assert.equal(resolveClientAddress({ headers: {}, socketAddress: "10.0.0.4", env: onAzure }), "10.0.0.4");
  assert.equal(resolveClientAddress({ headers: { "x-forwarded-for": "   " }, socketAddress: "10.0.0.4", env: onAzure }), "10.0.0.4");
  assert.equal(resolveClientAddress({ headers: { "x-forwarded-for": ["6.6.6.6"] }, socketAddress: "10.0.0.4", env: onAzure }), "10.0.0.4");
});

test("with nothing at all it returns a stable placeholder instead of throwing", () => {
  assert.equal(resolveClientAddress({ headers: {}, env: notOnAzure }), "unknown");
  assert.equal(resolveClientAddress({}), "unknown");
});
