import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// mobile/ is not an ES-module package, so sources are loaded the way the other tests do it.
async function loadModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { colors, tones, darkColors, darkTones, typeScale } = await loadModule("../src/theme/tokens.js");
const { getStatusTone, statusToneByKey } = await loadModule("../src/theme/statusTones.js");
const labels = await loadModule("../src/types/prototypeTypes.js");

// WCAG 2.x contrast ratio.
function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// CIE76 colour difference: how far apart two colours look.
function toLab(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(channel);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function colorDistance(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const PALETTES = [
  ["light", colors, tones],
  ["dark", darkColors, darkTones]
];

function textPairs(c, t) {
  return [
    ["text on page", c.text, c.page],
    ["text on recess", c.text, c.recess],
    ["secondary text on page", c.textSecondary, c.page],
    ["secondary text on recess", c.textSecondary, c.recess],
    ["accent ink on page", c.accentInk, c.page],
    ["accent ink on recess", c.accentInk, c.recess],
    ["label on accent fill", c.onAccent, c.accent],
    ["pickup code on its panel", c.onDark, c.text],
    ...Object.entries(t).map(([name, tone]) => [`${name} tone text`, tone.fg, tone.bg])
  ];
}

function outlinePairs(c) {
  return [
    ["accent outline on page", c.accent, c.page],
    ["accent outline on recess", c.accent, c.recess],
    ["input outline on page", c.lineInput, c.page]
  ];
}

test("dark palette has exactly the same keys as the light one", () => {
  assert.deepEqual(Object.keys(darkColors).sort(), Object.keys(colors).sort());
  assert.deepEqual(Object.keys(darkTones).sort(), Object.keys(tones).sort());
  for (const [name, tone] of Object.entries(darkTones)) {
    assert.equal(tone.mark, tones[name].mark, `${name} keeps the same mark in both themes`);
  }
});

test("every text colour pair meets WCAG AA (4.5:1) in both themes", () => {
  for (const [theme, c, t] of PALETTES) {
    for (const [name, foreground, background] of textPairs(c, t)) {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${theme}: ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("outlines that carry meaning reach 3:1 against the surface they sit on, in both themes", () => {
  for (const [theme, c] of PALETTES) {
    for (const [name, line, surface] of outlinePairs(c)) {
      const ratio = contrast(line, surface);
      assert.ok(ratio >= 3, `${theme}: ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("status tone backgrounds look clearly different from each other, in both themes", () => {
  for (const [theme, , t] of PALETTES) {
    const names = Object.keys(t);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const distance = colorDistance(t[names[i]].bg, t[names[j]].bg);
        assert.ok(distance >= 8, `${theme}: ${names[i]} ~ ${names[j]}: ${distance.toFixed(1)}`);
      }
    }
  }
});

test("all colours are 6-digit hex (the contrast helpers above rely on it)", () => {
  const values = PALETTES.flatMap(([, c, t]) => [...Object.values(c), ...Object.values(t).flatMap((tone) => [tone.bg, tone.fg])]);
  for (const value of values) {
    assert.match(value, /^#[0-9A-F]{6}$/);
  }
});

test("type scale uses only regular and bold and stays readable", () => {
  for (const [name, style] of Object.entries(typeScale)) {
    assert.ok(["400", "700"].includes(style.fontWeight), `${name}: weight ${style.fontWeight}`);
    assert.ok(style.fontSize >= 12, `${name}: fontSize ${style.fontSize}`);
    assert.ok(style.lineHeight >= style.fontSize, `${name}: lineHeight ${style.lineHeight}`);
  }
});

const LABEL_MAPS = {
  groupBuyActivity: labels.groupBuyActivityStatusLabels,
  payment: labels.paymentStatusLabels,
  merchantPayment: labels.merchantPaymentStatusLabels,
  pickup: labels.pickupStatusLabels,
  refundRequest: labels.refundRequestStatusLabels,
  refundMark: labels.refundMarkStatusLabels,
  discount: labels.discountStatusLabels
};

test("every status label in prototypeTypes has an existing tone", () => {
  for (const [owner, labelMap] of Object.entries(LABEL_MAPS)) {
    for (const value of Object.keys(labelMap)) {
      const tone = getStatusTone(owner, value);
      assert.ok(Object.hasOwn(tones, tone), `${owner}.${value} -> ${tone}`);
    }
  }
});

test("statusToneByKey has no entry for a status that no longer exists", () => {
  for (const [key, tone] of Object.entries(statusToneByKey)) {
    const [owner, value] = key.split(".");
    assert.ok(Object.hasOwn(LABEL_MAPS[owner] ?? {}, value), `${key} is not in prototypeTypes`);
    assert.ok(Object.hasOwn(tones, tone), `${key} -> unknown tone ${tone}`);
  }
});

test("an authorized (not charged yet) payment never looks like a captured (paid) one", () => {
  assert.notEqual(getStatusTone("payment", "authorized"), getStatusTone("payment", "captured"));
});

test("merchant payment follows the payment tone except for its two overrides", () => {
  assert.equal(getStatusTone("merchantPayment", "captured"), getStatusTone("payment", "captured"));
  assert.equal(getStatusTone("merchantPayment", "authorized"), "success");
  assert.equal(getStatusTone("merchantPayment", "failed"), "neutral");
  assert.equal(getStatusTone("payment", "failed"), "danger");
});

test("getStatusTone returns null for a status nobody mapped", () => {
  assert.equal(getStatusTone("payment", "no_such_status"), null);
  assert.equal(getStatusTone("noSuchOwner", "recruiting"), null);
});
