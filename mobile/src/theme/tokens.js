// Visual design values for the 揪飲 JOIN brand palette (blue + orange, from the logo proposal; replaces the
// purple-aqua direction of 2026-09-24). Rules and rationale: docs/ui-style-guide.md. This file only holds values.
// Keep it free of imports: mobile/tests load it by reading the source and importing it as a
// data URL (mobile/ is not an ES-module package).

export const colors = {
  page: "#FFFFFF", // page and card background
  recess: "#EAF4FF", // sunken areas: pearl tray, unselected chips, avatars, secondary panels ("soft blue")
  text: "#172554", // primary text, filled pearls, pickup-code panel ("deep navy")
  textSecondary: "#4A5F8A", // secondary text ("slate blue"); only on page or recess
  accent: "#2563EB", // solid fill of tappable things (text: onAccent) and 2px drawn outlines ("brand blue")
  accentInk: "#1D4ED8", // links and the text of selected labels
  onAccent: "#FFFFFF", // text on an accent fill
  onDark: "#EAF4FF", // text on the panel filled with `text` (the pickup code)
  lineDecor: "#BFDBFE", // decorative card outline on customer screens ("light blue"); carries no meaning
  lineRow: "#D6E2F3", // 1px divider between list rows; carries no meaning
  lineInput: "#6F86B0", // outline of an unselected input (must reach 3:1 on `page`)
  heroPlate: "#FFFFFF" // plate behind the login logo: same as `page` here, a pale card in dark mode
};

// Status pill colours. Meaning is never carried by colour alone: every tone also has a `mark`
// drawn inside the pill, and the pill always shows its label text.
export const tones = {
  info: { bg: "#CFE3FF", fg: "#172554", mark: "dots" }, // in progress / recruiting / ordered, not charged yet
  success: { bg: "#D2EFB8", fg: "#1F4A12", mark: "check" }, // done, locked, paid
  warning: { bg: "#FFEBB0", fg: "#6B4200", mark: "bang" }, // needs attention
  danger: { bg: "#FBD5DE", fg: "#9E1F3A", mark: "cross" }, // failed, rejected, overdue
  neutral: { bg: "#E4E8EE", fg: "#3F4855", mark: "dash" }, // finished, cancelled, not applicable
  estimate: { bg: "#E4D6F6", fg: "#4B2A7A", mark: "dots" } // a discount that can still change
};

// Dark theme (2026-09-25). Same keys and roles as `colors` / `tones` above, so a screen never has to know
// which theme is active: page is a near-black navy, text a pale blue-white, accent (buttons and drawn
// lines) flips to a light blue with dark text on it, and the pickup-code panel becomes a light panel with dark
// digits (`onDark` is the digit colour on the `text`-filled panel).
export const darkColors = {
  page: "#0B1220",
  recess: "#13264A",
  text: "#EAF2FF",
  textSecondary: "#A5B8D9",
  accent: "#60A5FA",
  accentInk: "#BFDBFE",
  onAccent: "#0B1220",
  onDark: "#172554",
  lineDecor: "#1E3F7A",
  lineRow: "#1E2C47",
  lineInput: "#6F86AD",
  heroPlate: "#EAF4FF"
};

export const darkTones = {
  info: { bg: "#1E3A8A", fg: "#DBEAFE", mark: "dots" },
  success: { bg: "#25421B", fg: "#D2EFB8", mark: "check" },
  warning: { bg: "#4D3B0C", fg: "#FFEBB0", mark: "bang" },
  danger: { bg: "#552030", fg: "#FBD5DE", mark: "cross" },
  neutral: { bg: "#2D323C", fg: "#E4E8EE", mark: "dash" },
  estimate: { bg: "#37275E", fg: "#E4D6F6", mark: "dots" }
};

// Shades the dark Google Maps style needs that are not UI colours (land, roads, water...). They live here so
// the whole dark palette is in one file; theme/mapStyles.js turns them into the style array.
export const darkMapColors = {
  land: "#0F1A2E",
  labelText: darkColors.textSecondary,
  labelStroke: darkColors.page,
  boundary: "#2A3A5C",
  locality: darkColors.accentInk,
  park: "#12302E",
  parkText: "#6B9B96",
  road: "#1A2742",
  highway: "#2A3A5C",
  highwayText: "#CBD9F2",
  transit: "#1B2A47",
  water: "#0B2536",
  waterText: "#4E7A96"
};

export const radii = { xs: 8, sm: 14, md: 20, lg: 28, pill: 999 };

// Multiples of 4.
export const spacing = { s4: 4, s8: 8, s12: 12, s16: 16, s20: 20, s24: 24, s32: 32 };

export const sizes = {
  stroke: 2, // the only line thickness in the app (merchant list dividers are 1px)
  tap: 44, // minimum height of anything tappable
  buttonHeight: 52,
  buttonRadius: 26
};

// Set as `maxFontSizeMultiplier` on the pickup code, pearl numbers and pill labels so a large
// system font size cannot break their layout.
export const maxFontSizeMultiplier = 1.1;

// Chinese system fonts differ per device; only weights 400 and 700 are reliable steps.
export const typeScale = {
  pearlNumber: { fontSize: 32, lineHeight: 36, fontWeight: "700" },
  amount: { fontSize: 28, lineHeight: 32, fontWeight: "700" }, // order total, amount to pay
  pickupCode: { fontSize: 52, lineHeight: 60, fontWeight: "700" },
  screenTitle: { fontSize: 24, lineHeight: 32, fontWeight: "700" },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: "700" },
  price: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  button: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 23, fontWeight: "400" },
  bodyDense: { fontSize: 14, lineHeight: 20, fontWeight: "400" }, // merchant screens
  label: { fontSize: 12, lineHeight: 16, fontWeight: "700" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "400" }
};
