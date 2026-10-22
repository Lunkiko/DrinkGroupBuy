import { StyleSheet, Text, View } from "react-native";
import { Card } from "./Card";
import { spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";
import { formatCurrency } from "../utils/calculations";

export function OrderAmountSummary({ originalAmount, discountAmount = 0, totalAmount, totalLabel = "應付金額", estimated = false, filled = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card compact tone={filled ? "recess" : "plain"} style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.label}>小計</Text>
        <Text style={styles.value}>{formatCurrency(originalAmount)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>{estimated ? "目前預估折扣" : "折扣金額"}</Text>
        <Text style={styles.discount}>{formatCurrency(discountAmount)}</Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.totalLabel}>{totalLabel}</Text>
        <Text style={styles.totalValue}>{formatCurrency(totalAmount)}</Text>
      </View>
    </Card>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  card: { gap: spacing.s12, padding: spacing.s20 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s12 },
  label: { ...typeScale.body, color: colors.textSecondary },
  value: { ...typeScale.body, fontWeight: "700", color: colors.text },
  discount: { ...typeScale.body, fontWeight: "700", color: colors.warmInk },
  divider: { height: 1, backgroundColor: colors.lineDecor },
  totalLabel: { ...typeScale.sectionTitle, color: colors.text },
  totalValue: { ...typeScale.amount, color: colors.accentInk }
});
