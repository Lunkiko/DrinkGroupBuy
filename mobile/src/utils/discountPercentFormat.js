// Only place that converts between the merchant-facing "打幾折" input (e.g. "7", "7.9") and the
// backend's discountPercent (integer percent OFF, 1-99). "折" is a base-10-percent unit (7折 =
// pay 70%), so one decimal place of 折 precision (7.9折 = pay 79%) always lands on a whole
// percent -- discountPercent = 100 - dealFactor*10 is always an integer when dealFactor has at
// most one decimal digit.
export function parseDealFactorToDiscountPercent(rawInput) {
  const text = String(rawInput ?? "").trim();
  if (text === "") return null;
  if (!/^\d+(\.\d)?$/.test(text)) return null;

  const dealFactor = Number(text);
  const discountPercent = Math.round(100 - dealFactor * 10);
  if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 99) {
    return null;
  }
  return discountPercent;
}

export function formatDiscountPercentAsDealFactor(discountPercent) {
  const percent = Number(discountPercent);
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) return null;

  const dealFactor = (100 - percent) / 10;
  return Number.isInteger(dealFactor) ? String(dealFactor) : dealFactor.toFixed(1);
}

export function formatDealFactorLabel(discountPercent) {
  const dealFactor = formatDiscountPercentAsDealFactor(discountPercent);
  return dealFactor == null ? "" : `${dealFactor}折`;
}

// "9折" -> "9 折", "8.5折" -> "8.5 折": the blueprint puts a space before 折. Falls back to a dash.
export function formatDealFactorLabelWithSpace(discountPercent) {
  const label = formatDealFactorLabel(discountPercent);
  return label ? label.replace(/折$/, " 折") : "—";
}
