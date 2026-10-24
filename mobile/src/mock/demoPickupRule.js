// Display-only copy. The live payment flow always loads its versioned rule from the backend.
export const demoPickupRule = {
  ruleType: "pickup_overdue",
  ruleVersion: "demo",
  title: "取餐與逾期未取規則（展示資料）",
  content: [
    "請依訂單明細顯示的取餐時間到店並出示取餐碼。取餐代碼自取餐開始時間起保留 3 小時；若店家當日營業結束早於 3 小時，則保留至當日營業結束。",
    "逾期未取不會自動退款。逾期後若飲品仍在且店家判斷可安全交付，顧客可憑歷史訂單與店家協調領取；若因品質、衛生、保存時間或條件不適合交付，店家可以不再提供原飲品，且不得交付有食品安全疑慮的飲品。",
    "若因店家保存不當、製作錯誤或其他可歸責於店家的原因無法交付，不得視為顧客逾期未取，應另依退款、重做或補償流程處理。顧客在有效取餐期間內到店而店家無法交付時，也不得標記為逾期未取。"
  ].join("\n")
};
