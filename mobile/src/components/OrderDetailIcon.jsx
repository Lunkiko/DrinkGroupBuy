import { StyleSheet, View } from "react-native";
import { sizes } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

export function OrderDetailIcon({ name, size = 24 }) {
  const styles = useThemedStyles(makeStyles);
  const scale = size / 24;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ width: 24, height: 24, transform: [{ scale }] }}>
        {name === "store" ? <>
          <View style={styles.storeRoof} />
          <View style={styles.storeBody} />
          <View style={styles.storeDoor} />
        </> : null}
        {name === "pin" ? <>
          <View style={styles.pinShell} />
          <View style={styles.pinHole} />
        </> : null}
        {name === "phone" ? <>
          <View style={styles.phoneCurve} />
          <View style={styles.phoneTop} />
          <View style={styles.phoneBottom} />
        </> : null}
        {name === "clock" ? <>
          <View style={styles.clockCircle} />
          <View style={styles.clockMinute} />
          <View style={styles.clockHour} />
        </> : null}
        {name === "calendar" ? <>
          <View style={styles.calendarBox} />
          <View style={styles.calendarRule} />
          <View style={styles.calendarRingLeft} />
          <View style={styles.calendarRingRight} />
          <View style={styles.calendarDotLeft} />
          <View style={styles.calendarDotRight} />
        </> : null}
        {name === "people" ? <>
          <View style={styles.peopleHeadLeft} />
          <View style={styles.peopleHeadRight} />
          <View style={styles.peopleShoulderLeft} />
          <View style={styles.peopleShoulderRight} />
        </> : null}
        {name === "receipt" ? <>
          <View style={styles.receiptBody} />
          <View style={styles.receiptLineTop} />
          <View style={styles.receiptLineBottom} />
        </> : null}
      </View>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  storeRoof: { position: "absolute", left: 2, top: 2, width: 20, height: 8, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 4 },
  storeBody: { position: "absolute", left: 4, top: 9, width: 16, height: 13, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 3 },
  storeDoor: { position: "absolute", left: 10, top: 15, width: 5, height: 7, borderWidth: sizes.stroke, borderBottomWidth: 0, borderColor: colors.accent, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  pinShell: { position: "absolute", left: 4, top: 1, width: 16, height: 16, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 9 },
  pinHole: { position: "absolute", left: 10, top: 14, width: 5, height: 8, borderLeftWidth: sizes.stroke, borderBottomWidth: sizes.stroke, borderColor: colors.accent, transform: [{ rotate: "-45deg" }] },
  phoneCurve: { position: "absolute", left: 4, top: 3, width: 15, height: 18, borderLeftWidth: sizes.stroke + 1, borderBottomWidth: sizes.stroke + 1, borderColor: colors.accent, borderBottomLeftRadius: 14, transform: [{ rotate: "-35deg" }] },
  phoneTop: { position: "absolute", left: 2, top: 3, width: 7, height: 5, backgroundColor: colors.accent, borderRadius: 3, transform: [{ rotate: "-35deg" }] },
  phoneBottom: { position: "absolute", right: 2, bottom: 2, width: 7, height: 5, backgroundColor: colors.accent, borderRadius: 3, transform: [{ rotate: "-35deg" }] },
  clockCircle: { position: "absolute", left: 2, top: 2, width: 20, height: 20, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 10 },
  clockMinute: { position: "absolute", left: 11, top: 6, width: sizes.stroke, height: 7, backgroundColor: colors.accent },
  clockHour: { position: "absolute", left: 11, top: 11, width: 6, height: sizes.stroke, backgroundColor: colors.accent, transform: [{ rotate: "30deg" }] },
  calendarBox: { position: "absolute", left: 2, top: 4, width: 20, height: 18, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 3 },
  calendarRule: { position: "absolute", left: 3, top: 10, width: 18, height: sizes.stroke, backgroundColor: colors.accent },
  calendarRingLeft: { position: "absolute", left: 7, top: 1, width: sizes.stroke, height: 7, backgroundColor: colors.accent },
  calendarRingRight: { position: "absolute", right: 7, top: 1, width: sizes.stroke, height: 7, backgroundColor: colors.accent },
  calendarDotLeft: { position: "absolute", left: 7, top: 14, width: 3, height: 3, backgroundColor: colors.accent },
  calendarDotRight: { position: "absolute", right: 7, top: 14, width: 3, height: 3, backgroundColor: colors.accent },
  peopleHeadLeft: { position: "absolute", left: 3, top: 3, width: 8, height: 8, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 4 },
  peopleHeadRight: { position: "absolute", right: 2, top: 5, width: 7, height: 7, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 4 },
  peopleShoulderLeft: { position: "absolute", left: 1, bottom: 3, width: 14, height: 9, borderWidth: sizes.stroke, borderBottomWidth: 0, borderColor: colors.accent, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  peopleShoulderRight: { position: "absolute", right: 0, bottom: 3, width: 10, height: 8, borderWidth: sizes.stroke, borderBottomWidth: 0, borderColor: colors.accent, borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  receiptBody: { position: "absolute", left: 5, top: 2, width: 14, height: 20, borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: 3 },
  receiptLineTop: { position: "absolute", left: 8, top: 9, width: 8, height: sizes.stroke, backgroundColor: colors.accent },
  receiptLineBottom: { position: "absolute", left: 8, top: 14, width: 8, height: sizes.stroke, backgroundColor: colors.accent }
});
