import { NarraLoopVideo } from "@/components/narra/NarraLoopVideo";
import { ChevronRightIcon } from "@/components/ui/Icon";
import { ScrollViewMarker } from "@/components/ui/ScrollViewMarker";
import { Text } from "@/components/ui/Typography";
import { hasBundledOpenRouterKey } from "@/config/bundled-ai";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import { hapticLight } from "@/lib/haptics";
import { animateNarraImage } from "@/lib/narra/animate-openrouter";
import { buildSceneMotionPrompt } from "@/lib/narra/animate-prompt";
import { NarraAudioPlayer } from "@/lib/narra/audio-player";
import { reportNarraError } from "@/lib/narra/errors";
import { normalizePersistedNarraMediaUri, synthesizeNarraSpeech } from "@/lib/narra/media";
import { generateNarraAudioScenario } from "@/lib/narra/scene-audio";
import { generateNarraSceneImage as generateSceneImage } from "@/lib/narra/scene-image-openrouter";
import type { NarraCharacter, NarraSceneAudioSegment } from "@/lib/narra/types";
import { toast } from "@/lib/notifications";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { NATIVE_SCROLL_EDGE_EFFECTS } from "@/navigation/scroll-edge-effects";
import { useBackendBook } from "@/hooks/use-backend-book";
import { useLibraryStore, useNarraStore } from "@/stores";
import {
  type ThemeColors,
  fontSize,
  headingFontFamily,
  radius,
  spacing,
  useTheme,
} from "@/styles/theme";
import { interfaceFontFamily } from "@deslop/primitives/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "NarraScene">;
const EMPTY_CHARACTERS: NarraCharacter[] = [];
type AudioStatus = "idle" | "preparing" | "playing";

function sceneChapterTitle(chapter: string): string {
  const title = chapter.replace(/^\s*\d{1,3}(?:[.)]|[—–-])?\s+(?=\D)/, "").trim();
  return title || chapter.trim();
}

/**
 * Короткая подпись под картинкой: первое предложение отрывка либо его
 * обрезка до ~120 знаков с «…» — вместо простыни текста (фидбек PO).
 */
function sceneCaption(excerpt: string): string {
  const text = excerpt.replace(/\s+/g, " ").trim();
  const sentence = (text.match(/^.{1,160}?[.!?…]+(?=\s|$)/)?.[0] ?? text).trim();
  if (sentence.length <= 132) return sentence;
  const cut = sentence.slice(0, 120);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : cut.length).trimEnd()}…`;
}

/**
 * Экран «Сцена»: картинка — главная (во всю ширину, скругление из темы),
 * под ней короткая подпись и ряд пилюль «Заново» / «Оживить» / «Озвучить»
 * (по образцу пары «Поговорить/Послушать голос» в карточке героя).
 * Полный отрывок спрятан в свёрнутый блок «Показать текст сцены».
 */
export function NarraSceneScreen({ route, navigation }: Props) {
  const { bookId, chapter, excerpt, sourceKey } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const displayChapter = sceneChapterTitle(chapter);
  const caption = useMemo(() => sceneCaption(excerpt), [excerpt]);
  const book = useLibraryStore((state) => state.books.find((item) => item.id === bookId));
  useBackendBook(book);
  const bookEditionId = useNarraStore(
    (state) => state.books[bookId]?.backendBinding?.bookEditionId || book?.bookEditionId,
  );
  const characters = useNarraStore((state) => state.books[bookId]?.characters ?? EMPTY_CHARACTERS);
  const cachedScene = useNarraStore((state) => state.books[bookId]?.scenes?.[sourceKey]);
  const cachedAudio = useNarraStore((state) => state.books[bookId]?.sceneAudios?.[sourceKey]);
  const setScene = useNarraStore((state) => state.setScene);
  const setSceneAudio = useNarraStore((state) => state.setSceneAudio);
  const [imageUri, setImageUri] = useState(() =>
    cachedScene?.imageUri ? normalizePersistedNarraMediaUri(cachedScene.imageUri) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [videoState, setVideoState] = useState<{
    uri: string | null;
    ready: boolean;
    failed: boolean;
  }>({ uri: null, ready: false, failed: false });
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("idle");
  const [textExpanded, setTextExpanded] = useState(false);
  const startedRef = useRef(false);
  const audioRef = useRef(new NarraAudioPlayer());
  const audioRunRef = useRef(0);
  const sceneMediaOperationRef = useRef<"idle" | "image" | "video">("idle");

  // Кэш «ожившей» сцены из стора: повторный тап играет без генерации.
  const videoUri = cachedScene?.videoUri
    ? normalizePersistedNarraMediaUri(cachedScene.videoUri)
    : null;
  const videoReady =
    showVideo &&
    videoState.uri === videoUri &&
    videoState.ready &&
    !videoState.failed &&
    Boolean(videoUri);

  useEffect(() => {
    setVideoState({ uri: showVideo ? videoUri : null, ready: false, failed: false });
  }, [showVideo, videoUri]);

  const generate = useCallback(async () => {
    if (loading || animating || sceneMediaOperationRef.current !== "idle") return;
    sceneMediaOperationRef.current = "image";
    setLoading(true);
    setError(null);
    // Новая картинка обесценивает старое видео: setScene ниже пишет сцену
    // без videoUri, а показ возвращается к статичному кадру.
    setShowVideo(false);
    try {
      const nextImageUri = await generateSceneImage(bookId, chapter, excerpt, characters);
      setImageUri(nextImageUri);
      setScene(bookId, {
        sourceKey,
        chapter,
        excerpt,
        imageUri: nextImageUri,
        generatedAt: Date.now(),
      });
    } catch (cause) {
      setError(reportNarraError("scene_image", cause).message);
    } finally {
      sceneMediaOperationRef.current = "idle";
      setLoading(false);
    }
  }, [animating, bookId, chapter, characters, excerpt, loading, setScene, sourceKey]);

  useEffect(() => {
    if (startedRef.current || imageUri) return;
    startedRef.current = true;
    void generate();
  }, [generate, imageUri]);

  // Уход с экрана останавливает озвучку и отменяет незавершённую подготовку.
  useEffect(
    () => () => {
      audioRunRef.current += 1;
      audioRef.current.stop();
    },
    [],
  );

  const stopAudio = useCallback(() => {
    audioRunRef.current += 1;
    audioRef.current.stop();
    setAudioStatus("idle");
  }, []);

  const playUri = useCallback(
    (uri: string) =>
      new Promise<void>((resolve) => {
        audioRef.current.play(uri, resolve, resolve);
      }),
    [],
  );

  // Озвучка по ролям — как на старом экране: генерация аудио-сценария,
  // синтез сегментов с префетчем следующего и последовательное воспроизведение.
  const playScene = useCallback(async () => {
    if (audioStatus !== "idle") {
      stopAudio();
      return;
    }

    const runId = audioRunRef.current + 1;
    audioRunRef.current = runId;
    setAudioStatus("preparing");

    try {
      const segments: NarraSceneAudioSegment[] = cachedAudio?.segments?.length
        ? cachedAudio.segments.map((segment) => ({ ...segment }))
        : await generateNarraAudioScenario(excerpt, characters, bookEditionId);
      if (audioRunRef.current !== runId) return;

      const createdAt = cachedAudio?.createdAt ?? Date.now();
      setSceneAudio(bookId, { sourceKey, segments, createdAt });
      recordTelemetry("tts_playback_started", {
        source: "scene",
        cache_hit: Boolean(cachedAudio?.segments?.every((segment) => segment.audioUri)),
        origin: "user",
      });

      const ensureAudio = async (index: number): Promise<string> => {
        const segment = segments[index];
        if (!segment) throw new Error("Audio segment is missing");
        if (segment.audioUri) return normalizePersistedNarraMediaUri(segment.audioUri);
        const audioUri = await synthesizeNarraSpeech(segment.text, segment.voice);
        segments[index] = { ...segment, audioUri };
        setSceneAudio(bookId, {
          sourceKey,
          segments: segments.map((item) => ({ ...item })),
          createdAt,
        });
        return audioUri;
      };

      let prefetched: { index: number; promise: Promise<string> } | null = null;
      for (let index = 0; index < segments.length; index += 1) {
        if (audioRunRef.current !== runId) return;
        setAudioStatus("preparing");

        const uri =
          prefetched?.index === index ? await prefetched.promise : await ensureAudio(index);
        if (audioRunRef.current !== runId) return;

        const nextIndex = index + 1;
        prefetched =
          nextIndex < segments.length
            ? { index: nextIndex, promise: ensureAudio(nextIndex) }
            : null;
        prefetched?.promise.catch(() => undefined);

        setAudioStatus("playing");
        await playUri(uri);
      }
    } catch (cause) {
      if (audioRunRef.current === runId) {
        reportNarraError("scene_speech", cause);
      }
    } finally {
      if (audioRunRef.current === runId) {
        setAudioStatus("idle");
      }
    }
  }, [
    audioStatus,
    bookEditionId,
    bookId,
    cachedAudio,
    characters,
    excerpt,
    playUri,
    setSceneAudio,
    sourceKey,
    stopAudio,
  ]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => null,
      unstable_headerRightItems: () => [],
    });
  }, [navigation]);

  // «Оживление» сцены (P18): image-to-video через OpenRouter Veo. Генерация
  // ТОЛЬКО по явному тапу (платные вызовы), готовое видео кэшируется в сцене.
  const runAnimation = useCallback(async () => {
    if (!imageUri || animating || loading || sceneMediaOperationRef.current !== "idle") return;
    sceneMediaOperationRef.current = "video";
    setAnimating(true);
    try {
      const nextVideoUri = await animateNarraImage({
        imageUri,
        motionPrompt: buildSceneMotionPrompt(excerpt),
        cacheKey: `${bookId}-scene-video`,
      });
      setScene(bookId, {
        sourceKey,
        chapter,
        excerpt,
        imageUri: cachedScene?.imageUri ?? imageUri,
        generatedAt: cachedScene?.generatedAt ?? Date.now(),
        anchor: cachedScene?.anchor,
        videoUri: nextVideoUri,
      });
      setShowVideo(true);
    } catch (cause) {
      const normalized = reportNarraError("scene_animate", cause);
      toast.error(t("narra.sceneAnimateFailedTitle", "Не удалось оживить сцену"), {
        description: normalized.message,
      });
    } finally {
      sceneMediaOperationRef.current = "idle";
      setAnimating(false);
    }
  }, [animating, bookId, cachedScene, chapter, excerpt, imageUri, loading, setScene, sourceKey, t]);

  // Тап: показ кэшированного видео / возврат к картинке / первая генерация.
  const animateScene = useCallback(() => {
    if (animating) return;
    if (showVideo) {
      setShowVideo(false);
      return;
    }
    if (!hasBundledOpenRouterKey) {
      toast.error(t("narra.animateNeedKey", "Нужен ключ OpenRouter"));
      return;
    }
    if (videoUri) {
      setShowVideo(true);
      return;
    }
    void runAnimation();
  }, [animating, runAnimation, showVideo, t, videoUri]);

  // Долгий тап — регенерация видео даже при наличии кэша.
  const regenerateAnimation = useCallback(() => {
    if (animating) return;
    if (!hasBundledOpenRouterKey) {
      toast.error(t("narra.animateNeedKey", "Нужен ключ OpenRouter"));
      return;
    }
    setShowVideo(false);
    void runAnimation();
  }, [animating, runAnimation, t]);

  return (
    <ScrollViewMarker
      scrollEdgeEffects={NATIVE_SCROLL_EDGE_EFFECTS}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {/* Картинка — главная: во всю ширину, скругление из темы */}
        <View style={styles.imageCard}>
          {imageUri ? (
            <>
              {showVideo && videoUri ? (
                <NarraLoopVideo
                  accessibilityLabel={t("narra.sceneVideoLabel", "Ожившая сцена")}
                  onError={() => {
                    setVideoState({ uri: videoUri, ready: false, failed: true });
                    setShowVideo(false);
                  }}
                  onReady={() => setVideoState({ uri: videoUri, ready: true, failed: false })}
                  style={StyleSheet.absoluteFill}
                  uri={videoUri}
                />
              ) : null}
              {!showVideo || !videoReady ? (
                <Image
                  accessibilityLabel={t(
                    "narra.sceneIllustrationLabel",
                    "Иллюстрация к главе {{chapter}}",
                    {
                      chapter: displayChapter,
                    },
                  )}
                  source={{ uri: imageUri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                  onError={() => setImageUri(null)}
                />
              ) : null}
              {loading ? (
                <View style={styles.imageOverlay}>
                  <ActivityIndicator size="large" color="#fff" />
                </View>
              ) : null}
              {animating ? (
                <View style={styles.imageOverlay}>
                  <ActivityIndicator size="large" color="#fff" />
                  <Text style={styles.overlayHint}>
                    {t("narra.sceneAnimating", "Оживляем… 1–3 минуты")}
                  </Text>
                </View>
              ) : null}
            </>
          ) : loading ? (
            // Спокойный плейсхолдер на время генерации — по образцу врезок в тексте
            <View style={styles.placeholder}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.placeholderTitle}>
                {t("narra.sceneSlotDrawing", "Рисуем сцену…")}
              </Text>
              <Text style={styles.placeholderHint}>
                {t("narra.sceneSlotDrawingHint", "Обычно 20–60 секунд")}
              </Text>
            </View>
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderTitle}>
                {t("narra.sceneFailedTitle", "Не удалось создать сцену")}
              </Text>
              {error ? <Text style={styles.placeholderHint}>{error}</Text> : null}
            </View>
          )}
        </View>

        {/* Короткая подпись вместо простыни текста */}
        <View style={styles.captionBlock}>
          {displayChapter ? <Text style={styles.chapterLabel}>{displayChapter}</Text> : null}
          <Text style={styles.caption} numberOfLines={2}>
            {caption}
          </Text>
        </View>

        {/* Ряд пилюль — как «Поговорить/Послушать голос» в карточке героя */}
        <View style={styles.actionsRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("narra.sceneRegenerate", "Нарисовать заново")}
            disabled={loading || animating}
            onPress={() => {
              hapticLight();
              void generate();
            }}
            style={({ pressed }) => [styles.primaryPill, pressed && styles.pillPressed]}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={styles.primaryPillText}>{t("narra.sceneSlotRegen", "Заново")}</Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              showVideo
                ? t("narra.sceneShowImage", "Показать картинку")
                : t("narra.sceneAnimate", "Оживить")
            }
            disabled={animating || loading || !imageUri}
            onPress={() => {
              hapticLight();
              animateScene();
            }}
            onLongPress={() => {
              hapticLight();
              regenerateAnimation();
            }}
            style={({ pressed }) => [styles.ghostPill, pressed && styles.pillPressed]}
          >
            {animating ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Text style={styles.ghostPillText}>
                {showVideo
                  ? t("narra.sceneShowImageShort", "Картинка")
                  : t("narra.sceneAnimate", "Оживить")}
              </Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              audioStatus === "idle"
                ? t("narra.sceneVoice", "Озвучить")
                : t("narra.stopVoiceSample", "Остановить озвучку")
            }
            disabled={audioStatus === "preparing"}
            onPress={() => {
              hapticLight();
              void playScene();
            }}
            style={({ pressed }) => [styles.ghostPill, pressed && styles.pillPressed]}
          >
            {audioStatus === "preparing" ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Text style={styles.ghostPillText}>
                {audioStatus === "playing"
                  ? t("narra.ttsStop", "Стоп")
                  : t("narra.sceneVoice", "Озвучить")}
              </Text>
            )}
          </Pressable>
        </View>

        {/* Полный отрывок — свёрнут по умолчанию */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: textExpanded }}
          onPress={() => {
            hapticLight();
            setTextExpanded((value) => !value);
          }}
          style={({ pressed }) => [styles.disclosureRow, pressed && styles.pillPressed]}
        >
          <Text style={styles.disclosureLabel}>
            {textExpanded
              ? t("narra.sceneHideText", "Скрыть текст сцены")
              : t("narra.sceneShowText", "Показать текст сцены")}
          </Text>
          <View style={textExpanded ? styles.chevronOpen : styles.chevronClosed}>
            <ChevronRightIcon color={colors.mutedForeground} size={16} />
          </View>
        </Pressable>
        {textExpanded ? <Text style={styles.excerpt}>{excerpt.trim()}</Text> : null}
      </ScrollView>
    </ScrollViewMarker>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      gap: spacing.lg,
    },
    imageCard: {
      position: "relative",
      width: "100%",
      aspectRatio: 1,
      overflow: "hidden",
      borderRadius: radius.card,
      backgroundColor: colors.elevation2,
    },
    image: { width: "100%", height: "100%" },
    imageOverlay: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      backgroundColor: "rgba(0,0,0,0.38)",
    },
    // Подпись прогресса оживления поверх затемнённой картинки
    overlayHint: {
      color: "#fff",
      fontFamily: interfaceFontFamily.regular,
      fontSize: fontSize.xs,
      textAlign: "center",
    },
    placeholder: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
    placeholderTitle: {
      color: colors.foreground,
      fontFamily: headingFontFamily,
      fontSize: fontSize.sm,
      textAlign: "center",
    },
    placeholderHint: {
      color: colors.mutedForeground,
      fontFamily: interfaceFontFamily.regular,
      fontSize: fontSize.xs,
      lineHeight: 18,
      textAlign: "center",
    },
    captionBlock: { gap: spacing.xs },
    // Заголовок главы — мелкий caps-лейбл над подписью
    chapterLabel: {
      color: colors.mutedForeground,
      fontFamily: interfaceFontFamily.caps,
      fontSize: fontSize.xs,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    // Подпись 1–2 строки — SB Sans, спокойный mutedForeground
    caption: {
      color: colors.mutedForeground,
      fontFamily: interfaceFontFamily.regular,
      fontSize: fontSize.sm,
      lineHeight: 22,
    },
    actionsRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    // Горизонтальный паддинг компактнее, чем в карточке героя (spacing.md
    // вместо spacing.lg): три пилюли должны помещаться в ряд на iPhone.
    primaryPill: {
      flex: 1,
      minHeight: 48,
      paddingHorizontal: spacing.md,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.foreground,
    },
    primaryPillText: {
      color: colors.background,
      fontFamily: interfaceFontFamily.semibold,
      fontSize: fontSize.sm,
    },
    ghostPill: {
      flex: 1,
      minHeight: 48,
      paddingHorizontal: spacing.md,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    ghostPillText: {
      color: colors.foreground,
      fontFamily: interfaceFontFamily.semibold,
      fontSize: fontSize.sm,
    },
    pillPressed: { opacity: 0.72 },
    disclosureRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.xs,
      minHeight: 44,
    },
    disclosureLabel: {
      color: colors.mutedForeground,
      fontFamily: interfaceFontFamily.semibold,
      fontSize: fontSize.sm,
    },
    chevronClosed: { transform: [{ rotate: "90deg" }] },
    chevronOpen: { transform: [{ rotate: "-90deg" }] },
    excerpt: {
      color: colors.mutedForeground,
      fontFamily: interfaceFontFamily.regular,
      fontSize: fontSize.sm,
      lineHeight: 22,
    },
  });
