import { XIcon } from "@/components/ui/Icon";
import { fontFamily, useTheme, withOpacity } from "@/styles/theme";
import type { AttachedQuote } from "@readany/core/types";
import type { CitationPart, MessageV2 } from "@readany/core/types/message";
import type { TFunction } from "i18next";
import { useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardGestureArea, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NarraChatComposer } from "./narra-chat-composer";
import { NarraChatTranscript } from "./narra-chat-transcript";

type StreamingStep = "thinking" | "tool_calling" | "responding" | "idle";

/**
 * Свёрнутая высота дока композера без нижней safe area.
 *
 * Нужна только как стартовая оценка на первый кадр: настоящую высоту сообщает
 * onLayout, и она сразу перекрывает эту константу. Расхождение в пару пунктов
 * не видно — лента доводится одним доскроллом после измерения.
 */
const COLLAPSED_COMPOSER_DOCK_HEIGHT = 60;

/** Собирает видимый текст сообщения из частей MessageV2. */
function messageText(message: MessageV2, t: TFunction): string {
  const body: string[] = [];
  const citations: CitationPart[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        if (part.text.trim()) body.push(part.text);
        break;
      case "quote": {
        const source = part.source ? `\n> — ${part.source}` : "";
        body.push(`> ${part.text.replaceAll("\n", "\n> ")}${source}`);
        break;
      }
      case "citation":
        citations.push(part);
        break;
      case "mindmap":
        body.push(`**${part.title}**\n\n${part.markdown}`);
        break;
      case "mermaid":
        body.push(`**${part.title}**\n\n\`\`\`mermaid\n${part.chart}\n\`\`\``);
        break;
      case "aborted":
        body.push(`_${t("chat.responseStopped", "Ответ остановлен.")}_`);
        break;
      // The 4.2 typing and streaming states replace Narra's old visible
      // reasoning/tool cards. Internal reasoning remains in message data.
      case "reasoning":
      case "tool_call":
        break;
    }
  }

  if (citations.length) {
    const sources = citations
      .sort((a, b) => (a.citationIndex ?? 0) - (b.citationIndex ?? 0))
      .map((citation, index) => {
        const number = citation.citationIndex ?? index + 1;
        return `[${number}. ${citation.chapterTitle}](narra-citation://${encodeURIComponent(citation.id)})`;
      });
    body.push(`**${t("chat.sources", "Источники")}**\n\n${sources.join("  \n")}`);
  }

  return body.join("\n\n");
}

interface NarraChatProps {
  messages: MessageV2[];
  isStreaming?: boolean;
  currentStep?: StreamingStep;
  placeholder?: string;
  quotes?: AttachedQuote[];
  onRemoveQuote?: (id: string) => void;
  onCitationClick?: (citation: CitationPart) => void;
  onSend: (
    text: string,
    deepThinking: boolean,
    spoilerFree: boolean,
    quotes?: AttachedQuote[],
  ) => void | Promise<void>;
  onStop?: () => void;
  autoFocus?: boolean;
  assistantName?: string;
  floatingComposer?: boolean;
  topInset?: number;
  showScrollToBottomButton?: boolean;
  showTypingIndicator?: boolean;
  revealMessageId?: string | null;
  onRevealComplete?: (messageId: string) => void;
  showModeControls?: boolean;
  /** Стартовое значение «Без спойлеров»: для книжных чатов — включено. */
  defaultSpoilerFree?: boolean;
}

/**
 * Чат Narra: лента на PanelUI (narra-chat-transcript) и композер на AIInput
 * (narra-chat-composer). Вендорная библиотека чата здесь больше не участвует.
 *
 * Пока не перенесено с прежней ленты: посимвольное проявление ответа
 * (revealMessageId/onRevealComplete принимаются, но не используются).
 */
export function NarraChat({
  messages,
  isStreaming = false,
  placeholder,
  quotes = [],
  onRemoveQuote,
  onCitationClick,
  onSend,
  onStop,
  autoFocus = false,
  floatingComposer = false,
  topInset = 0,
  showScrollToBottomButton = true,
  showTypingIndicator = true,
  showModeControls = false,
  defaultSpoilerFree = false,
}: NarraChatProps) {
  const { colors } = useTheme();
  const { bottom: safeAreaBottom } = useSafeAreaInsets();
  const { t, i18n } = useTranslation();
  const reactInputId = useId();
  const inputNativeId = `narra-chat-input-${reactInputId.replaceAll(":", "")}`;
  const effectivePlaceholder = placeholder || t("chat.inputPlaceholder", "Сообщение");
  const [deepThinking, setDeepThinking] = useState(false);
  const [spoilerFree, setSpoilerFree] = useState(defaultSpoilerFree);
  // Текст композера раньше держала вендорная лента — теперь он наш.
  const [composerText, setComposerText] = useState("");
  // MessageScroller ставит стартовую прокрутку до того, как onLayout сообщит
  // высоту дока. С нулём лента открывалась без нижнего резервирования, а
  // следующий кадр возвращал последнее сообщение из-под инпута скачком.
  // Оценка живёт только до первого измерения, которое её перекрывает.
  const initialComposerHeight = floatingComposer
    ? COLLAPSED_COMPOSER_DOCK_HEIGHT + safeAreaBottom
    : 0;
  const [composerHeight, setComposerHeight] = useState(initialComposerHeight);
  const [baseComposerHeight, setBaseComposerHeight] = useState(initialComposerHeight);
  const [composerMeasured, setComposerMeasured] = useState(false);
  const baseComposerHeightRef = useRef(initialComposerHeight);
  const didMeasureComposerRef = useRef(false);

  const streamingMessageId =
    isStreaming && messages.at(-1)?.role === "assistant" ? messages.at(-1)?.id : undefined;

  // Индикатор набора нужен, пока ответ ещё не начал приходить текстом.
  const lastMessage = messages.at(-1);
  const showInitialStreaming =
    isStreaming &&
    (!lastMessage || lastMessage.role !== "assistant" || !messageText(lastMessage, t).trim());

  const handleComposerSend = useCallback(() => {
    const value = composerText.trim();
    if (!value && quotes.length === 0) return;
    setComposerText("");
    void onSend(value, deepThinking, spoilerFree, quotes);
    for (const quote of quotes) onRemoveQuote?.(quote.id);
  }, [composerText, deepThinking, onRemoveQuote, onSend, quotes, spoilerFree]);

  const handleComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = Math.ceil(event.nativeEvent.layout.height);
      setComposerHeight(height);
      setComposerMeasured(true);

      if (!floatingComposer) return;

      const wasMeasured = didMeasureComposerRef.current;
      didMeasureComposerRef.current = true;
      const baseHeight = baseComposerHeightRef.current;
      if (!wasMeasured || baseHeight === 0 || height < baseHeight) {
        baseComposerHeightRef.current = height;
        setBaseComposerHeight(height);
      }
    },
    [floatingComposer],
  );

  const renderMessageText = useCallback((message: MessageV2) => messageText(message, t), [t]);

  const renderAccessory = () => {
    if (quotes.length === 0 && !showModeControls) return null;

    return (
      <View style={styles.accessory}>
        {quotes.map((quote) => (
          <View key={quote.id} style={[styles.quoteChip, { backgroundColor: colors.elevation2 }]}>
            <Text style={[styles.chipText, { color: colors.foreground }]} numberOfLines={1}>
              {quote.text}
            </Text>
            <Pressable onPress={() => onRemoveQuote?.(quote.id)} hitSlop={8}>
              <XIcon size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ))}
        {showModeControls ? (
          <View style={styles.modeRow}>
            <ModeButton
              label={t("chat.deepThinking", "Глубокий анализ")}
              active={deepThinking}
              onPress={() => setDeepThinking((value) => !value)}
            />
            <ModeButton
              label={t("chat.spoilerFree", "Без спойлеров")}
              active={spoilerFree}
              onPress={() => setSpoilerFree((value) => !value)}
            />
          </View>
        ) : null}
      </View>
    );
  };

  const composer = (
    <NarraChatComposer
      allowSendWithoutText={quotes.length > 0}
      isStreaming={isStreaming}
      onSend={handleComposerSend}
      onStop={onStop}
      text={composerText}
      textInputProps={{
        autoFocus,
        editable: !isStreaming,
        nativeID: inputNativeId,
        onChangeText: setComposerText,
        placeholder: effectivePlaceholder,
      }}
    />
  );

  const composerDock = (
    <View onLayout={handleComposerLayout}>
      {renderAccessory()}
      {composer}
    </View>
  );

  return (
    <KeyboardGestureArea
      interpolator="ios"
      offset={composerHeight}
      style={styles.root}
      textInputNativeID={inputNativeId}
    >
      <NarraChatTranscript
        baseBottomInset={floatingComposer ? baseComposerHeight : 0}
        bottomInset={floatingComposer ? composerHeight : 0}
        composerMeasured={composerMeasured}
        locale={i18n.resolvedLanguage === "en" ? "en" : "ru"}
        messages={messages}
        onCitationClick={onCitationClick}
        renderText={renderMessageText}
        showScrollToBottom={showScrollToBottomButton}
        showTyping={showTypingIndicator && showInitialStreaming}
        streamingMessageId={streamingMessageId}
        topInset={topInset}
      />
      <KeyboardStickyView
        offset={{ opened: safeAreaBottom }}
        style={floatingComposer ? styles.floatingComposer : undefined}
      >
        {composerDock}
      </KeyboardStickyView>
    </KeyboardGestureArea>
  );
}

function ModeButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[
        styles.modeButton,
        {
          borderColor: active ? withOpacity(colors.primary, 0.5) : colors.border,
          backgroundColor: active ? withOpacity(colors.primary, 0.1) : "transparent",
        },
      ]}
      onPress={onPress}
    >
      <Text style={[styles.modeLabel, { color: active ? colors.primary : colors.mutedForeground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  floatingComposer: { position: "absolute", right: 0, bottom: 0, left: 0 },
  accessory: {
    gap: 6,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 2,
  },
  quoteChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    flex: 1,
    fontFamily: fontFamily.regular,
    fontSize: 12,
  },
  modeRow: {
    flexDirection: "row",
    gap: 6,
  },
  modeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 0.5,
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  modeLabel: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
  },
});
