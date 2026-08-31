import { Text, TextInput } from "@/components/ui/Typography";
import { useTheme } from "@/styles/theme";
import { spacingPixels } from "@deslop/primitives";
import { Host, List, ListItem, Text as ExpoText } from "@expo/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ReaderTOCPanel } from "./ReaderTOCPanel";
import type { ReaderTOCSheetSession } from "./reader-toc-sheet-context";

type ContentsTab = "toc" | "bookmarks" | "search";

export function ReaderContentsPanel({ session }: { session: ReaderTOCSheetSession }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [tab, setTab] = useState<ContentsTab>("toc");
  const tabs: { key: ContentsTab; label: string }[] = [
    { key: "toc", label: t("reader.toc", "Оглавление") },
    { key: "bookmarks", label: t("reader.bookmarks", "Закладки") },
    { key: "search", label: t("reader.search", "Поиск") },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        {tabs.map((item) => {
          const active = tab === item.key;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(item.key)}
              style={[
                styles.tab,
                { borderBottomColor: active ? colors.primary : "transparent" },
              ]}
            >
              <Text
                style={[
                  styles.tabLabel,
                  { color: active ? colors.primary : colors.mutedForeground },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {tab === "toc" ? (
        <ReaderTOCPanel
          toc={session.toc}
          currentChapter={session.currentChapter}
          onSelectTocItem={session.onSelectTocItem}
        />
      ) : null}
      {tab === "bookmarks" ? (
        <Host style={{ flex: 1 }}>
          <List>
            {session.bookmarks.length > 0 ? (
              session.bookmarks.map((bookmark) => (
                <ListItem key={bookmark.id} onPress={() => session.onSelectCfi(bookmark.cfi)}>
                  <ExpoText>
                    {bookmark.label?.trim() ||
                      bookmark.chapterTitle?.trim() ||
                      t("reader.currentPage", "Текущая страница")}
                  </ExpoText>
                </ListItem>
              ))
            ) : (
              <ListItem>
                <ExpoText>{t("bookmarks.empty", "Закладок пока нет")}</ExpoText>
              </ListItem>
            )}
          </List>
        </Host>
      ) : null}
      {tab === "search" ? (
        <View style={styles.search}>
          <TextInput
            value={session.search.query}
            onChangeText={session.search.onChangeQuery}
            onSubmitEditing={session.search.onSubmit}
            placeholder={t("reader.searchInBook", "Искать в книге…")}
            returnKeyType="search"
            autoCorrect={false}
            style={[styles.searchInput, { color: colors.foreground, borderColor: colors.border }]}
          />
          {session.search.isSearching ? (
            <Text style={{ color: colors.mutedForeground, padding: spacingPixels[16] }}>
              {t("reader.loading", "Загрузка…")}
            </Text>
          ) : null}
          {session.search.timedOut ? (
            <Text style={{ color: colors.mutedForeground, padding: spacingPixels[16] }}>
              {t("reader.searchTimedOut", "Поиск занял слишком долго. Попробуйте фразу покороче.")}
            </Text>
          ) : null}
          <Host style={{ flex: 1 }}>
            <List>
              {session.search.results.length > 0 ? (
                session.search.results.map((result) => (
                  <ListItem key={result.cfi} onPress={() => session.search.onSelect(result.cfi)}>
                    <ExpoText numberOfLines={3}>
                      {`${result.pre}${result.match}${result.post}`.trim()}
                    </ExpoText>
                  </ListItem>
                ))
              ) : session.search.query.trim() && !session.search.isSearching ? (
                <ListItem>
                  <ExpoText>
                    {t("reader.searchEmptyHint", "Введите слово или фразу — найдём по всей книге")}
                  </ExpoText>
                </ListItem>
              ) : null}
            </List>
          </Host>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabs: { flexDirection: "row", paddingHorizontal: spacingPixels[16] },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacingPixels[12],
    borderBottomWidth: 2,
  },
  tabLabel: { fontSize: 15, fontWeight: "600" },
  search: { flex: 1 },
  searchInput: {
    marginHorizontal: spacingPixels[16],
    marginVertical: spacingPixels[12],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: spacingPixels[10],
    paddingHorizontal: spacingPixels[12],
    paddingVertical: spacingPixels[10],
    fontSize: 16,
  },
});
