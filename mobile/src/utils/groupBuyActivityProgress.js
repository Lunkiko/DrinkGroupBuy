export function getGroupBuyActivityProgress(groupBuyActivity) {
  const currentCups = Number(groupBuyActivity?.currentCups ?? 0);
  const tierTargets = (groupBuyActivity?.tiers ?? [])
    .map((tier) => Number(tier.cups ?? tier.targetCups))
    .filter((cups) => Number.isFinite(cups) && cups > 0)
    .sort((left, right) => left - right);
  const maximumTarget = Number(groupBuyActivity?.maximumCups ?? tierTargets[tierTargets.length - 1] ?? groupBuyActivity?.targetCups ?? 0);
  const nextTarget = tierTargets.find((cups) => currentCups < cups)
    ?? maximumTarget
    ?? Number(groupBuyActivity?.targetCups ?? 0);
  const reachedTier = [...tierTargets].reverse().find((cups) => currentCups >= cups) ?? null;
  const remainingCups = Math.max(0, nextTarget - currentCups);
  const progressPercent = nextTarget > 0
    ? Math.min(100, Math.round((currentCups / nextTarget) * 100))
    : 0;

  return {
    currentCups,
    nextTarget,
    reachedTier,
    remainingCups,
    progressPercent
  };
}

export function getGroupBuyActivityCapacityInfo(groupBuyActivity) {
  const tierTargets = (groupBuyActivity?.tiers ?? [])
    .map((tier) => Number(tier.cups ?? tier.targetCups))
    .filter((cups) => Number.isFinite(cups) && cups > 0)
    .sort((left, right) => left - right);
  const maximumCups = Number(groupBuyActivity?.maximumCups ?? tierTargets[tierTargets.length - 1] ?? groupBuyActivity?.targetCups ?? 0);
  const currentCups = Number(groupBuyActivity?.currentCups ?? 0);
  const remainingCapacity = Math.max(0, maximumCups - currentCups);

  return {
    currentCups,
    maximumCups,
    remainingCapacity,
    isFull: maximumCups > 0 && currentCups >= maximumCups
  };
}

export function wouldExceedGroupBuyActivityCapacity(groupBuyActivity, additionalCups) {
  const { maximumCups, currentCups } = getGroupBuyActivityCapacityInfo(groupBuyActivity);
  if (!maximumCups) return false;
  return currentCups + Number(additionalCups ?? 0) > maximumCups;
}

// Only reports which tier (if any) the activity currently qualifies for -- unlike the old
// flat-amount model there is no single activity-wide $ figure to estimate here, since a
// percentage discount depends on each order's own item prices. Use getOrderDiscountEstimate
// below for a specific order's own estimated amount.
export function getGroupBuyActivityDiscountInfo(groupBuyActivity) {
  const settlement = groupBuyActivity?.settlement;
  if (settlement) {
    const appliedTier = (groupBuyActivity?.tiers ?? [])
      .find((tier) => tier.id === settlement.appliedTierId) ?? null;
    return {
      currentCups: settlement.authorizedCups,
      currentTierId: settlement.appliedTierId,
      currentTierTargetCups: appliedTier ? Number(appliedTier.cups ?? appliedTier.targetCups) : null,
      currentTierDiscountPercent: settlement.discountPercent ?? 0,
      nextTierTargetCups: null,
      cupsToNextTier: 0,
      isQualified: settlement.outcome === "qualified",
      isEstimated: false
    };
  }

  const currentCups = Math.max(Number(groupBuyActivity?.currentCups ?? 0), 0);
  const tiers = (groupBuyActivity?.tiers ?? [])
    .map((tier) => ({
      id: tier.id ?? null,
      targetCups: Number(tier.cups ?? tier.targetCups),
      discountPercent: Number(tier.discountPercent)
    }))
    .filter((tier) => Number.isInteger(tier.targetCups)
      && tier.targetCups > 0
      && Number.isInteger(tier.discountPercent)
      && tier.discountPercent >= 1
      && tier.discountPercent <= 99)
    .sort((left, right) => left.targetCups - right.targetCups);
  const reachedTiers = tiers.filter((tier) => currentCups >= tier.targetCups);
  const reachedTier = reachedTiers[reachedTiers.length - 1] ?? null;
  const nextTier = tiers.find((tier) => currentCups < tier.targetCups) ?? null;
  const hasCurrentBackendSummary = Number(groupBuyActivity?.discountSummaryAuthorizedCups) === currentCups;

  return {
    currentCups,
    currentTierId: hasCurrentBackendSummary
      ? groupBuyActivity?.currentTierId ?? reachedTier?.id ?? null
      : reachedTier?.id ?? null,
    currentTierTargetCups: hasCurrentBackendSummary
      ? normalizeNullablePositiveInteger(groupBuyActivity?.currentTierTargetCups)
      : reachedTier?.targetCups ?? null,
    currentTierDiscountPercent: hasCurrentBackendSummary
      ? normalizeNonNegativeInteger(groupBuyActivity?.currentTierDiscountPercent)
      : reachedTier?.discountPercent ?? 0,
    nextTierTargetCups: hasCurrentBackendSummary
      ? normalizeNullablePositiveInteger(groupBuyActivity?.nextTierTargetCups)
      : nextTier?.targetCups ?? null,
    cupsToNextTier: hasCurrentBackendSummary
      ? normalizeNonNegativeInteger(groupBuyActivity?.cupsToNextTier)
      : nextTier ? Math.max(nextTier.targetCups - currentCups, 0) : 0,
    isQualified: Boolean(reachedTier),
    isEstimated: ["recruiting", "confirmed"].includes(groupBuyActivity?.status)
  };
}

// Estimates ONE order's own discount from its own original amount, using the currently
// qualified tier's percent-off -- mirrors backend/pricing/groupBuyDiscount.js's
// calculatePercentageDiscount (round the amount the customer pays UP to the nearest dollar) so
// the pre-settlement estimate matches what settlement will actually charge. Returns null when
// the order has no known original amount.
export function getOrderDiscountEstimate(groupBuyActivity, order) {
  const originalAmount = normalizeNullableNonNegativeInteger(order?.originalAmount ?? order?.subtotal);
  if (originalAmount == null) return null;

  const discountInfo = getGroupBuyActivityDiscountInfo(groupBuyActivity);
  const discountPercent = discountInfo.isQualified ? discountInfo.currentTierDiscountPercent : 0;
  if (!discountPercent) {
    return { originalAmount, finalAmount: originalAmount, discountAmount: 0 };
  }

  const finalAmount = Math.ceil((originalAmount * (100 - discountPercent)) / 100);
  return { originalAmount, finalAmount, discountAmount: originalAmount - finalAmount };
}

export function getFinalSettlementSnapshot(groupBuyActivity, order) {
  const settlement = groupBuyActivity?.settlement;
  if (!settlement) return null;

  const originalAmount = normalizeNullableNonNegativeInteger(
    order?.originalAmount ?? order?.subtotal
  );
  const finalAmount = normalizeNullableNonNegativeInteger(order?.finalAmount);
  const orderDiscountAmount = originalAmount == null || finalAmount == null
    ? null
    : Math.max(originalAmount - finalAmount, 0);

  return {
    hasOrder: Boolean(order),
    outcome: settlement.outcome,
    outcomeLabel: getSettlementOutcomeLabel(settlement.outcome),
    authorizedCups: normalizeNonNegativeInteger(settlement.authorizedCups),
    discountPercent: settlement.discountPercent ?? null,
    originalAmount,
    finalAmount,
    orderDiscountAmount,
    settledAt: settlement.settledAt ?? null
  };
}

function getSettlementOutcomeLabel(outcome) {
  if (outcome === "qualified") return "已達優惠門檻";
  if (outcome === "failed") return "未達優惠門檻";
  if (outcome === "cancelled") return "團購已取消";
  return "已完成結算";
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function normalizeNullablePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeNullableNonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

export function findTierByCups(groupBuyActivity, cups) {
  return (groupBuyActivity?.tiers ?? []).find((tier) => Number(tier.cups ?? tier.targetCups) === Number(cups)) ?? null;
}

// "已成團" (confirmed) still takes orders until the deadline, so "open" is not just status === recruiting.
export function isGroupBuyActivityOpen(groupBuyActivity) {
  return ["recruiting", "confirmed"].includes(groupBuyActivity?.status) && groupBuyActivity?.canJoin !== false;
}
