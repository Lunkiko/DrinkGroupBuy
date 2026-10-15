"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { describeTarget } = require("./databaseTarget");

test("a URL naming this computer is local, whichever way it is written", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const target = describeTarget(`postgres://user:pw@${host}:5432/drink_group_buy`);
    assert.equal(target.isLocal, true, host);
    assert.equal(target.database, "drink_group_buy");
  }
});

test("any other host is remote", () => {
  const target = describeTarget("postgres://user:pw@drinkgroupbuy.postgres.database.azure.com:5432/postgres?sslmode=require");
  assert.equal(target.isLocal, false);
  assert.equal(target.host, "drinkgroupbuy.postgres.database.azure.com");
});

test("a local-looking URL whose query string redirects the connection is treated as remote", () => {
  for (const query of ["host=db.example.com", "hostaddr=10.0.0.5"]) {
    const target = describeTarget(`postgres://user:pw@localhost:5432/app?${query}`);
    assert.equal(target.isLocal, false, query);
    assert.match(target.host, /連線參數改指定了其他主機/);
  }
});

test("a host that merely contains the word localhost is not local", () => {
  assert.equal(describeTarget("postgres://u:p@localhost.example.com:5432/app").isLocal, false);
  assert.equal(describeTarget("postgres://u:p@notlocalhost:5432/app").isLocal, false);
});

test("a URL that is not a URL throws instead of guessing", () => {
  assert.throws(() => describeTarget("not a url"));
});
