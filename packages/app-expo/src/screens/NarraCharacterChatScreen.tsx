import { NarraChat } from "@/components/chat/NarraChat";
import {
  NARRA_CHAT_EMBEDDED_TOP_INSET,
  NARRA_CHAT_HEADER_HEIGHT,
  NarraChatHeader,
} from "@/components/chat/narra-chat-header";
import { CharacterPortraitImage } from "@/components/narra/character-portrait-image";
import { CenteredEmptyState } from "@/components/ui/centered-empty-state";
import { InitialsAvatar } from "@/components/ui/initials-avatar";
import { useBackendBook } from "@/hooks/use-backend-book";
import { type NarraChatMessageInput, completeNarraChat } from "@/lib/ai/narra-chat";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import { normalizeCharacterChatPlaceholder } from "@/lib/narra/chat-placeholder";
import { isCharacterUnlocked, normalizeReadingProgress } from "@/lib/narra/domain";
import { reportNarraError } from "@/lib/narra/errors";
import type { NarraCharacter, NarraChatMessage } from "@/lib/narra/types";
import { toast } from "@/lib/notifications";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { useLibraryStore, useNarraStore } from "@/stores";
import { type ThemeColors, useTheme } from "@/styles/theme";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MessageV2 } from "@readany/core/types/message";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type StandaloneCharacterChatProps = NativeStackScreenProps<
  RootStackParamList,
  "NarraCharacterChat"
>;

type EmbeddedCharacterChatProps = {
  embedded: true;
  bookId: string;
  characterId: string;
  onBack: () => void;
};

export type NarraCharacterChatScreenProps =
  | StandaloneCharacterChatProps
  | EmbeddedCharacterChatProps;

const headerControlSize = 34;

export function buildCharacterSystemPrompt(
  character: NarraCharacter,
  title: string,
  progress: number,
  memory: string,
  language: "ru" | "en" = "ru",
): string {
  const safeProgress = normalizeReadingProgress(progress);
  if (language === "en") {
    return `You are ${character.fullName} from “${title}”. Stay completely in character.
Traits: ${character.traits.join(", ")}.
Role: ${character.role}.
Speaking style: ${character.speechStyle}.
Reply in English, in the first person, naturally, usually in 1–3 sentences. Never say that you are an AI, a model, or a book character.
Avoid lists and corporate language. React to the reader's actual words; you may disagree, joke, and ask questions.
The reader has completed about ${Math.round(safeProgress * 100)}% of the book. Do not reveal events, knowledge, relationships, or character fates beyond that point. If a question risks a spoiler, gently deflect in character and return to events the reader already knows without mentioning rules or restrictions.
You may evade, but do not lie. Speak honestly about events the reader has already reached and do not invent facts that are not in the book.
${memory ? `Your long-term memory of the reader:\n${memory}` : ""}`;
  }
  return `Ты — ${character.fullName} из книги «${title}». Полностью оставайся в роли.
Характер: ${character.traits.join(", ")}.
Роль: ${character.role}.
Манера речи: ${character.speechStyle}.
Отвечай от первого лица, живо, обычно 1–3 предложениями. Не говори, что ты ИИ, модель или персонаж книги.
Не используй списки и канцелярит. Реагируй на конкретные слова собеседника, можешь спорить, шутить и задавать вопросы.
Читатель прошёл примерно ${Math.round(safeProgress * 100)}% книги. Не раскрывай события, знания, отношения и судьбы героев дальше этого прогресса. Если вопрос ведёт к спойлеру, мягко уклонись в своём характере и переведи разговор к уже известным событиям — не упоминай правила или ограничения.
Уклоняться можно, лгать нельзя. О том, что читатель уже прошёл, говори честно: не отрицай своих поступков и событий книги, даже если герою неприятно о них вспоминать. Не выдумывай того, чего в книге нет.
${memory ? `Твоя долговременная память о собеседнике:\n${memory}` : ""}`;
}

function toMessageV2(message: NarraChatMessage, threadId: string): MessageV2 {
  return {
    id: message.id,
    threadId,
    role: message.role,
    createdAt: message.createdAt,
    parts: [
      {
        id: `${message.id}-text`,
        type: "text",
        text: message.content,
        status: "completed",
        createdAt: message.createdAt,
      },
    ],
  };
}

export function NarraCharacterChatScreen(props: NarraCharacterChatScreenProps) {
  const embedded = "embedded" in props;
  const presentedAsSheet = Platform.OS === "ios" && !embedded;
  const bookId = embedded ? props.bookId : props.route.params.bookId;
  const characterId = embedded ? props.characterId : props.route.params.characterId;
  const embeddedBack = embedded ? props.onBack : undefined;
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t, i18n } = useTranslation();
  const interfaceLanguage = i18n.resolvedLanguage === "en" ? "en" : "ru";
  const book = useLibraryStore((state) => state.books.find((item) => item.id === bookId));
  useBackendBook(book);
  const narraBook = useNarraStore((state) => state.books[bookId]);
  const append = useNarraStore((state) => state.appendChatMessage);
  const setMemory = useNarraStore((state) => state.setMemory);
  const updateCharacter = useNarraStore((state) => state.updateCharacter);
  const character = narraBook?.characters.find(
    (item) => item.id === characterId && item.backendManaged,
  );
  const messages = narraBook?.chats?.[characterId] ?? [];
  const memory = narraBook?.memories?.[characterId] ?? "";
  const [sending, setSending] = useState(false);
  const [greetingLoading, setGreetingLoading] = useState(false);
  const greetingRequestedRef = useRef(false);
  const placeholderRequestedRef = useRef<string | null>(null);
  const unlocked = Boolean(book && character && isCharacterUnlocked(book.progress, character));
  const bookEditionId = narraBook?.backendBinding?.bookEditionId || book?.bookEditionId;
  const characterStatus =
    sending || greetingLoading
      ? t("narra.characterTyping", "Печатает...")
      : t("narra.characterOnline", "онлайн");
  const headerSafeAreaTop =
    embedded || presentedAsSheet ? NARRA_CHAT_EMBEDDED_TOP_INSET : insets.top;
  const headerHeight = headerSafeAreaTop + NARRA_CHAT_HEADER_HEIGHT;
  const goBack = useCallback(() => {
    void KeyboardController.dismiss({ animated: true, keepFocus: false });
    if (embeddedBack) {
      embeddedBack();
      return;
    }
    navigation.goBack();
  }, [embeddedBack, navigation]);
  const openCharacterProfile = useCallback(
    () =>
      navigation.navigate("NarraCharacterProfile", {
        bookId,
        characterId,
        openedFromChat: true,
      }),
    [bookId, characterId, navigation],
  );
  useEffect(() => {
    recordTelemetry("chat_opened", { feature: "chat" });
  }, []);

  useEffect(() => {
    if (interfaceLanguage === "en" || !book || !character || character.chatPlaceholder) return;
    if (placeholderRequestedRef.current === character.id) return;
    placeholderRequestedRef.current = character.id;

    void (async () => {
      try {
        const completion = await completeNarraChat({
          messages: [
            {
              role: "system",
              content:
                "Ты — редактор русского интерфейса. Верни только короткий placeholder без кавычек в формате «Написать <имя в дательном падеже>…». Используй только переданное короткое имя, не добавляй фамилию, имя или отчество. Никаких пояснений.",
            },
            {
              role: "user",
              content: `Короткое имя персонажа: ${character.name}\nПолное имя для понимания контекста: ${character.fullName}`,
            },
          ],
          temperature: 0,
          purpose: "character_chat",
          origin: "background",
          analyticsTier: "none",
        });
        const placeholder = normalizeCharacterChatPlaceholder(completion);
        if (placeholder) updateCharacter(bookId, characterId, { chatPlaceholder: placeholder });
      } catch (error) {
        // Generic fallback stays grammatically correct and keeps chat usable offline.
        reportNarraError("character_chat_placeholder", error);
      }
    })();
  }, [book, bookId, character, characterId, interfaceLanguage, updateCharacter]);

  const conversation = useMemo<NarraChatMessageInput[]>(
    () =>
      character && book
        ? [
            {
              role: "system",
              content: buildCharacterSystemPrompt(
                character,
                book.meta.title,
                book.progress,
                memory,
                interfaceLanguage,
              ),
            },
            ...messages.slice(-18).map(({ role, content }) => ({ role, content })),
          ]
        : [],
    [book, character, interfaceLanguage, memory, messages],
  );

  const chatMessages = useMemo(() => {
    const threadId = `narra-character-${bookId}-${characterId}`;
    return messages.map((message) => toMessageV2(message, threadId));
  }, [bookId, characterId, messages]);

  // Первое сообщение героя: свой greeting из анализа/каталога, иначе — просим
  // Шлюз здоровается в роли персонажа. Сохраняется в историю чата один раз,
  // поэтому при повторных входах не регенерится и не дублируется.
  useEffect(() => {
    if (!book || !character || !unlocked) return;
    if (messages.length > 0 || greetingRequestedRef.current) return;
    greetingRequestedRef.current = true;

    const appendGreeting = (content: string) => {
      const state = useNarraStore.getState();
      if ((state.books[bookId]?.chats?.[characterId]?.length ?? 0) > 0) return;
      state.appendChatMessage(bookId, characterId, {
        id: Crypto.randomUUID(),
        role: "assistant",
        content,
        createdAt: Date.now(),
      });
    };

    if (character.greeting && interfaceLanguage !== "en") {
      appendGreeting(character.greeting);
      return;
    }

    setGreetingLoading(true);
    void (async () => {
      try {
        const content = await completeNarraChat({
          messages: [
            {
              role: "system",
              content: buildCharacterSystemPrompt(
                character,
                book.meta.title,
                book.progress,
                "",
                interfaceLanguage,
              ),
            },
            {
              role: "user",
              content:
                interfaceLanguage === "en"
                  ? "Greet the reader in character in 1–3 sentences, without spoilers. Do not mention this instruction."
                  : "Поприветствуй читателя первым сообщением в своём характере: 1–3 предложения, без спойлеров. Не упоминай это указание.",
            },
          ],
          temperature: 0.85,
          purpose: "character_chat",
          origin: "user",
          analyticsTier: "essential",
          bookEditionId,
        });
        if (content) appendGreeting(content);
      } catch (error) {
        // Без приветствия чат остаётся рабочим: читатель может написать первым.
        reportNarraError("character_greeting", error);
        greetingRequestedRef.current = false;
      } finally {
        setGreetingLoading(false);
      }
    })();
  }, [book, bookEditionId, bookId, character, characterId, interfaceLanguage, messages.length, unlocked]);

  const refreshMemory = useCallback(
    async (updatedMessages: NarraChatMessage[]) => {
      if (!character || updatedMessages.length < 4 || updatedMessages.length % 4 !== 0) return;
      try {
        const nextMemory = await completeNarraChat({
          messages: [
            {
              role: "system",
              content:
                interfaceLanguage === "en"
                  ? "Briefly update the character's long-term memory of the reader: facts, preferences, promises, and important emotional moments. Do not retell the whole conversation. Up to 900 characters, in English."
                  : "Кратко обнови долговременную память персонажа о читателе: факты, предпочтения, обещания и важные эмоциональные моменты. Не пересказывай весь диалог. До 900 знаков, по-русски.",
            },
            {
              role: "user",
              content: `${interfaceLanguage === "en" ? "Previous memory" : "Старая память"}:\n${memory || (interfaceLanguage === "en" ? "none" : "нет")}\n\n${interfaceLanguage === "en" ? "Conversation" : "Диалог"}:\n${updatedMessages
                .slice(-12)
                .map(
                  (item) =>
                    `${item.role === "user" ? (interfaceLanguage === "en" ? "Reader" : "Читатель") : character.name}: ${item.content}`,
                )
                .join("\n")}`,
            },
          ],
          temperature: 0.25,
          purpose: "memory",
          origin: "background",
          analyticsTier: "none",
        });
        if (nextMemory) setMemory(bookId, characterId, nextMemory.slice(0, 900));
      } catch {
        // Memory refresh is background-only and must not make a successful chat look failed.
      }
    },
    [bookId, character, characterId, interfaceLanguage, memory, setMemory],
  );

  const send = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!text || !book || !character || !unlocked || sending) return;
      setSending(true);
      const userMessage: NarraChatMessage = {
        id: Crypto.randomUUID(),
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      const assistantMessageId = Crypto.randomUUID();
      append(bookId, characterId, userMessage);
      try {
        const content = await completeNarraChat({
          messages: [...conversation, { role: "user", content: text }],
          temperature: 0.85,
          purpose: "character_chat",
          origin: "user",
          analyticsTier: "essential",
          bookEditionId,
        });
        const assistantMessage: NarraChatMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: content || t("narra.emptyAnswer", "Мне нечего добавить."),
          createdAt: Date.now(),
        };
        append(bookId, characterId, assistantMessage);
        void refreshMemory([...messages, userMessage, assistantMessage]);
      } catch (error) {
        toast.error(t("narra.chatFailedTitle", "Не удалось получить ответ"), {
          description: reportNarraError("character_chat", error).message,
        });
      } finally {
        setSending(false);
      }
    },
    [
      append,
      book,
      bookEditionId,
      bookId,
      character,
      characterId,
      conversation,
      messages,
      refreshMemory,
      sending,
      t,
      unlocked,
    ],
  );

  const header = (
    <NarraChatHeader
      backLabel={presentedAsSheet ? t("common.close", "Закрыть") : t("common.back", "Назад")}
      backIcon={presentedAsSheet ? "xmark" : "chevron.backward"}
      onBack={goBack}
      onTitlePress={character ? openCharacterProfile : undefined}
      onTrailingPress={character ? openCharacterProfile : undefined}
      safeAreaTop={headerSafeAreaTop}
      subtitle={characterStatus}
      title={character?.name || t("narra.characterChat", "Чат с персонажем")}
      trailing={
        character ? (
          <View style={styles.headerAvatar}>
            <CharacterPortraitImage
              character={character}
              resizeMode="cover"
              cropAnchor="top"
              staticOnly
              style={styles.headerAvatarImage}
              fallback={
                <InitialsAvatar
                  size={32}
                  userId={`${bookId}:${character.id}`}
                  name={character.fullName || character.name}
                />
              }
            />
          </View>
        ) : null
      }
      trailingLabel={
        character
          ? t("narra.openCharacterProfile", "Открыть профиль {{character}}", {
              character: character.name,
            })
          : undefined
      }
    />
  );

  if (!book || !character) {
    return (
      <View style={styles.container}>
        {header}
        <View style={[styles.content, { paddingTop: headerHeight }]}>
          <CenteredEmptyState
            title={t("narra.characterUnavailable", "Персонаж недоступен.")}
            style={styles.content}
          />
        </View>
      </View>
    );
  }

  if (!unlocked) {
    return (
      <View style={styles.container}>
        {header}
        <View style={[styles.content, { paddingTop: headerHeight }]}>
          <CenteredEmptyState
            title={t("narra.characterLocked", "Персонаж ещё не открыт")}
            description={t(
              "narra.keepReading",
              "Продолжайте читать — герой появится позже по ходу книги.",
            )}
            style={styles.content}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <NarraChat
        messages={chatMessages}
        floatingComposer
        isStreaming={sending || greetingLoading}
        showScrollToBottomButton={false}
        currentStep={sending || greetingLoading ? "responding" : "idle"}
        placeholder={
          interfaceLanguage === "en"
            ? t("narra.messagePlaceholder", "Message {{name}}…", { name: character.name })
            : character.chatPlaceholder ||
              t("narra.genericMessagePlaceholder", "Написать сообщение…")
        }
        onSend={send}
        assistantName={character.name}
        showTypingIndicator={false}
        showModeControls={false}
        topInset={headerHeight}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { flex: 1 },
    headerAvatar: {
      width: headerControlSize,
      height: headerControlSize,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: headerControlSize / 2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.elevation2,
    },
    headerAvatarImage: { width: "100%", height: "100%" },
  });
