import { ProfileNumericText } from "@/components/profile/ProfileNumericText";
import { NativeSettingsPicker } from "@/components/settings/NativeSettingsPicker";
import { NativeSymbol } from "@/components/ui/NativeSymbol";
import { ScrollViewMarker } from "@/components/ui/ScrollViewMarker";
import { Text } from "@/components/ui/Typography";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { shareDiagnosticLogs } from "@/lib/diagnostics/diagnostics";
import { toast } from "@/lib/notifications";
import { clearMobileRuntimeCache, formatCacheSize } from "@/lib/platform/mobile-cache";
import { stopTTSPreview } from "@/lib/platform/tts-preview";
import {
  mergeCurrentSessionIntoDailyStats,
  mergeCurrentSessionIntoOverallStats,
} from "@/lib/stats/live-reading-stats";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { ProfileTabStackParamList } from "@/navigation/TabNavigator";
import { NATIVE_SCROLL_EDGE_EFFECTS } from "@/navigation/scroll-edge-effects";
import { useReadingSessionStore, useTTSStore } from "@/stores";
import type { ThemeMode } from "@/styles/ThemeContext";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  headingFontFamily,
  radius,
  spacing,
  useColors,
  useTheme,
  withOpacity,
} from "@/styles/theme";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { changeAndPersistLanguage } from "@readany/core/i18n";
import { readingStatsService } from "@readany/core/stats";
import type { DailyStats, OverallStats } from "@readany/core/stats";
import { eventBus } from "@readany/core/utils/event-bus";
/**
 * ProfileScreen — matching Tauri mobile ProfilePage exactly.
 * Features: reading stats cards, heatmap, settings menu (general/skills/about),
 * complete menu items including Skills and VectorModel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";

// Профильный стек + корневой стек: navigate по неизвестному маршруту всплывает к родителю
type Nav = NativeStackNavigationProp<RootStackParamList & ProfileTabStackParamList>;
type ProfileMenuIcon = {
  name: string;
  fallback: string;
};
type ProfileMenuRoute = Extract<keyof RootStackParamList, "SyncSettings">;
type ProfileMenuItem =
  | {
      icon: ProfileMenuIcon;
      label: string;
      route: ProfileMenuRoute;
      showDot?: boolean;
    }
  | {
      icon: ProfileMenuIcon;
      label: string;
      action: () => void;
      disabled?: boolean;
    };
type ProfileMenuSection = {
  key: "general" | "storage";
  title: string;
  items: ProfileMenuItem[];
};

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

function formatProfileReadingTime(
  minutes: number,
  minuteLabel: string,
  minutesLabel: string,
  hourLabel: string,
  hoursLabel: string,
): string {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  if (roundedMinutes < 60) {
    return `${roundedMinutes}\u00a0${roundedMinutes === 1 ? minuteLabel : minutesLabel}`;
  }

  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;
  return remainingMinutes > 0
    ? `${hours}\u00a0${hours === 1 ? hourLabel : hoursLabel} ${remainingMinutes}\u00a0${
        remainingMinutes === 1 ? minuteLabel : minutesLabel
      }`
    : `${hours}\u00a0${hours === 1 ? hourLabel : hoursLabel}`;
}

function StatCard({
  title,
  value,
  style,
}: {
  title: string;
  value: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const s = makeStyles(colors);
  return (
    <View style={[s.statCard, style]}>
      <View style={s.statCardTitleRow}>
        <Text style={s.statCardTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {title}
        </Text>
      </View>
      <View style={s.statCardBody}>
        <ProfileNumericText value={value} color={colors.foreground} style={s.statCardValue} />
      </View>
    </View>
  );
}

/** Compact heatmap — last 16 weeks, matching Tauri MobileHeatmap */
function MiniHeatmap({ dailyStats }: { dailyStats: DailyStats[] }) {
  const themeColors = useColors();
  const s = makeStyles(themeColors);
  const { t } = useTranslation();
  const WEEKS = 16;
  const DAYS_PER_WEEK = 7;
  const GAP = 2;
  const [containerWidth, setContainerWidth] = useState(0);
  const [selectedCell, setSelectedCell] = useState<{
    date: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);

  // Calculate cell size based on container width
  // containerWidth = WEEKS * CELL + (WEEKS - 1) * GAP
  const CELL = containerWidth > 0 ? Math.floor((containerWidth - (WEEKS - 1) * GAP) / WEEKS) : 8;
  const gridWidth = WEEKS * CELL + (WEEKS - 1) * GAP;
  const gridHeight = DAYS_PER_WEEK * CELL + (DAYS_PER_WEEK - 1) * GAP;

  const cells = useMemo(() => {
    const statsMap = new Map<string, number>();
    for (const d of dailyStats) statsMap.set(d.date, d.totalTime);

    const today = new Date();
    const result: { col: number; row: number; intensity: number; date: string; time: number }[] =
      [];
    const maxTime = Math.max(1, ...dailyStats.map((d) => d.totalTime));

    for (let w = WEEKS - 1; w >= 0; w--) {
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() - (w * 7 + (6 - d)));
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const time = statsMap.get(key) || 0;
        result.push({
          col: WEEKS - 1 - w,
          row: d,
          intensity: time > 0 ? Math.min(1, time / maxTime) : 0,
          date: key,
          time,
        });
      }
    }
    return result;
  }, [dailyStats]);

  const getColor = (intensity: number) => {
    if (intensity <= 0) return themeColors.primary10;
    if (intensity < 0.25) return withOpacity(themeColors.primary, 0.3);
    if (intensity < 0.5) return withOpacity(themeColors.primary, 0.5);
    if (intensity < 0.75) return withOpacity(themeColors.primary, 0.7);
    return withOpacity(themeColors.primary, 0.9);
  };

  const formatDisplayDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${Math.round(minutes)}${t("common.minutes", "分钟")}`;
    return `${(minutes / 60).toFixed(1)}${t("common.hours", "小时")}`;
  };

  const handleCellPress = (cell: { date: string; time: number }, col: number, row: number) => {
    const x = col * (CELL + GAP) + CELL / 2;
    const y = row * (CELL + GAP) + CELL / 2;
    if (selectedCell?.date === cell.date) {
      setSelectedCell(null);
    } else {
      setSelectedCell({ ...cell, x, y });
      setTimeout(() => setSelectedCell(null), 1000);
    }
  };

  // Calculate tooltip position with boundary detection
  const getTooltipStyle = () => {
    if (!selectedCell || containerWidth === 0) return null;
    const TOOLTIP_WIDTH = 80;
    const TOOLTIP_HEIGHT = 24;

    let left = selectedCell.x - TOOLTIP_WIDTH / 2;
    let top = selectedCell.y - TOOLTIP_HEIGHT - 8;

    // Boundary detection
    if (left < 4) left = 4;
    if (left + TOOLTIP_WIDTH > containerWidth - 4) left = containerWidth - TOOLTIP_WIDTH - 4;
    if (top < 4) top = selectedCell.y + CELL + 4; // Show below if no space above

    return { left, top };
  };

  const tooltipStyle = getTooltipStyle();

  return (
    <View
      style={s.heatmapContainer}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
    >
      {containerWidth > 0 && (
        <View style={[s.heatmapGrid, { width: gridWidth, height: gridHeight }]}>
          {cells.map((cell) => (
            <TouchableOpacity
              key={cell.date}
              style={{
                position: "absolute",
                left: cell.col * (CELL + GAP),
                top: cell.row * (CELL + GAP),
                width: CELL,
                height: CELL,
                borderRadius: Math.max(2, CELL * 0.25),
                backgroundColor: getColor(cell.intensity),
              }}
              onPress={() => handleCellPress(cell, cell.col, cell.row)}
              activeOpacity={0.7}
            />
          ))}
        </View>
      )}
      {/* Selected cell tooltip */}
      {selectedCell && tooltipStyle && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            ...tooltipStyle,
            backgroundColor: themeColors.card,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 4,
            borderWidth: 0.5,
            borderColor: themeColors.border,
            minWidth: 80,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.15,
            shadowRadius: 2,
            elevation: 3,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: themeColors.cardForeground,
              fontWeight: "500",
              textAlign: "center",
            }}
          >
            {formatDisplayDate(selectedCell.date)}{" "}
            {selectedCell.time > 0 ? formatTime(selectedCell.time) : t("stats.noReading", "无阅读")}
          </Text>
        </View>
      )}
    </View>
  );
}

export function ProfileScreen() {
  const { colors, mode: themeMode, setMode: setThemeMode, isDark } = useTheme();
  const s = makeStyles(colors);
  const { t, i18n } = useTranslation();
  const layout = useResponsiveLayout();
  const statsGridColumns = layout.isTablet ? 4 : 2;
  const statCardSlotWidth = `${100 / statsGridColumns}%` as `${number}%`;
  const nav = useNavigation<Nav>();
  const [overall, setOverall] = useState<OverallStats | null>(null);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [clearingCache, setClearingCache] = useState(false);
  const [sharingLogs, setSharingLogs] = useState(false);
  const saveCurrentSession = useReadingSessionStore((s) => s.saveCurrentSession);
  const currentSession = useReadingSessionStore((s) => s.currentSession);
  const stopTTS = useTTSStore((s) => s.stop);
  const themeLabels = [
    t("settings.system", "Системная"),
    t("settings.light", "Светлая"),
    t("settings.dark", "Тёмная"),
  ];
  const themeOptions = THEME_MODES.map((value, index) => ({
    value,
    label: themeLabels[index] ?? value,
  }));
  const languageOptions = [
    { value: "ru", label: "Русский" },
    { value: "en", label: "English" },
  ] as const;
  const languageValue = i18n.resolvedLanguage === "en" ? "en" : "ru";

  const loadStats = useCallback(async () => {
    try {
      await saveCurrentSession();

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 365);

      const [daily, overallStats] = await Promise.all([
        readingStatsService.getDailyStats(startDate, endDate),
        readingStatsService.getOverallStats(),
      ]);
      setDailyStats(daily);
      setOverall(overallStats);
    } catch (err) {
      console.error("[ProfileScreen] Failed to load stats:", err);
    }
  }, [saveCurrentSession]);

  useFocusEffect(
    useCallback(() => {
      void loadStats();
    }, [loadStats]),
  );

  useEffect(() => {
    return eventBus.on("sync:completed", () => {
      void loadStats();
    });
  }, [loadStats]);

  const liveDailyStats = useMemo(
    () => mergeCurrentSessionIntoDailyStats(dailyStats, currentSession),
    [dailyStats, currentSession],
  );
  const liveOverall = useMemo(
    () => mergeCurrentSessionIntoOverallStats(overall, dailyStats, currentSession),
    [overall, dailyStats, currentSession],
  );
  const handleClearCache = useCallback(() => {
    Alert.alert(
      t("profile.clearCacheTitle", "清除缓存"),
      t(
        "profile.clearCacheConfirm",
        "将清除临时导入文件、TTS 音频缓存和其他运行缓存。书籍、笔记、设置和同步数据不会被删除。",
      ),
      [
        { text: t("common.cancel", "取消"), style: "cancel" },
        {
          text: t("profile.clearCacheAction", "清除缓存"),
          style: "destructive",
          onPress: async () => {
            setClearingCache(true);
            try {
              stopTTS();
              stopTTSPreview();
              const result = await clearMobileRuntimeCache();
              toast.success(t("profile.clearCacheDoneTitle", "Кэш очищен"), {
                description: t("profile.clearCacheDoneDesc", {
                  count: result.deletedFiles,
                  size: formatCacheSize(result.deletedBytes),
                }),
              });
            } catch (error) {
              console.error("[ProfileScreen] Failed to clear cache:", error);
              toast.error(t("profile.clearCacheFailedTitle", "Не удалось очистить кэш"), {
                description:
                  error instanceof Error
                    ? error.message
                    : t("profile.clearCacheFailedDesc", "Попробуйте ещё раз позже."),
              });
            } finally {
              setClearingCache(false);
            }
          },
        },
      ],
    );
  }, [stopTTS, t]);

  const handleShareLogs = async () => {
    if (sharingLogs) return;
    setSharingLogs(true);
    try {
      await shareDiagnosticLogs(t("profile.shareLogs", "Поделиться логами"));
    } catch {
      toast.error(
        t("profile.shareLogsFailed", "Не удалось открыть отправку логов. Попробуйте снова"),
      );
    } finally {
      setSharingLogs(false);
    }
  };

  // Settings menu — matching Tauri ProfilePage exactly
  const menuSections = useMemo<ProfileMenuSection[]>(
    () => [
      {
        key: "general",
        title: t("settings.general", "通用"),
        items: [
          // Бывший таб «Заметки» — теперь строка меню в стеке Профиля
          {
            icon: { name: "square.and.pencil", fallback: "edit" },
            label: t("tabs.notes", "Заметки"),
            action: () => nav.navigate("ProfileNotes"),
          },
          {
            icon: { name: "text.magnifyingglass", fallback: "search" },
            label: t("tabs.search", "Поиск"),
            action: () => nav.navigate("ProfileSearch"),
          },
          {
            icon: { name: "icloud", fallback: "cloud" },
            label: t("settings.sync", "同步"),
            route: "SyncSettings" as const,
          },
        ],
      },
      {
        key: "storage",
        title: t("profile.storage", "存储"),
        items: [
          {
            icon: { name: "trash", fallback: "delete" },
            label: clearingCache
              ? t("profile.clearingCache", "清除中...")
              : t("profile.clearCache", "清除缓存"),
            action: handleClearCache,
            disabled: clearingCache,
          },
        ],
      },
    ],
    [t, clearingCache, handleClearCache, nav],
  );

  const booksRead = liveOverall?.totalBooks ?? 0;
  const minuteLabel = t("common.minute", "мин");
  const minutesLabel = t("common.minutes", "мин");
  const hourLabel = t("common.hour", "ч");
  const hoursLabel = t("common.hours", "ч");
  const totalTime = formatProfileReadingTime(
    liveOverall?.totalReadingTime ?? 0,
    minuteLabel,
    minutesLabel,
    hourLabel,
    hoursLabel,
  );
  const averageDailyTime = formatProfileReadingTime(
    liveOverall?.avgDailyTime ?? 0,
    minuteLabel,
    minutesLabel,
    hourLabel,
    hoursLabel,
  );
  const streak = liveOverall?.currentStreak ?? 0;
  const overviewCards = [
    {
      key: "time",
      title: t("profile.totalTime", "总时长"),
      value: totalTime,
    },
    {
      key: "average-daily-time",
      title: t("profile.avgDaily", "В среднем за день"),
      value: averageDailyTime,
    },
    {
      key: "books",
      title: t("profile.booksRead", "已读"),
      value: String(booksRead),
    },
    {
      key: "streak",
      title: t("profile.streak", "连续阅读"),
      value: String(streak),
    },
  ];

  return (
    <ScrollViewMarker style={s.scrollView} scrollEdgeEffects={NATIVE_SCROLL_EDGE_EFFECTS}>
      <ScrollView
        style={[s.scrollView, { backgroundColor: colors.background }]}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
      >
        {/* Stats cards */}
        <View style={s.statsSection}>
          <View style={s.statsGrid}>
            {overviewCards.map((card) => (
              <View
                key={card.key}
                style={{
                  width: statCardSlotWidth,
                  paddingHorizontal: 6,
                }}
              >
                <StatCard title={card.title} value={card.value} style={{ width: "100%" }} />
              </View>
            ))}
          </View>
        </View>

        {/* Compact heatmap */}
        <View style={s.heatmapSection}>
          <View style={s.heatmapHeader}>
            <Text style={s.heatmapTitle} numberOfLines={1} maxFontSizeMultiplier={1.5}>
              {t("profile.readingActivity", "阅读活动")}
            </Text>
          </View>
          <MiniHeatmap dailyStats={liveDailyStats} />
        </View>

        {/* Settings menu */}
        {menuSections.map((section) => (
          <View key={section.title} style={s.menuSection}>
            <Text style={s.menuSectionTitle} maxFontSizeMultiplier={1.5}>
              {section.title}
            </Text>
            <View style={s.menuCard}>
              {section.key === "general" && (
                <>
                  <View style={[s.nativePickerRow, s.menuItemBorder]}>
                    <NativeSettingsPicker
                      label={t("settings.theme", "Тема")}
                      selectedValue={themeMode}
                      options={themeOptions}
                      onValueChange={(value) => {
                        if (value === "system" || value === "light" || value === "dark") {
                          setThemeMode(value);
                        }
                      }}
                      colorScheme={isDark ? "dark" : "light"}
                    />
                  </View>
                  <View style={[s.nativePickerRow, s.menuItemBorder]}>
                    <NativeSettingsPicker
                      label={t("settings.language", "Язык")}
                      selectedValue={languageValue}
                      options={languageOptions}
                      onValueChange={(value) => {
                        void changeAndPersistLanguage(value === "en" ? "en" : "ru");
                      }}
                      colorScheme={isDark ? "dark" : "light"}
                    />
                  </View>
                </>
              )}
              {section.items.map((item, idx) => {
                const itemKey = "route" in item ? item.route : item.label;
                const handlePress = () => {
                  if ("disabled" in item && item.disabled) {
                    return;
                  }
                  if ("action" in item && item.action) {
                    item.action();
                  } else if ("route" in item) {
                    nav.navigate(item.route);
                  }
                };
                return (
                  <Pressable
                    key={itemKey}
                    style={({ pressed }) => [
                      s.menuItem,
                      idx < section.items.length - 1 && s.menuItemBorder,
                      pressed && { backgroundColor: colors.primary5 },
                    ]}
                    onPress={handlePress}
                    disabled={"disabled" in item && item.disabled}
                    android_ripple={{ color: colors.primary5 }}
                    accessibilityRole="button"
                  >
                    <NativeSymbol
                      name={item.icon.name}
                      fallback={item.icon.fallback}
                      variant="filled"
                      size={20}
                      color={colors.mutedForeground}
                    />
                    <Text style={s.menuItemLabel} maxFontSizeMultiplier={1.7}>
                      {item.label}
                    </Text>
                    {"showDot" in item && item.showDot ? <View style={s.menuItemDot} /> : null}
                    <NativeSymbol
                      name="chevron.forward"
                      fallback="chevron_right"
                      size={16}
                      color={colors.mutedForeground}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        {__DEV__ && (
          <View style={s.menuSection}>
            <Text style={s.menuSectionTitle} maxFontSizeMultiplier={1.5}>
              {t("profile.development")}
            </Text>
            <View style={s.menuCard}>
              <Pressable
                style={({ pressed }) => [
                  s.menuItem,
                  pressed && { backgroundColor: colors.primary5 },
                ]}
                onPress={() => nav.navigate("Storybook")}
                android_ripple={{ color: colors.primary5 }}
                accessibilityRole="button"
                accessibilityLabel={t("profile.openComponentPreview")}
              >
                <NativeSymbol
                  name="bell"
                  fallback="notifications"
                  variant="filled"
                  size={20}
                  color={colors.mutedForeground}
                />
                <Text style={s.menuItemLabel} maxFontSizeMultiplier={1.7}>
                  {t("profile.componentPreview")}
                </Text>
                <NativeSymbol
                  name="chevron.forward"
                  fallback="chevron_right"
                  size={16}
                  color={colors.mutedForeground}
                />
              </Pressable>
            </View>
          </View>
        )}
        <View style={s.menuSection}>
          <View style={s.menuCard}>
            <Pressable
              style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: colors.primary5 }]}
              onPress={handleShareLogs}
              disabled={sharingLogs}
              accessibilityRole="button"
              accessibilityState={{ disabled: sharingLogs, busy: sharingLogs }}
              accessibilityHint={t("profile.logsPrivacy", "Без текстов книг, переписок и ключей")}
            >
              <NativeSymbol
                name="doc.text"
                fallback="description"
                size={20}
                color={colors.mutedForeground}
              />
              <Text style={s.menuItemLabel} maxFontSizeMultiplier={1.7}>
                {sharingLogs
                  ? t("profile.preparingLogs", "Подготовка логов…")
                  : t("profile.shareLogs", "Поделиться логами")}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </ScrollViewMarker>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    headerTitleWrap: {
      flex: 1,
      minWidth: 0,
      marginRight: 12,
    },
    headerTitle: {
      fontFamily: headingFontFamily,
      fontSize: fontSize["2xl"],
      lineHeight: fontSize["2xl"] * 1.4,
      fontWeight: fontWeight.bold,
      color: colors.foreground,
    },
    scrollView: { flex: 1 },
    scrollContent: {
      paddingBottom: 12,
      gap: spacing.xxl,
    },
    // Stats
    statsSection: { paddingHorizontal: 16, paddingTop: 16 },
    statsGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      rowGap: 12,
      marginHorizontal: -6,
    },
    statCard: {
      backgroundColor: colors.elevation1,
      borderRadius: radius.card,
      borderWidth: 0.5,
      borderColor: colors.primary5,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 10,
      minHeight: 102,
    },
    statCardHeader: {
      marginBottom: 10,
    },
    statCardTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      minWidth: 0,
    },
    statCardTitle: {
      fontFamily: headingFontFamily,
      flex: 1,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: fontWeight.medium,
      color: withOpacity(colors.mutedForeground, 0.8),
    },
    statCardBody: { flexDirection: "row", alignItems: "baseline", gap: 4 },
    statCardValue: {
      flexShrink: 1,
      fontSize: 25,
      lineHeight: 32,
      fontWeight: fontWeight.bold,
      color: colors.foreground,
      letterSpacing: -0.8,
    },
    statCardMetaRow: {
      marginTop: 6,
    },
    statCardMetaText: {
      fontSize: 11,
      lineHeight: 16,
      color: withOpacity(colors.mutedForeground, 0.72),
    },
    statCardMetaLabel: {
      color: withOpacity(colors.mutedForeground, 0.72),
    },
    statCardMetaDivider: {
      color: withOpacity(colors.mutedForeground, 0.46),
    },
    statCardMetaValue: {
      fontWeight: fontWeight.semibold,
      color: withOpacity(colors.foreground, 0.78),
    },
    // Heatmap
    heatmapSection: {
      marginHorizontal: 16,
      backgroundColor: colors.elevation1,
      borderRadius: radius.card,
      borderWidth: 0.5,
      borderColor: colors.primary5,
      padding: 16,
    },
    heatmapHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
    },
    heatmapTitle: {
      fontFamily: headingFontFamily,
      flex: 1,
      minWidth: 0,
      fontSize: fontSize.sm,
      lineHeight: fontSize.sm * 1.5,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
    },
    heatmapContainer: { width: "100%" },
    heatmapGrid: { alignSelf: "center" },
    // Menu
    menuSection: { paddingHorizontal: 16 },
    menuSectionTitle: {
      fontFamily: headingFontFamily,
      fontSize: fontSize.xs,
      lineHeight: fontSize.xs * 1.5,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: 8,
    },
    nativePickerRow: { minHeight: 58 },
    menuCard: {
      backgroundColor: colors.elevation1,
      borderRadius: radius.card,
      borderWidth: 0.5,
      borderColor: colors.primary5,
      overflow: "hidden",
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    menuItemBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    menuItemLabel: {
      flex: 1,
      fontSize: fontSize.md,
      lineHeight: fontSize.md * 1.5,
      color: colors.foreground,
    },
    menuItemDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.destructive,
    },
  });
