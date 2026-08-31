import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Android reader toolbar", () => {
  it("exposes listen and characters actions instead of an empty bar", () => {
    const toolbar = read("../../screens/reader/ReaderToolbar.tsx");
    expect(toolbar).toContain("export const TOOLBAR_HEIGHT = 50");
    expect(toolbar).toContain('t("reader.listen", "Слушать")');
    expect(toolbar).toContain('t("narra.characters", "Персонажи")');
    expect(toolbar).not.toContain("return null");
  });
});

describe("iOS reader toolbar contract", () => {
  it("uses the compact localized stop action", () => {
    const toolbar = read("../../screens/reader/ReaderToolbar.ios.tsx");

    expect(toolbar).toContain('speechStopLabel={t("tts.stopShort", "Стоп")}');
    expect(toolbar).not.toContain('speechStopLabel={t("common.stop"');
  });

  it("keeps native toolbar titles on one line while preserving their accessible names", () => {
    const nativeControls = read(
      "../../../modules/native-controls/ios/ReadAnyNativeControlsModule.swift",
    );
    const readerToolbar = nativeControls
      .split("final class ReadAnyReaderToolbar")[1]
      .split("final class ReadAnySceneToolbar")[0];

    expect(readerToolbar).toContain("button.titleLabel?.numberOfLines = 1");
    expect(readerToolbar).toContain("button.titleLabel?.adjustsFontSizeToFitWidth = true");
    expect(readerToolbar).toContain("button.titleLabel?.minimumScaleFactor = 0.85");
    expect(readerToolbar).toContain(
      "button.setContentCompressionResistancePriority(.required, for: .horizontal)",
    );
    expect(readerToolbar).toContain("button.accessibilityLabel = title");
    expect(readerToolbar).toContain("speechItem.accessibilityLabel = currentSpeechLabel");
  });

  it("shows a centered system spinner instead of visible loading icon and copy", () => {
    const nativeControls = read(
      "../../../modules/native-controls/ios/ReadAnyNativeControlsModule.swift",
    );
    const readerToolbar = nativeControls
      .split("final class ReadAnyReaderToolbar")[1]
      .split("final class ReadAnySceneToolbar")[0];

    expect(readerToolbar).toContain("UIActivityIndicatorView(style: .medium)");
    expect(readerToolbar).toContain(
      "indicator.centerXAnchor.constraint(equalTo: speechButton.centerXAnchor)",
    );
    expect(readerToolbar).toContain(
      "indicator.centerYAnchor.constraint(equalTo: speechButton.centerYAnchor)",
    );
    expect(readerToolbar).toContain("isLoading: speechLoading");
    expect(readerToolbar).toContain(
      "configuration.baseForegroundColor = isLoading ? .clear : toolbarTintColor",
    );
    expect(readerToolbar).toContain("speechLoadingIndicator.startAnimating()");
    expect(readerToolbar).toContain("speechLoadingIndicator.stopAnimating()");
  });
});
