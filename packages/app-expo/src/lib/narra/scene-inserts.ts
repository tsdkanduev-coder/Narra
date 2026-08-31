/**
 * Врезки сцен внутри текста книги — чистая логика якорей и восстановления.
 *
 * Сцена, сгенерированная из врезки, персистится в narra-store с ключом
 * `page:<anchor>`, где anchor — CFI блока, после которого врезка вставлена
 * в DOM секции (считает WebView, см. reader.template.html). При повторном
 * открытии секции RN отдаёт список якорей в WebView, тот вставляет карточки
 * обратно и запрашивает картинки событием sceneSlotRestored.
 */

import type { NarraBookState, NarraSceneImage } from "./types";

/** Префикс sourceKey сцен, привязанных к позиции страницы (как в P6). */
export const SCENE_PAGE_SOURCE_PREFIX = "page:";

/** sourceKey сцены-врезки по CFI-якорю вставки. */
export function sceneSourceKeyForAnchor(anchor: string): string {
  return `${SCENE_PAGE_SOURCE_PREFIX}${anchor}`;
}

/**
 * Якоря сцен книги, пригодных для восстановления в тексте: только сцены,
 * сохранённые с явным полем anchor (врезки). Сцены со старым sourceKey
 * `page:<cfi>` без якоря (экран NarraScene) в текст не возвращаются.
 */
export function sceneInsertAnchors(
  scenes: Record<string, NarraSceneImage> | undefined,
  requests?: NarraBookState["sceneRequests"],
  bindings?: NarraBookState["sceneAnchorBindings"],
  scenesByBackendId?: NarraBookState["scenesByBackendId"],
): string[] {
  const anchors: string[] = Object.keys(bindings ?? {});
  anchors.push(
    ...Object.keys(requests ?? {})
      .filter((key) => key.startsWith(SCENE_PAGE_SOURCE_PREFIX))
      .map((key) => key.slice(SCENE_PAGE_SOURCE_PREFIX.length).trim())
      .filter(Boolean),
  );
  for (const scene of [...Object.values(scenes ?? {}), ...Object.values(scenesByBackendId ?? {})]) {
    const anchor = scene.anchor?.trim();
    if (anchor && scene.imageUri && !anchors.includes(anchor)) {
      anchors.push(anchor);
    }
  }
  return [...new Set(anchors)].sort();
}

/** MIME по расширению файла картинки; генерация narra пишет .png (media.ts). */
export function sceneImageMimeType(uri: string): string {
  const clean = (uri.split(/[?#]/, 1)[0] ?? "").toLowerCase();
  const dotIndex = clean.lastIndexOf(".");
  const extension = dotIndex >= 0 ? clean.slice(dotIndex + 1) : "";
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/**
 * data-URI картинки для передачи в WebView: файл читается в RN (base64),
 * чтобы не зависеть от доступа WebView к файловой системе или static server.
 */
export function sceneImageDataUri(base64: string, uri: string): string {
  return `data:${sceneImageMimeType(uri)};base64,${base64}`;
}
