import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import sceneGenerationConfig from "./scene-generation-config.json";

describe("square scene contract", () => {
  it("keeps the frame and replaces loading copy with a disposable mosaic", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    const render = template
      .split("function renderSceneInsert(el, state, payload)")[1]
      .split("function appendSceneFlowBorder")[0];
    expect(render).toContain("doc.createElement('canvas')");
    expect(render).toContain("box.setAttribute('role', 'status')");
    expect(render).toContain("box.setAttribute('aria-label', _sceneSlotLabels.loading)");
    // Во время генерации в квадрате нет текста; подпись есть только у
    // неактивного слота (бэкенд ещё готовит разметку).
    const loadingBranch = render
      .split("if (state === 'loading') {")[1]
      .split("} else if (inert)")[0];
    expect(loadingBranch).not.toContain("createTextNode");
    expect(render).toContain("note.className = 'readany-scene-disabled'");
    expect(render).not.toContain("loadingHint");
    expect(template).not.toContain("NARRA_LOADER_SVG");
    expect(render.match(/appendSceneFlowBorder\(box\)/g)).toHaveLength(1);
    expect(render).toContain("oldBox.__readanyDisposeLoader()");
    expect(render).toContain("window._readanyMountScenePixelLoader(loader, preset)");
    expect(render).toContain("state === 'loading' ? 'sweep-gradient' : 'pixels-organic'");
    expect(render).toContain("state === 'loading' || state === 'idle'");
  });
  it("keeps scene generation configured for a square image", () => {
    expect(sceneGenerationConfig.aspectRatio).toBe("1:1");

    const source = readFileSync(
      fileURLToPath(new URL("./scene-image-openrouter.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const SCENE_WIDTH = 1024;");
    expect(source).toContain("const SCENE_HEIGHT = 1024;");
  });

  it("reserves one page-bounded square and starts it on a new column", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("'  stroke-dasharray: none;'");
    expect(template).not.toContain("readany-scene-dash-flow");
    expect(template).toContain("function appendSceneFlowBorder(box)");
    expect(template).toContain("var bounds = box.getBoundingClientRect();");
    expect(template).not.toContain("function sizeSceneInsertToHost(el, host)");
    expect(template).toContain("'  width: var(--readany-scene-side) !important;'");
    expect(template).toContain("'  height: var(--readany-scene-side) !important;'");
    expect(template).toContain("'  break-before: column !important;'");
    expect(template).toContain("'  margin: 0 auto 24px !important;'");
    expect(template).toContain("img.style.setProperty('height', '100%', 'important')");
    expect(template).toContain("el.setAttribute('cfi-inert', '')");
    expect(template).toContain("el.cfiFilter = sceneCfiFilter");
  });

  it("uses the approved scene action copy and wand icon", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("idle: 'Сгенерировать сцену'");
    expect(template).toContain("var SCENE_WAND_SVG = '<svg");
    expect(template).not.toContain("'✦ ' + _sceneSlotLabels.idle");
    expect(template).toContain("'  font-family: \"SB Sans Interface\", system-ui, sans-serif;'");
    expect(template).toContain("'  color: ' + actionColor + ' !important;'");
    expect(template).toContain("'  font-size: 16px;'");
    expect(template).toContain("'  line-height: 20px;'");
    expect(template).toContain("sceneSlotInterfaceFontFaceText()");
    expect(template).toContain("action.style.setProperty('font-size', '16px', 'important')");
    expect(template).toContain(
      "action.style.setProperty('color', currentThemeColors.sceneActionColor, 'important')",
    );
    expect(template).toContain("'  fill: currentColor !important;'");
    expect(template).toContain(
      "action.style.setProperty('justify-content', 'center', 'important')",
    );
    expect(template).toContain("action.style.setProperty('text-indent', '0', 'important')");
    expect(template).toContain("'\"SB Sans Interface\", system-ui, sans-serif'");
    const ru = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../core/src/i18n/locales/ru/common.json", import.meta.url)),
        "utf8",
      ),
    );
    const en = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../core/src/i18n/locales/en/common.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(ru.narra.sceneSlotShow).toBe("Сгенерировать сцену");
    expect(en.narra.sceneSlotShow).toBe("Generate scene");
  });

  it("uses an accessible pill outline button inside the solid square", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("var action = doc.createElement('button')");
    expect(template).toContain("action.type = 'button'");
    expect(template).toContain("action.setAttribute('data-variant', 'outline')");
    expect(template).toContain("'  border-radius: 9999px !important;'");
    expect(template).toContain("icon.setAttribute('data-icon', 'inline-start')");
    expect(template).toContain(".readany-scene-action:focus-visible");
    expect(template).toContain("appendSceneAction(box, _sceneSlotLabels.idle)");
    expect(template).toContain("action.style.setProperty('width', 'auto', 'important')");
  });

  it("shares cover press feedback and uses Primitives surfaces", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("var press = window._readanyCoverPressFeedback");
    expect(template).toContain("'  transform: scale(' + press.scale + ');'");
    expect(template).toContain("press.durationMs + 'ms cubic-bezier(' + press.easing.join(',')");
    expect(template).toContain("var primary5 = currentThemeColors.primary5;");
    expect(template).toContain("'  stroke: ' + primary5 + ';'");
    expect(template).toContain("'  border: 1px solid ' + primary10 + ' !important;'");
    expect(template).toContain("'  background: ' + currentThemeColors.elevation1 + ' !important;'");
    expect(template).toContain("'  background: ' + currentThemeColors.elevation2 + ' !important;'");
    expect(template).toContain("'  -webkit-backdrop-filter: blur(10px);'");
    expect(template).toContain("'  backdrop-filter: blur(10px);'");
  });

  it("installs theme styles before the first scene subscribes to changes", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    const create = template
      .split("function createSceneInsert(doc, anchor, state)")[1]
      .split("return el;")[0];
    expect(create.indexOf("sceneSlotInjectStyles(doc)")).toBeLessThan(
      create.indexOf("renderSceneInsert(el, state || 'idle', null)"),
    );
  });

  it("disables native tap highlighting throughout the scene", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    const sceneStyles = template
      .split("function sceneSlotStyleText()")[1]
      .split("function sceneSlotInterfaceFontFaceText()")[0];
    expect(sceneStyles).toContain("'  -webkit-tap-highlight-color: transparent !important;'");
    expect(sceneStyles).not.toContain("-webkit-tap-highlight-color: rgba(");
    expect(sceneStyles).toContain("'  transform: scale(' + press.scale + ');'");
  });

  it("blocks selection throughout scene UI without disabling book text", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("'.' + SCENE_INSERT_CLASS + ' * {'");
    expect(template).toContain("'  -webkit-touch-callout: none !important;'");
    expect(template).toContain("if (isSceneUiNode(e.target))");
    expect(template).toContain("if (dismissSceneSelection(doc, sel)) return;");
    expect(template).toContain("if (dismissSceneSelection(doc)) return;");
  });
});
