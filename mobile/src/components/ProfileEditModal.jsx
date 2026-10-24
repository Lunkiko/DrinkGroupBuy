import { useEffect, useRef, useState } from "react";
import { Image, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { useTheme, useThemedStyles } from "../theme/ThemeContext";
import { maxFontSizeMultiplier, radii, sizes, spacing, typeScale } from "../theme/tokens";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function ProfileEditModal({ visible, displayName, photoUrl, onClose, onApplyPreview }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const fileInputRef = useRef(null);
  const [draftName, setDraftName] = useState(displayName);
  const [draftPhotoUrl, setDraftPhotoUrl] = useState(photoUrl);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setDraftName(displayName);
    setDraftPhotoUrl(photoUrl);
    setError("");
  }, [visible, displayName, photoUrl]);

  if (!visible && Platform.OS === "web") return null;

  const choosePhoto = () => {
    if (Platform.OS === "web") {
      fileInputRef.current?.click();
      return;
    }
    setError("手機相片選取尚未接上；目前可先預覽暱稱編輯。");
  };

  const handleWebPhoto = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      setError("請選擇 JPG、PNG 或 WebP 圖片。");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError("照片大小不可超過 5 MB。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setError("照片讀取失敗，請重新選擇。");
        return;
      }
      setDraftPhotoUrl(reader.result);
      setError("");
    };
    reader.onerror = () => setError("照片讀取失敗，請重新選擇。");
    reader.readAsDataURL(file);
  };

  const applyPreview = () => {
    const nextName = draftName.trim();
    if (!nextName) {
      setError("請輸入暱稱。");
      return;
    }
    onApplyPreview({ displayName: nextName, photoUrl: draftPhotoUrl });
  };

  const content = (
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="關閉編輯會員資料視窗" onPress={onClose} style={styles.backdrop} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>編輯會員資料</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="關閉" onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.photoSection}>
          <View style={styles.avatarWrap}>
            {draftPhotoUrl ? (
              <Image source={{ uri: draftPhotoUrl }} style={styles.avatar} accessibilityLabel="相片預覽" />
            ) : (
              <View style={styles.avatar}>
                <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.avatarText}>{(draftName.trim() || "會").slice(0, 1)}</Text>
              </View>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="更換相片" hitSlop={8} onPress={choosePhoto} style={styles.photoEditBadge}>
              <Text style={styles.photoEditSymbol}>✎</Text>
            </Pressable>
          </View>
          <Text style={styles.photoHint}>點擊鉛筆更換照片{"\n"}JPG、PNG、WebP，最多 5 MB</Text>
        </View>
        {Platform.OS === "web" ? (
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleWebPhoto} style={{ display: "none" }} />
        ) : null}
        <View style={styles.field}>
          <Text style={styles.label}>暱稱</Text>
          <TextInput
            accessibilityLabel="暱稱"
            autoCapitalize="none"
            maxLength={20}
            onChangeText={(value) => { setDraftName(value); setError(""); }}
            placeholder="請輸入暱稱"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            value={draftName}
          />
          <Text style={styles.helper}>最多 20 個字</Text>
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Text style={styles.previewNote}>目前只套用於畫面預覽，尚未儲存至會員帳號。</Text>
        <View style={styles.actions}>
          <PrimaryButton label="取消" variant="secondary" onPress={onClose} style={styles.actionButton} />
          <PrimaryButton label="套用預覽" onPress={applyPreview} style={styles.actionButton} />
        </View>
      </View>
    </View>
  );

  if (Platform.OS === "web") return <View style={StyleSheet.absoluteFillObject}>{content}</View>;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>{content}</Modal>;
}

const makeStyles = (colors) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", paddingHorizontal: spacing.s20 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.text, opacity: 0.45 },
  panel: { width: "100%", maxHeight: "88%", gap: spacing.s16, padding: spacing.s20, borderWidth: sizes.stroke, borderColor: colors.lineDecor, borderRadius: radii.lg, backgroundColor: colors.page },
  header: { minHeight: sizes.tap, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { ...typeScale.screenTitle, color: colors.text },
  closeButton: { width: sizes.tap, height: sizes.tap, alignItems: "center", justifyContent: "center" },
  closeText: { ...typeScale.sectionTitle, color: colors.textSecondary },
  photoSection: { alignItems: "center", gap: spacing.s8 },
  avatarWrap: { width: 84, height: 84 },
  avatar: { width: 76, height: 76, borderRadius: radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.recess },
  avatarText: { ...typeScale.screenTitle, color: colors.text },
  photoEditBadge: { position: "absolute", right: 0, bottom: 0, width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: sizes.stroke, borderColor: colors.accent, borderRadius: radii.pill, backgroundColor: colors.page },
  photoEditSymbol: { ...typeScale.sectionTitle, color: colors.accentInk },
  photoHint: { ...typeScale.caption, color: colors.textSecondary, textAlign: "center" },
  field: { gap: spacing.s8 },
  label: { ...typeScale.sectionTitle, color: colors.text },
  input: { minHeight: sizes.buttonHeight, paddingHorizontal: spacing.s16, borderWidth: sizes.stroke, borderColor: colors.lineInput, borderRadius: radii.sm, color: colors.text, backgroundColor: colors.page, ...typeScale.body },
  helper: { ...typeScale.caption, color: colors.textSecondary },
  error: { ...typeScale.bodyDense, color: colors.warmInk },
  previewNote: { ...typeScale.caption, color: colors.textSecondary },
  actions: { flexDirection: "row", gap: spacing.s8 },
  actionButton: { flex: 1 }
});
