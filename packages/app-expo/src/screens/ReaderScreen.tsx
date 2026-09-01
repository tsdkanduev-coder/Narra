import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { AnimatedNarraFace } from "@/components/chat/animated-narra-face";
import { ChapterTranslationSheet } from "@/components/reader/ChapterTranslationSheet";
import { TranslationPanel } from "@/components/reader/TranslationPanel";
import { NotebookPenIcon, XIcon } from "@/components/ui/Icon";
import { NativeContextMenuButton } from "@/components/ui/NativeContextMenuButton";
import type { NativeContextMenuItem } from "@/components/ui/NativeContextMenuButton.types";
import { Text } from "@/components/ui/Typography";
import { useBackendBook } from "@/hooks/use-backend-book";
import { useReaderBridge } from "@/hooks/use-reader-bridge";
import type {
  RelocateEvent,
  ReaderSearchResultItem,
  SelectionEvent,
  VisibleTTSSegment,
} from "@/hooks/use-reader-bridge";
import { durationBucket } from "@/lib/analytics/contract";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import {
  BUNDLED_CATALOG_BOOKS,
  findBundledCatalogBookByTitle,
  installBundledCatalogCover,
  normalizeCatalogIdentity,
  resolveBundledCatalogBookUri,
} from "@/lib/catalog/bundled-books";
import { diagnosticErrorReason, recordDiagnostic } from "@/lib/diagnostics/diagnostics";
import { hapticLight } from "@/lib/haptics";
import { importBackendCatalogBook } from "@/lib/narra/backend-catalog-import";
import { isCatalogBookRevisionCurrent } from "@/lib/narra/backend-catalog-library";
import { backendSceneMarkupIdentity } from "@/lib/narra/backend-scene-identity";
import { generateBackendReaderScene, readSceneDataUri } from "@/lib/narra/backend-scene-reader";
import { backendSceneForAnchor } from "@/lib/narra/backend-scene-state";
import { buildCharacterNameMatcherSpec } from "@/lib/narra/character-name-matcher";
import { isCharacterUnlocked } from "@/lib/narra/domain";
import { NarraServiceError, reportNarraError } from "@/lib/narra/errors";
import { sceneInsertAnchors, sceneSourceKeyForAnchor } from "@/lib/narra/scene-inserts";
import {
  INITIAL_SCENE_SUGGESTION_STATE,
  advanceSceneSuggestion,
} from "@/lib/narra/scene-suggestion";
import type { NarraCharacter } from "@/lib/narra/types";
import { toast } from "@/lib/notifications";
import { DEFAULT_READER_FONT_FAMILY } from "@/lib/reader/bundled-reader-font";
import { getReaderBookmarkCopy } from "@/lib/reader/reader-bookmark-copy";
import { isReaderTransportError } from "@/lib/reader/reader-recovery";
import {
  READER_BUILD_ID,
  prepareReaderAsset,
  prepareReaderHost,
  prepareReaderPdfEngineUri,
} from "@/lib/reader/reader-runtime";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import {
  useAnnotationStore,
  useLibraryStore,
  useNarraStore,
  useReaderStore,
  useReadingSessionStore,
  useSettingsStore,
  useTTSStore,
} from "@/stores";
import { useMissingBookPromptStore } from "@/stores/missing-book-prompt-store";
import { darkColors, lightColors, useTheme } from "@/styles/ThemeContext";
import { useColors } from "@/styles/theme";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { readingContextService } from "@readany/core/ai/reading-context-service";
import { runWithDbRetry } from "@readany/core/db/write-retry";
import { useChapterTranslation } from "@readany/core/hooks";
import { useReadingSession } from "@readany/core/hooks/use-reading-session";
import type { Book, ReadSettings, TOCItem } from "@readany/core/types";
import { eventBus } from "@readany/core/utils/event-bus";
import { throttle } from "@readany/core/utils/throttle";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
/**
 * ReaderScreen — WebView-based reader with foliate-js engine.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { ReaderTopBar } from "./reader/ReaderTopBar";

// ── Extracted modules ──
import { ReaderNoteViewModal } from "./reader/ReaderNoteViewModal";
import { ReaderToolbar, TOOLBAR_HEIGHT } from "./reader/ReaderToolbar";

const REFLOWABLE_CHARACTERS_PER_LOCATION = 1500;
const MAX_TRACKED_LOCATION_DELTA = 20;
const MAX_TRACKED_PAGE_DELTA = 20;
const MAX_TRACKED_FRACTION_DELTA = 0.08;
const INITIAL_PROGRESS_RESTORE_GUARD_MS = 1800;
const PROGRAMMATIC_NAV_GUARD_MS = 1200;
const CONTROLS_VISIBILITY_ANIMATION_MS = 220;
const BOOK_MIME_TYPES = [
  "application/epub+zip",
  "application/pdf",
  "application/x-mobipocket-ebook",
  "application/vnd.amazon.ebook",
  "application/vnd.comicbook+zip",
  "application/x-fictionbook+xml",
  "text/plain",
  "application/octet-stream",
];

const BOOK_FORMAT_MIME_TYPES: Partial<Record<string, string>> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook+zip",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-zip-compressed-fb2",
  txt: "text/plain",
};

function normalizeBookIdentityText(value?: string): string {
  return (value || "").toLowerCase().replace(/[\s\p{P}\p{S}_-]+/gu, "");
}

function authorsLikelyMatch(a?: string, b?: string): boolean {
  const left = normalizeBookIdentityText(a);
  const right = normalizeBookIdentityText(b);
  if (!left || !right) return true;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftParts = left.split(/[,，、/&]+/).filter((part) => part.length > 1);
  const rightParts = right.split(/[,，、/&]+/).filter((part) => part.length > 1);
  return leftParts.some((part) =>
    rightParts.some((candidate) => part.includes(candidate) || candidate.includes(part)),
  );
}

function shouldConfirmReimportCandidate(
  originalBook: { meta: { title: string; author: string }; format: string; fileHash?: string },
  candidate: { title: string; author: string; format: string; fileHash?: string },
): boolean {
  if (candidate.fileHash && originalBook.fileHash && candidate.fileHash === originalBook.fileHash) {
    return false;
  }
  const originalTitle = normalizeBookIdentityText(originalBook.meta.title);
  const candidateTitle = normalizeBookIdentityText(candidate.title);
  const titleMismatch =
    !!originalTitle &&
    !!candidateTitle &&
    originalTitle !== candidateTitle &&
    !originalTitle.includes(candidateTitle) &&
    !candidateTitle.includes(originalTitle);
  const authorMismatch = !authorsLikelyMatch(originalBook.meta.author, candidate.author);
  const formatMismatch = originalBook.format !== candidate.format;
  return titleMismatch || (formatMismatch && authorMismatch);
}
const NOTE_TOOLTIP_WIDTH = 300;
const NOTE_TOOLTIP_SIDE_PADDING = 12;
const NOTE_TOOLTIP_ABOVE_OFFSET = 2;
const NOTE_TOOLTIP_BELOW_OFFSET = 8;
const NOTE_TOOLTIP_TOP_THRESHOLD = 180;
import {
  flattenReaderColor,
  getAppSyncedReaderTheme,
  resolveReaderScenePalette,
  resolveReaderThemeColors,
} from "@/lib/reader/reader-themes";
import { useRubyStore } from "@readany/core/stores/ruby-store";
import { ReaderSettingsPanel } from "./reader/ReaderSettingsPanel.entry";
import { CONTROLS_TIMEOUT, SCREEN_HEIGHT, SCREEN_WIDTH } from "./reader/reader-constants";
import { makeStyles, noteTooltipMdStyles } from "./reader/reader-styles";
import { useReaderTOCSheet } from "./reader/reader-toc-sheet-context";
import { useReaderBookmark } from "./reader/useReaderBookmark";
import { useReaderSearch } from "./reader/useReaderSearch";
import { useReaderSystemInfo } from "./reader/useReaderSystemInfo";
import { useReaderTTS } from "./reader/useReaderTTS";
import { useVolumeButtonPaging } from "./reader/useVolumeButtonPaging";

type Props = NativeStackScreenProps<RootStackParamList, "Reader">;
type TTSSegment = VisibleTTSSegment;

// ──────────────────────────── helpers ────────────────────────────

function ReaderLoadingIndicator({ color }: { color: string }) {
  return <AnimatedNarraFace width={56} height={58} color={color} />;
}

const keepTTSInReader = (_visible: boolean) => undefined;

async function isStoredBookFileAvailable(book: Book): Promise<boolean> {
  const filePath = book.filePath;
  const isAbsolute = filePath.startsWith("/") || /^[a-z]+:\/\//i.test(filePath);
  const uri = isAbsolute ? filePath : `${FileSystem.documentDirectory ?? ""}${filePath}`;
  if (!uri) return false;

  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && !info.isDirectory && (info.size ?? 1) > 0;
}

// ──────────────────────────── ReaderScreen ────────────────────────────
export function ReaderScreen(props: Props) {
  const { t } = useTranslation();
  const importBooks = useLibraryStore((state) => state.importBooks);
  const updateBook = useLibraryStore((state) => state.updateBook);
  const requestedBookId = props.route.params.bookId;
  const catalogBookId = props.route.params.catalogBookId;
  const catalogBook = props.route.params.catalogBook;
  const [resolvedBookId, setResolvedBookId] = useState<string | null>(
    catalogBookId || catalogBook ? null : requestedBookId,
  );

  useEffect(() => {
    if (catalogBookId || catalogBook) return;
    setResolvedBookId(requestedBookId);
  }, [catalogBook, catalogBookId, requestedBookId]);

  useEffect(() => {
    if (!catalogBookId) return;

    const bundledBook = BUNDLED_CATALOG_BOOKS.find((book) => book.id === catalogBookId);
    if (!bundledBook) {
      toast.error(t("library.catalogImportErrorTitle", "Не получилось добавить книгу"), {
        description: t("library.catalogImportErrorDescription", "Попробуйте ещё раз."),
      });
      props.navigation.goBack();
      return;
    }

    let cancelled = false;
    const prepareBundledBook = async () => {
      const existingBook = useLibraryStore
        .getState()
        .books.find(
          (book) =>
            !book.deletedAt &&
            normalizeCatalogIdentity(book.meta.title) ===
              normalizeCatalogIdentity(bundledBook.title),
        );
      if (existingBook) return existingBook.id;

      const uri = await resolveBundledCatalogBookUri(bundledBook);
      const result = await importBooks([{ uri, name: bundledBook.fileName }]);
      const importedBook = result.imported[0] ?? result.skippedDuplicates[0]?.existingBook;
      if (!importedBook) throw new Error("catalog-import-failed");

      const normalizedMeta = {
        ...importedBook.meta,
        title: bundledBook.title,
        author: bundledBook.author,
      };
      await updateBook(importedBook.id, { meta: normalizedMeta });
      void installBundledCatalogCover(importedBook.id, bundledBook)
        .then((coverUrl) => updateBook(importedBook.id, { meta: { ...normalizedMeta, coverUrl } }))
        .catch((error) =>
          console.warn(`[Catalog] Failed to install cover ${bundledBook.id}:`, error),
        );
      return importedBook.id;
    };

    void prepareBundledBook()
      .then((bookId) => {
        if (!cancelled) setResolvedBookId(bookId);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(`[Catalog] Failed to add ${bundledBook.id}:`, error);
        toast.error(t("library.catalogImportErrorTitle", "Не получилось добавить книгу"), {
          description: t("library.catalogImportErrorDescription", "Попробуйте ещё раз."),
        });
        props.navigation.goBack();
      });

    return () => {
      cancelled = true;
    };
  }, [catalogBookId, importBooks, props.navigation, t, updateBook]);

  // Каталог открывает книгу сразу: качаем и импортируем уже здесь, под лоудером
  // ридера. Уход назад прерывает загрузку — незачем тянуть файл в пустоту.
  useEffect(() => {
    if (!catalogBook) return;

    const controller = new AbortController();
    let cancelled = false;
    const prepareCatalogBook = async () => {
      const existingBook = useLibraryStore
        .getState()
        .books.find(
          (book) =>
            !book.deletedAt &&
            book.sourceKind === "catalog" &&
            book.bookEditionId === catalogBook.bookEditionId,
        );
      if (
        existingBook &&
        isCatalogBookRevisionCurrent(existingBook, catalogBook) &&
        (await isStoredBookFileAvailable(existingBook))
      ) {
        return existingBook.id;
      }

      const importedBook = await importBackendCatalogBook(catalogBook, {
        importBooks,
        updateBook,
        signal: controller.signal,
      });
      if (existingBook && importedBook.id !== existingBook.id) {
        await updateBook(existingBook.id, { sourceKind: "local" });
        await updateBook(importedBook.id, {
          progress: existingBook.progress,
          groupId: existingBook.groupId,
          tags: existingBook.tags,
          lastOpenedAt: Date.now(),
        });
      }
      return importedBook.id;
    };

    void prepareCatalogBook()
      .then((bookId) => {
        if (!cancelled) setResolvedBookId(bookId);
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        console.error(`[Catalog] Failed to add ${catalogBook.catalogKey}:`, error);
        toast.error(t("library.catalogImportErrorTitle", "Не получилось добавить книгу"), {
          description: t("library.catalogImportErrorDescription", "Попробуйте ещё раз."),
        });
        props.navigation.goBack();
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [catalogBook, importBooks, props.navigation, t, updateBook]);

  if (!resolvedBookId) {
    return <ReaderLoadingChrome navigation={props.navigation} />;
  }

  return (
    <ReaderContent
      {...props}
      route={{
        ...props.route,
        params: { ...props.route.params, bookId: resolvedBookId, catalogBookId: undefined },
      }}
    />
  );
}

/**
 * Бумажный фон ридера. Нужен и до открытия книги: экран загрузки красится им же,
 * чтобы тап по обложке не давал вспышки цвета приложения.
 */
function useReaderPaperColors() {
  const readerTheme = useSettingsStore((s) => s.readSettings.readerTheme);

  return useMemo(() => {
    const resolved = resolveReaderThemeColors(
      readerTheme,
      {
        background: lightColors.primary10,
        foreground: lightColors.primary80,
        muted: lightColors.mutedForeground,
        primary: lightColors.primary,
      },
      {
        background: darkColors.primary10,
        foreground: darkColors.primary80,
        muted: darkColors.mutedForeground,
        primary: darkColors.primary,
      },
    );
    const backdrop = readerTheme === "dark" ? darkColors.background : lightColors.background;
    const paperBackground = flattenReaderColor(resolved.background, backdrop);
    const sceneColors = resolveReaderScenePalette(
      readerTheme,
      lightColors,
      darkColors,
      paperBackground,
    );
    return {
      ...resolved,
      primary5: sceneColors.primary5,
      primary8: sceneColors.primary8,
      primary10: sceneColors.primary10,
      primary20: sceneColors.primary20,
      primary40: sceneColors.primary40,
      sceneActionColor: sceneColors.sceneActionColor ?? sceneColors.primary40,
      elevation1: sceneColors.elevation1,
      elevation2: sceneColors.elevation2,
      background: paperBackground,
    };
  }, [readerTheme]);
}

function ReaderLoadingChrome({ navigation }: { navigation: Props["navigation"] }) {
  const colors = useColors();
  const paperColors = useReaderPaperColors();
  const { isDark } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const ignorePress = () => undefined;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: true,
      headerTransparent: false,
      headerShadowVisible: false,
      headerBackButtonDisplayMode: "minimal",
      headerTintColor: colors.foreground,
      headerTitleAlign: "center",
      title: "",
      unstable_headerRightItems: undefined,
      headerRight: () => (
        <View pointerEvents="none">
          <NativeContextMenuButton
            accessibilityLabel={t("reader.bookActions", "Действия с книгой")}
            items={[]}
            color={colors.foreground}
          />
        </View>
      ),
    });
  }, [colors.foreground, navigation, t]);

  return (
    <View
      style={{ flex: 1, paddingBottom: insets.bottom, backgroundColor: paperColors.background }}
    >
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ReaderLoadingIndicator color={colors.primary20} />
      </View>
      {Platform.OS === "ios" && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            left: 0,
            height: TOOLBAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
            backgroundColor: "transparent",
          }}
        >
          <ReaderToolbar
            tintColor={colors.foreground}
            isDark={isDark}
            speechState="idle"
            onSpeechPress={ignorePress}
            onCharactersPress={ignorePress}
          />
        </View>
      )}
    </View>
  );
}

function ReaderContent({ route, navigation }: Props) {
  const colors = useColors();
  const { mode: themeMode, isDark } = useTheme();
  const s = makeStyles(colors);
  const { register: registerTOCSheet, unregister: unregisterTOCSheet } = useReaderTOCSheet();
  const { bookId, cfi, highlight: shouldHighlight, openTTS } = route.params;
  const charactersSheetSourceId = `reader-characters-${bookId}`;
  const { t } = useTranslation();
  const bookmarkCopy = useMemo(() => getReaderBookmarkCopy(t), [t]);
  const isIPadLayout = Platform.OS === "ios" && Platform.isPad;
  const baseTopInset = Platform.OS === "ios" ? 20 : 24;

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [showTOC, setShowTOC] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotebook, setShowNotebook] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationText, setTranslationText] = useState("");
  const [showChapterTranslation, setShowChapterTranslation] = useState(false);
  const [isReimporting, setIsReimporting] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const restartHostRef = useRef(false);
  const automaticRecoveryRef = useRef(false);
  const readerServerUrlRef = useRef<string | null>(null);
  const diagnosticPingRef = useRef(0);
  const diagnosticUnresponsiveRef = useRef(false);
  const lastDiagnosticRelocateRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [currentChapter, setCurrentChapter] = useState("");
  const [currentChapterHref, setCurrentChapterHref] = useState("");
  // Позиция по всей книге (foliate location, как «стр. N из M» в Apple Books)
  const [bookLocation, setBookLocation] = useState<{ current: number; total: number } | null>(null);
  const [toc, setToc] = useState<TOCItem[]>([]);
  const [bookTitle, setBookTitle] = useState("");
  const [webViewReady, setWebViewReady] = useState(false);
  const [translationReady, setTranslationReady] = useState(false);
  const [readerHtmlUri, setReaderHtmlUri] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState("");
  const [selection, setSelection] = useState<SelectionEvent | null>(null);
  const selectionRef = useRef<SelectionEvent | null>(null);
  const [defaultReaderFontFaceCSS, setDefaultReaderFontFaceCSS] = useState("");
  const [noteViewHighlight, setNoteViewHighlight] = useState<{
    id: string;
    text: string;
    note?: string;
    cfi: string;
    color: string;
  } | null>(null);
  const [noteViewEditing, setNoteViewEditing] = useState(false);
  const [noteViewContent, setNoteViewContent] = useState("");
  const [noteTooltip, setNoteTooltip] = useState<{
    note: string;
    cfi: string;
    position: { x: number; y: number; selectionTop: number; selectionBottom: number };
  } | null>(null);
  const noteTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTooltipVisibleRef = useRef(false);
  const suppressReaderTapUntilRef = useRef(0);
  // Mediator ref so onRelocate can fire TTS continuation without direct hook dependency
  const ttsPendingContinueRef = useRef<{
    pendingTTSContinueCallbackRef: React.RefObject<(() => void) | null>;
    pendingTTSContinueSafetyTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  } | null>(null);
  const searchCompleteRef = useRef<
    ((count: number, results?: ReaderSearchResultItem[]) => void) | null
  >(null);

  const bridgeRef = useRef<{
    requestPageSnippet: () => void;
    goNext: () => void;
    search: (query: string) => void;
    clearSearch: () => void;
    navigateSearch: (index: number) => void;
    getVisibleText: () => Promise<string>;
    getVisibleTTSSegments: (alignCfi?: string | null) => Promise<TTSSegment[]>;
    getChapterParagraphs: () => Promise<Array<{ id: string; text: string; tagName: string }>>;
    getTTSSegmentContext: (
      cfi: string,
      before?: number,
      after?: number,
    ) => Promise<{ before: TTSSegment[]; after: TTSSegment[] }>;
    getHrefTTSSegments?: (href: string, count?: number) => Promise<TTSSegment[]>;
    getChapterTTSSegments?: (
      startHref: string,
      endHref?: string,
      count?: number,
    ) => Promise<TTSSegment[]>;
    getSectionTTSSegments?: (sectionIndex: number, count?: number) => Promise<TTSSegment[]>;
    goToFraction: (fraction: number) => void;
    goToSection: (sectionIndex: number) => void;
    goToCFI: (cfi: string) => void;
    followTTSLocation: (cfi: string) => void;
    goToHref: (href: string) => void;
    flashHighlight: (cfi: string, color?: string, duration?: number) => void;
    addAnnotation: (annotation: {
      value: string;
      type?: string;
      color?: string;
      note?: string;
    }) => void;
    removeAnnotation: (annotation: { value: string; type?: string }) => void;
    setTTSHighlight: (
      cfi: string | null,
      color?: string,
      force?: boolean,
      wordIndex?: number | null,
      text?: string | null,
    ) => void;
    insertSceneSlot: () => void;
    replaceSceneSlot: (anchor: string, imageDataUri: string) => void;
    setSceneSlotState: (anchor: string, state: "idle" | "loading" | "error") => void;
    removeSceneSlot: (anchor: string) => void;
  } | null>(null);

  // Chapter translation state
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const chapterTranslationBridgeRef = useRef<{
    getChapterParagraphs: () => Promise<Array<{ id: string; text: string; tagName: string }>>;
    injectChapterTranslations: (
      results: Array<{ paragraphId: string; originalText: string; translatedText: string }>,
      visibility?: { originalVisible: boolean; translationVisible: boolean },
    ) => Promise<void>;
    removeChapterTranslations: () => void;
  } | null>(null);

  const readSettings = useSettingsStore((s) => s.readSettings);
  const updateReadSettings = useSettingsStore((s) => s.updateReadSettings);
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const showTopTitleProgress = readSettings.showTopTitleProgress !== false;

  // При открытии ридера и при смене темы приложения начинаем с той же темы.
  // После этого пользователь может выбрать сепию или другую тему для текущей сессии.
  useEffect(() => {
    const readerTheme = getAppSyncedReaderTheme(isDark);
    if (useSettingsStore.getState().readSettings.readerTheme !== readerTheme) {
      updateReadSettings({ readerTheme });
    }
  }, [isDark, updateReadSettings]);

  // Явные темы страницы: Light, Dark, Sepia. "original" — сохранённый id Light.
  const readerThemeColors = useReaderPaperColors();
  const readerThemeColorsRef = useRef(readerThemeColors);
  readerThemeColorsRef.current = readerThemeColors;
  const isReaderThemeDark =
    readSettings.readerTheme === "dark" || (!readSettings.readerTheme && isDark);

  // Track OS-level accessibility font scale; re-renders when the user
  // changes the system font size while the reader is open.
  const { fontScale: systemFontScale } = useWindowDimensions();
  // Apply the system scale only when the user has opted into
  // followSystemFontScale. The store keeps the user's raw fontSize, so
  // toggling the option (or changing OS font size) doesn't drift the
  // stepper value.
  const computeEffectiveFontSize = useCallback(
    (rawFontSize: number, follow: boolean | undefined): number =>
      follow ? Math.max(1, Math.round(rawFontSize * systemFontScale)) : rawFontSize,
    [systemFontScale],
  );

  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsVisibility = useSharedValue(1);
  const controlsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: controlsVisibility.value,
  }));
  const lastCfiRef = useRef<string>("");
  const progressRef = useRef(0);
  const locationHistoryRef = useRef<string[]>([]);
  const lastNavigatedCfiRef = useRef<string | undefined>(undefined);
  const defaultReaderFontFaceCSSRef = useRef("");
  const sessionProgressRef = useRef<{
    mode: "location" | "page" | "characters";
    current: number;
    fraction?: number;
    section?: number;
    page?: number;
  } | null>(null);
  const totalBookCharactersRef = useRef<number | null>(null);
  const progressTrackingGuardUntilRef = useRef(0);

  const incrementPagesRead = useReadingSessionStore((s) => s.incrementPagesRead);
  const incrementCharactersRead = useReadingSessionStore((s) => s.incrementCharactersRead);
  const readingActiveTime = useReadingSessionStore(
    (state) => state.currentSession?.totalActiveTime ?? 0,
  );
  const qualifiedReadingRecordedRef = useRef(false);
  const { sendEvent } = useReadingSession(bookId); // Added useReadingSession hook
  const { books, updateBook } = useLibraryStore();
  const setGoToCfiFn = useReaderStore((s) => s.setGoToCfiFn);

  // Throttled progress save (same as desktop - 5 seconds)
  const throttledSaveProgress = useRef(
    throttle((bId: string, prog: number, cfi: string) => {
      updateBook(bId, {
        progress: prog,
        currentCfi: cfi,
      });
    }, 5000),
  ).current;
  const publishCharacterProgress = useCallback(() => {
    // Character screens read the library store, not the reader's live position.
    // Publish before navigating so the five-second save throttle cannot relock a hero.
    if (!lastCfiRef.current) return;
    void updateBook(bookId, {
      progress,
      currentCfi: lastCfiRef.current,
    });
  }, [bookId, progress, updateBook]);
  const { loadAnnotations, highlights } = useAnnotationStore();
  const book = useMemo(() => books.find((b) => b.id === bookId), [books, bookId]);
  const activeReaderLoadIdRef = useRef<string | null>(null);

  // ── Narra: кликабельные имена персонажей ────────────────────────────────────
  const narraBookCharacters = useNarraStore((state) => state.books[bookId]?.characters);
  const characters = useMemo<NarraCharacter[]>(
    () => (narraBookCharacters ?? []).filter((item) => item.backendManaged),
    [narraBookCharacters],
  );
  // Ключ состава открытых персонажей: спека пересобирается только при unlock,
  // а не на каждом изменении прогресса
  const unlockedCharacterIdsKey = useMemo(
    () =>
      characters
        .filter((character) => isCharacterUnlocked(progress, character))
        .map((character) => character.id)
        .join(","),
    [characters, progress],
  );
  const characterNameSpecJson = useMemo(() => {
    const unlockedIds = new Set(unlockedCharacterIdsKey.split(",").filter(Boolean));
    if (unlockedIds.size === 0) return null;
    const unlocked = characters.filter((character) => unlockedIds.has(character.id));
    return JSON.stringify(buildCharacterNameMatcherSpec(unlocked));
  }, [characters, unlockedCharacterIdsKey]);

  // ── Narra: врезки сцен внутри текста раз в N страниц (P6 → P14) ─────────────
  // Счётчик перелистываний прежний (scene-suggestion.ts); по сигналу в конец
  // видимого фрагмента WebView вставляет слот «Сгенерировать сцену», тап по нему
  // запускает генерацию, готовая картинка встаёт в текст на место слота.
  const sceneSuggestionInterval = useNarraStore((state) => state.sceneSuggestionInterval);
  const sceneSuggestionStateRef = useRef(INITIAL_SCENE_SUGGESTION_STATE);
  const narraScenes = useNarraStore((state) => state.books[bookId]?.scenes);
  const narraSceneRequests = useNarraStore((state) => state.books[bookId]?.sceneRequests);
  const narraSceneAnchorBindings = useNarraStore(
    (state) => state.books[bookId]?.sceneAnchorBindings,
  );
  const narraScenesByBackendId = useNarraStore((state) => state.books[bookId]?.scenesByBackendId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each book owns separate operations; changing books aborts only the previous ones.
  const sceneSlotActions = useMemo(() => new Map<string, AbortController>(), [bookId]);
  useEffect(
    () => () => {
      for (const action of sceneSlotActions.values()) action.abort();
      sceneSlotActions.clear();
    },
    [sceneSlotActions],
  );

  // Генерация (или перегенерация) сцены для врезки: слот уже показывает
  // плейсхолдер «Рисуем сцену…» — сюда приходим по событию из WebView.
  const runSceneSlotGeneration = useCallback(
    async (anchor: string) => {
      if (sceneSlotActions.has(anchor)) return;
      const action = new AbortController();
      sceneSlotActions.set(anchor, action);
      // Snapshot BEFORE any await. Paging while the server works cannot change the slot.
      const requestedProgress = progressRef.current;
      let usesBackend = false;
      try {
        const sourceKey = sceneSourceKeyForAnchor(anchor);
        const bookState = useNarraStore.getState().books[bookId];
        const cached = backendSceneForAnchor(bookState, anchor) ?? bookState?.scenes?.[sourceKey];
        const chapter =
          cached?.chapter ||
          currentChapter ||
          bookTitle ||
          book?.meta.title ||
          t("reader.currentPage", "Текущая страница");
        // Catalog identity may be present before the persisted binding has hydrated.
        const edition = bookState?.backendBinding?.bookEditionId || book?.bookEditionId;
        usesBackend = Boolean(edition);
        if (!edition) {
          throw new NarraServiceError(
            "REQUEST",
            "Сцена рисуется только для книги с изданием в Narra. Ответ без книги недоступен.",
          );
        }
        const previous = bookState?.sceneRequests?.[sourceKey] ?? cached?.backendScene;
        const manifest = bookState?.backendManifest;
        const intent =
          previous?.bookEditionId === edition
            ? previous
            : {
                bookEditionId: edition,
                requestedProgress,
                markupIdentity: backendSceneMarkupIdentity(manifest, bookState?.backendBinding),
              };
        await generateBackendReaderScene(
          {
            bookId,
            anchor,
            sourceKey,
            chapter,
            intent,
            display: (targetAnchor, dataUri) =>
              bridgeRef.current?.replaceSceneSlot(targetAnchor, dataUri),
            remove: (targetAnchor) => bridgeRef.current?.removeSceneSlot(targetAnchor),
          },
          action.signal,
        );
      } catch (cause) {
        if (action.signal.aborted) return;
        // Native download errors can contain signed URLs. Backend details use the safe journal.
        if (!usesBackend) reportNarraError("scene_image", cause);
        bridgeRef.current?.setSceneSlotState(anchor, "error");
      } finally {
        sceneSlotActions.delete(anchor);
      }
    },
    [book?.meta.title, book?.bookEditionId, sceneSlotActions, t, bookId, bookTitle, currentChapter],
  );

  // Врезка восстановлена при загрузке секции — вернуть сохранённую картинку
  const handleSceneSlotRestored = useCallback(
    async (anchor: string) => {
      if (sceneSlotActions.has(anchor)) {
        bridgeRef.current?.setSceneSlotState(anchor, "loading");
        return;
      }
      const sourceKey = sceneSourceKeyForAnchor(anchor);
      const bookState = useNarraStore.getState().books[bookId];
      const scene = backendSceneForAnchor(bookState, anchor) ?? bookState?.scenes?.[sourceKey];
      if (!scene?.imageUri) {
        bridgeRef.current?.setSceneSlotState(
          anchor,
          bookState?.sceneRequests?.[sourceKey] ? "error" : "idle",
        );
        return;
      }
      const action = new AbortController();
      sceneSlotActions.set(anchor, action);
      try {
        const dataUri = await readSceneDataUri(scene.imageUri);
        if (!action.signal.aborted) bridgeRef.current?.replaceSceneSlot(anchor, dataUri);
      } catch {
        if (!action.signal.aborted) bridgeRef.current?.setSceneSlotState(anchor, "error");
      } finally {
        sceneSlotActions.delete(anchor);
      }
    },
    [bookId, sceneSlotActions],
  );

  useEffect(() => {
    if (qualifiedReadingRecordedRef.current || readingActiveTime < 60_000) return;
    qualifiedReadingRecordedRef.current = true;
    recordTelemetry("reading_session_qualified", {
      book_kind: book && findBundledCatalogBookByTitle(book.meta.title) ? "builtin" : "imported",
      duration_seconds: Math.round(readingActiveTime / 1_000),
      duration_bucket: durationBucket(readingActiveTime),
    });
  }, [book, readingActiveTime]);

  // ── System safe area ────────────────────────────────────────────────────────
  const { stableTopInset, insets } = useReaderSystemInfo({
    isIPadLayout,
    baseTopInset,
  });

  // ── Bookmark ───────────────────────────────────────────────────────────────
  const requestPageSnippet = useCallback(() => {
    bridgeRef.current?.requestPageSnippet();
  }, []);
  // Отдача висит на самом действии, а не на появлении ленты закладки: лента
  // показывается и когда пользователь просто перелистнул на уже заложенную
  // страницу, и вибрация там была бы откликом на прокрутку. Тост остаётся
  // основным сигналом, вибрация только подтверждает его.
  const handleBookmarkAdded = useCallback(() => {
    hapticLight();
    toast.success(bookmarkCopy.added);
  }, [bookmarkCopy.added]);
  const handleBookmarkRemoved = useCallback(() => {
    hapticLight();
    toast.success(bookmarkCopy.removed);
  }, [bookmarkCopy.removed]);
  const bookmark = useReaderBookmark({
    bookId,
    currentCfi,
    currentChapter,
    requestPageSnippet,
    onBookmarkAdded: handleBookmarkAdded,
    onBookmarkRemoved: handleBookmarkRemoved,
  });
  const { isBookmarked, handleToggleBookmark } = bookmark;

  useLayoutEffect(() => {
    // The reader draws its own top bar, in the same animated container as the
    // toolbar, so the native header stays out of the way entirely. It cannot
    // carry these controls anyway: a bar button item does not take part in the
    // toolbar's fade, and on this modal screen adding or removing the header
    // tears the content down and reloads the book.
    navigation.setOptions({
      statusBarStyle: isReaderThemeDark ? "light" : "dark",
    });
  }, [isReaderThemeDark, navigation]);

  const suppressProgressTracking = useCallback((duration = PROGRAMMATIC_NAV_GUARD_MS) => {
    progressTrackingGuardUntilRef.current = Math.max(
      progressTrackingGuardUntilRef.current,
      Date.now() + duration,
    );
  }, []);

  const goToCFISafely = useCallback(
    (targetCfi: string) => {
      if (!targetCfi) return;
      suppressProgressTracking();
      bridgeRef.current?.goToCFI(targetCfi);
    },
    [suppressProgressTracking],
  );

  const goToHrefSafely = useCallback(
    (href: string) => {
      if (!href) return;
      suppressProgressTracking();
      bridgeRef.current?.goToHref(href);
    },
    [suppressProgressTracking],
  );

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    sessionProgressRef.current = null;
    totalBookCharactersRef.current = null;
    sceneSuggestionStateRef.current = INITIAL_SCENE_SUGGESTION_STATE;
    suppressProgressTracking(INITIAL_PROGRESS_RESTORE_GUARD_MS);
  }, [bookId]);
  const chapterTranslation = useChapterTranslation({
    bookId,
    sectionIndex: currentSectionIndex,
    aiConfig,
    ready: translationReady,
    translationConfig,
    getParagraphs: async () => {
      if (!chapterTranslationBridgeRef.current) return [];
      return chapterTranslationBridgeRef.current.getChapterParagraphs();
    },
    injectTranslations: (results, visibility) => {
      return chapterTranslationBridgeRef.current?.injectChapterTranslations(results, visibility);
    },
    removeTranslations: () => {
      chapterTranslationBridgeRef.current?.removeChapterTranslations();
    },
    applyVisibility: (originalVisible, translationVisible) => {
      const translationHidden = !translationVisible;
      const originalHidden = !originalVisible;
      const solo = !originalVisible && translationVisible;
      bridge.webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            var doc = null;
            var renderer = typeof view !== 'undefined' && view && view.renderer;
            if (renderer && renderer.getContents) {
              var contents = renderer.getContents();
              if (contents && contents[0] && contents[0].doc) doc = contents[0].doc;
            }
            if (!doc) {
              var iframes = document.querySelectorAll('iframe');
              for (var fi = 0; fi < iframes.length; fi++) {
                try {
                  var iframeDoc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
                  if (iframeDoc && iframeDoc.body) { doc = iframeDoc; break; }
                } catch (e) {}
              }
            }
            if (!doc) return;
            var els = doc.querySelectorAll('.readany-translation');
            for (var i = 0; i < els.length; i++) {
              els[i].setAttribute('data-hidden', '${translationHidden}');
              els[i].setAttribute('data-solo', '${solo}');
            }
            var origEls = doc.querySelectorAll('[data-translate-id]');
            for (var j = 0; j < origEls.length; j++) {
              origEls[j].setAttribute('data-original-hidden', '${originalHidden}');
            }
          } catch(e) {}
        })();
        true;
      `);
    },
    getCurrentCfi: () => currentCfi,
    goToCfi: (cfi) => bridgeRef.current?.goToCFI(cfi),
  });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Also read ttsPlayState from store for volume paging guard
  const ttsPlayState = useTTSStore((s) => s.playState);

  // Focus & foreground state for volume paging whitelist
  const isFocused = useIsFocused();
  useBackendBook(book, isFocused, progress);
  const [appActive, setAppActive] = useState(true);

  useEffect(() => {
    if (!isFocused) return;

    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => {
      setShowControls(false);
      controlsTimer.current = null;
    }, CONTROLS_TIMEOUT);

    return () => {
      if (controlsTimer.current) {
        clearTimeout(controlsTimer.current);
        controlsTimer.current = null;
      }
    };
  }, [isFocused]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s: AppStateStatus) =>
      setAppActive(s === "active"),
    );
    return () => sub.remove();
  }, []);

  // A rebuilt HTML asset must replace the WebView even after Fast Refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the generated build ID changes on HMR, unlike an ordinary imported constant.
  useEffect(() => {
    let cancelled = false;
    const loadAsset = async () => {
      try {
        const uri = await prepareReaderAsset();
        if (cancelled || uri === readerHtmlUri) return;
        setWebViewReady(false);
        setLoading(true);
        setReaderHtmlUri(uri);
      } catch (err) {
        console.error("[ReaderScreen] Failed to load reader.html asset:", err);
        if (!cancelled) setError("Failed to load reader");
      }
    };
    loadAsset();
    return () => {
      cancelled = true;
    };
  }, [READER_BUILD_ID, readerHtmlUri]);

  // Controls toggle — declared before bridge so onTap can reference it without TS error
  const toggleControls = useCallback(() => {
    const willShow = !showControls;
    setShowControls(willShow);

    if (controlsTimer.current) {
      clearTimeout(controlsTimer.current);
      controlsTimer.current = null;
    }

    if (willShow) {
      controlsTimer.current = setTimeout(() => {
        setShowControls(false);
        controlsTimer.current = null;
      }, CONTROLS_TIMEOUT);
    }
  }, [showControls]);

  useEffect(() => {
    controlsVisibility.value = withTiming(showControls ? 1 : 0, {
      duration: CONTROLS_VISIBILITY_ANIMATION_MS,
    });
  }, [controlsVisibility, showControls]);

  // Reader bridge
  const retryReader = useCallback((restartHost = true) => {
    recordDiagnostic("reader_retry", { restart: restartHost });
    restartHostRef.current = restartHost;
    readerServerUrlRef.current = null;
    activeReaderLoadIdRef.current = null;
    setWebViewReady(false);
    setLoading(true);
    setError(null);
    setLoadAttempt((value) => value + 1);
  }, []);

  const bridge = useReaderBridge({
    onDiagnosticPong: (id) => {
      if (id !== diagnosticPingRef.current) return;
      if (diagnosticUnresponsiveRef.current) recordDiagnostic("webview_responsive");
      diagnosticUnresponsiveRef.current = false;
      diagnosticPingRef.current = 0;
    },
    onReady: () => {
      recordDiagnostic("reader_ready");
      setWebViewReady(true);
      bridge.webViewRef.current?.injectJavaScript(`
        (function() {
          if (!window.__view && document.querySelector('foliate-view')) {
            window.__view = document.querySelector('foliate-view');
          }
        })();
        true;
      `);
    },
    onLoaded: (detail) => {
      if (detail.loadId && detail.loadId !== activeReaderLoadIdRef.current) return;
      recordDiagnostic("reader_loaded");
      // Initial typography is sent with openBook and applied inside the
      // WebView before it signals loaded. Applying it again here starts a
      // second renderer layout pass and makes the first page flash.
      setLoading(false);

      // Auto-restore ruby annotations if enabled for this book
      const rubyMode = useRubyStore.getState().getBookRuby(bookId);
      if (rubyMode) {
        void (async () => {
          try {
            const { checkExistingDictMobile, readDictStrings } = await import(
              "@/lib/ruby/dict-service-mobile"
            );
            const exists = await checkExistingDictMobile();
            if (exists) {
              const { wordDict, charDict } = await readDictStrings();
              if (wordDict || charDict) {
                bridge.setRubyDicts(wordDict, charDict);
                setTimeout(() => bridge.injectRuby(rubyMode), 150);
              }
            }
          } catch (err) {
            console.error("[ReaderScreen] Ruby auto-restore failed:", err);
          }
        })();
      }
    },
    onBookTextMetrics: ({ totalCharacters }) => {
      if (totalCharacters <= 0) {
        totalBookCharactersRef.current = null;
        return;
      }
      totalBookCharactersRef.current = totalCharacters;
      updateBook(bookId, { totalCharacters });
    },
    onRelocate: (detail: RelocateEvent) => {
      if (detail.loadId && detail.loadId !== activeReaderLoadIdRef.current) return;
      if (Date.now() - lastDiagnosticRelocateRef.current > 5000) {
        recordDiagnostic("reader_relocated");
        lastDiagnosticRelocateRef.current = Date.now();
      }
      const absoluteFraction = detail.fraction ?? 0;
      // Track section changes for chapter translation reset
      const newSection = detail.section?.current ?? 0;
      if (newSection !== currentSectionIndex) {
        setCurrentSectionIndex(newSection);
        setTranslationReady(false);
        chapterTranslation.reset();
      }

      if (detail.fraction != null) {
        setProgress(absoluteFraction);
      }

      // «стр. N из M» по всей книге — из foliate location (нет в scrolled/fixed)
      setBookLocation(detail.location?.total ? detail.location : null);

      const trackingSuppressed = Date.now() < progressTrackingGuardUntilRef.current;

      if (detail.location?.total) {
        const totalBookCharacters = totalBookCharactersRef.current;
        const fraction = absoluteFraction;
        if (totalBookCharacters && totalBookCharacters > 0) {
          const currentCharacters = Math.round(totalBookCharacters * fraction);
          const previous = sessionProgressRef.current;
          const currentSection = detail.section?.current ?? 0;
          const currentRendererPage = detail.page?.current ?? null;

          if (
            !trackingSuppressed &&
            previous?.mode === "characters" &&
            currentCharacters > previous.current
          ) {
            if (currentRendererPage != null && previous.page != null && previous.section != null) {
              const samePage =
                previous.section === currentSection && previous.page === currentRendererPage;
              const movedForwardWithinSection =
                previous.section === currentSection &&
                currentRendererPage > previous.page &&
                currentRendererPage - previous.page <= MAX_TRACKED_PAGE_DELTA;
              const movedForwardAcrossSection =
                currentSection > previous.section && currentSection - previous.section <= 1;

              if (!samePage && (movedForwardWithinSection || movedForwardAcrossSection)) {
                incrementCharactersRead(currentCharacters - previous.current);
              }
            } else if (
              Math.abs(fraction - (previous.fraction ?? 0)) <= MAX_TRACKED_FRACTION_DELTA
            ) {
              incrementCharactersRead(currentCharacters - previous.current);
            }
          }
          sessionProgressRef.current = {
            mode: "characters",
            current: currentCharacters,
            fraction,
            section: currentSection,
            page: currentRendererPage ?? undefined,
          };
        } else {
          const previous = sessionProgressRef.current;
          if (
            !trackingSuppressed &&
            previous?.mode === "location" &&
            detail.location.current > previous.current
          ) {
            const delta = detail.location.current - previous.current;
            if (delta <= MAX_TRACKED_LOCATION_DELTA) {
              incrementCharactersRead(delta * REFLOWABLE_CHARACTERS_PER_LOCATION);
            }
          }
          sessionProgressRef.current = {
            mode: "location",
            current: detail.location.current,
            fraction,
          };
        }
      } else if (detail.section?.total) {
        const previous = sessionProgressRef.current;
        if (
          !trackingSuppressed &&
          previous?.mode === "page" &&
          detail.section.current > previous.current
        ) {
          const delta = detail.section.current - previous.current;
          if (delta <= MAX_TRACKED_PAGE_DELTA) {
            incrementPagesRead(delta);
          }
        }
        sessionProgressRef.current = { mode: "page", current: detail.section.current };
      }
      if (detail.tocItem?.label) setCurrentChapter(detail.tocItem.label);
      if (detail.tocItem?.href) setCurrentChapterHref(detail.tocItem.href);
      if (detail.cfi) {
        if (lastCfiRef.current && detail.cfi !== lastCfiRef.current) {
          const fractionDiff = Math.abs(absoluteFraction - progress);
          if (fractionDiff > 0.02 || locationHistoryRef.current.length === 0) {
            locationHistoryRef.current.push(lastCfiRef.current);
            if (locationHistoryRef.current.length > 50) {
              locationHistoryRef.current.shift();
            }
          }
        }
        lastCfiRef.current = detail.cfi;
        setCurrentCfi(detail.cfi);
        // Use throttled save instead of immediate update
        throttledSaveProgress(bookId, absoluteFraction, detail.cfi);
      }

      // Врезки сцен: перелистывания считает foliate relocate, собственной
      // пагинации нет (логика — scene-suggestion.ts). По сигналу счётчика
      // WebView вставляет слот «Сгенерировать сцену» в конец видимого фрагмента.
      const sceneAdvance = advanceSceneSuggestion(
        sceneSuggestionStateRef.current,
        detail,
        sceneSuggestionInterval,
        trackingSuppressed,
      );
      sceneSuggestionStateRef.current = sceneAdvance.state;
      if (sceneAdvance.suggest) {
        console.log("[SceneSlot] suggest → insertSceneSlot", {
          interval: sceneSuggestionInterval,
          step: sceneAdvance.state.step,
        });
        bridgeRef.current?.insertSceneSlot();
      } else if (sceneAdvance.moved) {
        console.log("[SceneSlot] move counted", {
          pagesTurned: sceneAdvance.state.pagesTurned,
          interval: sceneSuggestionInterval,
          suppressed: trackingSuppressed,
        });
      }

      // Mark translation ready after first successful relocate (CFI navigation done)
      if (!translationReady) setTranslationReady(true);

      // If TTS is waiting for a page turn to complete, fire the continuation callback now
      // that the renderer has fully updated its position (renderer.start reflects new page).
      if (ttsPendingContinueRef.current?.pendingTTSContinueCallbackRef.current) {
        console.log("[ReaderScreen][TTS] onRelocate triggered pending TTS continuation");
        const cb = ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current;
        ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current = null;
        // Cancel the safety timer since onRelocate fired successfully
        const safetyTimerRef = ttsPendingContinueRef.current.pendingTTSContinueSafetyTimerRef;
        if (safetyTimerRef.current) {
          clearTimeout(safetyTimerRef.current);
          safetyTimerRef.current = null;
        }
        void cb();
      }

      // Sync reading context for AI tools
      readingContextService.updateContext({
        bookId,
        bookTitle: book?.meta?.title || "",
        currentChapter: {
          index: detail.section?.current ?? 0,
          title: detail.tocItem?.label || "",
          href: detail.tocItem?.href || "",
        },
        currentPosition: {
          cfi: detail.cfi || "",
          percentage: absoluteFraction * 100,
        },
      });
    },
    onTocReady: (items: TOCItem[]) => {
      setToc(items);
    },
    onSelection: (detail: SelectionEvent) => {
      selectionRef.current = detail;
      setSelection(detail);
      // Sync selection for AI tools
      if (detail.cfi) {
        readingContextService.updateSelection({
          text: detail.text,
          cfi: detail.cfi,
          chapterIndex: 0,
          chapterTitle: "",
        });
      }
    },
    onSelectionCleared: () => {
      setSelection(null);
      readingContextService.clearSelection();
    },
    onTap: () => {
      recordDiagnostic("reader_tap");
      if (noteTooltipVisibleRef.current || Date.now() < suppressReaderTapUntilRef.current) {
        return;
      }
      sendEvent({ type: "activity" });
      if (selection) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      toggleControls();
    },
    onCharacterTap: ({ characterId }) => {
      const character = characters.find((item) => item.id === characterId);
      // Запертые персонажи не размечаются, но на случай гонки — двойная проверка
      if (!character || !isCharacterUnlocked(progress, character)) return;
      suppressReaderTapUntilRef.current = Date.now() + 400;
      publishCharacterProgress();
      navigation.navigate("NarraCharacterProfile", {
        bookId,
        characterId: character.id,
      });
    },
    // Врезки сцен генерируются только по явному тапу.
    onSceneSlotTap: ({ anchor }) => {
      hapticLight();
      console.log("[SceneSlot] tap → generate", { anchor });
      void runSceneSlotGeneration(anchor);
    },
    onSceneSlotRestored: ({ anchor }) => {
      void handleSceneSlotRestored(anchor);
    },
    onError: (message: string, detail) => {
      console.error("[Reader] WebView error:", message);
      if (detail.loadId && detail.loadId !== activeReaderLoadIdRef.current) return;
      recordDiagnostic("reader_error", { reason: diagnosticErrorReason(message), loading });
      if (isReaderTransportError(message) && !automaticRecoveryRef.current) {
        automaticRecoveryRef.current = true;
        retryReader();
        return;
      }
      if (loading) {
        setError(message);
        setLoading(false);
      }
    },
    onShowAnnotation: (detail: {
      value: string;
      position: { x: number; y: number; selectionTop: number; selectionBottom: number };
    }) => {
      suppressReaderTapUntilRef.current = Date.now() + 650;
      const highlight = highlights.find((h) => h.cfi === detail.value);
      if (!highlight) return;
      setSelection({
        text: highlight.text,
        cfi: highlight.cfi,
        position: detail.position,
      });
    },
    onNoteTooltip: (detail) => {
      suppressReaderTapUntilRef.current = Date.now() + 900;
      // Dismiss any existing tooltip
      if (noteTooltipTimer.current) {
        clearTimeout(noteTooltipTimer.current);
      }
      setNoteTooltip({
        note: detail.note,
        cfi: detail.cfi,
        position: detail.position,
      });
      // Auto-hide after 4 seconds
      noteTooltipTimer.current = setTimeout(() => {
        setNoteTooltip(null);
        noteTooltipTimer.current = null;
      }, 4000);
    },
    onPageSnippet: (_text: string) => {
      // page snippet handled by bookmark hook if pending
    },
    onBookmarkSnippet: (text: string) => {
      bookmark.onBookmarkSnippet(text);
    },
    onSearchComplete: (count, results) => {
      searchCompleteRef.current?.(count, results);
    },
  });
  const readerSearch = useReaderSearch({ bridge });
  searchCompleteRef.current = readerSearch.onSearchComplete;

  useEffect(() => {
    noteTooltipVisibleRef.current = !!noteTooltip;
  }, [noteTooltip]);

  // ── Volume button paging ─────────────────────────────────────────────────
  const isPureReadingContext = useMemo(
    () =>
      Platform.OS === "android" &&
      readSettings.volumeButtonsPageTurn === true &&
      webViewReady &&
      !loading &&
      !error &&
      !isReimporting &&
      !showTOC &&
      !showSettings &&
      !showNotebook &&
      !showTranslation &&
      !showChapterTranslation &&
      chapterTranslation.state.status === "idle" &&
      !selection &&
      !noteViewHighlight &&
      !noteTooltip &&
      ttsPlayState === "stopped" &&
      isFocused &&
      appActive,
    // 维护约定：任何新增遮盖正文/输入态/导航跳转，必须在此追加判定。
    [
      readSettings.volumeButtonsPageTurn,
      webViewReady,
      loading,
      error,
      isReimporting,
      showTOC,
      showSettings,
      showNotebook,
      showTranslation,
      showChapterTranslation,
      chapterTranslation.state.status,
      selection,
      noteViewHighlight,
      noteTooltip,
      ttsPlayState,
      isFocused,
      appActive,
    ],
  );

  useVolumeButtonPaging({
    active: isPureReadingContext,
    onPrev: () => bridge.goPrev(),
    onNext: () => bridge.goNext(),
  });

  bridgeRef.current = bridge;
  chapterTranslationBridgeRef.current = bridge;

  // Спека имён персонажей: отправляем при готовности WebView и при unlock новых героев;
  // разметку по секциям WebView делает сам (лениво, по мере загрузки секций)
  const sendCharacterNames = bridge.setCharacterNames;
  useEffect(() => {
    if (!webViewReady) return;
    sendCharacterNames(characterNameSpecJson);
  }, [webViewReady, characterNameSpecJson, sendCharacterNames]);

  // Подписи врезок сцен — локализованные строки внутрь WebView
  const configureSceneSlots = bridge.configureSceneSlots;
  useEffect(() => {
    if (!webViewReady) return;
    configureSceneSlots(
      JSON.stringify({
        idle: t("narra.sceneSlotShow", "Сгенерировать сцену"),
        loading: t("narra.sceneSlotDrawing", "Рисуем сцену…"),
        loadingHint: t("narra.sceneSlotDrawingHint", "Это может занять несколько минут"),
        caption: t("narra.sceneSlotCaption", "Сцена — сгенерировано ИИ"),
        error: t("narra.sceneSlotError", "Попробовать снова"),
      }),
    );
  }, [webViewReady, configureSceneSlots, t]);

  // Якоря сохранённых сцен: WebView восстанавливает врезки при загрузке
  // секций и просит картинки событием sceneSlotRestored
  const sceneAnchorsJson = useMemo(() => {
    const anchors = sceneInsertAnchors(
      narraScenes,
      narraSceneRequests,
      narraSceneAnchorBindings,
      narraScenesByBackendId,
    );
    return anchors.length ? JSON.stringify(anchors) : null;
  }, [narraScenes, narraSceneRequests, narraSceneAnchorBindings, narraScenesByBackendId]);
  const setSceneAnchors = bridge.setSceneAnchors;
  useEffect(() => {
    if (!webViewReady) return;
    setSceneAnchors(sceneAnchorsJson);
  }, [webViewReady, sceneAnchorsJson, setSceneAnchors]);

  // ── useReaderTTS ──
  const tts = useReaderTTS({
    bookId,
    bookTitle: bookTitle || book?.meta.title || "",
    currentChapter,
    currentChapterHref,
    currentSectionIndex,
    currentCfi,
    webViewReady,
    showTTS: false,
    setShowTTS: keepTTSInReader,
    setShowControls,
    bridgeRef,
    toc,
    bookCoverUrl: book?.meta.coverUrl,
    colors,
    goToHref: bridge.goToHref,
    characters,
  });

  const openScene = useCallback(
    (excerpt: string, sourceKey: string) => {
      const normalizedExcerpt = excerpt.trim();
      if (!normalizedExcerpt) {
        toast.error("Не удалось создать сцену", {
          description: "На этой странице нет текста для иллюстрации.",
        });
        return;
      }
      navigation.navigate("NarraScene", {
        bookId,
        chapter:
          currentChapter ||
          bookTitle ||
          book?.meta.title ||
          t("reader.currentPage", "Текущая страница"),
        excerpt: normalizedExcerpt,
        sourceKey,
      });
    },
    [book?.meta.title, bookId, bookTitle, currentChapter, navigation],
  );

  const handleSelectionMenuAction = useCallback(
    (event: { nativeEvent: { key: string; selectedText: string } }) => {
      const activeSelection = selectionRef.current ?? selection;
      const selectedText = (activeSelection?.text || event.nativeEvent.selectedText).trim();
      if (!selectedText) return;

      const cfi = activeSelection?.cfi ?? "";
      selectionRef.current = null;
      setSelection(null);

      switch (event.nativeEvent.key) {
        case "add-note":
          navigation.navigate("ManualNote", {
            bookId,
            cfi,
            text: selectedText,
            chapterTitle: currentChapter,
          });
          break;
        case "copy":
          void Clipboard.setStringAsync(selectedText);
          break;
        case "translate":
          setTranslationText(selectedText);
          setShowTranslation(true);
          break;
        case "summarize":
          navigation.navigate("NarraSummary", {
            bookId,
            chapter:
              currentChapter ||
              bookTitle ||
              book?.meta.title ||
              t("reader.currentExcerpt", "Текущий фрагмент"),
            excerpt: selectedText,
            sourceKey: `selection:${cfi || `${currentChapter}:${selectedText.slice(0, 120)}`}`,
          });
          break;
        case "generate-scene":
          openScene(
            selectedText,
            `selection:${cfi || `${currentChapter}:${selectedText.slice(0, 120)}`}`,
          );
          break;
        case "speak":
          tts.startSelectionTTS(selectedText, cfi);
          break;
      }
    },
    [
      book?.meta.title,
      bookId,
      bookTitle,
      currentChapter,
      navigation,
      openScene,
      selection,
      tts.startSelectionTTS,
    ],
  );

  const handleOpenCharacters = useCallback(() => {
    publishCharacterProgress();
    navigation.navigate("NarraCharacters", { bookId, charactersSheetSourceId });
  }, [bookId, charactersSheetSourceId, navigation, publishCharacterProgress]);

  const openTOCSheet = useCallback(() => {
    setShowTOC(true);
    navigation.navigate("ReaderTOC");
  }, [navigation]);

  const openReaderAppearance = useCallback(() => setShowSettings(true), []);

  const readerActions = useMemo<NativeContextMenuItem[]>(
    () => [
      {
        key: "toc",
        label: t("reader.toc", "Оглавление"),
        icon: "list",
        sfSymbol: "list.bullet",
        onPress: openTOCSheet,
      },
      {
        key: "bookmark",
        label: isBookmarked
          ? t("bookmarks.removeCurrent", "Удалить закладку")
          : t("bookmarks.addCurrent", "Добавить закладку"),
        icon: "bookmark",
        sfSymbol: isBookmarked ? "bookmark.slash" : "bookmark",
        onPress: handleToggleBookmark,
      },
      {
        key: "characters",
        label: t("narra.characters", "Персонажи"),
        icon: "people",
        sfSymbol: "person.2",
        onPress: handleOpenCharacters,
      },
      {
        key: "notes",
        label: t("reader.notebook", "Заметки"),
        icon: "pencil-square",
        sfSymbol: "square.and.pencil",
        onPress: () => navigation.navigate("FullScreenNotes", { bookId }),
      },
      {
        key: "speak",
        label: t("reader.speak", "Озвучить"),
        icon: "headphones",
        sfSymbol: "headphones",
        onPress: () => void tts.handleToggleTTS(),
      },
    ],
    [
      bookId,
      handleOpenCharacters,
      handleToggleBookmark,
      isBookmarked,
      navigation,
      openTOCSheet,
      t,
      tts.handleToggleTTS,
    ],
  );

  // Bind mediator ref so onRelocate can fire the TTS continuation callback
  ttsPendingContinueRef.current = {
    pendingTTSContinueCallbackRef: tts.pendingTTSContinueCallbackRef,
    pendingTTSContinueSafetyTimerRef: tts.pendingTTSContinueSafetyTimerRef,
  };

  // ── Non-TTS callbacks ──────────────────────────────────────────────────────

  const closeTocSheet = useCallback(() => {
    setShowTOC(false);
    const state = navigation.getState();
    if (state.routes[state.index]?.name === "ReaderTOC") {
      navigation.goBack();
    }
  }, [navigation]);

  const goToTocItem = useCallback(
    (href: string) => {
      if (lastCfiRef.current) {
        locationHistoryRef.current.push(lastCfiRef.current);
      }
      goToHrefSafely(href);
      closeTocSheet();
    },
    [closeTocSheet, goToHrefSafely],
  );
  const goToContentsCfi = useCallback(
    (cfi: string) => {
      goToCFISafely(cfi);
      closeTocSheet();
    },
    [closeTocSheet, goToCFISafely],
  );

  const goBackToPreviousLocation = useCallback(() => {
    if (locationHistoryRef.current.length === 0) return;
    const previousCfi = locationHistoryRef.current.pop();
    if (previousCfi) {
      goToCFISafely(previousCfi);
    }
  }, [goToCFISafely]);

  const canGoBack = locationHistoryRef.current.length > 0;

  const updateSetting = useCallback(
    <K extends keyof ReadSettings>(key: K, value: ReadSettings[K]) => {
      const updates = { [key]: value } as Partial<ReadSettings>;
      updateReadSettings(updates);
      const currentSettings = useSettingsStore.getState().readSettings;
      // Recompute effective fontSize after every settings change — covers
      // both stepper changes and toggling followSystemFontScale on/off.
      const merged = { ...currentSettings, ...updates };
      bridge.applySettings({
        ...merged,
        fontSize: computeEffectiveFontSize(merged.fontSize, merged.followSystemFontScale),
        customFontFaceCSS: defaultReaderFontFaceCSSRef.current,
        customFontFamily: DEFAULT_READER_FONT_FAMILY,
      });
    },
    [bridge, updateReadSettings, computeEffectiveFontSize],
  );

  const readerTOCSheetSession = useMemo(
    () => ({
      bookId,
      toc,
      currentChapter,
      bookmarks: bookmark.bookBookmarks,
      search: {
        query: readerSearch.searchQuery,
        results: readerSearch.searchResults,
        isSearching: readerSearch.isSearching,
        timedOut: readerSearch.searchTimedOut,
        onChangeQuery: readerSearch.handleSearchInput,
        onSubmit: readerSearch.submitSearch,
        onSelect: goToContentsCfi,
      },
      onClose: closeTocSheet,
      onSelectTocItem: goToTocItem,
      onSelectCfi: goToContentsCfi,
    }),
    [
      bookId,
      bookmark.bookBookmarks,
      closeTocSheet,
      currentChapter,
      goToContentsCfi,
      goToTocItem,
      readerSearch.handleSearchInput,
      readerSearch.isSearching,
      readerSearch.searchQuery,
      readerSearch.searchResults,
      readerSearch.searchTimedOut,
      readerSearch.submitSearch,
      toc,
    ],
  );

  useEffect(() => {
    registerTOCSheet(readerTOCSheetSession);
  }, [readerTOCSheetSession, registerTOCSheet]);

  useEffect(
    () => () => {
      unregisterTOCSheet(bookId);
    },
    [bookId, unregisterTOCSheet],
  );

  useEffect(() => navigation.addListener("focus", () => setShowTOC(false)), [navigation]);

  useEffect(() => {
    setGoToCfiFn(() => bridge.goToCFI);
    return () => setGoToCfiFn(null);
  }, [bridge.goToCFI, setGoToCfiFn]);

  // ── Book loading effects ───────────────────────────────────────────────────

  // Load book metadata and annotations
  useEffect(() => {
    if (!book) {
      setError(t("reader.bookNotFound", "书籍未找到"));
      setLoading(false);
      return;
    }
    setBookTitle(book.meta.title);
    recordTelemetry("book_opened", {
      book_kind: findBundledCatalogBookByTitle(book.meta.title) ? "builtin" : "imported",
    });
    updateBook(bookId, { lastOpenedAt: Date.now() });
    loadAnnotations(bookId);

    return () => {
      readingContextService.clearContext();
    };
  }, [bookId]);

  useEffect(() => {
    return eventBus.on("sync:completed", () => {
      void loadAnnotations(bookId);
    });
  }, [bookId, loadAnnotations]);

  // Save progress immediately on unmount
  useEffect(() => {
    return () => {
      if (lastCfiRef.current) {
        const db = require("@readany/core/db/database");
        runWithDbRetry(
          () =>
            db.updateBook(bookId, {
              progress: progressRef.current,
              currentCfi: lastCfiRef.current,
            }),
          { attempts: 10, initialDelayMs: 150 },
        ).catch((err: Error) => console.error("Failed to save progress on unmount:", err));
      }
      const { useSyncStore } = require("@readany/core/stores/sync-store");
      useSyncStore.getState().syncNow?.();
    };
  }, [bookId]);

  // Serving the file and staging the fonts needs no WebView, so it starts with
  // the screen instead of waiting for the reader bundle to finish parsing.
  // Both steps are idempotent: the server is reused for the same doc root and
  // the fonts are staged once per process.
  useEffect(() => {
    void prepareReaderHost().catch((err) => {
      console.warn("[ReaderScreen] Reader host preparation failed:", err);
    });
  }, [prepareReaderHost]);

  // When WebView is ready and book is available, send the open command
  useEffect(() => {
    if (!webViewReady || !book?.filePath) {
      return;
    }
    const loadId = `${bookId}:${book.filePath}:${loadAttempt}`;
    activeReaderLoadIdRef.current = loadId;
    let cancelled = false;

    const loadBook = async () => {
      try {
        recordDiagnostic("reader_open", { attempt: loadAttempt, format: book.format });
        setLoading(true);
        setError(null);
        const lastLocation = lastCfiRef.current || book.currentCfi || undefined;
        const fileName = book.filePath.split("/").pop() || "book.epub";
        const mimeType = BOOK_FORMAT_MIME_TYPES[book.format] || "application/octet-stream";

        // The local HTTP server lets the WebView fetch the file directly, which
        // avoids reading the whole book into RN memory and base64-encoding it.
        // It was started when the screen mounted; by now it is usually up.
        const restart = restartHostRef.current;
        restartHostRef.current = false;
        const { serverUrl, fontFaceCSS } = await prepareReaderHost(restart);
        const pdfEngineUri =
          mimeType === "application/pdf" ? await prepareReaderPdfEngineUri(serverUrl) : undefined;
        if (cancelled) return;
        readerServerUrlRef.current = serverUrl;
        defaultReaderFontFaceCSSRef.current = fontFaceCSS;
        setDefaultReaderFontFaceCSS(fontFaceCSS);
        const encodedPath = book.filePath
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");

        // A count measured on an earlier open makes character tracking work
        // from the first page, and spares the WebView the whole-book scan.
        totalBookCharactersRef.current = book.totalCharacters ?? null;

        bridge.openBook({
          uri: `${serverUrl}/${encodedPath}`,
          fileName,
          mimeType,
          pdfEngineUri,
          loadId,
          lastLocation,
          pageMargin: readSettings.pageMargin,
          paginatedLayout: readSettings.paginatedLayout,
          settings: {
            fontSize: computeEffectiveFontSize(
              readSettings.fontSize,
              readSettings.followSystemFontScale,
            ),
            lineHeight: readSettings.lineHeight,
            paragraphSpacing: readSettings.paragraphSpacing,
            pageMargin: readSettings.pageMargin,
            fontTheme: readSettings.fontTheme,
            viewMode: readSettings.viewMode,
            paginatedLayout: readSettings.paginatedLayout,
            customFontFaceCSS: fontFaceCSS,
            customFontFamily: DEFAULT_READER_FONT_FAMILY,
          },
          // A whole-book character scan runs on the same WebView thread as
          // page gestures. On a newly imported book it can freeze the first
          // visible page for several seconds, so never start it while reading.
          // Progress tracking already falls back to renderer locations/pages.
          measureTextMetrics: false,
        });

        bridge.setThemeColors(readerThemeColorsRef.current);
      } catch (err: any) {
        if (cancelled) return;
        console.error("[ReaderScreen] Failed to load book:", err);
        recordDiagnostic("reader_error", { reason: diagnosticErrorReason(err), loading: true });
        setError(err.message || "Failed to load book file");
        setLoading(false);
      }
    };

    loadBook();
    return () => {
      cancelled = true;
    };
  }, [bookId, book?.filePath, loadAttempt, prepareReaderHost, webViewReady]);

  // iOS may suspend the local server while the reader stays mounted.
  // A new origin invalidates the EPUB range reader and PDF/font URLs together.
  useEffect(() => {
    let cancelled = false;
    let previousState = AppState.currentState;
    const checkHost = () => {
      const checkedUrl = readerServerUrlRef.current;
      if (!isFocused || !checkedUrl || AppState.currentState !== "active") return;
      recordDiagnostic("reader_foreground");
      void prepareReaderHost()
        .then((host) => {
          if (
            !cancelled &&
            AppState.currentState === "active" &&
            readerServerUrlRef.current === checkedUrl &&
            host.serverUrl !== checkedUrl
          )
            retryReader(false);
        })
        .catch(() => {
          if (
            !cancelled &&
            AppState.currentState === "active" &&
            readerServerUrlRef.current === checkedUrl
          )
            retryReader();
        });
    };
    checkHost();
    const subscription = AppState.addEventListener("change", (state) => {
      const returning = state === "active" && previousState !== "active";
      previousState = state;
      if (returning) checkHost();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isFocused, retryReader]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different book gets its own automatic-recovery budget.
  useEffect(() => {
    automaticRecoveryRef.current = false;
    return () => {
      recordDiagnostic("reader_closed");
    };
  }, [bookId]);

  useEffect(() => {
    recordDiagnostic("reader_panels", {
      toc: showTOC,
      settings: showSettings,
      notebook: showNotebook,
      translation: showTranslation,
    });
  }, [showTOC, showSettings, showNotebook, showTranslation]);

  // A probe contains no book data. RN timer lag and missing WebView replies
  // distinguish a blocked app thread from an unresponsive reading engine.
  useEffect(() => {
    diagnosticPingRef.current = 0;
    diagnosticUnresponsiveRef.current = false;
    if (!isFocused || !appActive || !webViewReady) return;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") {
        diagnosticPingRef.current = 0;
        return;
      }
      const now = Date.now();
      if (diagnosticPingRef.current) {
        if (now - diagnosticPingRef.current >= 10_000 && !diagnosticUnresponsiveRef.current) {
          diagnosticUnresponsiveRef.current = true;
          recordDiagnostic("webview_unresponsive", { loading });
        }
        return;
      }
      diagnosticPingRef.current = now;
      bridge.webViewRef.current?.injectJavaScript(
        `window.ReactNativeWebView.postMessage(JSON.stringify({type:'diagnosticPong',id:${now}}));true;`,
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [isFocused, appActive, webViewReady, loading, bridge.webViewRef]);

  const handleReimportMissingBook = useCallback(async () => {
    if (isReimporting) return;
    setIsReimporting(true);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: BOOK_MIME_TYPES,
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const selectedUri = result.assets[0].uri;
      if (book) {
        const candidate = await useLibraryStore.getState().inspectDeletedBookCandidate(bookId, {
          uri: selectedUri,
          name: result.assets[0].name,
        });
        if (candidate && shouldConfirmReimportCandidate(book, candidate)) {
          const shouldContinue = await useMissingBookPromptStore.getState().showPrompt({
            title: t("reader.reimportMismatchTitle", "这份文件看起来和原书不太一致"),
            description: t(
              "reader.reimportMismatchDescription",
              "原书《{{originalTitle}}》与当前文件《{{candidateTitle}}》信息差异较大。仍要把它接回原来的笔记和阅读统计吗？",
              {
                originalTitle: book.meta.title,
                candidateTitle: candidate.title || t("reader.unknownBook", "未命名书籍"),
              },
            ),
            confirmLabel: t("reader.reimportContinue", "继续接回"),
            cancelLabel: t("reader.reimportPickAnotherFile", "重新选择"),
          });
          if (!shouldContinue) return;
        }
      }

      const restoredBook = await useLibraryStore
        .getState()
        .reimportDeletedBook(bookId, { uri: selectedUri, name: result.assets[0].name });

      if (!restoredBook) {
        setError(t("reader.reimportFailed", "重新导入失败，请稍后再试。"));
        return;
      }

      setError(null);
      setLoading(true);
    } catch (err) {
      console.error("[ReaderScreen] Failed to re-import missing book:", err);
      setError(
        err instanceof Error
          ? err.message
          : t("reader.reimportFailed", "重新导入失败，请稍后再试。"),
      );
    } finally {
      setIsReimporting(false);
    }
  }, [bookId, isReimporting, t]);

  // Apply theme colors when theme changes
  useEffect(() => {
    if (!webViewReady) return;
    bridge.setThemeColors(readerThemeColors);
  }, [themeMode, readerThemeColors, webViewReady]);

  // The book always uses the bundled SB Serif family.
  useEffect(() => {
    if (!webViewReady) return;
    bridge.applySettings({
      customFontFaceCSS: defaultReaderFontFaceCSS,
      customFontFamily: DEFAULT_READER_FONT_FAMILY,
    });
  }, [bridge, defaultReaderFontFaceCSS, webViewReady]);

  // Re-apply effective fontSize when the OS-level font scale changes while
  // the reader is open (e.g. user changes "Display & Brightness → Text Size"
  // in iOS Settings, then comes back). Only fires when followSystemFontScale
  // is on; otherwise the stored fontSize is used as-is and there's nothing
  // to re-push.
  //
  // We also re-send paragraphSpacing and pageMargin so the webview's
  // layoutScale-based scaling (in reader.template.html) re-runs against the
  // new effective font size — otherwise the renderer would keep margins
  // computed from the previous size.
  useEffect(() => {
    if (!webViewReady) return;
    if (!readSettings.followSystemFontScale) return;
    bridge.applySettings({
      fontSize: computeEffectiveFontSize(readSettings.fontSize, true),
      paragraphSpacing: readSettings.paragraphSpacing,
      pageMargin: readSettings.pageMargin,
    });
  }, [
    systemFontScale,
    readSettings.followSystemFontScale,
    readSettings.fontSize,
    readSettings.paragraphSpacing,
    readSettings.pageMargin,
    webViewReady,
    bridge,
    computeEffectiveFontSize,
  ]);

  // Load annotations into reader when ready
  useEffect(() => {
    if (!webViewReady || loading || highlights.length === 0) return;
    for (const h of highlights) {
      bridge.addAnnotation({ value: h.cfi, type: "highlight", color: h.color, note: h.note });
    }
  }, [webViewReady, loading, highlights]);

  // Reset last navigated CFI when book changes
  useEffect(() => {
    lastNavigatedCfiRef.current = undefined;
  }, [bookId]);

  // Navigate to CFI when book is loaded (from NotesPage or AI citation navigation)
  useEffect(() => {
    if (!webViewReady || loading || !cfi || cfi === lastNavigatedCfiRef.current) return;
    goToCFISafely(cfi);
    lastNavigatedCfiRef.current = cfi;
    navigation.setParams({ bookId, cfi: undefined, highlight: undefined });

    if (shouldHighlight) {
      let flashCount = 0;
      const doFlash = () => {
        if (flashCount >= 3) return;
        bridge.flashHighlight(cfi, "orange", 500);
        flashCount++;
        if (flashCount < 3) setTimeout(doFlash, 600);
      };
      setTimeout(doFlash, 100);
    }
  }, [webViewReady, loading, cfi, shouldHighlight, goToCFISafely, navigation, bookId]);

  // Return to the active narration fragment when navigating from the mini player.
  useEffect(() => {
    if (!openTTS || !webViewReady || loading) return;

    let cancelled = false;
    const returnToNarration = async () => {
      const targetCfi =
        tts.resolvedTTSSegmentCfi || tts.ttsDisplaySegments[0]?.cfi || currentCfi || null;
      if (targetCfi && targetCfi !== currentCfi) {
        goToCFISafely(targetCfi);
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
      if (cancelled) return;
      setShowControls(true);
      navigation.setParams({ bookId, openTTS: undefined });
    };

    void returnToNarration();
    return () => {
      cancelled = true;
    };
  }, [bookId, currentCfi, goToCFISafely, loading, navigation, openTTS, webViewReady]);

  // Mirror of readerToolbarDock at the top edge: same animated container, same
  // clock, so both bars fade together on a centre tap and on the timeout.
  const readerTopBarDock = (
    <Reanimated.View
      pointerEvents={showControls || actionsMenuOpen ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          top: 0,
          right: 0,
          left: 0,
          zIndex: 30,
          paddingTop: insets.top,
          backgroundColor: "transparent",
        },
        controlsAnimatedStyle,
      ]}
    >
      <ReaderTopBar
        tintColor={readerThemeColors.foreground}
        isDark={isReaderThemeDark}
        actions={readerActions}
        onClosePress={() => navigation.goBack()}
        onAppearancePress={openReaderAppearance}
        onActionsOpenChange={setActionsMenuOpen}
      />
    </Reanimated.View>
  );

  const readerToolbarDock = (
      <Reanimated.View
        pointerEvents={loading || !showControls ? "none" : "auto"}
        style={[
          {
            position: "absolute",
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 30,
            height: TOOLBAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
            backgroundColor: "transparent",
          },
          controlsAnimatedStyle,
        ]}
      >
        <ReaderToolbar
          tintColor={readerThemeColors.foreground}
          isDark={isReaderThemeDark}
          charactersSheetSourceId={charactersSheetSourceId}
          speechState={
            ttsPlayState === "loading" ? "loading" : ttsPlayState === "playing" ? "playing" : "idle"
          }
          onSpeechPress={() => void tts.handleToggleTTS()}
          onCharactersPress={handleOpenCharacters}
        />
      </Reanimated.View>
    );

  if (loading && !webViewReady && !readerHtmlUri) {
    return (
      <View
        style={[
          s.container,
          {
            paddingBottom: insets.bottom,
            backgroundColor: readerThemeColors.background,
          },
        ]}
      >
        <View style={s.readerStage}>
          <View style={s.loadingWrap}>
            <ReaderLoadingIndicator color={colors.primary20} />
          </View>
        </View>
        {readerTopBarDock}
        {readerToolbarDock}
      </View>
    );
  }

  if (error) {
    return (
      <View
        style={[
          s.container,
          {
            paddingBottom: insets.bottom,
            backgroundColor: readerThemeColors.background,
          },
        ]}
      >
        <View style={s.readerStage}>
          <View style={s.loadingWrap}>
            <Text style={s.errorText}>{t("reader.loadFailed", "加载失败")}</Text>
            <Text style={[s.loadingText, { textAlign: "center", maxWidth: 320 }]}>{error}</Text>
            <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                style={s.backButton}
                onPress={() => {
                  if (book?.filePath) {
                    automaticRecoveryRef.current = false;
                    retryReader();
                    return;
                  }
                  navigation.reset({ routes: [{ name: "Tabs" }] });
                }}
              >
                <Text style={s.backButtonText}>
                  {book?.filePath ? t("common.retry", "重试") : t("common.back", "返回")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.backButton,
                  {
                    backgroundColor: colors.background,
                    borderWidth: 1,
                    borderColor: colors.border,
                  },
                ]}
                onPress={() => void handleReimportMissingBook()}
                disabled={isReimporting}
              >
                <Text style={[s.backButtonText, { color: colors.foreground }]}>
                  {isReimporting
                    ? t("reader.reimporting", "正在重新导入...")
                    : t("reader.reimport", "重新导入")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        {readerTopBarDock}
        {readerToolbarDock}
      </View>
    );
  }

  if (!readerHtmlUri) {
    return (
      <View
        style={[
          s.container,
          {
            paddingBottom: insets.bottom,
            backgroundColor: readerThemeColors.background,
          },
        ]}
      >
        <View style={s.readerStage}>
          <View style={s.loadingWrap}>
            <ReaderLoadingIndicator color={colors.primary20} />
          </View>
        </View>
        {readerTopBarDock}
        {readerToolbarDock}
      </View>
    );
  }

  const layoutTopInset = stableTopInset;
  const percent = Math.round(progress * 100);
  const isPanelOpen = showTOC || showSettings || showNotebook || showTranslation;
  const readerContentInset = Math.round(
    readSettings.pageMargin *
      (computeEffectiveFontSize(readSettings.fontSize, readSettings.followSystemFontScale) / 16),
  );
  const readerTopMargin = showTopTitleProgress ? layoutTopInset + 30 : layoutTopInset;
  const adjustedNoteTooltip = noteTooltip
    ? {
        ...noteTooltip,
        position: {
          ...noteTooltip.position,
          y: noteTooltip.position.y + readerTopMargin,
          selectionTop: noteTooltip.position.selectionTop + readerTopMargin,
          selectionBottom: noteTooltip.position.selectionBottom + readerTopMargin,
        },
      }
    : null;

  return (
    <>
      <View
        style={[
          s.container,
          {
            paddingBottom: insets.bottom,
            backgroundColor: readerThemeColors.background,
          },
        ]}
      >
        <Animated.View
          style={[s.readerStage, { backgroundColor: "transparent" }]}
          pointerEvents="box-none"
        >
          {/* WebView with foliate-js */}
          <View style={{ flex: 1, backgroundColor: "transparent" }}>
            <WebView
              key={`${readerHtmlUri}:${loadAttempt}`}
              ref={bridge.webViewRef}
              source={{ uri: readerHtmlUri }}
              containerStyle={{ backgroundColor: "transparent" }}
              style={[
                s.webview,
                {
                  marginTop: readerTopMargin,
                  backgroundColor: "transparent",
                },
              ]}
              pointerEvents={isPanelOpen ? "none" : "auto"}
              onMessage={bridge.handleMessage}
              menuItems={[
                { key: "add-note", label: t("reader.addNote", "Добавить заметку") },
                { key: "copy", label: t("reader.copySelection", "Скопировать") },
                { key: "translate", label: t("reader.translate", "Перевести") },
                { key: "summarize", label: t("reader.summarize", "Кратко пересказать") },
                { key: "generate-scene", label: t("reader.drawScene", "Нарисовать сцену") },
                { key: "speak", label: t("reader.speak", "Озвучить") },
              ]}
              onCustomMenuSelection={handleSelectionMenuAction}
              onError={(e) => {
                console.error("[ReaderScreen] WebView error:", e.nativeEvent);
                recordDiagnostic("webview_error", { code: e.nativeEvent.code });
              }}
              onHttpError={(e) => {
                console.error("[ReaderScreen] WebView HTTP error:", e.nativeEvent);
                recordDiagnostic("webview_error", { code: e.nativeEvent.statusCode });
              }}
              onContentProcessDidTerminate={() => {
                console.warn("[ReaderScreen] WebView content process terminated");
                recordDiagnostic("webview_terminated");
                if (!automaticRecoveryRef.current) {
                  automaticRecoveryRef.current = true;
                  retryReader();
                } else {
                  setLoading(false);
                  setError(t("reader.processStopped", "Читалка остановилась. Нажмите «Повторить»"));
                }
              }}
              javaScriptEnabled
              domStorageEnabled
              cacheEnabled={false}
              allowFileAccess
              allowFileAccessFromFileURLs
              allowUniversalAccessFromFileURLs
              allowsInlineMediaPlayback
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              originWhitelist={["*"]}
              mixedContentMode="always"
            />
          </View>

          {/* Loading overlay */}
          {loading && (
            <View
              style={[s.loadingOverlay, { backgroundColor: readerThemeColors.background }]}
              pointerEvents="none"
            >
              <ReaderLoadingIndicator color={colors.primary20} />
            </View>
          )}

          {/* ─── Top Info Bar (always visible) ─── */}
          {!showControls && showTopTitleProgress && (
            <View
              style={[s.topInfoBar, { top: layoutTopInset, paddingHorizontal: readerContentInset }]}
            >
              <View style={s.topInfoRow}>
                <Text style={[s.topInfoText, { color: readerThemeColors.muted }]} numberOfLines={1}>
                  {currentChapter || bookTitle}
                </Text>
                {/* Номер страницы по всей книге (как в Apple Books); без
                    location (scrolled/fixed-layout) — процент прогресса */}
                {bookLocation ? (
                  <Text style={[s.topInfoPageText, { color: readerThemeColors.muted }]}>
                    {t("reader.pageOfBook", "стр. {{current}} из {{total}}", {
                      current: Math.min(bookLocation.current + 1, bookLocation.total),
                      total: bookLocation.total,
                    })}
                  </Text>
                ) : (
                  <Text
                    style={[s.topInfoPageText, { color: readerThemeColors.muted }]}
                  >{`${percent}%`}</Text>
                )}
              </View>
            </View>
          )}
        </Animated.View>

        {readerTopBarDock}
        {readerToolbarDock}

        {/* ─── Bookmark Ribbon (top-right) ─── */}

        {/* Note Tooltip (long-press on wavy underline) */}
        {adjustedNoteTooltip && (
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => {
                suppressReaderTapUntilRef.current = Date.now() + 350;
                if (noteTooltipTimer.current) {
                  clearTimeout(noteTooltipTimer.current);
                  noteTooltipTimer.current = null;
                }
                setNoteTooltip(null);
              }}
            />
            <Pressable
              style={[
                s.noteTooltip,
                {
                  left: Math.max(
                    NOTE_TOOLTIP_SIDE_PADDING,
                    Math.min(
                      adjustedNoteTooltip.position.x - NOTE_TOOLTIP_WIDTH / 2,
                      SCREEN_WIDTH - NOTE_TOOLTIP_WIDTH - NOTE_TOOLTIP_SIDE_PADDING,
                    ),
                  ),
                  ...(adjustedNoteTooltip.position.selectionTop > NOTE_TOOLTIP_TOP_THRESHOLD
                    ? {
                        bottom:
                          SCREEN_HEIGHT -
                          adjustedNoteTooltip.position.selectionTop +
                          NOTE_TOOLTIP_ABOVE_OFFSET,
                      }
                    : {
                        top:
                          adjustedNoteTooltip.position.selectionBottom + NOTE_TOOLTIP_BELOW_OFFSET,
                      }),
                },
              ]}
              onPress={(event) => {
                event.stopPropagation();
                suppressReaderTapUntilRef.current = Date.now() + 550;
              }}
              onPressIn={(event) => {
                event.stopPropagation();
                suppressReaderTapUntilRef.current = Date.now() + 550;
              }}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderTerminationRequest={() => false}
            >
              <View style={s.noteTooltipContent}>
                <MarkdownRenderer
                  content={adjustedNoteTooltip.note || ""}
                  styleOverrides={noteTooltipMdStyles}
                />
              </View>
            </Pressable>
          </View>
        )}

        {/* ─── Settings Panel ─── */}
        <ReaderSettingsPanel
          visible={showSettings}
          readSettings={readSettings}
          onClose={() => setShowSettings(false)}
          onUpdateSetting={updateSetting}
        />

        {/* ─── Notebook Panel ─── */}
        <Modal
          visible={showNotebook}
          transparent
          animationType="slide"
          onRequestClose={() => setShowNotebook(false)}
        >
          <Pressable style={s.modalBackdrop} onPress={() => setShowNotebook(false)} />
          <View
            style={[
              s.bottomSheet,
              { maxHeight: SCREEN_HEIGHT * 0.7, paddingBottom: insets.bottom || 16 },
            ]}
          >
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>{t("reader.notebook", "笔记本")}</Text>
              <TouchableOpacity onPress={() => setShowNotebook(false)}>
                <XIcon size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {highlights.length > 0 ? (
              <ScrollView showsVerticalScrollIndicator={false} style={s.sheetScroll}>
                {highlights.map((h) => (
                  <View key={h.id} style={s.highlightItem}>
                    <View
                      style={[
                        s.highlightColorDot,
                        {
                          backgroundColor:
                            h.color === "yellow"
                              ? "#facc15"
                              : h.color === "green"
                                ? "#4ade80"
                                : h.color === "blue"
                                  ? "#60a5fa"
                                  : h.color === "pink"
                                    ? "#ec4899"
                                    : h.color === "red"
                                      ? "#f87171"
                                      : "#a78bfa",
                        },
                      ]}
                    />
                    <View style={s.highlightContent}>
                      <Text style={s.highlightText} numberOfLines={3}>
                        {h.text}
                      </Text>
                      {h.note && <Text style={s.highlightNote}>{h.note}</Text>}
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={s.notebookPlaceholder}>
                <NotebookPenIcon size={40} color={colors.mutedForeground} />
                <Text style={s.notebookPlaceholderText}>
                  {t("reader.notebookHint", "在阅读时选中文字来创建笔记和高亮")}
                </Text>
              </View>
            )}
          </View>
        </Modal>

        {/* ─── Note View Modal ─── */}
        <ReaderNoteViewModal
          highlight={noteViewHighlight}
          editing={noteViewEditing}
          editContent={noteViewContent}
          bookId={bookId}
          onClose={() => {
            setNoteViewHighlight(null);
            setNoteViewEditing(false);
          }}
          onStartEdit={() => {
            setNoteViewContent(noteViewHighlight?.note || "");
            setNoteViewEditing(true);
          }}
          onCancelEdit={() => {
            setNoteViewEditing(false);
            setNoteViewContent(noteViewHighlight?.note || "");
          }}
          onContentChange={setNoteViewContent}
          onSave={(highlight, newNote) => {
            bridge.removeAnnotation({ value: highlight.cfi });
            bridge.addAnnotation({
              value: highlight.cfi,
              type: "highlight",
              color: highlight.color,
              note: newNote,
            });
            setNoteViewHighlight({ ...highlight, note: newNote });
            setNoteViewEditing(false);
          }}
        />

        {/* ─── Translation Panel ─── */}
        {showTranslation && translationText && (
          <TranslationPanel
            text={translationText}
            onClose={() => {
              setShowTranslation(false);
              setTranslationText("");
            }}
          />
        )}

        {/* ─── Chapter Translation Sheet ─── */}
        <ChapterTranslationSheet
          visible={showChapterTranslation}
          onClose={() => setShowChapterTranslation(false)}
          state={chapterTranslation.state}
          onStart={chapterTranslation.startTranslation}
          onCancel={chapterTranslation.cancelTranslation}
          onToggleOriginalVisible={chapterTranslation.toggleOriginalVisible}
          onToggleTranslationVisible={chapterTranslation.toggleTranslationVisible}
          onReset={chapterTranslation.reset}
        />
      </View>
    </>
  );
}
