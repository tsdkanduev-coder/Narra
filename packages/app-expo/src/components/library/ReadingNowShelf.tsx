import { Text } from "@/components/ui/Typography";
import { isGeneratedBookCoverPath, shouldRenderCoverTypography } from "@/lib/book/cover-display";
import { generatedCoverTextTone } from "@/lib/book/cover-text-contrast";
import { loadingCoverColorForTitleAuthor } from "@/lib/book/loading-cover-placeholder";
import { findBundledCatalogBookByTitle } from "@/lib/catalog/bundled-books";
import { useResolvedCovers } from "@/screens/notes/useResolvedCovers";
import {
  type ThemeColors,
  fontWeight,
  headingFontFamily,
  radius,
  spacing,
  useColors,
} from "@/styles/theme";
import { radiusPixels, spacingPixels } from "@deslop/primitives";
import type { Book } from "@readany/core/types";
/**
 * ReadingNowShelf — секция «Читаю сейчас» в библиотеке: нативный горизонтальный
 * ряд книг, отсортированных по lastOpenedAt.
 */
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BookCardActionSheet } from "./BookCardActionSheet";
import { BookCoverTypography } from "./book-cover-typography";
import { BookSpineOverlay } from "./book-spine-overlay";
import { PerspectiveBook } from "./perspective-book";
import { useResolvedAssetUris } from "./use-resolved-asset-uris";

const CARD_WIDTH = 104;
const COVER_HEIGHT = Math.round(CARD_WIDTH * (41 / 28));

interface ReadingNowShelfProps {
  books: Book[];
  edgeInset: number;
  catalogCardWidth: number;
  onDelete: (bookId: string, options?: { preserveData?: boolean }) => void;
  onOpen: (book: Book) => void;
}

export const ReadingNowShelf = memo(function ReadingNowShelf({
  books,
  edgeInset,
  catalogCardWidth,
  onDelete,
  onOpen,
}: ReadingNowShelfProps) {
  const colors = useColors();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { t } = useTranslation();
  const [failedCoverKeys, setFailedCoverKeys] = useState<Set<string>>(() => new Set());

  const coverItems = useMemo(
    () => books.map((book) => ({ bookId: book.id, coverUrl: book.meta.coverUrl ?? null })),
    [books],
  );
  const covers = useResolvedCovers(coverItems);
  const bundledCoverAssetModules = useMemo(
    () =>
      books.flatMap((book) => {
        const bundledBook = findBundledCatalogBookByTitle(book.meta.title);
        return bundledBook ? [bundledBook.coverAssetModule] : [];
      }),
    [books],
  );
  const bundledCoverUris = useResolvedAssetUris(bundledCoverAssetModules);

  if (books.length === 0) return null;

  return (
    <View style={s.section}>
      <Text style={s.title} accessibilityRole="header">
        {t("library.readingNow", "Читаю сейчас")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        alwaysBounceHorizontal={books.length > 1}
        contentInsetAdjustmentBehavior="never"
        removeClippedSubviews={false}
        style={[s.carousel, { marginHorizontal: -edgeInset }]}
        contentContainerStyle={[s.row, { paddingHorizontal: edgeInset }]}
      >
        {books.map((book) => {
          const coverUri = covers.get(book.id);
          const coverKey = `${book.id}:${book.meta.coverUrl ?? ""}`;
          const hasUsableCover = Boolean(coverUri) && !failedCoverKeys.has(coverKey);
          const progressPercent = Math.round(Math.max(0, Math.min(1, book.progress ?? 0)) * 100);
          const bundledCatalogBook = hasUsableCover
            ? undefined
            : findBundledCatalogBookByTitle(book.meta.title);
          const bundledCoverUri = bundledCatalogBook
            ? bundledCoverUris.get(bundledCatalogBook.coverAssetModule)
            : undefined;
          const showsColorPlaceholder = !hasUsableCover && !bundledCoverUri;
          const showCoverTypography =
            !hasUsableCover || shouldRenderCoverTypography(book.id, book.meta.coverUrl);
          const coverTextTone = showsColorPlaceholder
            ? "light"
            : isGeneratedBookCoverPath(book.id, book.meta.coverUrl)
              ? generatedCoverTextTone({ title: book.meta.title, author: book.meta.author })
              : (bundledCatalogBook?.coverTextTone ?? "dark");
          return (
            <BookCardActionSheet key={book.id} book={book} onDelete={onDelete} onOpen={onOpen}>
              <PerspectiveBook
                width={CARD_WIDTH}
                height={COVER_HEIGHT}
                coverEffects
                onPress={() => onOpen(book)}
                accessibilityLabel={t("library.readingProgress", "Прочитано {{percent}}%", {
                  percent: progressPercent,
                })}
                accessibilityHint={t("notes.openBook", "Открыть книгу")}
                footer={
                  <View style={s.progressBlock}>
                    <View style={s.progressTrack}>
                      <View style={[s.progressFill, { width: `${progressPercent}%` }]} />
                    </View>
                    <Text style={s.progressLabel}>{`${progressPercent}%`}</Text>
                  </View>
                }
                cover={
                  <View style={s.coverCanvas}>
                    {hasUsableCover && coverUri ? (
                      <Image
                        source={{ uri: coverUri }}
                        style={s.coverImage}
                        resizeMode="cover"
                        onError={() =>
                          setFailedCoverKeys((current) => {
                            if (current.has(coverKey)) return current;
                            const next = new Set(current);
                            next.add(coverKey);
                            return next;
                          })
                        }
                      />
                    ) : bundledCoverUri ? (
                      <Image
                        source={{ uri: bundledCoverUri }}
                        style={s.coverImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        style={[
                          s.fallbackCover,
                          {
                            backgroundColor: loadingCoverColorForTitleAuthor({
                              title: book.meta.title,
                              author: book.meta.author,
                            }),
                          },
                        ]}
                      />
                    )}
                    <BookSpineOverlay coverWidth={CARD_WIDTH} />
                    <BookCoverTypography
                      title={book.meta.title}
                      width={CARD_WIDTH}
                      referenceWidth={catalogCardWidth}
                      titleFontSize={15}
                      leftInsetAdjustment={2}
                      showText={showCoverTypography}
                      textTone={coverTextTone}
                      coverUri={(hasUsableCover ? coverUri : bundledCoverUri) ?? undefined}
                    />
                    <PageCurlCorner />
                  </View>
                }
              />
            </BookCardActionSheet>
          );
        })}
      </ScrollView>
    </View>
  );
});

/** MVP page-curl: повёрнутый градиент + тень из токенов deslop, без новой дизайн-системы. */
const PageCurlCorner = memo(function PageCurlCorner() {
  const size = spacingPixels[24];
  return (
    <View pointerEvents="none" style={curlStyles.wrap}>
      <View
        style={[
          curlStyles.shadow,
          {
            width: size,
            height: size,
            borderBottomRightRadius: radiusPixels[8],
          },
        ]}
      />
      <LinearGradient
        colors={["rgba(255,255,255,0.72)", "rgba(0,0,0,0.22)"]}
        start={{ x: 0, y: 1 }}
        end={{ x: 1, y: 0 }}
        style={[curlStyles.fold, { width: size, height: size }]}
      />
    </View>
  );
});

const curlStyles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: spacingPixels[24],
    height: spacingPixels[24],
    overflow: "hidden",
  },
  shadow: {
    position: "absolute",
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  fold: {
    position: "absolute",
    right: -spacingPixels[12],
    bottom: -spacingPixels[12],
    transform: [{ rotate: "45deg" }],
  },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    section: { marginBottom: spacing.xxl },
    title: {
      fontFamily: headingFontFamily,
      fontSize: 20,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      marginBottom: spacing.md,
    },
    carousel: { overflow: "visible" },
    row: { gap: spacing.lg },
    coverCanvas: {
      width: "100%",
      height: "100%",
      position: "relative",
      isolation: "isolate",
    },
    coverImage: { width: "100%", height: "100%" },
    fallbackCover: {
      flex: 1,
      overflow: "hidden",
      padding: spacing.md,
      backgroundColor: colors.bookCoverSurface,
    },
    progressBlock: {
      marginTop: spacing.sm,
      gap: spacingPixels[4],
    },
    progressTrack: {
      height: 4,
      backgroundColor: colors.muted,
      borderRadius: radius.full,
      overflow: "hidden",
    },
    progressFill: {
      height: 4,
      backgroundColor: colors.primary,
      borderRadius: radius.full,
    },
    progressLabel: {
      fontSize: 13,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
      fontVariant: ["tabular-nums"],
    },
  });
