import { darkMapColors as c } from "./tokens";

// Hides Google's own business icons and names (restaurants, shops...) so the map only shows this app's
// stores. Lives in the style arrays because that is the one place both maps read: the native map's
// `showsPointsOfInterest` prop does nothing on Android, so before this rule the phone showed those icons
// while the web preview hid them. Keep it LAST in each array so it also wins over the dark poi colour rules.
const HIDE_POI_LABELS = { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] };

// Google Maps night style, tinted to the app's dark palette (values in tokens.js `darkMapColors`). The same
// array works for react-native-maps (`customMapStyle`) and the Maps JavaScript API (`styles`).
export const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: c.land }] },
  { elementType: "labels.text.fill", stylers: [{ color: c.labelText }] },
  { elementType: "labels.text.stroke", stylers: [{ color: c.labelStroke }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: c.boundary }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: c.locality }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: c.labelText }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: c.park }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: c.parkText }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: c.road }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: c.labelStroke }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: c.labelText }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: c.highway }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: c.land }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: c.highwayText }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: c.transit }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: c.labelText }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: c.water }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: c.waterText }] },
  HIDE_POI_LABELS
];

// The default (light) map: Google's standard look plus the POI rule above, kept as one constant so the map
// is not handed a new array on every render.
export const LIGHT_MAP_STYLE = [HIDE_POI_LABELS];
