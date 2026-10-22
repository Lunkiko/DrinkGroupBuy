// Which tone (see `tones` in tokens.js) each status label uses. Keys are "<owner>.<value>", where
// owner is the label map in src/types/prototypeTypes.js the status comes from.
export const statusToneByKey = {
  "groupBuyActivity.recruiting": "info",
  "groupBuyActivity.confirmed": "success",
  "groupBuyActivity.formed": "success",
  "groupBuyActivity.ordering": "info",
  "groupBuyActivity.ready_for_pickup": "success",
  "groupBuyActivity.completed": "neutral",
  "groupBuyActivity.failed": "danger",
  "groupBuyActivity.cancelled": "neutral",
  "groupBuyActivity.full": "warning",

  // "authorized" (order placed, not charged yet) must never look like "captured" (paid).
  "payment.pending": "warning",
  "payment.submitted": "info",
  "payment.confirmed": "success",
  "payment.not_required": "neutral",
  "payment.authorized": "info",
  "payment.captured": "success",
  "payment.authorization_voided": "neutral",
  "payment.released": "neutral",
  "payment.failed": "danger",
  "payment.refunded": "neutral",

  // The merchant sees authorized as "paid" and failed as "pending payment" (see prototypeTypes.js).
  "merchantPayment.authorized": "success",
  "merchantPayment.failed": "neutral",

  "pickup.not_ready": "neutral",
  "pickup.preparing": "info",
  "pickup.ready": "success",
  "pickup.picked_up": "neutral",
  "pickup.cancelled": "neutral",
  "pickup.expired": "danger",

  "refundRequest.pending": "warning",
  "refundRequest.approved": "success",
  "refundRequest.rejected": "danger",

  "refundMark.active": "success",
  "refundMark.revoked": "neutral",

  "discount.not_yet_qualified": "estimate",
  "discount.qualified": "success",
  "discount.failed": "danger"
};

// Returns a tone name from tokens.js, or null for a status nobody mapped. The caller picks the
// look for null (StatusBadge today shows unknown values in its neutral grey).
// merchantPaymentStatusLabels spreads paymentStatusLabels and overrides only authorized/failed,
// so every other merchantPayment value shares the payment tone.
export function getStatusTone(owner, value) {
  const direct = statusToneByKey[`${owner}.${value}`];
  if (direct) return direct;
  if (owner !== "merchantPayment") return null;
  return statusToneByKey[`payment.${value}`] ?? null;
}
