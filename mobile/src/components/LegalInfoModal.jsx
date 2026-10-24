import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { radii, sizes, spacing, typeScale } from "../theme/tokens";
import { useThemedStyles } from "../theme/ThemeContext";

const LEGAL_COPY = {
  terms: {
    title: "服務條款草案",
    sections: [
      ["服務內容", "揪飲提供顧客查看店家團購、選購飲品、查詢訂單與取餐資訊的介面。飲品內容、供應情形及取餐地點以各店家與活動頁面顯示的資訊為準。"],
      ["訂單與付款", "送出前請確認品項、數量、客製化與金額。付款透過 LINE Pay 辦理；預授權與實際請款是不同階段，團購截止後依最終優惠與訂單結果確認實際金額。付款或訂單狀態請以訂單明細為準。"],
      ["修改、取餐與爭議", "可修改或退出團購的時段與條件會顯示於活動及訂單頁面。取餐與逾期未取依付款前提供的現行規則辦理；若店家無法交付、商品有瑕疵或發生退款爭議，應依實際情況與適用法規處理。"],
      ["發布前待確認", "營運者名稱、聯絡方式、適用範圍、條款生效日期及爭議處理管道，須由專案擁有者確認後補齊。本草案目前僅供畫面與內容審閱。"]
    ]
  },
  privacy: {
    title: "隱私政策草案",
    sections: [
      ["可能使用的資料", "登入可能取得 Google 帳號提供的名稱、電子郵件與相片；使用服務時會產生暱稱、訂單、飲品選項、付款結果及取餐紀錄。使用地圖定位時，會先依裝置設定取得定位權限。"],
      ["使用目的與對象", "資料用於登入、顯示附近店家、完成訂單、付款、取餐、客服及必要的交易紀錄。為完成服務，相關資訊可能提供給參與訂單的店家及登入、地圖、付款等服務提供者；實際提供範圍須與正式串接方式核對。"],
      ["保存與權利", "使用者可依適用法規請求查詢、更正或刪除個人資料；必要的付款、訂單與爭議紀錄可能需在法定或必要期間保留。請勿在尚未確認保存期間與辦理方式前，將本草案視為正式個資告知。"],
      ["發布前待確認", "資料蒐集者名稱與聯絡方式、各項資料的保存期間、利用地區與對象、權利行使管道及政策生效日期，須由專案擁有者確認後補齊。"]
    ]
  }
};

export function LegalInfoModal({ type, onClose }) {
  const styles = useThemedStyles(makeStyles);
  const copy = LEGAL_COPY[type];
  if (!copy) return null;

  const content = (
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="關閉說明" onPress={onClose} style={styles.backdrop} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="關閉" onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {copy.sections.map(([heading, paragraph]) => (
            <View key={heading} style={styles.section}>
              <Text style={styles.heading}>{heading}</Text>
              <Text style={styles.paragraph}>{paragraph}</Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>{content}</Modal>;
}

const makeStyles = (colors) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.s20 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.text, opacity: 0.45 },
  panel: { width: "100%", maxWidth: 480, maxHeight: "82%", padding: spacing.s20, borderRadius: radii.md, borderWidth: sizes.stroke, borderColor: colors.lineDecor, backgroundColor: colors.page },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s12 },
  title: { ...typeScale.sectionTitle, color: colors.text, flex: 1 },
  closeButton: { minWidth: sizes.tap, minHeight: sizes.tap, alignItems: "center", justifyContent: "center" },
  closeText: { ...typeScale.sectionTitle, color: colors.accentInk },
  body: { gap: spacing.s16, paddingBottom: spacing.s8 },
  section: { gap: spacing.s4 },
  heading: { ...typeScale.body, fontWeight: typeScale.label.fontWeight, color: colors.text },
  paragraph: { ...typeScale.bodyDense, color: colors.textSecondary }
});
