import { describe, expect, it } from "vitest";
import {
  sceneImageDataUri,
  sceneImageMimeType,
  sceneInsertAnchors,
  sceneSourceKeyForAnchor,
} from "./scene-inserts";
import type { NarraSceneImage } from "./types";

function scene(overrides: Partial<NarraSceneImage>): NarraSceneImage {
  return {
    sourceKey: "page:epubcfi(/6/4!/4/2)",
    chapter: "Глава 1",
    excerpt: "Отрывок",
    imageUri: "file:///Documents/narra-media/scene.png",
    generatedAt: 1,
    ...overrides,
  };
}

describe("sceneSourceKeyForAnchor", () => {
  it("собирает sourceKey с префиксом page: как в P6", () => {
    expect(sceneSourceKeyForAnchor("epubcfi(/6/4!/4/2)")).toBe("page:epubcfi(/6/4!/4/2)");
  });
});

describe("sceneInsertAnchors", () => {
  it("возвращает пусто без сцен", () => {
    expect(sceneInsertAnchors(undefined)).toEqual([]);
    expect(sceneInsertAnchors({})).toEqual([]);
  });

  it("берёт только сцены с явным якорем и картинкой", () => {
    const anchors = sceneInsertAnchors({
      a: scene({ sourceKey: "page:x", anchor: "epubcfi(/6/4!/4/10)" }),
      // Старая сцена с экрана NarraScene: без anchor — в текст не возвращается
      b: scene({ sourceKey: "page:epubcfi(/6/4!/4/2:5)" }),
      // Сцена без файла картинки не восстанавливается
      c: scene({ sourceKey: "page:y", anchor: "epubcfi(/6/6!/4/2)", imageUri: "" }),
    });
    expect(anchors).toEqual(["epubcfi(/6/4!/4/10)"]);
  });

  it("берёт якорь из scenesByBackendId, даже если book.scenes пуст", () => {
    const anchors = sceneInsertAnchors(
      {},
      undefined,
      undefined,
      {
        "backend-1": scene({
          sourceKey: "page:epubcfi(/6/8!/4/2)",
          anchor: "epubcfi(/6/8!/4/2)",
        }),
      },
    );
    expect(anchors).toEqual(["epubcfi(/6/8!/4/2)"]);
  });

  it("дедуплицирует и сортирует якоря, пустые якоря отбрасывает", () => {
    const anchors = sceneInsertAnchors({
      a: scene({ anchor: "epubcfi(/6/6!/4/2)" }),
      b: scene({ anchor: "epubcfi(/6/4!/4/2)" }),
      c: scene({ anchor: "epubcfi(/6/6!/4/2)" }),
      d: scene({ anchor: "   " }),
    });
    expect(anchors).toEqual(["epubcfi(/6/4!/4/2)", "epubcfi(/6/6!/4/2)"]);
  });
});

describe("sceneImageMimeType", () => {
  it("определяет тип по расширению без учёта регистра и query", () => {
    expect(sceneImageMimeType("file:///a/scene.png")).toBe("image/png");
    expect(sceneImageMimeType("file:///a/scene.JPG")).toBe("image/jpeg");
    expect(sceneImageMimeType("file:///a/scene.jpeg?x=1")).toBe("image/jpeg");
    expect(sceneImageMimeType("file:///a/scene.webp#frag")).toBe("image/webp");
    expect(sceneImageMimeType("file:///a/scene.gif")).toBe("image/gif");
  });

  it("для неизвестных расширений падает обратно в png (формат генерации)", () => {
    expect(sceneImageMimeType("file:///a/scene")).toBe("image/png");
    expect(sceneImageMimeType("file:///a/scene.bin")).toBe("image/png");
  });
});

describe("sceneImageDataUri", () => {
  it("собирает data-URI с корректным MIME", () => {
    expect(sceneImageDataUri("QUJD", "file:///a/scene.png")).toBe(
      "data:image/png;base64,QUJD",
    );
    expect(sceneImageDataUri("QUJD", "file:///a/photo.jpg")).toBe(
      "data:image/jpeg;base64,QUJD",
    );
  });
});
