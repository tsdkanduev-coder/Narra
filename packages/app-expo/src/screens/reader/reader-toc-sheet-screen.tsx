import { getStrokeIconImageSource } from "@/components/ui/MishanaerIcon";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { useTheme } from "@/styles/theme";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { ReaderContentsPanel } from "./ReaderContentsPanel";
import { ReaderTOCSheetCloseButton } from "./ReaderTOCSheetCloseButton";
import { useReaderTOCSheet } from "./reader-toc-sheet-context";

type Props = NativeStackScreenProps<RootStackParamList, "ReaderTOC">;

export function ReaderTOCSheetScreen({ navigation }: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const { session } = useReaderTOCSheet();
  const handleClose = useCallback(() => {
    if (session) {
      session.onClose();
      return;
    }
    navigation.goBack();
  }, [navigation, session]);

  useLayoutEffect(() => {
    navigation.setOptions({
      contentStyle: { backgroundColor: colors.card },
      headerShown: true,
      headerBackVisible: false,
      headerTitle: t("reader.contents", "Содержание"),
      headerTitleAlign: "center",
      ...(Platform.OS === "ios"
        ? {
            headerRight: undefined,
            unstable_headerRightItems: () => [
              {
                type: "button" as const,
                label: t("common.close", "Закрыть"),
                accessibilityLabel: t("common.close", "Закрыть"),
                icon: {
                  type: "image" as const,
                  source: getStrokeIconImageSource("x"),
                },
                onPress: handleClose,
              },
            ],
          }
        : {
            unstable_headerRightItems: undefined,
            headerRight: () => (
              <ReaderTOCSheetCloseButton
                accessibilityLabel={t("common.close", "Закрыть")}
                colorScheme={isDark ? "dark" : "light"}
                foregroundColor={colors.foreground}
                onPress={handleClose}
              />
            ),
          }),
    });
  }, [colors.card, colors.foreground, handleClose, isDark, navigation, t]);

  if (!session) {
    return <View style={[styles.container, { backgroundColor: colors.card }]} />;
  }

  return (
    <View collapsable={false} style={[styles.container, { backgroundColor: colors.card }]}>
      <ReaderContentsPanel session={session} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
