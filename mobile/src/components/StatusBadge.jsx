import { getStatusTone } from "../theme/statusTones";
import {
  groupBuyActivityStatusLabels,
  merchantPaymentStatusLabels,
  paymentStatusLabels,
  pickupStatusLabels,
  refundMarkStatusLabels,
  refundRequestStatusLabels
} from "../types/prototypeTypes";
import { TonePill } from "./TonePill";

// A status label drawn as a tone pill (tone colour plus a drawn mark, see theme/statusTones.js).
export function StatusBadge({ owner = "groupBuyActivity", value }) {
  const fallbackLabels = {
    ordering: "訂單製作中"
  };
  const labelMaps = {
    groupBuyActivity: groupBuyActivityStatusLabels,
    merchantPayment: merchantPaymentStatusLabels,
    payment: paymentStatusLabels,
    pickup: pickupStatusLabels,
    refundRequest: refundRequestStatusLabels,
    refundMark: refundMarkStatusLabels
  };
  const label = labelMaps[owner]?.[value] ?? fallbackLabels[value] ?? value;
  return <TonePill tone={getStatusTone(owner, value) ?? "neutral"} label={label} />;
}
