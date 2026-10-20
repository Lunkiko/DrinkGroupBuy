import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// mobile/ is not an ES-module package, so sources are loaded the way the other tests do it.
async function loadModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { getCategoryLabel } = await loadModule("../src/utils/menuCategory.js");

test("the four seed category slugs are shown with their Chinese names", () => {
  assert.equal(getCategoryLabel("coffee"), "咖啡");
  assert.equal(getCategoryLabel("fruit"), "果茶");
  assert.equal(getCategoryLabel("milk_tea"), "奶茶");
  assert.equal(getCategoryLabel("tea"), "純茶");
});

test("a category a merchant typed in themselves is shown as typed", () => {
  assert.equal(getCategoryLabel("鮮奶茶類"), "鮮奶茶類");
});
