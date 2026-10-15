import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/utils/apiErrorText.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const { describeApiError } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("the backend's generic server-error code becomes a Traditional Chinese sentence", () => {
  assert.equal(describeApiError("internal_error"), "伺服器發生錯誤，請稍後再試。");
});

test("any other code is returned unchanged so callers can still branch on or map it", () => {
  assert.equal(describeApiError("operation_locked"), "operation_locked");
  assert.equal(describeApiError("Authentication required"), "Authentication required");
});

test("a missing code stays missing, so the caller's own fallback text is used", () => {
  assert.equal(describeApiError(undefined), undefined);
  assert.equal(describeApiError(undefined) ?? "List stores failed", "List stores failed");
});
