/**
 * Страховка ридера от навигации за пределы книги (C5-RC2).
 *
 * Книжный WebView загружает reader.html и разделы EPUB с локального
 * файлового сервера; всё остальное — внешние ссылки из текста книги
 * (litres/royallib/wikisource, сноски на сайты), которые раньше уводили
 * читателя из книги.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOCAL_SCHEMES = new Set(["file:", "about:", "blob:", "data:", "javascript:"]);

/** URL, который WebView ридера вправе загрузить сам. */
export function isReaderHostedUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Относительные адреса приходят только из локального документа.
    return true;
  }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOCAL_HOSTS.has(parsed.hostname);
}

/** Хост внешней ссылки для подсказки читателю («litres.ru»). */
export function externalLinkHost(href: string | null | undefined): string {
  if (!href) return "";
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    return host.slice(0, 80);
  } catch {
    return "";
  }
}
