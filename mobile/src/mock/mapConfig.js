// prototype only, not final API contract

export const mapCenter = {
  id: "nutc-sanmin-campus",
  name: "國立臺中科技大學 三民校區",
  address: "台中市北區三民路三段 129 號",
  latitude: 24.14972,
  longitude: 120.68393
};

export const mapDefaults = {
  zoom: 16
};

// How long the camera must stay still before the store-name labels come back after a pan or zoom. Both map
// screens (phone and web preview) hide the labels while the map moves and use this as the "settled" delay.
export const markerLabelSettleMs = 350;
