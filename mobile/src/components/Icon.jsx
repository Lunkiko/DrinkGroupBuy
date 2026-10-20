import { View } from "react-native";
import { useTheme } from "../theme/ThemeContext";

// Line icons drawn from plain Views (no icon font or SVG package, so no native rebuild): the blueprint's
// bottom-nav icons, the clock / check / chevrons, and the two empty-state pictures. Everything is laid out
// on a 24-unit grid scaled to `size`. `filled` gives the solid version (used by the selected home tab);
// `cutout` is the colour of whatever the icon sits on, used for the holes of a filled glyph.
export function Icon({ name, size = 24, color, filled = false, cutout }) {
  const { colors } = useTheme();
  const tint = color ?? colors.textSecondary;
  const hole = cutout ?? colors.page;
  const u = size / 24;
  const stroke = Math.max(1.5, 2 * u);
  const glyph = GLYPHS[name];

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

  clock: ({ u, tint, stroke }) => (
    <>
      <View style={at(u, 3, 3, 18, 18, { borderWidth: stroke, borderColor: tint, borderRadius: 9 * u })} />
      <View style={at(u, 11.2, 6.5, stroke / u, 6, { backgroundColor: tint, borderRadius: u })} />
      <View style={at(u, 11.2, 11.7, 4.5, stroke / u, { backgroundColor: tint, borderRadius: u })} />
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
