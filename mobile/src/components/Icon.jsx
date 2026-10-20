import { Image, View } from "react-native";
import { useTheme } from "../theme/ThemeContext";

// The bottom-nav icons are the designer's own artwork: shape-only PNGs (black with an alpha channel) cut
// out of the blueprint and recoloured with `tintColor`, so one file serves light, dark, selected and not.
// Only home and the map pin have a solid version in the blueprint.
const IMAGE_ICONS = {
  home: { outline: require("../../assets/icons/nav-home.png"), filled: require("../../assets/icons/nav-home-filled.png") },
  pin: { outline: require("../../assets/icons/nav-pin.png"), filled: require("../../assets/icons/nav-pin-filled.png") },
  orders: { outline: require("../../assets/icons/nav-orders.png") },
  profile: { outline: require("../../assets/icons/nav-profile.png") }
};

// Line icons drawn from plain Views (no icon font or SVG package, so no native rebuild): the
// clock / check / chevrons, the detail-page glyphs, and the two empty-state pictures. Everything is laid out
// on a 24-unit grid scaled to `size`. `filled` gives the solid version (used by the selected home tab);
// `cutout` is the colour of whatever the icon sits on, used for the holes of a filled glyph.
export function Icon({ name, size = 24, color, filled = false, cutout }) {
  const { colors } = useTheme();
  const tint = color ?? colors.textSecondary;
  const hole = cutout ?? colors.page;
  const u = size / 24;
  const stroke = Math.max(1.5, 2 * u);
  const picture = IMAGE_ICONS[name];
  const glyph = GLYPHS[name];

  if (picture) {
    return (
      <Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        resizeMode="contain"
        source={filled && picture.filled ? picture.filled : picture.outline}
        style={{ width: size, height: size, tintColor: tint }}
      />
    );
  }

  return (
    <View importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      {glyph ? glyph({ u, tint, hole, stroke, filled }) : null}
    </View>
  );
}

// Absolutely placed box on the 24-unit grid.
const at = (u, left, top, width, height, style) => ({
  position: "absolute",
  left: left * u,
  top: top * u,
  width: width * u,
  height: height * u,
  ...style
});

const GLYPHS = {
  home: ({ u, tint, hole, stroke, filled }) => (filled ? (
    <>
      <View
        style={{
          position: "absolute",
          left: 2 * u,
          top: 2.5 * u,
          width: 0,
          height: 0,
          borderLeftWidth: 10 * u,
          borderRightWidth: 10 * u,
          borderBottomWidth: 9 * u,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderBottomColor: tint
        }}
      />
      <View style={at(u, 5, 10.5, 14, 10.5, { backgroundColor: tint, borderBottomLeftRadius: 3 * u, borderBottomRightRadius: 3 * u })} />
      <View style={at(u, 10, 15, 4, 5.5, { backgroundColor: hole, borderTopLeftRadius: 2 * u, borderTopRightRadius: 2 * u })} />
    </>
  ) : (
    <>
      <View
        style={at(u, 5.4, 5.4, 13.2, 13.2, {
          borderLeftWidth: stroke,
          borderTopWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 2 * u,
          transform: [{ rotate: "45deg" }]
        })}
      />
      <View
        style={at(u, 5, 12, 14, 9, {
          borderLeftWidth: stroke,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: tint,
          borderBottomLeftRadius: 3 * u,
          borderBottomRightRadius: 3 * u
        })}
      />
    </>
  )),

  pin: ({ u, tint, hole, stroke, filled }) => (
    <View
      style={at(u, 5, 3.2, 14, 14, {
        alignItems: "center",
        justifyContent: "center",
        borderWidth: stroke,
        borderColor: tint,
        backgroundColor: filled ? tint : "transparent",
        borderTopLeftRadius: 7 * u,
        borderTopRightRadius: 7 * u,
        borderBottomLeftRadius: 7 * u,
        borderBottomRightRadius: 0,
        transform: [{ rotate: "45deg" }]
      })}
    >
      <View
        style={{
          width: 5.5 * u,
          height: 5.5 * u,
          borderRadius: 3 * u,
          borderWidth: stroke,
          borderColor: filled ? hole : tint
        }}
      />
    </View>
  ),

  orders: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 4.5, 2.5, 15, 19, { borderWidth: stroke, borderColor: tint, borderRadius: 3 * u })} />
      <View style={at(u, 8, 8.5, 8, stroke / u, { backgroundColor: tint, borderRadius: u })} />
      <View style={at(u, 8, 12.5, 8, stroke / u, { backgroundColor: tint, borderRadius: u })} />
      <View style={at(u, 8, 16.5, 5, stroke / u, { backgroundColor: tint, borderRadius: u })} />
    </>
  ),

  profile: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 8, 2.5, 8, 8, { borderWidth: stroke, borderColor: tint, borderRadius: 4 * u })} />
      <View
        style={at(u, 4, 14, 16, 7.5, {
          borderWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 8 * u,
          borderTopRightRadius: 8 * u,
          borderBottomLeftRadius: 2 * u,
          borderBottomRightRadius: 2 * u
        })}
      />
    </>
  ),

  bag: ({ u, tint, stroke }) => (
    <>
      <View
        style={at(u, 7.5, 2.5, 9, 9, {
          borderLeftWidth: stroke,
          borderRightWidth: stroke,
          borderTopWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 4.5 * u,
          borderTopRightRadius: 4.5 * u
        })}
      />
      <View style={at(u, 3.5, 9, 17, 12.5, { borderWidth: stroke, borderColor: tint, borderRadius: 3.5 * u })} />
    </>
  ),

  store: ({ u, tint, stroke }) => (
    <>
      <View
        style={at(u, 3, 4.5, 18, 6.5, {
          borderWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 3 * u,
          borderTopRightRadius: 3 * u,
          borderBottomLeftRadius: 2 * u,
          borderBottomRightRadius: 2 * u
        })}
      />
      <View
        style={at(u, 5, 10.5, 14, 10.5, {
          borderLeftWidth: stroke,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: tint,
          borderBottomLeftRadius: 2 * u,
          borderBottomRightRadius: 2 * u
        })}
      />
      <View
        style={at(u, 10, 14.5, 4, 6.5, {
          borderLeftWidth: stroke,
          borderRightWidth: stroke,
          borderTopWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 2 * u,
          borderTopRightRadius: 2 * u
        })}
      />
    </>
  ),

  phone: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 6.5, 2.5, 11, 19, { borderWidth: stroke, borderColor: tint, borderRadius: 3 * u })} />
      <View style={at(u, 10.5, 17.5, 3, stroke / u, { backgroundColor: tint, borderRadius: u })} />
    </>
  ),

  calendar: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 3.5, 5, 17, 16, { borderWidth: stroke, borderColor: tint, borderRadius: 3 * u })} />
      <View style={at(u, 3.5, 9.5, 17, stroke / u, { backgroundColor: tint })} />
      <View style={at(u, 8, 2.5, stroke / u, 4.5, { backgroundColor: tint, borderRadius: u })} />
      <View style={at(u, 16 - stroke / u, 2.5, stroke / u, 4.5, { backgroundColor: tint, borderRadius: u })} />
      <View style={at(u, 7.3, 13, 2.4, 2.4, { backgroundColor: tint, borderRadius: 0.6 * u })} />
      <View style={at(u, 10.8, 13, 2.4, 2.4, { backgroundColor: tint, borderRadius: 0.6 * u })} />
      <View style={at(u, 14.3, 13, 2.4, 2.4, { backgroundColor: tint, borderRadius: 0.6 * u })} />
      <View style={at(u, 7.3, 16.6, 2.4, 2.4, { backgroundColor: tint, borderRadius: 0.6 * u })} />
      <View style={at(u, 10.8, 16.6, 2.4, 2.4, { backgroundColor: tint, borderRadius: 0.6 * u })} />
    </>
  ),

  tag: ({ u, tint, stroke }) => (
    <>
      <View
        style={at(u, 5.5, 5.5, 13, 13, {
          borderWidth: stroke,
          borderColor: tint,
          borderRadius: 3 * u,
          transform: [{ rotate: "45deg" }]
        })}
      />
      <View style={at(u, 8.2, 8.2, 3.4, 3.4, { borderWidth: stroke * 0.8, borderColor: tint, borderRadius: 2 * u })} />
    </>
  ),

  shield: ({ u, tint, stroke }) => (
    <>
      <View
        style={at(u, 4.5, 2.5, 15, 18, {
          borderWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 3 * u,
          borderTopRightRadius: 3 * u,
          borderBottomLeftRadius: 8 * u,
          borderBottomRightRadius: 8 * u
        })}
      />
      <View
        style={at(u, 8.3, 8, 7.4, 4.4, {
          borderLeftWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: tint,
          transform: [{ rotate: "-45deg" }]
        })}
      />
    </>
  ),

  // A picture frame with a sun and two hills: the placeholder for a drink photo or store logo.
  image: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 3.5, 4.5, 17, 15, { borderWidth: stroke, borderColor: tint, borderRadius: 3 * u })} />
      <View style={at(u, 14.5, 7.8, 3, 3, { backgroundColor: tint, borderRadius: 1.5 * u })} />
      <View style={at(u, 5.6, 12.6, 6.4, stroke / u, { backgroundColor: tint, borderRadius: u, transform: [{ rotate: "-40deg" }] })} />
      <View style={at(u, 9.4, 12.6, 6.4, stroke / u, { backgroundColor: tint, borderRadius: u, transform: [{ rotate: "40deg" }] })} />
    </>
  ),

  // A filled disc with a lowercase "i": `cutout` is the colour of the dot and bar.
  info: ({ u, tint, hole }) => (
    <>
      <View style={at(u, 2.5, 2.5, 19, 19, { backgroundColor: tint, borderRadius: 9.5 * u })} />
      <View style={at(u, 10.7, 6.4, 2.6, 2.6, { backgroundColor: hole, borderRadius: 1.3 * u })} />
      <View style={at(u, 10.7, 10.4, 2.6, 7, { backgroundColor: hole, borderRadius: 1.3 * u })} />
    </>
  ),

  people: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 5.5, 4.5, 7, 7, { borderWidth: stroke, borderColor: tint, borderRadius: 3.5 * u })} />
      <View
        style={at(u, 2.5, 13.5, 13, 7, {
          borderWidth: stroke,
          borderColor: tint,
          borderTopLeftRadius: 6.5 * u,
          borderTopRightRadius: 6.5 * u,
          borderBottomLeftRadius: 2 * u,
          borderBottomRightRadius: 2 * u
        })}
      />
      <View style={at(u, 14, 4.5, 5.5, 5.5, { borderWidth: stroke, borderColor: tint, borderRadius: 2.75 * u })} />
      <View
        style={at(u, 15.5, 12, 6, 6, {
          borderTopWidth: stroke,
          borderRightWidth: stroke,
          borderColor: tint,
          borderTopRightRadius: 5 * u
        })}
      />
    </>
  ),

  // Proportions measured off the blueprint's countdown clock: the ring fills the whole icon box and the
  // single hand is a thick "L" (up from the centre, then right), as thick as the ring.
  clock: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 0, 0, 24, 24, { borderWidth: stroke, borderColor: tint, borderRadius: 12 * u })} />
      <View style={at(u, 10.8, 6.3, 2.4, 8.5, { backgroundColor: tint })} />
      <View style={at(u, 10.8, 12.4, 6.9, 2.4, { backgroundColor: tint })} />
    </>
  ),

  check: ({ u, tint, stroke }) => (
    <View
      style={at(u, 5.5, 6, 13, 8, {
        borderLeftWidth: stroke * 1.5,
        borderBottomWidth: stroke * 1.5,
        borderColor: tint,
        transform: [{ rotate: "-45deg" }]
      })}
    />
  ),

  chevronRight: ({ u, tint, stroke }) => (
    <View
      style={at(u, 6.5, 8, 8, 8, {
        borderTopWidth: stroke,
        borderRightWidth: stroke,
        borderColor: tint,
        transform: [{ rotate: "45deg" }]
      })}
    />
  ),

  chevronDown: ({ u, tint, stroke }) => (
    <View
      style={at(u, 8, 5.5, 8, 8, {
        borderRightWidth: stroke,
        borderBottomWidth: stroke,
        borderColor: tint,
        transform: [{ rotate: "45deg" }]
      })}
    />
  ),

  chevronUp: ({ u, tint, stroke }) => (
    <View
      style={at(u, 8, 10.5, 8, 8, {
        borderLeftWidth: stroke,
        borderTopWidth: stroke,
        borderColor: tint,
        transform: [{ rotate: "45deg" }]
      })}
    />
  )
};
