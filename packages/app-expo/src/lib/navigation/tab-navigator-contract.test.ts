import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const navigator = readFileSync(
  new URL("../../navigation/TabNavigator.tsx", import.meta.url),
  "utf8",
);

describe("native tab navigator contract", () => {
  it("keeps four labeled tabs Library / Reading / My path / Profile and search in the Profile stack", () => {
    expect(navigator).toContain('tabBarLabelVisibilityMode: "labeled"');
    expect(navigator).toContain('name="Library"');
    expect(navigator).toContain('name="Reading"');
    expect(navigator).toContain("ReadingTabScreen");
    expect(navigator).toContain('name="Chats"');
    expect(navigator).toContain('name="Profile"');
    expect(navigator).toContain('name="ProfileSearch"');
    expect(navigator).toContain('t("tabs.reading", "Читалка")');
    expect(navigator).toContain('t("tabs.myPath", "Мой путь")');
    expect(navigator).toContain('getStrokeIconImageSource("book-open")');
    expect(navigator).not.toContain('tabBarLabel: ""');
    expect(navigator).not.toContain("tabBarSystemItem");
    expect(navigator).not.toMatch(/name="Search"/);
  });
});
