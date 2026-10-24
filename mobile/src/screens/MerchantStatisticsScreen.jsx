import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { EmptyPanel } from "../components/EmptyPanel";
import { MobileScreen, Section } from "../components/MobileScreen";
import { Notice } from "../components/Notice";
import { PrimaryButton } from "../components/PrimaryButton";
import { maxFontSizeMultiplier, radii, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";
import { getMerchantStoreStatistics } from "../utils/apiClient";
import { formatQualifiedRate, normalizeMerchantStatistics } from "../utils/merchantStatistics";

// useFocusEffect (not useEffect): the screen stays mounted in its stack, so a plain effect would
// keep showing the figures from the first visit even after more orders are paid.
function useMerchantStatistics(storeId) {
  const [state, setState] = useState({ status: "loading", statistics: null });
  const [reloadCount, setReloadCount] = useState(0);

  useFocusEffect(useCallback(() => {
    if (!storeId) return undefined;
    let active = true;
    // Refreshing keeps the last shown figures on screen; only a first load or a retry shows "loading".
    // A failed load replaces them with the error notice instead of leaving possibly stale numbers.
    setState((current) => (current.statistics ? current : { status: "loading", statistics: null }));
    getMerchantStoreStatistics(storeId)
      .then((payload) => {
        if (!active) return;
        const statistics = normalizeMerchantStatistics(payload);
        setState(statistics ? { status: "ready", statistics } : { status: "error", statistics: null });
      })
      .catch(() => {
        if (active) setState({ status: "error", statistics: null });
      });
    return () => {
      active = false;
    };
  }, [storeId, reloadCount]));

  const retry = useCallback(() => setReloadCount((count) => count + 1), []);
  return { ...state, retry };
}

export function MerchantStatisticsScreen({ selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const { status, statistics, retry } = useMerchantStatistics(selectedMerchantStoreId);

  return (
    <MobileScreen title="">
      <Text accessibilityRole="header" style={styles.pageTitle}>分析</Text>
      {!selectedMerchantStoreId ? (
        <EmptyPanel>找不到目前的店家資料，請重新登入。</EmptyPanel>
      ) : (
        <StatisticsBody status={status} statistics={statistics} onRetry={retry} />
      )}
    </MobileScreen>
  );
}

function StatisticsBody({ status, statistics, onRetry }) {
  const styles = useThemedStyles(makeStyles);
  const [explanationOpen, setExplanationOpen] = useState(false);

  if (status === "loading") return <EmptyPanel>正在統計店家數據…</EmptyPanel>;

  if (status === "error") {
    return (
      <Notice accessibilityRole="alert" tone="danger" message="暫時無法載入營運統計，請稍後再試。">
        <PrimaryButton label="重新載入" variant="secondary" onPress={onRetry} />
      </Notice>
    );
  }

  if (statistics.orderCount === 0 && statistics.settledActivityCount === 0) {
    return (
      <EmptyPanel title="還沒有營運數據">
        有團購成團並完成請款後，統計會顯示在這裡。
      </EmptyPanel>
    );
  }

  return (
    <>
      <Section title="營收與訂單">
        <View style={styles.grid}>
          <StatCard label="累計實收" value={formatNumber(statistics.totalRevenue)} unit="元" />
          <StatCard label="成交訂單" value={formatNumber(statistics.orderCount)} unit="筆" accent />
          <StatCard label="折扣讓利" value={formatNumber(statistics.discountGivenTotal)} unit="元" />
          <StatCard
            label="成團率 ⓘ"
            value={formatQualifiedRate(statistics.qualifiedRate)}
            accent
            hint={statistics.settledActivityCount > 0
              ? `${statistics.qualifiedActivityCount} / ${statistics.settledActivityCount} 場`
              : null}
          />
        </View>
      </Section>

      <WeeklyTrendSection
        weeklyTrend={statistics.weeklyTrend}
        weeklyTrendUnavailable={statistics.weeklyTrendUnavailable}
      />

      <Section title="熱銷飲品 TOP 3" headerRight={<Text style={styles.listCaption}>累計銷量</Text>}>
        {statistics.topDrinks.length === 0 ? (
          <EmptyPanel>還沒有已成交的飲品。</EmptyPanel>
        ) : (
          <View style={styles.drinkList}>
            {statistics.topDrinks.map((drink, index) => (
              <View key={drink.name} style={styles.drinkRow}>
                <Text style={styles.drinkRank}>{index + 1}</Text>
                <Text style={styles.drinkName} numberOfLines={2}>{drink.name}</Text>
                <Text style={styles.drinkCups}>{drink.cups} 杯</Text>
              </View>
            ))}
          </View>
        )}
      </Section>

      <Text style={styles.note}>統計以已請款、未取消的訂單為準。</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: explanationOpen }} onPress={() => setExplanationOpen((open) => !open)} style={styles.explanationButton}><Text style={styles.explanationIcon}>ⓘ</Text><Text style={styles.explanationLabel}>統計說明</Text><Text style={styles.explanationChevron}>{explanationOpen ? "⌃" : "⌄"}</Text></Pressable>
      {explanationOpen ? <Text style={styles.explanationText}>累計實收為已請款金額扣除退款；成交訂單、折扣讓利與熱銷杯數以已請款且未取消的訂單計算。店家標記退款後，該筆仍可能列入訂單數與杯數。逾期未取但已付款的訂單仍列入。折扣讓利為原價減最終請款金額；成團率為達到優惠門檻的團購占已結算團購的比例，進行中與已取消的團購不列入。</Text> : null}
    </>
  );
}

function StatCard({ label, value, unit, hint, accent = false }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card}>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.cardLabel}>{label}</Text>
      <Text maxFontSizeMultiplier={maxFontSizeMultiplier} numberOfLines={1} style={[styles.cardValue, accent && styles.cardValueAccent]}>{value}{unit ? <Text style={styles.cardUnit}> {unit}</Text> : null}</Text>
      {hint ? <Text style={styles.cardHint}>{hint}</Text> : null}
    </View>
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(value);
}

const CHART_HEIGHT = 120;
const MIN_BAR_HEIGHT = 3;
const Y_AXIS_WIDTH = 42;
// Three intervals give the chart four readable axis labels, including zero.
const Y_AXIS_STEPS = 3;

// Rounds maxValue/Y_AXIS_STEPS up to a "nice" 1/2/5 * 10^n number, so the axis reads like a real
// chart's 0/20/40/60 instead of an arbitrary fraction of whatever this week's max happens to
// be. Always rounds UP (never down), so axisStep * Y_AXIS_STEPS is guaranteed >= maxValue.
function computeNiceAxisStep(maxValue) {
  const rawStep = maxValue / Y_AXIS_STEPS;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

// One chart plots either order count or revenue from the same weekly rows. A zero week has no bar;
// a non-zero week keeps a small floor so it remains visible beside taller weeks.
function WeeklyTrendChart({ weeklyTrend, valueKey, formatValue }) {
  const styles = useThemedStyles(makeStyles);
  const [selectedWeek, setSelectedWeek] = useState(Math.floor(weeklyTrend.length / 2));
  const maxValue = Math.max(1, ...weeklyTrend.map((week) => week[valueKey]));
  const axisStep = computeNiceAxisStep(maxValue);
  const axisMax = axisStep * Y_AXIS_STEPS;
  const ticksDescending = Array.from(
    { length: Y_AXIS_STEPS + 1 },
    (_, index) => axisStep * (Y_AXIS_STEPS - index)
  );

  return (
    <View>
      <View style={styles.chartRow}>
        <View style={styles.yAxisLabels}>
          {ticksDescending.map((tick) => (
            <Text key={tick} maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.yAxisLabel} numberOfLines={1}>
              {formatValue(tick)}
            </Text>
          ))}
        </View>
        <View style={styles.plotArea}>
          <View style={styles.gridLines} pointerEvents="none">
            {ticksDescending.map((tick) => (
              <View key={tick} style={styles.gridLine} />
            ))}
          </View>
          {weeklyTrend.map((week, index) => {
            const value = week[valueKey];
            const barHeight = value === 0 ? 0 : Math.max(MIN_BAR_HEIGHT, (value / axisMax) * CHART_HEIGHT);
            return (
              <Pressable accessibilityRole="button" accessibilityLabel={`${formatWeekLabel(week.weekStart)}：${formatValue(value)}`} key={week.weekStart} onPress={() => setSelectedWeek(index)} style={[styles.chartCol, selectedWeek === index && styles.chartColSelected]}>
                {selectedWeek === index ? <View style={[styles.chartTooltip, { bottom: barHeight + spacing.s8 }]}><Text numberOfLines={1} style={styles.chartTooltipText}>{formatWeekLabel(week.weekStart)}　{formatNumber(value)}{valueKey === "revenue" ? " 元" : " 筆"}</Text></View> : null}
                <View style={[styles.chartBar, { height: barHeight }]} />
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={styles.xAxisRow}>
        <View style={styles.yAxisSpacer} />
        {weeklyTrend.map((week, index) => (
          <View key={week.weekStart} style={styles.xAxisLabelCol}>
            <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.xAxisLabel} numberOfLines={1}>
              {index % 2 === 0 || index === weeklyTrend.length - 1 ? formatWeekLabel(week.weekStart) : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Order count and revenue plot off the same weeklyTrend rows, so they share one unavailable/empty
// guard and one fetch -- rendering two separate guarded sections (one per metric) would show the
// same "暫時無法載入" notice twice for what is really one failed request.
function WeeklyTrendSection({ weeklyTrend, weeklyTrendUnavailable }) {
  const styles = useThemedStyles(makeStyles);
  const [metric, setMetric] = useState("orderCount");
  const [weeks, setWeeks] = useState(9);
  const [periodOpen, setPeriodOpen] = useState(false);
  const visibleTrend = weeklyTrend.slice(-weeks);
  return (
    <Section title="訂單與營收趨勢" headerRight={<Pressable accessibilityRole="button" accessibilityState={{ expanded: periodOpen }} onPress={() => setPeriodOpen((open) => !open)} style={styles.periodButton}><Text style={styles.periodText}>{weeks === 9 ? "近 2 個月" : "近 1 個月"} ⌄</Text></Pressable>}>
      {periodOpen ? <View style={styles.periodOptions}>{[{ label: "近 1 個月", value: 4 }, { label: "近 2 個月", value: 9 }].map((option) => <Pressable key={option.value} accessibilityRole="button" onPress={() => { setWeeks(option.value); setPeriodOpen(false); }} style={styles.periodOption}><Text style={styles.periodText}>{option.label}</Text></Pressable>)}</View> : null}
      {weeklyTrendUnavailable ? (
        <Notice tone="danger" message="暫時無法載入近期趨勢，請稍後再試。" />
      ) : weeklyTrend.length === 0 ? (
        <EmptyPanel>近期沒有訂單資料。</EmptyPanel>
      ) : (
        <View style={styles.chartCard}>
          <View style={styles.metricTabs}>{[{ key: "orderCount", label: "訂單數" }, { key: "revenue", label: "實收金額" }].map((option) => <Pressable key={option.key} accessibilityRole="tab" accessibilityState={{ selected: metric === option.key }} onPress={() => setMetric(option.key)} style={[styles.metricTab, metric === option.key && styles.metricTabActive]}><Text style={[styles.metricTabText, metric === option.key && styles.metricTabTextActive]}>{option.label}</Text></Pressable>)}</View>
          <Text style={styles.chartSubLabel}>{metric === "orderCount" ? "訂單數（筆）" : "實收金額（元）"}</Text>
          <WeeklyTrendChart key={`${metric}-${weeks}`} weeklyTrend={visibleTrend} valueKey={metric} formatValue={metric === "orderCount" ? String : formatNumber} />
        </View>
      )}
    </Section>
  );
}

// "2026-09-07" -> "9/7" (no leading zeros); weekStart is always that exact shape (see
// getStoreWeeklyTrendPostgres), never parsed through Date, so this can't be thrown off by timezone.
function formatWeekLabel(weekStart) {
  const [, month, day] = weekStart.split("-");
  return `${Number(month)}/${Number(day)}`;
}

const makeStyles = (colors) => StyleSheet.create({
  pageTitle: { ...typeScale.screenTitle, color: colors.text, textAlign: "center", marginBottom: spacing.s8 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s8
  },
  card: {
    flexGrow: 1,
    flexBasis: "45%",
    minHeight: 104,
    gap: spacing.s8,
    padding: spacing.s16,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.lineDecor,
    backgroundColor: colors.recess
  },
  cardLabel: {
    ...typeScale.body,
    color: colors.textSecondary
  },
  cardValue: {
    ...typeScale.amount,
    color: colors.text
  },
  cardValueAccent: { color: colors.accentInk },
  cardUnit: { ...typeScale.body, color: colors.text },
  cardHint: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  listCaption: { ...typeScale.bodyDense, color: colors.textSecondary },
  drinkList: { borderWidth: 1, borderColor: colors.lineDecor, borderRadius: radii.sm, overflow: "hidden" },
  drinkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s12,
    minHeight: 58,
    paddingHorizontal: spacing.s16,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineRow
  },
  drinkRank: {
    ...typeScale.price,
    minWidth: 24,
    color: colors.accentInk
  },
  drinkName: {
    ...typeScale.body,
    flex: 1,
    color: colors.text
  },
  drinkCups: {
    ...typeScale.price,
    color: colors.text
  },
  chartRow: {
    flexDirection: "row",
    gap: spacing.s8
  },
  periodButton: { borderWidth: 1, borderColor: colors.lineInput, borderRadius: radii.xs, minHeight: 40, paddingHorizontal: spacing.s12, justifyContent: "center" },
  periodText: { ...typeScale.body, color: colors.text },
  periodOptions: { alignSelf: "flex-end", borderWidth: 1, borderColor: colors.lineInput, borderRadius: radii.xs, backgroundColor: colors.page, minWidth: 126 },
  periodOption: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.s12, borderBottomWidth: 1, borderBottomColor: colors.lineRow },
  chartCard: { borderWidth: 1, borderColor: colors.lineDecor, borderRadius: radii.sm, padding: spacing.s12, gap: spacing.s16 },
  metricTabs: { flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.lineRow, borderRadius: radii.xs, overflow: "hidden" },
  metricTab: { minWidth: 104, minHeight: 40, justifyContent: "center", alignItems: "center", paddingHorizontal: spacing.s12 },
  metricTabActive: { backgroundColor: colors.recess },
  metricTabText: { ...typeScale.body, color: colors.textSecondary },
  metricTabTextActive: { ...typeScale.button, color: colors.accentInk },
  yAxisLabels: {
    width: Y_AXIS_WIDTH,
    height: CHART_HEIGHT,
    justifyContent: "space-between"
  },
  yAxisLabel: {
    ...typeScale.caption,
    color: colors.textSecondary,
    textAlign: "right"
  },
  plotArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.s4,
    height: CHART_HEIGHT
  },
  gridLines: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between"
  },
  gridLine: {
    height: 1,
    backgroundColor: colors.lineRow
  },
  chartCol: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    height: "100%",
    minWidth: 0
  },
  chartColSelected: { zIndex: 2 },
  chartBar: {
    width: "78%",
    backgroundColor: colors.accent
  },
  chartTooltip: { position: "absolute", width: 105, borderRadius: radii.xs, paddingHorizontal: spacing.s4, paddingVertical: spacing.s4, alignItems: "center", backgroundColor: colors.text },
  chartTooltipText: { ...typeScale.caption, color: colors.onDark },
  xAxisRow: {
    flexDirection: "row",
    gap: spacing.s4,
    marginTop: spacing.s12
  },
  yAxisSpacer: {
    width: Y_AXIS_WIDTH + spacing.s8
  },
  xAxisLabelCol: {
    flex: 1,
    alignItems: "center"
  },
  xAxisLabel: {
    ...typeScale.caption,
    color: colors.textSecondary
  },
  chartSubLabel: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  note: {
    ...typeScale.bodyDense,
    color: colors.textSecondary
  },
  explanationButton: { flexDirection: "row", alignItems: "center", gap: spacing.s12, minHeight: 52, borderWidth: 1, borderColor: colors.lineDecor, borderRadius: radii.sm, paddingHorizontal: spacing.s16 },
  explanationIcon: { ...typeScale.price, color: colors.textSecondary },
  explanationLabel: { ...typeScale.button, color: colors.text, flex: 1 },
  explanationChevron: { ...typeScale.price, color: colors.textSecondary },
  explanationText: { ...typeScale.bodyDense, color: colors.textSecondary }
});
