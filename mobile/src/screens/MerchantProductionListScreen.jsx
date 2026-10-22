import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MerchantPickupLookup } from "../components/MerchantPickupLookup";
import { MobileScreen } from "../components/MobileScreen";
import { PrimaryButton } from "../components/PrimaryButton";
import { TonePill } from "../components/TonePill";
import { formatOrderItemCustomizations, toLocalOrderItem } from "../utils/orderItems";
import { radii, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

const tabs = [{ key: "waiting", label: "待製作" }, { key: "ready", label: "可取餐" }, { key: "picked", label: "已取餐" }];

export function MerchantProductionListScreen({ navigation, route, appState, actions, selectedMerchantStoreId }) {
  const styles = useThemedStyles(makeStyles);
  const activityId = route.params?.groupBuyActivityId;
  const activity = appState.groupBuyActivities.find((item) => item.id === activityId && item.storeId === selectedMerchantStoreId);
  const [tab, setTab] = useState("waiting");
  const [expandedIds, setExpandedIds] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const orders = appState.orders.filter((order) => order.groupBuyActivityId === activityId && order.paymentStatus === "captured" && order.status !== "cancelled");
  const buckets = {
    waiting: orders.filter((order) => order.pickupStatus === "not_ready"),
    ready: orders.filter((order) => order.pickupStatus === "ready"),
    picked: orders.filter((order) => order.pickupStatus === "picked_up" || order.status === "completed")
  };

  async function markReady(orderId) {
    if (busy || !activity) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await actions.markOrdersReadyForPickupForGroupBuyActivity(activity.id, orderId);
      setNotice({ type: "success", text: `已標記可取餐，產生 ${result.createdCredentialCount} 筆取餐碼。` });
    } catch (error) {
      setNotice({ type: "error", text: error?.message || "標記可取餐失敗，請再試一次。" });
    } finally {
      setBusy(false);
    }
  }

  return <MobileScreen title="活動訂單" onBack={() => navigation.goBack()}>
    {!activity ? <Text style={styles.empty}>找不到這筆團購活動。</Text> : <>
      <View style={styles.activityHeader}>
        <View style={styles.activityTitleRow}><Text style={styles.activityTitle}>{activity.title}</Text><TonePill tone={activity.status === "completed" ? "neutral" : "info"} label={activity.status === "completed" ? "已完成" : activity.status === "recruiting" ? "招募中" : "已成團"} /></View>
        <Text style={styles.pickupTime}>取餐：{formatPickupWindow(activity)}</Text>
      </View>
      <View style={styles.tabs}>{tabs.map(({ key, label }) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} onPress={() => { setTab(key); setNotice(null); }} style={[styles.tab, tab === key && styles.selectedTab]}><Text numberOfLines={1} style={[styles.tabText, tab === key && styles.selectedTabText]}>{label}（{buckets[key].length}）</Text></Pressable>)}</View>
      {tab === "ready" ? <View style={styles.lookupSection}><Text style={styles.lookupTitle}>輸入六位取餐碼</Text><MerchantPickupLookup actions={actions} activityId={activity.id} /></View> : null}
      {activity.status === "completed" && tab === "picked" ? <Text style={styles.success}>所有訂單已取餐，此團購已移至歷史訂單。</Text> : null}
      {notice ? <Text accessibilityRole="alert" style={notice.type === "error" ? styles.error : styles.success}>{notice.text}</Text> : null}
      <View style={styles.list}>{buckets[tab].length === 0 ? <Text style={styles.empty}>{tab === "waiting" ? "目前沒有待製作訂單。" : tab === "ready" ? "目前沒有可取餐訂單。" : "目前沒有已取餐訂單。"}</Text> : buckets[tab].map((order, index) => {
        const expanded = expandedIds[order.id] ?? index === 0;
        const orderNumber = orders.findIndex((item) => item.id === order.id) + 1;
        const items = (order.items ?? []).map((item) => item.customizations ? toLocalOrderItem(item) : item);
        const cups = items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
        return <View key={order.id} style={styles.order}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpandedIds((current) => ({ ...current, [order.id]: !expanded }))} style={styles.orderHeader}>
            <View style={styles.orderIdentity}><Text numberOfLines={1} style={styles.customer}>#{String(orderNumber).padStart(3, "0")}　{order.customerDisplayName || order.customerId || "顧客"}</Text><Text style={styles.cups}>共 {cups} 杯</Text></View>
            <Text style={expanded ? styles.toggleActive : styles.toggle}>{expanded ? "收合⌃" : "展開⌄"}</Text>
          </Pressable>
          {expanded ? <View style={styles.orderBody}>{items.map((item, itemIndex) => <View key={item.id ?? itemIndex} style={styles.item}><View style={styles.itemInfo}><Text style={styles.itemName}>{item.itemName ?? item.name}</Text><Text style={styles.itemDetail}>{formatOrderItemCustomizations(item, { separator: " · " }) || "無客製化"}</Text></View><Text style={styles.itemQuantity}>×{item.quantity}</Text></View>)}{tab === "waiting" ? <PrimaryButton variant="secondary" disabled={busy} label={busy ? "處理中" : "標記可取餐"} onPress={() => markReady(order.id)} style={styles.orderAction} /> : null}</View> : null}
        </View>;
      })}</View>
      {tab === "waiting" && buckets.waiting.length > 0 ? <View style={styles.bulk}><Text style={styles.bulkHint}>請確認飲品已備妥，再通知顧客取餐。</Text><PrimaryButton disabled={busy} label={busy ? "處理中" : `全部標記可取餐（${buckets.waiting.length} 筆）`} onPress={() => markReady()} /></View> : null}
    </>}
  </MobileScreen>;
}

function formatPickupWindow(activity) {
  if (!activity.pickupStartAt || !activity.pickupEndAt) return activity.pickupTime || "時間待確認";
  const start = new Date(activity.pickupStartAt);
  const end = new Date(activity.pickupEndAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return activity.pickupTime || "時間待確認";
  const date = `${start.getMonth() + 1}/${start.getDate()}`;
  const time = (value) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time(start)}–${time(end)}`;
}

const makeStyles = (colors, tones) => StyleSheet.create({
  activityHeader: { gap: spacing.s8, marginTop: spacing.s8 },
  activityTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s8 },
  activityTitle: { ...typeScale.screenTitle, color: colors.text, flex: 1 },
  pickupTime: { ...typeScale.body, color: colors.textSecondary },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.lineRow, marginHorizontal: -spacing.s8 },
  tab: { flex: 1, minHeight: 48, justifyContent: "center", alignItems: "center", borderBottomWidth: 3, borderBottomColor: colors.page },
  selectedTab: { borderBottomColor: colors.accent },
  tabText: { ...typeScale.body, color: colors.textSecondary, textAlign: "center" },
  selectedTabText: { ...typeScale.button, color: colors.accentInk },
  lookupSection: { gap: spacing.s12, borderWidth: 1, borderColor: colors.lineDecor, borderRadius: radii.sm, padding: spacing.s16 },
  lookupTitle: { ...typeScale.sectionTitle, color: colors.text },
  list: { gap: 0 },
  order: { borderBottomWidth: 1, borderBottomColor: colors.lineRow, paddingVertical: spacing.s16, gap: spacing.s12 },
  orderHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s8, minHeight: 44 },
  orderIdentity: { flex: 1, gap: spacing.s4 },
  customer: { ...typeScale.price, color: colors.text },
  cups: { ...typeScale.body, color: colors.textSecondary },
  toggle: { ...typeScale.body, color: colors.textSecondary },
  toggleActive: { ...typeScale.button, color: colors.accentInk },
  orderBody: { gap: spacing.s12 },
  item: { flexDirection: "row", gap: spacing.s8, borderBottomWidth: 1, borderBottomColor: colors.lineRow, paddingBottom: spacing.s12 },
  itemInfo: { flex: 1, gap: spacing.s4 },
  itemName: { ...typeScale.price, color: colors.text },
  itemDetail: { ...typeScale.body, color: colors.textSecondary },
  itemQuantity: { ...typeScale.price, color: colors.text },
  orderAction: { alignSelf: "flex-end" },
  bulk: { gap: spacing.s12, marginTop: spacing.s20 },
  bulkHint: { ...typeScale.body, color: colors.textSecondary, textAlign: "center" },
  empty: { ...typeScale.body, color: colors.textSecondary, textAlign: "center", paddingVertical: spacing.s24 },
  success: { ...typeScale.body, color: tones.success.fg },
  error: { ...typeScale.body, color: tones.danger.fg }
});
