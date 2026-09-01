import { Text } from "@/components/ui/Typography";
import { openMobileBook } from "@/lib/library/open-mobile-book";
import { toast } from "@/lib/notifications";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
/**
 * ChatScreen — full AI chat matching app-mobile ChatPage layout.
 * Sliding sidebar for threads, compact header, empty state with suggestions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBackendBook } from "@/hooks/use-backend-book";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { completeNarraChat } from "@/lib/ai/narra-chat";
import {
  NarraServiceError,
  emptyBookSearchCode,
  reportNarraError,
  searchNotReadyCode,
} from "@/lib/narra/errors";
import { useLibraryStore, useNarraStore } from "@/stores";
import { useChatStore } from "@/stores/chat-store";
import type { AttachedQuote, Message } from "@readany/core/types";
import type { CitationPart } from "@readany/core/types/message";
import {
  convertToMessageV2,
  formatRelativeTimeShort,
  getMonthLabel,
  groupThreadsByTime,
} from "@readany/core/utils";
import * as Crypto from "expo-crypto";

import { NarraChat } from "@/components/chat/NarraChat";
import { AnimatedNarraFace } from "@/components/chat/animated-narra-face";
import {
  NARRA_CHAT_EMBEDDED_TOP_INSET,
  NARRA_CHAT_HEADER_HEIGHT,
  NarraChatHeader,
} from "@/components/chat/narra-chat-header";
import { MessageCirclePlusIcon, Trash2Icon, XIcon } from "@/components/ui/Icon";
import {
  fontSize as fs,
  fontWeight as fw,
  headingFontFamily,
  radius,
  useColors,
  withOpacity,
} from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";

type ChatRoute = RouteProp<RootStackParamList, "Chat"> | RouteProp<RootStackParamList, "BookChat">;

interface ChatScreenProps {
  embedded?: boolean;
  embeddedBookId?: string;
  onBack?: () => void;
}

function composeChatPrompt(text: string, quotes?: AttachedQuote[]): string {
  const trimmed = text.trim();
  if (quotes && quotes.length > 0) {
    const quotesText = quotes.map((quote) => `> ${quote.text.slice(0, 300)}`).join("\n\n");
    return trimmed
      ? `Про этот фрагмент:\n${quotesText}\n\n${trimmed}`
      : `Про этот фрагмент:\n${quotesText}\n\nРазбери этот отрывок.`;
  }
  return trimmed;
}

function buildNarraChatSystemPrompt(title?: string, progress?: number): string {
  if (!title) {
    return "Ты — Narra, спутница чтения. Отвечай по-русски, коротко и по делу. Не выдумывай факты книг. Не говори, что ты ИИ.";
  }
  const percent = Math.round(Math.max(0, Math.min(1, progress ?? 0)) * 100);
  return `Ты — Narra, спутница чтения книги «${title}». Отвечай по-русски, коротко и по делу.
Читатель прошёл примерно ${percent}% книги. Не раскрывай события дальше этой точки.
Опирайся только на фрагменты книги, которые приложены к запросу. Если их нет или недостаточно — скажи, что не можешь ответить по книге, не выдумывай.
Не говори, что ты ИИ.`;
}

export function ChatScreen({
  embedded = false,
  embeddedBookId,
  onBack: embeddedBack,
}: ChatScreenProps = {}) {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<ChatRoute>();
  const bookParams = route.name === "BookChat" ? route.params : undefined;
  const bookId = embeddedBookId ?? bookParams?.bookId;
  const books = useLibraryStore((state) => state.books);
  const book = useMemo(
    () => (bookId ? books.find((item) => item.id === bookId) : undefined),
    [bookId, books],
  );
  useBackendBook(book);
  const narraBook = useNarraStore((state) => (bookId ? state.books[bookId] : undefined));
  const bookEditionId = narraBook?.backendBinding?.bookEditionId || book?.bookEditionId;
  const [quotes, setQuotes] = useState<AttachedQuote[]>([]);
  const [sending, setSending] = useState(false);
  const lastFailedRef = useRef<{
    text: string;
    quotes?: AttachedQuote[];
    reuseUserMessage: boolean;
  } | null>(null);
  const handleRetryRef = useRef<() => void>(() => {});
  const headerSafeAreaTop = embedded ? NARRA_CHAT_EMBEDDED_TOP_INSET : insets.top;
  const headerHeight = headerSafeAreaTop + NARRA_CHAT_HEADER_HEIGHT;
  const goBack = useCallback(() => {
    void KeyboardController.dismiss({ animated: true, keepFocus: false });
    if (embeddedBack) {
      embeddedBack();
      return;
    }
    navigation.goBack();
  }, [embeddedBack, navigation]);

  useEffect(() => {
    if (!bookParams?.selectedText || quotes.length > 0) return;
    setQuotes([
      {
        id: `quote-${Date.now()}`,
        text: bookParams.selectedText,
        source: bookParams.chapterTitle || undefined,
      },
    ]);
  }, [bookParams?.chapterTitle, bookParams?.selectedText, quotes.length]);
  const layout = useResponsiveLayout();
  const isTabletLandscape = layout.isTabletLandscape;
  const sidebarWidth = isTabletLandscape
    ? Math.min(360, layout.width * 0.28)
    : Math.min(layout.width * 0.75, 300);
  const s = useMemo(
    () =>
      makeStyles(colors, {
        isTabletLandscape,
        sidebarWidth,
        horizontalPadding: layout.horizontalPadding,
      }),
    [colors, isTabletLandscape, layout.horizontalPadding, sidebarWidth],
  );

  // Thread sidebar
  const [showSidebar, setShowSidebar] = useState(false);
  const sidebarAnim = useRef(new Animated.Value(-sidebarWidth)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const showSidebarRef = useRef(showSidebar);
  useEffect(() => {
    showSidebarRef.current = showSidebar;
  }, [showSidebar]);

  useEffect(() => {
    if (isTabletLandscape) {
      setShowSidebar(false);
      sidebarAnim.setValue(0);
      backdropAnim.setValue(0);
      return;
    }
    if (!showSidebarRef.current) {
      sidebarAnim.setValue(-sidebarWidth);
    }
  }, [backdropAnim, isTabletLandscape, sidebarAnim, sidebarWidth]);

  const closeSidebar = useCallback(() => {
    if (isTabletLandscape) return;
    Animated.parallel([
      Animated.spring(sidebarAnim, {
        toValue: -sidebarWidth,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }),
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setShowSidebar(false);
    });
  }, [backdropAnim, isTabletLandscape, sidebarAnim, sidebarWidth]);

  // Chat store
  const threads = useChatStore((s) => s.threads);
  const generalActiveThreadId = useChatStore((s) => s.generalActiveThreadId);
  const initialized = useChatStore((s) => s.initialized);
  const loadAllThreads = useChatStore((s) => s.loadAllThreads);
  const loadThreads = useChatStore((s) => s.loadThreads);
  const removeThread = useChatStore((s) => s.removeThread);
  const setGeneralActiveThread = useChatStore((s) => s.setGeneralActiveThread);
  const setBookActiveThread = useChatStore((s) => s.setBookActiveThread);
  const getActiveThreadId = useChatStore((s) => s.getActiveThreadId);
  const getThreadsForContext = useChatStore((s) => s.getThreadsForContext);
  const createThread = useChatStore((s) => s.createThread);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateThreadTitle = useChatStore((s) => s.updateThreadTitle);

  useEffect(() => {
    if (bookId) {
      void loadThreads(bookId);
    } else if (!initialized) {
      void loadAllThreads();
    }
  }, [bookId, initialized, loadAllThreads, loadThreads]);

  const contextThreads = getThreadsForContext(bookId);
  const activeThreadId = bookId ? getActiveThreadId(bookId) : generalActiveThreadId;
  const firstContextThreadId = contextThreads[0]?.id;

  useEffect(() => {
    if (bookId && !activeThreadId && firstContextThreadId) {
      setBookActiveThread(bookId, firstContextThreadId);
    }
  }, [activeThreadId, bookId, firstContextThreadId, setBookActiveThread]);

  const activeThread = activeThreadId
    ? threads.find((thread) => thread.id === activeThreadId)
    : null;
  const allMessages = convertToMessageV2(activeThread?.messages || []);

  const getOrCreateThread = useCallback(async () => {
    const {
      threads: freshThreads,
      generalActiveThreadId,
      bookActiveThreadIds,
    } = useChatStore.getState();
    const activeId = bookId ? bookActiveThreadIds[bookId] || null : generalActiveThreadId;
    const existing = activeId ? freshThreads.find((thread) => thread.id === activeId) : null;
    if (existing) return existing;
    return await createThread(bookId);
  }, [bookId, createThread]);

  const showChatFailure = useCallback(
    (error: unknown) => {
      const normalized = reportNarraError("narra_chat", error);
      const readyCode = searchNotReadyCode(error) || searchNotReadyCode(normalized);
      const emptyCode = emptyBookSearchCode(error) || emptyBookSearchCode(normalized);
      toast.error(
        readyCode
          ? t("chat.searchNotReady", "SEARCH_NOT_READY")
          : emptyCode
            ? t("chat.searchEmpty", "Ничего не найдено")
            : t("chat.responseFailed", "Не удалось получить ответ"),
        {
          description: readyCode
            ? t(
                "chat.searchNotReadyMessage",
                "Поиск по книге ещё не готов. Ответ без книги недоступен.",
              )
            : emptyCode
              ? t(
                  "chat.searchEmptyMessage",
                  "По книге нет фрагментов для ответа. Ответ без книги недоступен.",
                )
              : normalized.message,
          action: {
            label: t("common.retry", "Повторить"),
            onClick: () => handleRetryRef.current(),
          },
        },
      );
    },
    [t],
  );

  const sendChat = useCallback(
    async (text: string, attachedQuotes?: AttachedQuote[], reuseUserMessage = false) => {
      const prompt = composeChatPrompt(text, attachedQuotes);
      if (!prompt || sending) return;

      lastFailedRef.current = { text, quotes: attachedQuotes, reuseUserMessage };

      if (bookId && !bookEditionId) {
        showChatFailure(
          new NarraServiceError(
            "SERVICE",
            "Поиск по книге ещё не готов (SEARCH_NOT_READY). Ответ без книги недоступен.",
            undefined,
            undefined,
            "SEARCH_NOT_READY",
          ),
        );
        return;
      }

      setSending(true);
      let userPersisted = reuseUserMessage;
      try {
        const thread = await getOrCreateThread();
        if (!reuseUserMessage && thread.messages.length === 0 && !thread.title) {
          await updateThreadTitle(thread.id, (text.trim() || prompt).slice(0, 50));
        }

        if (!reuseUserMessage) {
          const userMessage: Message = {
            id: Crypto.randomUUID(),
            threadId: thread.id,
            role: "user",
            content: prompt,
            createdAt: Date.now(),
          };
          await addMessage(thread.id, userMessage);
          userPersisted = true;
          lastFailedRef.current = { text, quotes: attachedQuotes, reuseUserMessage: true };
        }

        const fresh =
          useChatStore.getState().threads.find((item) => item.id === thread.id) ?? thread;
        const history = fresh.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-18)
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          }));

        const content = await completeNarraChat({
          messages: [
            {
              role: "system",
              content: buildNarraChatSystemPrompt(book?.meta.title, book?.progress),
            },
            ...history,
          ],
          temperature: 0.8,
          purpose: bookEditionId ? "character_chat" : "summary",
          origin: "user",
          analyticsTier: "essential",
          bookEditionId,
        });

        await addMessage(thread.id, {
          id: Crypto.randomUUID(),
          threadId: thread.id,
          role: "assistant",
          content,
          createdAt: Date.now(),
        });
        lastFailedRef.current = null;
      } catch (error) {
        lastFailedRef.current = {
          text,
          quotes: attachedQuotes,
          reuseUserMessage: userPersisted,
        };
        showChatFailure(error);
      } finally {
        setSending(false);
      }
    },
    [
      addMessage,
      book?.meta.title,
      book?.progress,
      bookEditionId,
      bookId,
      getOrCreateThread,
      sending,
      showChatFailure,
      updateThreadTitle,
    ],
  );

  const handleSend = useCallback(
    async (
      text: string,
      _deepThinking: boolean,
      _spoilerFree: boolean,
      nextQuotes?: AttachedQuote[],
    ) => {
      await sendChat(text, nextQuotes, false);
    },
    [sendChat],
  );

  const handleRetry = useCallback(async () => {
    const failed = lastFailedRef.current;
    if (!failed || sending) return;
    await sendChat(failed.text, failed.quotes, failed.reuseUserMessage);
  }, [sendChat, sending]);
  handleRetryRef.current = () => {
    void handleRetry();
  };

  const handleNewThread = useCallback(() => {
    if (bookId) {
      setBookActiveThread(bookId, null);
    } else {
      setGeneralActiveThread(null);
    }
    closeSidebar();
  }, [bookId, closeSidebar, setBookActiveThread, setGeneralActiveThread]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (bookId) {
        setBookActiveThread(bookId, threadId);
      } else {
        setGeneralActiveThread(threadId);
      }
      closeSidebar();
    },
    [bookId, closeSidebar, setBookActiveThread, setGeneralActiveThread],
  );

  const handleRemoveQuote = useCallback((id: string) => {
    setQuotes((current) => current.filter((quote) => quote.id !== id));
  }, []);

  const handleCitationClick = useCallback(
    (citation: CitationPart) => {
      if (!citation.bookId) return;
      void openMobileBook({
        bookId: citation.bookId,
        navigation,
        t,
        cfi: citation.cfi,
        highlight: true,
      });
    },
    [navigation, t],
  );

  const formatTime = useCallback((ts: number) => formatRelativeTimeShort(ts, t), [t]);

  const groupedThreads = useMemo(() => {
    const grouped = groupThreadsByTime(contextThreads);
    const sections: { key: string; label: string; threads: typeof contextThreads }[] = [
      { key: "today", label: t("chat.today", "今天"), threads: grouped.today },
      { key: "yesterday", label: t("chat.yesterday", "昨天"), threads: grouped.yesterday },
      { key: "last7Days", label: t("chat.last7Days", "7 天内"), threads: grouped.last7Days },
      { key: "last30Days", label: t("chat.last30Days", "30 天内"), threads: grouped.last30Days },
    ];

    const olderByMonth = new Map<string, typeof contextThreads>();
    for (const thread of grouped.older) {
      const monthLabel = getMonthLabel(thread.updatedAt);
      let monthThreads = olderByMonth.get(monthLabel);
      if (!monthThreads) {
        monthThreads = [];
        olderByMonth.set(monthLabel, monthThreads);
      }
      monthThreads.push(thread);
    }
    const sortedMonths = [...olderByMonth.keys()].sort((a, b) => b.localeCompare(a));
    for (const month of sortedMonths) {
      const monthThreads = olderByMonth.get(month);
      if (monthThreads) {
        sections.push({ key: month, label: month, threads: monthThreads });
      }
    }

    return sections;
  }, [contextThreads, t]);

  const renderSidebarContent = useCallback(
    (closable: boolean) => (
      <>
        <View style={s.sidebarHeader}>
          <Text style={s.sidebarTitle}>{t("chat.history", "历史记录")}</Text>
          {closable ? (
            <TouchableOpacity style={s.iconBtn} onPress={closeSidebar}>
              <XIcon size={16} color={colors.foreground} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.newChatBtn} onPress={handleNewThread} activeOpacity={0.75}>
              <MessageCirclePlusIcon size={15} color={colors.foreground} />
            </TouchableOpacity>
          )}
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
        >
          {contextThreads.length === 0 ? (
            <View style={s.sidebarEmpty}>
              <Text style={s.sidebarEmptyText}>{t("chat.noConversations", "暂无对话")}</Text>
            </View>
          ) : (
            groupedThreads.map(({ key, label, threads }) => {
              if (threads.length === 0) return null;
              return (
                <View key={key}>
                  <Text style={s.sectionLabel}>{label}</Text>
                  {threads.map((thread) => {
                    const isActive = thread.id === activeThreadId;
                    const lastMsg =
                      thread.messages.length > 0
                        ? thread.messages[thread.messages.length - 1]
                        : null;
                    const preview = lastMsg?.content?.slice(0, 60) || "";
                    return (
                      <TouchableOpacity
                        key={thread.id}
                        style={[s.threadItem, isActive && s.threadItemActive]}
                        onPress={() => handleSelectThread(thread.id)}
                        activeOpacity={0.7}
                      >
                        <View style={s.threadContent}>
                          <View style={s.threadTitleRow}>
                            <Text
                              style={[s.threadTitle, isActive && s.threadTitleActive]}
                              numberOfLines={1}
                            >
                              {thread.title || t("chat.newChat", "新对话")}
                            </Text>
                            <Text style={s.threadTime}>{formatTime(thread.updatedAt)}</Text>
                          </View>
                          {preview ? (
                            <Text style={s.threadPreview} numberOfLines={1}>
                              {preview}
                            </Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          style={s.threadDeleteBtn}
                          onPress={() => removeThread(thread.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Trash2Icon size={12} color={colors.mutedForeground} />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })
          )}
        </ScrollView>
      </>
    ),
    [
      closeSidebar,
      colors.foreground,
      colors.mutedForeground,
      activeThreadId,
      contextThreads.length,
      formatTime,
      groupedThreads,
      handleNewThread,
      handleSelectThread,
      removeThread,
      s,
      t,
    ],
  );

  return (
    <View style={s.container}>
      <View style={s.shell}>
        {isTabletLandscape && (
          <View style={[s.sidebarDocked, { paddingTop: insets.top }]}>
            {renderSidebarContent(false)}
          </View>
        )}

        <View style={s.mainColumn}>
          <NarraChatHeader
            backLabel={t("common.back", "Назад")}
            onBack={goBack}
            safeAreaTop={headerSafeAreaTop}
            subtitle={
              sending
                ? t("narra.characterTyping", "Печатает...")
                : t("narra.characterOnline", "онлайн")
            }
            title="Narra"
            // Пока без onTrailingPress: профиль Narra появится позже.
            trailing={
              <View style={s.headerAvatar}>
                <AnimatedNarraFace width={23} height={24} color={colors.mutedForeground} />
              </View>
            }
            trailingLabel="Narra"
          />
          {/* Content */}
          <View style={s.content}>
            <NarraChat
              messages={allMessages}
              isStreaming={sending}
              onSend={handleSend}
              quotes={quotes}
              onRemoveQuote={handleRemoveQuote}
              onCitationClick={handleCitationClick}
              autoFocus={!embedded}
              floatingComposer
              showModeControls={false}
              showScrollToBottomButton={false}
              showTypingIndicator={false}
              topInset={headerHeight}
            />
          </View>
        </View>
      </View>

      {/* Thread sidebar overlay */}
      {!isTabletLandscape && (
        <View
          style={[StyleSheet.absoluteFill, { zIndex: 20 }]}
          pointerEvents={showSidebar ? "box-none" : "none"}
        >
          <Animated.View
            style={[s.sidebarBackdrop, { opacity: backdropAnim }]}
            pointerEvents={showSidebar ? "auto" : "none"}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={closeSidebar} />
          </Animated.View>
          <Animated.View
            style={[
              s.sidebar,
              { paddingTop: insets.top, transform: [{ translateX: sidebarAnim }] },
            ]}
          >
            {renderSidebarContent(true)}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (
  colors: ThemeColors,
  layout: { isTabletLandscape: boolean; sidebarWidth: number; horizontalPadding: number },
) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    shell: { flex: 1, flexDirection: layout.isTabletLandscape ? "row" : "column" },
    sidebarDocked: {
      width: layout.sidebarWidth,
      backgroundColor: colors.background,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
      paddingHorizontal: 12,
      paddingBottom: 12,
    },
    mainColumn: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: 44,
      paddingHorizontal: layout.isTabletLandscape ? 20 : 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.background,
      zIndex: 10,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    headerRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    iconBtn: {
      width: 32,
      height: 32,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    content: { flex: 1 },
    headerAvatar: {
      width: 34,
      height: 34,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 17,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.elevation2,
    },

    // Sidebar
    sidebarBackdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0,0,0,0.2)",
    },
    sidebar: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: layout.sidebarWidth,
      backgroundColor: colors.background,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
      paddingHorizontal: 12,
      paddingBottom: 12,
      shadowColor: "#000",
      shadowOffset: { width: 2, height: 0 },
      shadowOpacity: 0.1,
      shadowRadius: 8,
      elevation: 8,
    },
    newChatBtn: {
      width: 32,
      height: 32,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withOpacity(colors.muted, 0.72),
    },
    sidebarHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
    },
    sidebarTitle: {
      fontFamily: headingFontFamily,
      fontSize: fs.sm,
      fontWeight: fw.semibold,
      color: colors.foreground,
    },
    sidebarEmpty: {
      paddingVertical: 40,
      alignItems: "center",
    },
    sidebarEmptyText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
    },
    sectionLabel: {
      fontSize: 12,
      fontWeight: fw.medium,
      color: colors.mutedForeground,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    threadItem: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      borderRadius: radius.md,
      paddingHorizontal: 10,
      paddingVertical: 10,
    },
    threadItemActive: {
      backgroundColor: withOpacity(colors.primary, 0.08),
    },
    threadContent: {
      flex: 1,
      gap: 2,
    },
    threadTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    threadTitle: {
      fontFamily: headingFontFamily,
      fontSize: fs.sm,
      fontWeight: fw.medium,
      color: colors.foreground,
      flex: 1,
    },
    threadTitleActive: {
      color: colors.primary,
    },
    threadTime: {
      fontSize: 11,
      color: colors.mutedForeground,
      opacity: 0.5,
    },
    threadPreview: {
      fontSize: 13,
      color: colors.mutedForeground,
    },
    threadDeleteBtn: {
      marginTop: 2,
      padding: 4,
    },
  });
