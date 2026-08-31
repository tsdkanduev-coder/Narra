import { BookCard } from "@/components/library/BookCard";
import { CatalogBookSkeleton } from "@/components/library/CatalogBookSkeleton";
import { ConnectedCatalogBookCard } from "@/components/library/ConnectedCatalogBookCard";
import { GroupCard } from "@/components/library/GroupCard";
import { ReadingNowShelf } from "@/components/library/ReadingNowShelf";
import { selectReadingNowBooks } from "@/lib/library/reading-now-books";
import { GroupPickerSheet } from "@/components/library/GroupPickerSheet";
import { ImportSourceMenuButton } from "@/components/library/ImportSourceMenuButton";
import { type ExtractorRef, ExtractorWebView } from "@/components/rag/ExtractorWebView";
import {
  CheckCheckIcon,
  ChevronLeftIcon,
  DatabaseIcon,
  FolderInputIcon,
  FolderMinusIcon,
  HashIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "@/components/ui/Icon";
import { getStrokeIconImageSource } from "@/components/ui/MishanaerIcon";
import { NativeButton } from "@/components/ui/NativeButton";
import { ScrollViewMarker } from "@/components/ui/ScrollViewMarker";
import { SyncButton } from "@/components/ui/SyncButton";
import { Text, TextInput } from "@/components/ui/Typography";
import { CenteredEmptyState } from "@/components/ui/centered-empty-state";
import {
  NativeSegmentedPager,
  type NativeSegmentedPagerHandle,
} from "@/components/ui/native-segmented-pager";
import { SwipePressGuardProvider, useSwipePressGuard } from "@/components/ui/swipe-press-guard";
import { useBackendCatalog, useBackendCatalogActivity } from "@/hooks/use-backend-catalog";
import { useBookImportActions } from "@/hooks/use-book-import-actions";
import { useCatalogCoverWindow } from "@/hooks/use-catalog-cover-window";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { openMobileBook } from "@/lib/library/open-mobile-book";
import type { CachedBackendCatalogBook } from "@/lib/narra/backend-catalog-cache";
import { findReadableLibraryBookForCatalogBook } from "@/lib/narra/backend-catalog-library";
import { retryCatalogCover as retrySharedCatalogCover } from "@/lib/narra/catalog-cover-coordinator";
import { getCatalogBookWithCover } from "@/lib/narra/catalog-cover-store";
import { setCallback, setExtractorRef } from "@/lib/rag/auto-vectorize-service";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { LibraryTabStackParamList } from "@/navigation/TabNavigator";
import { NATIVE_SCROLL_EDGE_EFFECTS } from "@/navigation/scroll-edge-effects";
import { useLibraryStore } from "@/stores/library-store";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  radius,
  secondLevelTitleFontFamily,
  useColors,
  useTheme,
} from "@/styles/theme";
import { spacingPixels } from "@deslop/primitives";
import { useHeaderHeight } from "@react-navigation/elements";
import { type RouteProp, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { getPlatformService } from "@readany/core";
import { setFallbackContentProvider } from "@readany/core/ai";
import { onLibraryChanged } from "@readany/core/events/library-events";
import { useSyncStore } from "@readany/core/stores";
import type { Book, BookGroup } from "@readany/core/types";
import { File as ExpoFile } from "expo-file-system";
/**
 * LibraryScreen — matching Tauri mobile LibraryPage exactly.
 * Features: header sort/import, tag filter, vectorization progress banner,
 * tag management sheet, responsive book grid, empty/loading states.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { TagManagementSheet } from "./library/TagManagementSheet";
import { useBookDownload } from "./library/useBookDownload";
import { useVectorizationQueue } from "./library/useVectorizationQueue";

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

type Nav = NativeStackNavigationProp<RootStackParamList>;
type LibraryRoute = RouteProp<LibraryTabStackParamList, "LibraryHome">;

const NUM_COLUMNS = 2;
const GRID_GAP = 16;
/** Запас рядов, для которых обложки грузятся заранее, ниже видимой области. */
const COVER_LOOKAHEAD_ROWS = 3;
/**
 * Каталог монтируется чанками: карточек в нём около сотни, а вьюхи для них
 * создаются разом, одним коммитом в главном потоке. Это подвешивало экран на
 * полсекунды каждый раз, когда библиотеку нужно показать — при переходе на
 * вкладку и при закрытии ридера, у которого экран под ним отсоединён.
 */
const CATALOG_PAGE_SIZE = 10;
/**
 * Сколько точек заглушек видно за последней готовой книгой. Ровно столько
 * прокрутка и позволяет: дальше контента нет, поэтому экран скелетонов
 * пролистать нельзя, но и конец списка не выглядит обрывом.
 */
const CATALOG_SKELETON_PEEK_HEIGHT = 200;
/** Нижний отступ содержимого прокрутки — входит в расчёт предела прокрутки. */
const CATALOG_CONTENT_BOTTOM_PADDING = 24;
/**
 * Запас под тень книги внутри страницы пейджера. Тень уходит на 33 точки вниз
 * (boxShadow 0 11px 22px), нижний отступ карточки даёт 16 — остальное добираем
 * здесь. Отступ снаружи страницы не годится: страницу режет нативный пейджер
 * ровно по высоте её содержимого.
 */
const CATALOG_SHADOW_ROOM = 24;
type LibraryGridItem =
  | { type: "group"; group: BookGroup; books: Book[] }
  | { type: "book"; book: Book };

type LibrarySection = "catalog" | "my-books";
const LIBRARY_SECTION_STORAGE_KEY = "library_last_section";
// Download finishes silently — user can re-tap the book to open it.
const onBookDownloaded = () => {};

export function LibraryScreen() {
  return (
    <SwipePressGuardProvider>
      <LibraryScreenContent />
    </SwipePressGuardProvider>
  );
}

/** Focus and queue ownership stay outside the persistent library tree. */
function LibraryCatalogLifecycle({
  books,
  chunkCount,
  scrollY,
  columnCount,
  gridItemWidth,
  gridGap,
  viewportHeight,
  enabled,
}: {
  books: CachedBackendCatalogBook[];
  chunkCount: number;
  scrollY: number;
  columnCount: number;
  gridItemWidth: number;
  gridGap: number;
  viewportHeight: number;
  enabled: boolean;
}) {
  const focused = useIsFocused();
  const guard = useSwipePressGuard();
  useBackendCatalogActivity(focused && enabled);
  useEffect(() => {
    guard?.setEnabled(focused);
    return () => guard?.setEnabled(false);
  }, [focused, guard]);
  const window = useMemo(() => {
    const rowHeight = gridItemWidth * (41 / 28) + gridGap;
    const firstRow = Math.max(0, Math.floor(scrollY / rowHeight) - 1);
    const rowsOnScreen = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    const columns = Math.max(1, columnCount);
    const first = firstRow * columns;
    const visibleEnd = Math.min(chunkCount, (firstRow + rowsOnScreen + 1) * columns);
    const nearbyEnd = Math.min(chunkCount, visibleEnd + COVER_LOOKAHEAD_ROWS * columns);
    return {
      visible: books.slice(first, visibleEnd),
      nearby: books.slice(visibleEnd, nearbyEnd),
    };
  }, [books, chunkCount, columnCount, gridGap, gridItemWidth, scrollY, viewportHeight]);
  useCatalogCoverWindow({ ...window, active: focused && enabled });
  return null;
}

function LibraryScreenContent() {
  const colors = useColors();
  const { isDark } = useTheme();
  const { t } = useTranslation();
  const nav = useNavigation<Nav>();
  const route = useRoute<LibraryRoute>();
  const nativeHeaderHeight = useHeaderHeight();
  const layout = useResponsiveLayout();
  const gridGap = layout.isTablet ? 16 : GRID_GAP;
  const columnCount = layout.isTabletLandscape ? 5 : layout.isTablet ? 4 : NUM_COLUMNS;
  const contentWidth = layout.centeredContentWidth;
  const gridItemWidth = Math.floor((contentWidth - gridGap * (columnCount - 1)) / columnCount);
  const s = useMemo(
    () =>
      makeStyles(colors, {
        horizontalPadding: layout.horizontalPadding,
        contentWidth,
        gridGap,
        gridItemWidth,
        isWideScreen: layout.isTablet,
      }),
    [colors, contentWidth, gridGap, gridItemWidth, layout.horizontalPadding, layout.isTablet],
  );
  const [tagSheetOpen, setTagSheetOpen] = useState(false);
  const [tagSheetBook, setTagSheetBook] = useState<Book | null>(null);
  const requestedSection = route.params?.initialSection;
  const [librarySection, setLibrarySection] = useState<LibrarySection>(
    requestedSection ?? "catalog",
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<string>>(new Set());
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [batchTagBookIds, setBatchTagBookIds] = useState<string[]>([]);
  const [groupNameModal, setGroupNameModal] = useState<{
    mode: "create" | "rename";
    group?: BookGroup;
  } | null>(null);
  const [groupNameInput, setGroupNameInput] = useState("");
  const librarySectionChangedRef = useRef(false);
  const swipePressGuard = useSwipePressGuard();

  const extractorRef = useRef<ExtractorRef>(null);
  const libraryPagerRef = useRef<NativeSegmentedPagerHandle>(null);
  const catalogState = useBackendCatalog(false);
  const catalogBooks = catalogState.catalog.books;
  const catalogNextCursor = catalogState.catalog.nextCursor;
  const isCatalogLoading = catalogState.isLoading;
  const isCatalogLoadingMore = catalogState.isRefreshing && catalogBooks.length > 0;
  const catalogError = catalogState.error
    ? t("library.catalogLoadError", "Не удалось загрузить каталог")
    : null;
  const catalogLoadMoreError =
    catalogState.error && catalogBooks.length > 0
      ? t("library.catalogLoadMoreError", "Не удалось загрузить следующие книги")
      : null;
  const loadBackendCatalog = catalogState.retry;
  const loadMoreBackendCatalogPage = catalogState.retry;
  const [catalogScrollY, setCatalogScrollY] = useState(0);
  const primaryScrollRef = useRef<ScrollView>(null);

  const {
    books,
    groups,
    isLoaded,
    isImporting,
    filter,
    allTags,
    activeTag,
    activeGroupId,
    isGroupView,
    loadBooks,
    removeBook,
    setGroupView,
    setActiveGroupId,
    setActiveTag,
    addTag,
    addGroup,
    renameGroup,
    removeGroup,
    moveBooksToGroup,
    addTagToBook,
    removeTagFromBook,
    removeTag,
    renameTag,
  } = useLibraryStore();
  const hasBooks = books.length > 0;
  const syncNow = useSyncStore((state) => state.syncNow);
  const syncStatus = useSyncStore((state) => state.status);
  const syncBackendType = useSyncStore((state) => state.backendType);
  const isSyncBusy = syncStatus !== "idle" && syncStatus !== "error";

  const selectLibrarySection = useCallback((section: LibrarySection) => {
    librarySectionChangedRef.current = true;
    setLibrarySection(section);
    void getPlatformService()
      .kvSetItem(LIBRARY_SECTION_STORAGE_KEY, section)
      .catch((error) => {
        console.warn("[Library] Failed to save selected section:", error);
      });
  }, []);

  useEffect(() => {
    if (!requestedSection) return;
    selectLibrarySection(requestedSection);
  }, [requestedSection, selectLibrarySection]);

  const revealImportedBooks = useCallback((importedCount: number) => {
    if (importedCount > 0) libraryPagerRef.current?.selectPage(1);
  }, []);

  const {
    isPickingImport,
    isUrlImporting,
    handleLocalImport,
    handleOpenImportSources,
    handleOpenUrlImport,
  } = useBookImportActions({ onImportComplete: revealImportedBooks });
  const isBookImporting = isImporting || isPickingImport || isUrlImporting;

  useEffect(() => {
    let cancelled = false;

    void getPlatformService()
      .kvGetItem(LIBRARY_SECTION_STORAGE_KEY)
      .then((savedSection) => {
        if (
          !cancelled &&
          !librarySectionChangedRef.current &&
          (savedSection === "catalog" || savedSection === "my-books")
        ) {
          setLibrarySection(savedSection);
        }
      })
      .catch((error) => {
        console.warn("[Library] Failed to restore selected section:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const { downloadingBookId, downloadProgress, downloadBook } = useBookDownload({
    loadBooks,
    onSuccess: onBookDownloaded,
  });

  const { vectorQueue, vectorizingBookId, vectorProgress, handleVectorize } = useVectorizationQueue(
    { extractorRef, nav },
  );

  useEffect(() => {
    // "Auto-vectorize on import" is handled by the import/download paths.
    // Re-reading and base64-encoding every old book here blocked touch-up and
    // navigation on the library screen for seconds after startup.
    void loadBooks();
  }, [loadBooks]);
  useEffect(() => {
    setExtractorRef(extractorRef.current);
    setFallbackContentProvider({
      async getChapters(book) {
        if (!extractorRef.current) throw new Error("Mobile fallback extractor is not ready");
        const platform = getPlatformService();
        const appData = await platform.getAppDataDir();
        const filePath =
          book.filePath.startsWith("/") ||
          book.filePath.startsWith("file://") ||
          book.filePath.startsWith("asset://") ||
          book.filePath.startsWith("http")
            ? book.filePath
            : await platform.joinPath(appData, book.filePath);
        if (/^https?:\/\//i.test(filePath)) {
          throw new Error("Mobile original-file search requires a local book file");
        }

        const file = new ExpoFile(filePath);
        if (!file.exists) throw new Error("Book file is not available on this device");

        const bytes = await platform.readFile(filePath);
        const mimeTypes: Record<string, string> = {
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
        return extractorRef.current.extractChapters(
          bytesToBase64(bytes),
          mimeTypes[String(book.format || "").toLowerCase()] || "application/epub+zip",
        );
      },
    });
    setCallback((bookId, progress) => {
      console.log(
        `[AutoVectorize] Book ${bookId}: ${progress.status} (${Math.round(progress.progress * 100)}%)`,
      );
    });
    return () => {
      setExtractorRef(null);
      setFallbackContentProvider(null);
      setCallback(null);
    };
  }, []);

  useEffect(() => {
    return onLibraryChanged((deletedTags) => loadBooks(deletedTags));
  }, [loadBooks]);

  const filteredBooks = useMemo(() => {
    let result = [...books];
    if (activeTag === "__uncategorized__") {
      result = result.filter((b) => b.tags.length === 0);
    } else if (activeTag) {
      result = result.filter((b) => b.tags.includes(activeTag));
    }
    if (activeGroupId) {
      result = result.filter((b) => b.groupId === activeGroupId);
    }
    const { sortField, sortOrder } = filter;
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "title":
          cmp = a.meta.title.localeCompare(b.meta.title);
          break;
        case "author":
          cmp = (a.meta.author || "").localeCompare(b.meta.author || "");
          break;
        case "addedAt":
          cmp = (a.addedAt || 0) - (b.addedAt || 0);
          break;
        case "lastOpenedAt":
          cmp = (a.lastOpenedAt || 0) - (b.lastOpenedAt || 0);
          break;
        case "progress":
          cmp = a.progress - b.progress;
          break;
      }
      return sortOrder === "desc" ? -cmp : cmp;
    });
    return result;
  }, [books, filter, activeTag, activeGroupId]);

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? null,
    [groups, activeGroupId],
  );

  useLayoutEffect(() => {
    const title = selectionMode
      ? t("library.selectedCount", {
          count: selectedBookIds.size,
          defaultValue: "Выбрано: {{count}}",
        })
      : activeGroup?.name || t("tabs.library", "Библиотека");

    nav.setOptions({
      title,
      headerTitle: title,
    });
  }, [activeGroup?.name, nav, selectedBookIds.size, selectionMode, t]);

  const groupedEntries = useMemo(() => {
    return groups
      .map((group) => {
        const groupBooks = filteredBooks.filter((book) => book.groupId === group.id);
        return { type: "group" as const, group, books: groupBooks };
      })
      .filter((item) => item.books.length > 0);
  }, [filteredBooks, groups]);

  const visibleBooks = useMemo(
    () =>
      isGroupView && !activeGroupId ? filteredBooks.filter((book) => !book.groupId) : filteredBooks,
    [activeGroupId, filteredBooks, isGroupView],
  );

  const gridItems = useMemo<LibraryGridItem[]>(
    () =>
      isGroupView && !activeGroupId
        ? [...groupedEntries, ...visibleBooks.map((book) => ({ type: "book" as const, book }))]
        : visibleBooks.map((book) => ({ type: "book" as const, book })),
    [activeGroupId, groupedEntries, isGroupView, visibleBooks],
  );

  const catalogBooksInLibrary = useMemo(() => {
    const result = new Map<string, Book>();
    for (const catalogBook of catalogBooks) {
      const existingBook = findReadableLibraryBookForCatalogBook(catalogBook, books);
      if (existingBook) result.set(catalogBook.catalogKey, existingBook);
    }
    return result;
  }, [books, catalogBooks]);

  const showCatalog = !activeTag && !activeGroupId && !selectionMode;
  const isMyBooksEmptyState = showCatalog && librarySection === "my-books" && isLoaded && !hasBooks;
  const readingNowBooks = useMemo(
    () => (showCatalog ? selectReadingNowBooks(books) : []),
    [books, showCatalog],
  );

  const handleOpen = useCallback(
    async (book: Book) => {
      if (book.syncStatus === "remote") {
        await downloadBook(book);
        return;
      }
      await openMobileBook({ bookId: book.id, navigation: nav, t });
    },
    [downloadBook, nav, t],
  );

  const catalogCoverLoadingEnabled = showCatalog && librarySection === "catalog";

  /**
   * Докуда пользователь долистал каталог, округлённое вверх до чанка. Один
   * счётчик на две задачи: сколько обложек качать и сколько карточек
   * монтировать. Только растёт — иначе пролистанные карточки размонтировались
   * бы, и возврат наверх снова стоил бы коммита.
   */
  const [catalogChunkCount, setCatalogChunkCount] = useState(CATALOG_PAGE_SIZE);

  useEffect(() => {
    const rowHeight = gridItemWidth * (41 / 28) + gridGap;
    if (rowHeight <= 0) return;
    const rowsPassed = Math.max(0, Math.floor(catalogScrollY / rowHeight));
    const rowsOnScreen = Math.max(1, Math.ceil(layout.height / rowHeight));
    const needed = (rowsPassed + rowsOnScreen + COVER_LOOKAHEAD_ROWS) * Math.max(1, columnCount);
    setCatalogChunkCount((current) =>
      needed <= current ? current : Math.ceil(needed / CATALOG_PAGE_SIZE) * CATALOG_PAGE_SIZE,
    );
  }, [catalogScrollY, columnCount, gridGap, gridItemWidth, layout.height]);

  // Mount the existing chunk without waiting for every cover. Each card owns
  // its decode/skeleton state, so one finished cover cannot rebuild this grid.
  const visibleCatalogBooks = useMemo(
    () => catalogBooks.slice(0, catalogChunkCount),
    [catalogBooks, catalogChunkCount],
  );

  /**
   * За последней готовой книгой рисуем заглушек на целый экран. Одно правило
   * закрывает оба случая: при первом открытии экран полностью в шиммерах, при
   * догрузке — они продолжают сетку. Видно из них всегда ровно
   * CATALOG_SKELETON_PEEK_HEIGHT точек, остальное отсекает предел прокрутки.
   */
  const skeletonPeekCount = useMemo(() => {
    const rowHeight = gridItemWidth * (41 / 28) + gridGap;
    const rows = rowHeight > 0 ? Math.max(1, Math.ceil(layout.height / rowHeight)) : 1;
    const screenful = rows * Math.max(1, columnCount);
    // Список каталога ещё не пришёл — сколько будет книг, неизвестно, поэтому
    // просто заполняем экран: иначе первые секунды он остаётся пустым.
    if (isCatalogLoading && catalogBooks.length === 0) return screenful;
    const remaining = catalogBooks.length - visibleCatalogBooks.length;
    if (remaining <= 0) return isCatalogLoadingMore ? screenful : 0;
    return Math.min(remaining, screenful);
  }, [
    catalogBooks.length,
    columnCount,
    gridGap,
    gridItemWidth,
    isCatalogLoading,
    isCatalogLoadingMore,
    layout.height,
    visibleCatalogBooks,
  ]);

  const catalogSkeletonKeys = useMemo(() => {
    const fromBooks = catalogBooks
      .slice(visibleCatalogBooks.length, visibleCatalogBooks.length + skeletonPeekCount)
      .map((book) => book.bookEditionId);
    if (fromBooks.length === skeletonPeekCount) return fromBooks;
    return [
      ...fromBooks,
      ...Array.from(
        { length: skeletonPeekCount - fromBooks.length },
        (_, index) => `catalog-skeleton-${fromBooks.length + index}`,
      ),
    ];
  }, [catalogBooks, skeletonPeekCount, visibleCatalogBooks]);

  const handlePrimaryScroll = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
      setCatalogScrollY(nativeEvent.contentOffset.y);
      if (
        !showCatalog ||
        librarySection !== "catalog" ||
        !catalogNextCursor ||
        catalogLoadMoreError
      )
        return;
      const distanceFromBottom =
        nativeEvent.contentSize.height -
        nativeEvent.layoutMeasurement.height -
        nativeEvent.contentOffset.y;
      if (distanceFromBottom <= nativeEvent.layoutMeasurement.height * 0.75) {
        void loadMoreBackendCatalogPage();
      }
    },
    [
      catalogLoadMoreError,
      catalogNextCursor,
      librarySection,
      loadMoreBackendCatalogPage,
      showCatalog,
    ],
  );

  /**
   * Заглушки нарисованы целиком, а докрутить до них можно только на
   * CATALOG_SKELETON_PEEK_HEIGHT точек: остаток съедает отрицательный нижний
   * отступ прокрутки. Ничего не обрезано, предел задан, отпружинивание
   * системное. Пока готовых книг нет, отступ съедает весь экран заглушек — и
   * прокрутки просто нет.
   */
  const catalogScrollBottomInset = useMemo(() => {
    if (skeletonPeekCount <= 0 || librarySection !== "catalog") return 0;
    const columns = Math.max(1, columnCount);
    const rowHeight = gridItemWidth * (41 / 28) + gridGap;
    // Ряды одинаковые, поэтому высоту хвоста считаем, а не измеряем: измерение
    // давало бы лишний кадр раскладки ровно в момент появления обложки.
    const readyRows = Math.ceil(visibleCatalogBooks.length / columns);
    const totalRows = Math.ceil((visibleCatalogBooks.length + skeletonPeekCount) / columns);
    const tailHeight = (totalRows - readyRows) * rowHeight;
    return Math.min(
      0,
      CATALOG_SKELETON_PEEK_HEIGHT -
        tailHeight -
        CATALOG_CONTENT_BOTTOM_PADDING -
        CATALOG_SHADOW_ROOM,
    );
  }, [
    columnCount,
    gridGap,
    gridItemWidth,
    librarySection,
    skeletonPeekCount,
    visibleCatalogBooks.length,
  ]);

  const retryCatalogCover = useCallback(
    (book: CachedBackendCatalogBook) => {
      if (!book.cover) {
        void catalogState.refresh();
        return;
      }
      retrySharedCatalogCover(book);
    },
    [catalogState.refresh],
  );

  // Нажатие на книгу каталога: своя книга открывается напрямую, чужая уходит в
  // ридер вместе с описанием из каталога — качает и импортирует уже он, показывая
  // свой лоудер вместо заглушки поверх обложки.
  const handleCatalogOpen = useCallback(
    async (catalogBook: CachedBackendCatalogBook) => {
      const existingBook = catalogBooksInLibrary.get(catalogBook.catalogKey);
      if (existingBook) {
        await handleOpen(existingBook);
        return;
      }
      nav.navigate("Reader", { bookId: "", catalogBook: getCatalogBookWithCover(catalogBook) });
    },
    [catalogBooksInLibrary, handleOpen, nav],
  );

  const handleManageTags = useCallback((book: Book) => {
    setTagSheetBook(book);
    setTagSheetOpen(true);
  }, []);

  const handleSync = useCallback(() => {
    if (!isSyncBusy) void syncNow();
  }, [isSyncBusy, syncNow]);

  useLayoutEffect(() => {
    if (selectionMode) {
      nav.setOptions(
        Platform.OS === "ios"
          ? { unstable_headerRightItems: () => [] }
          : { headerRight: () => null },
      );
      return;
    }

    if (Platform.OS === "ios") {
      nav.setOptions({
        unstable_headerRightItems: () => [
          ...(syncBackendType
            ? [
                {
                  type: "button" as const,
                  label: t("sync.syncNow", "Синхронизировать"),
                  accessibilityLabel: t("sync.syncNow", "Синхронизировать"),
                  icon: {
                    type: "image" as const,
                    source: getStrokeIconImageSource("repeat"),
                  },
                  disabled: isSyncBusy,
                  onPress: handleSync,
                },
              ]
            : []),
          {
            type: "menu" as const,
            // Заголовок пустой: с ним iOS рисует в баре текст вместо плюса.
            label: "",
            accessibilityLabel: t("library.importFirst", "Добавить книгу"),
            icon: {
              type: "image" as const,
              source: getStrokeIconImageSource("plus"),
            },
            disabled: isBookImporting,
            menu: {
              items: [
                {
                  type: "action" as const,
                  label: t("library.importSourceUrl", "Найти по ссылке"),
                  icon: {
                    type: "image" as const,
                    source: getStrokeIconImageSource("link"),
                  },
                  onPress: handleOpenUrlImport,
                },
                {
                  type: "action" as const,
                  label: t("library.importSourceLocal", "Выбрать файл"),
                  icon: {
                    type: "image" as const,
                    source: getStrokeIconImageSource("folder"),
                  },
                  onPress: () => void handleLocalImport(),
                },
              ],
            },
          },
        ],
      });
      return;
    }

    nav.setOptions({
      headerRight: () => (
        <View style={s.nativeHeaderActions}>
          {syncBackendType ? (
            <View style={s.nativeHeaderButton}>
              <SyncButton size={20} color={colors.mutedForeground} />
            </View>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t("library.importFirst", "Добавить книгу")}
            style={s.nativeHeaderButton}
            onPress={handleOpenImportSources}
            disabled={isBookImporting}
            activeOpacity={0.65}
          >
            <PlusIcon size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [
    colors.mutedForeground,
    colors.primary,
    handleLocalImport,
    handleOpenImportSources,
    handleOpenUrlImport,
    handleSync,
    isBookImporting,
    isSyncBusy,
    nav,
    s.nativeHeaderActions,
    s.nativeHeaderButton,
    selectionMode,
    syncBackendType,
    t,
  ]);

  const isEmpty = gridItems.length === 0;
  const libraryPageMinHeight = Math.max(1, layout.height - nativeHeaderHeight - 76);
  const libraryPagerMinHeight =
    librarySection === "my-books" && !isMyBooksEmptyState ? 1 : libraryPageMinHeight;

  const toggleBookSelection = useCallback((book: Book) => {
    setSelectedBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  }, []);

  const enterSelectionMode = useCallback((book: Book) => {
    setSelectionMode(true);
    setSelectedBookIds(new Set([book.id]));
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedBookIds(new Set());
  }, []);

  const isAllSelected = visibleBooks.length > 0 && selectedBookIds.size === visibleBooks.length;

  const toggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedBookIds(new Set());
    } else {
      setSelectedBookIds(new Set(visibleBooks.map((b) => b.id)));
    }
  }, [visibleBooks, isAllSelected]);

  const handleBatchDelete = useCallback(() => {
    if (selectedBookIds.size === 0) return;
    Alert.alert(
      t("common.confirm", "确认"),
      t("library.batchDeleteConfirm", `确定要删除选中的 ${selectedBookIds.size} 本书吗？`),
      [
        { text: t("common.cancel", "取消"), style: "cancel" },
        {
          text: t("common.delete", "删除"),
          style: "destructive",
          onPress: async () => {
            for (const id of selectedBookIds) {
              await removeBook(id);
            }
            exitSelectionMode();
          },
        },
      ],
    );
  }, [selectedBookIds, removeBook, exitSelectionMode, t]);

  const handleBatchTag = useCallback(() => {
    if (selectedBookIds.size === 0) return;
    const selectedBooks = books.filter((b) => selectedBookIds.has(b.id));
    setTagSheetBook(selectedBooks[0] ?? null);
    setBatchTagBookIds([...selectedBookIds]);
    setTagSheetOpen(true);
  }, [selectedBookIds, books]);

  const handleBatchVectorize = useCallback(() => {
    if (selectedBookIds.size === 0) return;
    const selectedBooks = books.filter((b) => selectedBookIds.has(b.id));
    for (const book of selectedBooks) {
      handleVectorize(book);
    }
    exitSelectionMode();
  }, [selectedBookIds, books, handleVectorize, exitSelectionMode]);

  const openGroupNameModal = useCallback((mode: "create" | "rename", group?: BookGroup) => {
    setGroupNameInput(group?.name ?? "");
    setGroupNameModal({ mode, group });
  }, []);

  const submitGroupName = useCallback(async () => {
    const trimmed = groupNameInput.trim();
    if (!trimmed || !groupNameModal) return;
    if (groupNameModal.mode === "create") {
      await addGroup(trimmed);
      setGroupView(true);
    } else if (groupNameModal.group) {
      renameGroup(groupNameModal.group.id, trimmed);
    }
    setGroupNameInput("");
    setGroupNameModal(null);
  }, [addGroup, groupNameInput, groupNameModal, renameGroup, setGroupView]);

  const handleGroupLongPress = useCallback(
    (group: BookGroup) => {
      Alert.alert(group.name, undefined, [
        {
          text: t("common.rename", "重命名"),
          onPress: () => openGroupNameModal("rename", group),
        },
        {
          text: t("common.delete", "删除"),
          style: "destructive",
          onPress: () => void removeGroup(group.id),
        },
        { text: t("common.cancel", "取消"), style: "cancel" },
      ]);
    },
    [openGroupNameModal, removeGroup, t],
  );

  const handleBatchMoveGroup = useCallback(() => {
    if (selectedBookIds.size === 0) return;
    setShowGroupPicker(true);
  }, [selectedBookIds]);

  const handleGroupPickerSelect = useCallback(
    (groupId: string | undefined) => {
      moveBooksToGroup([...selectedBookIds], groupId);
      exitSelectionMode();
    },
    [exitSelectionMode, moveBooksToGroup, selectedBookIds],
  );

  const handleGroupPickerCreate = useCallback(
    async (name: string) => {
      const group = await addGroup(name);
      if (group) {
        moveBooksToGroup([...selectedBookIds], group.id);
        exitSelectionMode();
      }
    },
    [addGroup, exitSelectionMode, moveBooksToGroup, selectedBookIds],
  );

  const handleBatchRemoveFromGroup = useCallback(() => {
    if (selectedBookIds.size === 0) return;
    moveBooksToGroup([...selectedBookIds], undefined);
    exitSelectionMode();
  }, [exitSelectionMode, moveBooksToGroup, selectedBookIds]);

  const renderGridItem = useCallback(
    ({ item }: { item: LibraryGridItem }) => (
      <View
        key={item.type === "group" ? `group-${item.group.id}` : item.book.id}
        style={s.gridItem}
      >
        {item.type === "group" ? (
          <GroupCard
            group={item.group}
            books={item.books}
            cardWidth={gridItemWidth}
            onOpen={setActiveGroupId}
            onLongPress={handleGroupLongPress}
          />
        ) : (
          <BookCard
            book={item.book}
            cardWidth={gridItemWidth}
            onOpen={handleOpen}
            onDelete={removeBook}
            onManageTags={handleManageTags}
            onVectorize={handleVectorize}
            isVectorizing={vectorizingBookId === item.book.id}
            isQueued={vectorQueue.some((b) => b.id === item.book.id)}
            vectorProgress={vectorizingBookId === item.book.id ? vectorProgress : null}
            downloadProgress={downloadingBookId === item.book.id ? downloadProgress : null}
            isSelectionMode={selectionMode}
            isSelected={selectedBookIds.has(item.book.id)}
            onSelect={toggleBookSelection}
            onLongPress={selectionMode ? undefined : enterSelectionMode}
          />
        )}
      </View>
    ),
    [
      enterSelectionMode,
      gridItemWidth,
      handleGroupLongPress,
      handleManageTags,
      handleOpen,
      handleVectorize,
      removeBook,
      s.gridItem,
      selectedBookIds,
      selectionMode,
      setActiveGroupId,
      toggleBookSelection,
      vectorProgress,
      vectorQueue,
      vectorizingBookId,
      downloadingBookId,
      downloadProgress,
    ],
  );

  const listHeader = (
    <>
      {/* Contextual bulk/group controls stay in content; primary actions live in native header. */}
      {(selectionMode || activeGroup) && (
        <View style={[s.header, { zIndex: 20 }]}>
          <View style={s.headerInner}>
            {selectionMode ? (
              <View style={s.headerRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <TouchableOpacity style={s.headerBtn} onPress={exitSelectionMode}>
                    <XIcon size={18} color={colors.foreground} />
                  </TouchableOpacity>
                </View>
                <View style={s.headerActions}>
                  <TouchableOpacity style={s.headerBtn} onPress={toggleSelectAll}>
                    <CheckCheckIcon
                      size={18}
                      color={isAllSelected ? colors.primary : colors.mutedForeground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.headerBtn} onPress={handleBatchTag}>
                    <HashIcon size={18} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.headerBtn} onPress={handleBatchMoveGroup}>
                    <FolderInputIcon size={18} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  {activeGroupId ? (
                    <TouchableOpacity style={s.headerBtn} onPress={handleBatchRemoveFromGroup}>
                      <FolderMinusIcon size={18} color={colors.mutedForeground} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity style={s.headerBtn} onPress={handleBatchVectorize}>
                    <DatabaseIcon size={18} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.headerBtn} onPress={handleBatchDelete}>
                    <Trash2Icon size={18} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={s.headerRow}>
                <TouchableOpacity style={s.headerBtn} onPress={() => setActiveGroupId("")}>
                  <ChevronLeftIcon size={18} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      )}

      {hasBooks && allTags.length > 0 && (
        <View style={s.filterSection}>
          <View style={s.headerInner}>
            <View style={s.tagSection}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[s.tagScroll, layout.isTablet ? s.tagScrollWide : null]}
                contentContainerStyle={s.tagScrollContent}
              >
                <TouchableOpacity
                  style={[s.tagChip, !activeTag && !activeGroupId && s.tagChipActive]}
                  onPress={() => setActiveTag("")}
                >
                  <Text
                    style={[s.tagChipText, !activeTag && !activeGroupId && s.tagChipTextActive]}
                  >
                    {t("library.all", "全部")}
                  </Text>
                </TouchableOpacity>
                {allTags.map((tag) => (
                  <TouchableOpacity
                    key={tag}
                    style={[s.tagChip, activeTag === tag && s.tagChipActive]}
                    onPress={() => setActiveTag(activeTag === tag ? "" : tag)}
                  >
                    <Text style={[s.tagChipText, activeTag === tag && s.tagChipTextActive]}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[s.tagChip, activeTag === "__uncategorized__" && s.tagChipActive]}
                  onPress={() =>
                    setActiveTag(activeTag === "__uncategorized__" ? "" : "__uncategorized__")
                  }
                >
                  <Text
                    style={[
                      s.tagChipText,
                      activeTag === "__uncategorized__" && s.tagChipTextActive,
                    ]}
                  >
                    {t("sidebar.uncategorized", "未分类")}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </View>
      )}
    </>
  );

  const emptyLibraryState = !isLoaded ? null : books.length === 0 ? (
    <CenteredEmptyState
      title={t("library.empty", "Книг пока нет")}
      description={t("library.emptyHint", "Выберите файл или найдите книгу по ссылке")}
      avoidNativeTabBar
      style={{ minHeight: libraryPageMinHeight }}
    >
      <ImportSourceMenuButton
        label={t("library.emptyAction", "Добавить")}
        urlLabel={t("library.importSourceUrl", "Найти по ссылке")}
        localLabel={t("library.importSourceLocal", "Выбрать файл")}
        disabled={isPickingImport || isUrlImporting}
        onUrlPress={handleOpenUrlImport}
        onLocalPress={() => void handleLocalImport()}
        onFallbackPress={handleOpenImportSources}
      />
    </CenteredEmptyState>
  ) : hasBooks && isEmpty && !showCatalog ? (
    <CenteredEmptyState
      variant="compact"
      title={t("library.noResults", "没有找到匹配的书籍")}
      style={{ transform: [{ translateY: -nativeHeaderHeight / 2 }] }}
    />
  ) : null;

  const catalogGrid = (
    <View style={s.catalogSection}>
      {/* Пока каталог грузится, экран занят заглушками: крутилка с подписью
          поверх них только мигали бы. */}
      {catalogError && catalogBooks.length === 0 ? (
        // Тот же компонент, что и у остальных пустых экранов, иначе каталог
        // выпадает из общего вида: своя мелкая подпись вместо заголовка.
        <CenteredEmptyState variant="compact" title={catalogError} style={s.catalogStatus}>
          <NativeButton
            label={t("common.retry", "Повторить")}
            onPress={() => void loadBackendCatalog()}
            // Кнопка сама ставит себе alignSelf: "flex-start", и он перебивает
            // центрирование контейнера — иначе она прижимается к левому краю.
            style={s.catalogStatusButton}
          />
        </CenteredEmptyState>
      ) : catalogBooks.length === 0 && !catalogNextCursor && !isCatalogLoading ? (
        <CenteredEmptyState
          variant="compact"
          title={t("library.catalogEmpty", "В каталоге пока нет книг")}
          style={s.catalogStatus}
        />
      ) : (
        <View style={s.catalogGrid}>
          {visibleCatalogBooks.map((catalogBook) => (
            <View key={catalogBook.bookEditionId} style={s.gridItem}>
              <ConnectedCatalogBookCard
                book={catalogBook}
                cardWidth={gridItemWidth}
                isInLibrary={catalogBooksInLibrary.has(catalogBook.catalogKey)}
                onPress={handleCatalogOpen}
                onRetryCover={retryCatalogCover}
              />
            </View>
          ))}
          {catalogSkeletonKeys.map((key) => (
            <View key={key} style={s.gridItem}>
              <CatalogBookSkeleton cardWidth={gridItemWidth} />
            </View>
          ))}
        </View>
      )}
      {catalogLoadMoreError && catalogBooks.length > 0 ? (
        <View style={s.catalogLoadMoreStatus}>
          <Text style={s.catalogLoadMoreText}>{catalogLoadMoreError}</Text>
          <NativeButton
            label={t("common.retry", "Повторить")}
            onPress={() => void loadMoreBackendCatalogPage()}
            style={s.catalogStatusButton}
          />
        </View>
      ) : null}
    </View>
  );

  const renderLibraryGrid = (items: LibraryGridItem[]) => (
    <View style={s.pagerGridContent}>
      <View style={s.libraryGrid}>
        {isLoaded ? items.map((item) => renderGridItem({ item })) : null}
      </View>
    </View>
  );

  const libraryPager = (
    <NativeSegmentedPager
      ref={libraryPagerRef}
      values={[t("library.catalog", "Популярное"), t("library.myBooks", "Мои книги")]}
      selectedIndex={librarySection === "catalog" ? 0 : 1}
      onSelect={(index) => selectLibrarySection(index === 0 ? "catalog" : "my-books")}
      colorScheme={isDark ? "dark" : "light"}
      accessibilityLabel={t("library.section", "Раздел библиотеки")}
      controlsStyle={s.librarySectionTabs}
      minimumPageHeight={libraryPagerMinHeight}
      initialPageHeight={libraryPageMinHeight}
      pageGap={gridGap}
      stablePageHeight={false}
      onSwipeStateChange={(swiping) => {
        if (swiping) {
          // Пока идёт жест, высота держится по самой длинной вкладке, поэтому
          // анимация доезжает до верха без обрезания позиции. К моменту смены
          // страницы мы уже наверху — прыжка одним кадром больше нет.
          //
          // Верх здесь не ноль: при большом заголовке система поднимает
          // содержимое на высоту навбара, поэтому ноль оставляет список
          // посередине. Целимся в минус высоту навбара — это и есть верх.
          primaryScrollRef.current?.scrollTo({ y: -nativeHeaderHeight, animated: true });
        }
      }}
    >
      <View>{isLoaded ? catalogGrid : null}</View>
      <View>
        {isLoaded ? (
          <>
            {readingNowBooks.length > 0 ? (
              <ReadingNowShelf
                books={readingNowBooks}
                edgeInset={0}
                catalogCardWidth={gridItemWidth}
                onDelete={removeBook}
                onOpen={handleOpen}
              />
            ) : null}
            {hasBooks ? renderLibraryGrid(gridItems) : emptyLibraryState}
          </>
        ) : null}
      </View>
    </NativeSegmentedPager>
  );

  return (
    <>
      <LibraryCatalogLifecycle
        books={catalogBooks}
        chunkCount={catalogChunkCount}
        scrollY={catalogScrollY}
        columnCount={columnCount}
        gridItemWidth={gridItemWidth}
        gridGap={gridGap}
        viewportHeight={layout.height}
        enabled={catalogCoverLoadingEnabled}
      />
      <View style={s.page} {...swipePressGuard?.touchHandlers}>
        <ScrollViewMarker style={s.page} scrollEdgeEffects={NATIVE_SCROLL_EDGE_EFFECTS}>
          <ScrollView
            ref={primaryScrollRef}
            {...swipePressGuard?.scrollHandlers}
            {...swipePressGuard?.touchHandlers}
            contentInset={{ bottom: catalogScrollBottomInset }}
            onScroll={handlePrimaryScroll}
            scrollEventThrottle={100}
            contentInsetAdjustmentBehavior="automatic"
            style={s.primaryScroll}
            contentContainerStyle={
              isLoaded && (!isEmpty || showCatalog)
                ? [s.gridContent, showCatalog ? s.catalogGridContent : null]
                : s.emptyScrollContent
            }
            scrollEnabled={!isMyBooksEmptyState}
            scrollToOverflowEnabled
            alwaysBounceVertical={!isMyBooksEmptyState}
            bounces={!isMyBooksEmptyState}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {listHeader}
            {showCatalog ? libraryPager : renderLibraryGrid(gridItems)}
            {!showCatalog ? emptyLibraryState : null}
          </ScrollView>
        </ScrollViewMarker>
      </View>

      <Modal
        visible={!!groupNameModal}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupNameModal(null)}
      >
        <Pressable style={s.groupModalOverlay} onPress={() => setGroupNameModal(null)}>
          <Pressable style={s.groupModalCard} onPress={() => {}}>
            <Text style={s.groupModalTitle}>
              {groupNameModal?.mode === "rename"
                ? t("common.rename", "重命名")
                : t("library.createGroup", "新建分组")}
            </Text>
            <TextInput
              style={s.groupModalInput}
              value={groupNameInput}
              onChangeText={setGroupNameInput}
              placeholder={t("library.groupNamePrompt", "分组名称")}
              placeholderTextColor={colors.mutedForeground}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void submitGroupName()}
            />
            <View style={s.groupModalActions}>
              <NativeButton
                label={t("common.cancel", "Отмена")}
                onPress={() => setGroupNameModal(null)}
                variant="secondary"
              />
              <NativeButton
                label={t("common.confirm", "Готово")}
                onPress={() => void submitGroupName()}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <TagManagementSheet
        visible={tagSheetOpen}
        book={tagSheetBook}
        allTags={allTags}
        batchBookIds={batchTagBookIds.length > 0 ? batchTagBookIds : undefined}
        onClose={() => {
          setTagSheetOpen(false);
          setBatchTagBookIds([]);
        }}
        onAddTag={addTag}
        onAddTagToBook={addTagToBook}
        onRemoveTagFromBook={removeTagFromBook}
        onRemoveTag={removeTag}
        onRenameTag={renameTag}
      />
      <GroupPickerSheet
        visible={showGroupPicker}
        groups={groups}
        onSelect={handleGroupPickerSelect}
        onCreateGroup={handleGroupPickerCreate}
        onClose={() => setShowGroupPicker(false)}
      />
      <ExtractorWebView ref={extractorRef} />
    </>
  );
}

const makeStyles = (
  colors: ThemeColors,
  layout: {
    horizontalPadding: number;
    contentWidth: number;
    gridGap: number;
    gridItemWidth: number;
    isWideScreen: boolean;
  },
) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    page: { flex: 1 },
    header: {
      paddingTop: 12,
      paddingBottom: 8,
      alignItems: "center",
    },
    headerInner: { width: "100%", maxWidth: layout.contentWidth },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
    nativeHeaderActions: { flexDirection: "row", alignItems: "center" },
    nativeHeaderButton: {
      width: 40,
      height: 40,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    headerBtn: {
      width: 36,
      height: 36,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    filterSection: {
      paddingBottom: 8,
      alignItems: "center",
    },
    tagSection: {
      marginBottom: 4,
    },
    tagScroll: { marginBottom: 4 },
    tagScrollWide: { flex: 1, minWidth: 0, marginBottom: 0 },
    tagScrollContent: { gap: 6, paddingRight: 8 },
    tagChip: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: radius.full,
      backgroundColor: colors.muted,
    },
    tagChipActive: { backgroundColor: colors.primary },
    tagChipText: {
      fontSize: fontSize.xs,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
    },
    tagChipTextActive: { color: colors.primaryForeground },
    primaryScroll: { flex: 1, overflow: "visible" },
    emptyScrollContent: {
      flexGrow: 1,
      width: "100%",
      maxWidth: layout.contentWidth + layout.horizontalPadding * 2,
      alignSelf: "center",
      paddingHorizontal: layout.horizontalPadding,
    },
    vecBanner: {
      backgroundColor: `${colors.muted}0D`,
      borderRadius: radius.lg,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 12,
    },
    vecBannerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    vecBannerInfo: { flex: 1, minWidth: 0 },
    vecBannerStatusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    vecBannerStatus: {
      fontSize: fontSize.xs,
      fontWeight: fontWeight.medium,
      color: colors.primary,
    },
    vecBannerTitle: {
      fontFamily: secondLevelTitleFontFamily,
      fontSize: 12,
      color: colors.mutedForeground,
      marginTop: 2,
    },
    vecProgressBg: {
      height: 4,
      backgroundColor: `${colors.muted}1A`,
      borderRadius: radius.full,
      marginTop: 8,
      overflow: "hidden",
    },
    vecProgressFill: { height: 4, backgroundColor: colors.primary, borderRadius: radius.full },
    emptyIconWrap: {
      width: 80,
      height: 80,
      borderRadius: radius.full,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 16,
    },
    emptyImportBtn: {
      backgroundColor: colors.primary,
      borderRadius: radius.full,
      paddingHorizontal: 24,
      paddingVertical: 10,
    },
    emptyImportText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.primaryForeground,
    },
    gridRow: { gap: layout.gridGap, justifyContent: "flex-start" },
    gridContent: {
      width: "100%",
      maxWidth: layout.contentWidth + layout.horizontalPadding * 2,
      alignSelf: "center",
      paddingHorizontal: layout.horizontalPadding,
      paddingTop: 16,
      paddingBottom: CATALOG_CONTENT_BOTTOM_PADDING,
    },
    catalogGridContent: { paddingTop: spacingPixels[6] },
    // Заглушки занимают полную высоту карточки и никогда не обрезаются.
    // Насколько далеко можно доскроллить, решает отрицательный нижний отступ
    // прокрутки, а не подрезка содержимого.
    catalogStatus: {
      minHeight: 280,
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      paddingHorizontal: 24,
    },
    catalogStatusButton: { alignSelf: "center" },
    catalogLoadMoreStatus: {
      alignItems: "center",
      gap: spacingPixels[3],
      paddingVertical: spacingPixels[6],
    },
    catalogLoadMoreText: { color: colors.mutedForeground, fontSize: fontSize.sm },
    // Тень книги уходит на 33 точки вниз (0 11px 22px), поэтому запас снизу
    // больше обычного отступа: иначе последний ряд обрезается.
    pagerGridContent: { width: "100%", paddingBottom: 48 },
    libraryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: layout.gridGap,
      overflow: "visible",
    },
    gridItem: {
      width: layout.gridItemWidth,
      marginBottom: layout.gridGap,
      overflow: "visible",
    },
    librarySectionTabs: {
      width: "100%",
      marginBottom: spacingPixels[20] + spacingPixels[3],
    },
    catalogSection: { overflow: "visible", paddingBottom: CATALOG_SHADOW_ROOM },
    catalogGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: layout.gridGap,
      overflow: "visible",
    },
    groupModalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.24)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    groupModalCard: {
      width: "100%",
      maxWidth: 360,
      borderRadius: radius.xl,
      borderWidth: 0.5,
      borderColor: colors.border,
      backgroundColor: colors.card,
      padding: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.2,
      shadowRadius: 18,
      elevation: 12,
    },
    groupModalTitle: {
      fontFamily: secondLevelTitleFontFamily,
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      marginBottom: 12,
    },
    groupModalInput: {
      height: 42,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      color: colors.foreground,
      paddingHorizontal: 12,
      fontSize: fontSize.sm,
      backgroundColor: colors.background,
    },
    groupModalActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 14,
    },
    groupModalSecondary: {
      height: 36,
      paddingHorizontal: 14,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.muted,
    },
    groupModalSecondaryText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.foreground,
    },
    groupModalPrimary: {
      height: 36,
      paddingHorizontal: 16,
      borderRadius: radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary,
    },
    groupModalPrimaryText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.primaryForeground,
    },
  });
