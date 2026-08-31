import { AnimatedNarraFace } from "@/components/chat/animated-narra-face";
import {
  CharacterChatAvatar,
  CharacterChatList,
  type CharacterChatListItem,
} from "@/components/chats/character-chat-list";
import { CharacterPortraitImage } from "@/components/narra/character-portrait-image";
import { CenteredEmptyState } from "@/components/ui/centered-empty-state";
import { EmptyStateActionButton } from "@/components/ui/empty-state-action-button";
import { InitialsAvatar } from "@/components/ui/initials-avatar";
import { NativeSegmentedPager } from "@/components/ui/native-segmented-pager";
import { getBookTabLabel } from "@/lib/book/book-tab-label";
import { countRender } from "@/lib/diagnostics/interaction-performance";
import { loadBackendCharacterMedia } from "@/lib/narra/backend-character-media";
import { characterProfileText } from "@/lib/narra/character-profile";
import {
  type ChatListModel,
  type ChatListRow,
  createChatListSelector,
} from "@/lib/narra/chat-list-model";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { TabParamList } from "@/navigation/TabNavigator";
import { useLibraryStore, useNarraStore } from "@/stores";
import type { NarraState } from "@/stores/narra-store";
import { type ThemeColors, spacing, useTheme } from "@/styles/theme";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const _MAX_AUTOMATIC_PORTRAIT_ATTEMPTS = 2;
const EMPTY_ROWS: readonly ChatListRow[] = [];

export function ChatsScreen() {
  const books = useLibraryStore((state) => state.books);
  const selectChatList = useMemo(() => createChatListSelector(), []);
  const selectModel = useCallback(
    (state: NarraState) => selectChatList(books, state.books),
    [books, selectChatList],
  );
  const model = useNarraStore(selectModel);

  return <ChatsContent model={model} />;
}

const ChatsContent = memo(function ChatsContent({ model }: { model: ChatListModel }) {
  countRender("chats.screen");
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: viewportHeight } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const [selectedBookId, setSelectedBookId] = useState("all");
  const segmentValues = useMemo(
    () => [t("common.all", "Все"), ...model.books.map((book) => getBookTabLabel(book.title))],
    [model.books, t],
  );
  const selectedSegmentIndex = Math.max(
    0,
    model.books.findIndex((book) => book.id === selectedBookId) + 1,
  );
  const rows =
    selectedBookId === "all" ? model.allRows : (model.rowsByBook.get(selectedBookId) ?? EMPTY_ROWS);

  useEffect(() => {
    if (selectedBookId !== "all" && !model.rowsByBook.has(selectedBookId)) {
      setSelectedBookId("all");
    }
  }, [model.rowsByBook, selectedBookId]);

  const openChat = useCallback(
    (row: ChatListRow) => {
      if (!row.unlocked) {
        navigation.navigate("NarraCharacterProfile", {
          bookId: row.bookId,
          characterId: row.character.id,
        });
        return;
      }
      navigation.navigate("NarraCharacterChat", {
        bookId: row.bookId,
        characterId: row.character.id,
      });
    },
    [navigation],
  );

  const openNarraChat = useCallback(
    (bookId: string) => {
      if (bookId === "all") {
        navigation.navigate("Chat");
        return;
      }
      navigation.navigate("BookChat", { bookId });
    },
    [navigation],
  );

  const goToCatalog = useCallback(() => {
    navigation.getParent<BottomTabNavigationProp<TabParamList>>()?.navigate("Library", {
      screen: "LibraryHome",
      params: { initialSection: "catalog" },
    });
  }, [navigation]);

  const selectChatPage = useCallback(
    (index: number) => {
      setSelectedBookId(index === 0 ? "all" : (model.books[index - 1]?.id ?? "all"));
    },
    [model.books],
  );

  if (model.books.length === 0) {
    return (
      <CenteredEmptyState
        avoidNativeTabBar
        title={t("chats.emptyTitle", "Чаты с героями появятся после добавления книги")}
        description={t("chats.emptyDescription", "С ними можно будет пообщаться")}
      >
        <EmptyStateActionButton
          label={t("chats.emptyAction", "Добавить")}
          accessibilityLabel={t("chats.emptyAction", "Добавить")}
          onPress={goToCatalog}
        />
      </CenteredEmptyState>
    );
  }

  return (
    <>
      <ChatPortraitWorker rows={rows} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <NativeSegmentedPager
          values={segmentValues}
          selectedIndex={selectedSegmentIndex}
          onSelect={selectChatPage}
          colorScheme={isDark ? "dark" : "light"}
          accessibilityLabel={t("chats.bookFilter", "Фильтр по книге")}
          scrollableSegments
          controlsStyle={styles.tabs}
          minimumPageHeight={Math.max(1, viewportHeight - insets.top - insets.bottom - 120)}
        >
          {segmentValues.map((_, index) => {
            const pageBookId = index === 0 ? "all" : (model.books[index - 1]?.id ?? "all");
            return (
              <View key={pageBookId}>
                <ChatsPage
                  pageBookId={pageBookId}
                  rows={
                    pageBookId === "all"
                      ? model.allRows
                      : (model.rowsByBook.get(pageBookId) ?? EMPTY_ROWS)
                  }
                  onOpenChat={openChat}
                  onOpenNarraChat={openNarraChat}
                />
              </View>
            );
          })}
        </NativeSegmentedPager>
      </ScrollView>
    </>
  );
});

const ChatsPage = memo(function ChatsPage({
  pageBookId,
  rows,
  onOpenChat,
  onOpenNarraChat,
}: {
  pageBookId: string;
  rows: readonly ChatListRow[];
  onOpenChat: (row: ChatListRow) => void;
  onOpenNarraChat: (bookId: string) => void;
}) {
  const { t } = useTranslation();
  const narraItem = useMemo<CharacterChatListItem>(
    () => ({
      key: "narra",
      accessibilityLabel:
        pageBookId === "all"
          ? t("narra.openNarraChat", "Открыть чат с Narra")
          : t("narra.openNarraBookChat", "Открыть чат с Narra об этой книге"),
      title: "Narra",
      subtitle:
        pageBookId === "all"
          ? t("narra.askAboutBooks", "Спросите что угодно о книгах")
          : t("narra.askAboutBook", "Спросите что угодно о книге"),
      onPress: () => onOpenNarraChat(pageBookId),
      avatar: <FocusedNarraAvatar />,
    }),
    [pageBookId, onOpenNarraChat, t],
  );
  const itemForRow = useMemo(() => {
    const cache = new WeakMap<ChatListRow, CharacterChatListItem>();
    return (row: ChatListRow): CharacterChatListItem => {
      const existing = cache.get(row);
      if (existing) return existing;
      const rowKey = `${row.bookId}:${row.character.id}`;
      const unlockPercent = Math.round(Math.max(0, Math.min(1, row.character.unlockProgress ?? 0)) * 100);
      const item: CharacterChatListItem = {
        key: rowKey,
        accessibilityLabel: `${row.character.name}, ${row.bookTitle}`,
        title: row.character.fullName || row.character.name,
        subtitle: row.unlocked
          ? characterProfileText(row.character, "description")
          : t("narra.lockedCharacterProgressHint", "откроется на {{percent}}%", {
              percent: unlockPercent,
            }),
        dimmed: !row.unlocked,
        onPress: () => onOpenChat(row),
        avatar: (
          <CharacterChatAvatar muted={!row.unlocked}>
            <CharacterPortraitImage
              character={row.character}
              resizeMode="cover"
              cropAnchor="top"
              staticOnly
              style={avatarStyles.image}
              fallback={
                <InitialsAvatar
                  size={56}
                  userId={rowKey}
                  name={row.character.fullName || row.character.name}
                />
              }
            />
          </CharacterChatAvatar>
        ),
      };
      cache.set(row, item);
      return item;
    };
  }, [onOpenChat, t]);
  const items = useMemo(() => {
    countRender("chats.page.build");
    return [narraItem, ...rows.map(itemForRow)];
  }, [narraItem, rows, itemForRow]);

  return <CharacterChatList items={items} />;
});

// Only this small animation leaf and the queue worker subscribe to tab focus.
function FocusedNarraAvatar() {
  const isFocused = useIsFocused();
  return (
    <CharacterChatAvatar muted>
      <AnimatedNarraFace width={38} height={40} animated={isFocused} />
    </CharacterChatAvatar>
  );
}

function ChatPortraitWorker({ rows }: { rows: readonly ChatListRow[] }) {
  const isFocused = useIsFocused();
  const bookIdsKey = [...new Set(rows.map((row) => row.bookId))].join("\0");
  useEffect(() => {
    if (!isFocused) return;
    const controller = new AbortController();
    for (const id of bookIdsKey.split("\0")) {
      const book = useLibraryStore.getState().books.find((item) => item.id === id);
      if (book) void loadBackendCharacterMedia(id, book.progress, controller.signal);
    }
    return () => controller.abort();
  }, [isFocused, bookIdsKey]);

  return null;
}

const avatarStyles = StyleSheet.create({ image: { width: "100%", height: "100%" } });

const makeStyles = (colors: ThemeColors, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xxl + bottomInset,
    },
    tabs: {
      marginHorizontal: -spacing.lg,
      paddingBottom: spacing.lg,
    },
  });
