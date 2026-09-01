import { MishanaerIcon } from "@/components/ui/MishanaerIcon";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/Typography";
import type { ReaderToolbarProps } from "./ReaderToolbar.types";

export const TOOLBAR_HEIGHT = 50;
const CONTROL_HEIGHT = 44;

export function ReaderToolbar({
  tintColor,
  speechState,
  onSpeechPress,
  onCharactersPress,
}: ReaderToolbarProps) {
  const { t } = useTranslation();
  const listening = speechState === "playing";
  const loading = speechState === "loading";
  const speechLabel = listening
    ? t("tts.stopShort", "Стоп")
    : t("reader.listen", "Слушать");

  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          loading ? t("reader.audioLoading", "Загрузка аудио") : speechLabel
        }
        accessibilityState={{ busy: loading, selected: listening }}
        onPress={onSpeechPress}
        style={styles.action}
      >
        {loading ? (
          <ActivityIndicator color={tintColor} size="small" />
        ) : (
          <MishanaerIcon
            name={listening ? "stop" : "headphones"}
            size={22}
            color={tintColor}
          />
        )}
        <Text style={[styles.label, { color: tintColor }]}>{speechLabel}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("narra.characters", "Персонажи")}
        onPress={onCharactersPress}
        style={styles.action}
      >
        <MishanaerIcon name="people" size={22} color={tintColor} />
        <Text style={[styles.label, { color: tintColor }]}>
          {t("narra.characters", "Персонажи")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: "100%",
    height: TOOLBAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 20,
  },
  action: {
    minHeight: CONTROL_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  label: { fontSize: 15, fontWeight: "600" },
});

export type { ReaderToolbarProps } from "./ReaderToolbar.types";
