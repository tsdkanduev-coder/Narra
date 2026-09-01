import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function parseScreen(name: string) {
  return ts.createSourceFile(
    name,
    readFileSync(new URL(`../../screens/${name}.tsx`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function findCallbacks(source: ts.SourceFile, names: string[]) {
  const callbacks: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      names.includes(node.name.getText(source)) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      callbacks.push(node.initializer.expression);
    }
    if (ts.isPropertyAssignment(node) && names.includes(node.name.getText(source))) {
      callbacks.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return callbacks;
}

function runCallback(expression: ts.Expression, source: ts.SourceFile) {
  const events: string[] = [];
  const actions = [
    "hapticLight",
    "generate",
    "animateScene",
    "regenerateAnimation",
    "playScene",
    "setTextExpanded",
    "runSceneSlotGeneration",
    "handleSceneSlotRestored",
  ];
  const mocks = Object.fromEntries(actions.map((name) => [name, vi.fn(() => events.push(name))]));
  const handler = new Function(...actions, "console", `return (${expression.getText(source)});`)(
    ...actions.map((name) => mocks[name]),
    { log: vi.fn() },
  );
  handler({ anchor: "test-anchor" });
  return { events, mocks };
}

describe("scene action haptics", () => {
  it("fires one light impact before each scene button action, including long press", () => {
    const screen = parseScreen("NarraSceneScreen");
    const handlers = findCallbacks(screen, ["onPress", "onLongPress"]);
    expect(handlers).toHaveLength(5);
    const performed: string[] = [];
    for (const handler of handlers) {
      const { events, mocks } = runCallback(handler, screen);
      expect(mocks.hapticLight).toHaveBeenCalledTimes(1);
      expect(events[0]).toBe("hapticLight");
      expect(events).toHaveLength(2);
      performed.push(events[1]);
    }
    expect(performed).toEqual([
      "generate",
      "animateScene",
      "regenerateAnimation",
      "playScene",
      "setTextExpanded",
    ]);
  });

  it("gives feedback for generation/retry in the reader, but never automatic restoration", () => {
    const screen = parseScreen("ReaderScreen");
    const [tap] = findCallbacks(screen, ["onSceneSlotTap"]);
    const [restore] = findCallbacks(screen, ["onSceneSlotRestored"]);
    expect(runCallback(tap, screen).events).toEqual(["hapticLight", "runSceneSlotGeneration"]);
    expect(runCallback(restore, screen).events).toEqual(["handleSceneSlotRestored"]);
    const template = readFileSync(
      new URL("../../../assets/reader/reader.template.html", import.meta.url),
      "utf8",
    );
    expect(template).toMatch(
      /sceneState === 'idle' \|\| sceneState === 'error'[\s\S]*?postToRN\('sceneSlotTap'/,
    );
    expect(template).toContain("if (!_sceneSlotsEnabled) return");
    expect(template).toContain("var _sceneSlotsEnabled = false");
    // Пока бэкенд не готов, слот не получает кнопку и не «дышит»: вместо немого
    // квадрата — подпись, что сцена появится после разметки книги.
    expect(template).toContain("var inert = state !== 'loading' && !_sceneSlotsEnabled");
    expect(template).toContain("note.appendChild(doc.createTextNode(_sceneSlotLabels.disabled))");
    expect(template).toContain("appendSceneAction(box, _sceneSlotLabels.idle)");
    expect(template).not.toContain("action.disabled = !_sceneSlotsEnabled");
  });
});
