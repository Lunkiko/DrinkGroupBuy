import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// mobile/ is not an ES-module package, so sources are loaded the way the other tests do it.
async function loadModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { formatShortDateTime, formatShortTimeRange } = await loadModule("../src/utils/shortDateTime.js");
const { formatDealFactorLabelWithSpace } = await loadModule("../src/utils/discountPercentFormat.js");

// Built from local-time parts so the expectations hold in any time zone the tests run in.
const local = (month, day, hour, minute) => new Date(2026, month - 1, day, hour, minute).toISOString();

test("a date-time is month/day without leading zeros and a zero-padded 24h clock", () => {
  assert.equal(formatShortDateTime(local(10, 6, 8, 5)), "10/6 08:05");
  assert.equal(formatShortDateTime(local(1, 16, 18, 47)), "1/16 18:47");
});

test("a time range on one day shows the date once", () => {
  assert.equal(formatShortTimeRange(local(10, 16, 18, 47), local(10, 16, 21, 47)), "10/16 18:47 - 21:47");
});

test("a time range that crosses midnight carries the end date", () => {
  assert.equal(formatShortTimeRange(local(10, 16, 22, 30), local(10, 17, 1, 30)), "10/16 22:30 - 10/17 01:30");
});

test("an unusable date gives an empty string so callers can fall back to their own label", () => {
  assert.equal(formatShortDateTime(undefined), "");
  assert.equal(formatShortDateTime("not a date"), "");
  assert.equal(formatShortTimeRange(local(10, 16, 18, 47), null), "");
});

test("the deal-factor label puts a space before 折 and keeps one decimal", () => {
  assert.equal(formatDealFactorLabelWithSpace(10), "9 折");
  assert.equal(formatDealFactorLabelWithSpace(15), "8.5 折");
  assert.equal(formatDealFactorLabelWithSpace(0), "—");
  assert.equal(formatDealFactorLabelWithSpace(100), "—");
});
