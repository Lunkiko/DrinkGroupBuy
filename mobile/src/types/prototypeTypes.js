// Frontend/mobile prototype shapes only, not final API contract.

export const groupBuyActivityStatusLabels = {
  recruiting: "招募中",
  confirmed: "已成團",
  formed: "已成團",
  ordering: "訂單製作中",
  ready_for_pickup: "可取餐",
  completed: "已完成",
  failed: "流團",
  cancelled: "已取消",
  full: "已額滿"
};

export const paymentStatusLabels = {
  pending: "待付款",
  submitted: "付款回報已送出（舊流程）",
  confirmed: "付款已確認（舊流程）",
  not_required: "無需付款",
  authorized: "訂單成立",
  captured: "已付款",
  authorization_voided: "授權已取消",
  released: "已釋放授權",
  failed: "扣款失敗",
  refunded: "已退款"
};

export const merchantPaymentStatusLabels = {
  ...paymentStatusLabels,
  authorized: "已付款",
  failed: "待付款"
};

export const discountStatusLabels = {
  not_yet_qualified: "尚未達標",
  qualified: "優惠成立",
  failed: "未達標"
};

export const pickupStatusLabels = {
  not_ready: "尚未可取貨",
  preparing: "訂單製作中",
  ready: "可取貨",
  picked_up: "已取貨",
  cancelled: "已取消",
  expired: "已逾期"
};

export const refundRequestStatusLabels = {
  pending: "待審核",
  approved: "已退款",
  rejected: "未退款"
};
