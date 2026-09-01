import "./global.css";

import { Text } from "@/components/ui/Typography";
/**
 * Narra Expo App — Root component
 *
 * Initialises platform service, i18n, and mounts navigation.
 */

// Polyfill AbortSignal.throwIfAborted — missing in Hermes, required by LangChain
if (typeof AbortSignal !== "undefined" && !AbortSignal.prototype.throwIfAborted) {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) {
      const err = this.reason ?? new Error("The operation was aborted.");
      throw err;
    }
  };
}

// Polyfill navigator.userAgent for LangChain — React Native doesn't have userAgent
if (typeof navigator !== "undefined" && !navigator.userAgent) {
  Object.defineProperty(navigator, "userAgent", {
    get: () => "ReactNative",
    configurable: true,
  });
}

import { PanelUIThemeBridge } from "@/styles/panelui-theme-bridge";
import {
  interfaceFontAssets,
  interfaceFontFamily,
  serifCondensedFontAssets,
  serifTextFontAssets,
} from "@deslop/primitives/native";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { PanelUIProvider } from "panelui-native";
import { useEffect, useMemo, useState } from "react";
import { AppState, LogBox, Platform, StyleSheet, View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  type EntryExitAnimationFunction,
  SnappySpringConfig,
  withSpring,
} from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { rnSessionEventSource } from "@/hooks";
import { setStreamingFetch } from "@readany/core/ai/llm-provider";
import { initDatabase } from "@readany/core/db/database";
import { setSessionEventSource } from "@readany/core/hooks/use-reading-session";
import i18n, { i18nReady, initI18nLanguage } from "@readany/core/i18n";
import { setPlatformService } from "@readany/core/services";
import { setSyncAdapter } from "@readany/core/sync";
import { setAudioModeAsync } from "expo-audio";
import { I18nextProvider } from "react-i18next";
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Event as TrackEvent,
  Capability,
} from "react-native-track-player";
import { type ToastAnimation, Toaster } from "sonner-native";

import { CatalogCharacterPortraitPreloader } from "@/components/catalog/CatalogCharacterPortraitPreloader";
import { AnimatedNarraFace } from "@/components/chat/animated-narra-face";
import { MishanaerIcon, type MishanaerIconName } from "@/components/ui/Icon";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { useUpdateChecker } from "@/hooks/use-update-checker";
import {
  isNarraAssistantGatewayRequest,
  narraAssistantGatewayFetch,
} from "@/lib/ai/narra-assistant-gateway";
import { startTelemetry } from "@/lib/analytics/telemetry";
import { startDiagnostics, verifyNarraGatewayBackend } from "@/lib/diagnostics/diagnostics";
import { navigationRef } from "@/lib/navigationRef";
import { ExpoPlatformService } from "@/lib/platform/expo-platform-service";
import { seekActiveTTS, seekActiveTTSBy } from "@/lib/platform/tts-track-controls";
import { prewarmReader } from "@/lib/reader/reader-runtime";
import { MobileSyncAdapter } from "@/lib/sync/sync-adapter-mobile";
import { RootNavigator } from "@/navigation/RootNavigator";
import { flushAllWrites } from "@/stores/persist";
import { ReaderTOCSheetProvider } from "@/screens/reader/reader-toc-sheet-context";
import { useLibraryStore } from "@/stores/library-store";
import {
  type ThemeMode,
  ThemeProvider,
  loadStoredThemeMode,
  useTheme,
} from "@/styles/ThemeContext";
import { useAutoSync } from "@readany/core/hooks/use-auto-sync";

const toastEnterAnimation: EntryExitAnimationFunction = () => {
  "worklet";

  return {
    initialValues: {
      opacity: 1,
      transform: [{ translateY: -20 }],
    },
    animations: {
      transform: [
        {
          translateY: withSpring(0, SnappySpringConfig),
        },
      ],
    },
  };
};
const TOAST_ANIMATION = { enter: toastEnterAnimation } satisfies ToastAnimation;

// iOS New-Arch + expo-dev-client cold-start: when dev-client swaps its boot
// RCTInstance for the app's instance, RCTTurboModuleManager waits up to 10s for
// every TurboModule's invalidate to return. If any module's method queue is slow
// (e.g. react-native-track-player v4, whose v4 branch is frozen and does not
// fully support RN 0.81 New Arch), the wait times out and prints RCTLogError —
// triggering a red-box. State clears correctly afterwards (see
// RCTTurboModuleManager.mm:1105), so the warning is purely cosmetic dev noise.
if (Platform.OS === "ios") {
  LogBox.ignoreLogs([/TurboModuleManager: Timed out waiting for modules to be invalidated/]);
}

// Keep the native splash screen visible while we bootstrap
SplashScreen.setOptions({ duration: 180, fade: true });
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const systemColorScheme = useColorScheme();
  const [fontsLoaded, fontError] = useFonts({
    ...interfaceFontAssets,
    "SB Serif Condensed": serifCondensedFontAssets.regular,
    "SB Serif Text": serifTextFontAssets.regular,
    "SB Serif Text Bold": serifTextFontAssets.bold,
  });
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [initialThemeMode, setInitialThemeMode] = useState<ThemeMode | null>(null);

  useEffect(() => startTelemetry(), []);
  useEffect(() => startDiagnostics(), []);

  // Персист сторов пишется с задержкой 500 мс. Уход в фон (свайп приложения,
  // звонок) раньше терял последнее сообщение чата, прогресс и привязку книги.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        flushAllWrites().catch((err) => console.error("[App] flush on background failed", err));
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    async function bootstrap() {
      try {
        console.log("[App] bootstrap: register platform service");
        const platform = new ExpoPlatformService();
        setPlatformService(platform);

        // Reader HTML, fonts and the local book server do not depend on a
        // selected book. Prepare them while the rest of the app boots, but do
        // not make the splash screen wait if preparation fails.
        void prewarmReader().catch((error) => {
          console.warn("[App] Reader prewarm failed; will retry on book open:", error);
        });

        console.log("[App] bootstrap: register sync adapter");
        setSyncAdapter(new MobileSyncAdapter());

        console.log("[App] bootstrap: init database");
        await initDatabase();

        console.log("[App] bootstrap: wait i18nReady");
        await i18nReady;
        console.log("[App] i18n initialized successfully");

        console.log("[App] bootstrap: register RN session source");
        setSessionEventSource(rnSessionEventSource);

        console.log("[App] bootstrap: init language");
        await initI18nLanguage();

        console.log("[App] bootstrap: load theme");
        setInitialThemeMode(await loadStoredThemeMode());

        console.log("[App] bootstrap: import expo/fetch");
        const { fetch: expoFetch } = await import("expo/fetch");
        setStreamingFetch(((input: RequestInfo | URL, init?: RequestInit) => {
          if (isNarraAssistantGatewayRequest(input)) {
            return narraAssistantGatewayFetch(input, init);
          }
          return expoFetch(input, init);
        }) as typeof globalThis.fetch);

        // Verify the server that actually answered without blocking offline startup.
        void verifyNarraGatewayBackend();

        console.log("[App] bootstrap: configure audio mode");
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: "duckOthers",
        });

        console.log("[App] bootstrap: init react-native-track-player");
        // setupPlayer can only be called once per native process. On Android,
        // a Configuration Change (e.g. Huawei tablet small-screen → fullscreen)
        // restarts the Activity and re-runs this bootstrap, but the native
        // singleton is still alive — so setupPlayer() throws
        // "The player has already been initialized via setupPlayer".
        // Treat that specific error as success so bootstrap can continue.
        try {
          await TrackPlayer.setupPlayer();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/already been initialized/i.test(msg)) throw e;
          console.log("[App] TrackPlayer already initialized — reusing existing native instance");
        }
        await TrackPlayer.updateOptions({
          android: {
            appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
            alwaysPauseOnInterruption: false,
          },
          backwardJumpInterval: 15,
          forwardJumpInterval: 15,
          stoppingAppPausesPlayback: false,
          capabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.Stop,
            Capability.SeekTo,
            Capability.JumpBackward,
            Capability.JumpForward,
            Capability.SkipToNext,
            Capability.SkipToPrevious,
          ],
          compactCapabilities: [Capability.Play, Capability.Pause],
          notificationCapabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.Stop,
            Capability.SeekTo,
            Capability.JumpBackward,
            Capability.JumpForward,
            Capability.SkipToNext,
            Capability.SkipToPrevious,
          ],
        });

        // Remote event → TTS store bridge
        const { useTTSStore: ttsStore } = await import("@/stores/tts-store");
        TrackPlayer.addEventListener(TrackEvent.RemotePlay, () => {
          ttsStore.getState().resume();
        });
        TrackPlayer.addEventListener(TrackEvent.RemotePause, () => {
          ttsStore.getState().pause();
        });
        TrackPlayer.addEventListener(TrackEvent.RemoteStop, () => {
          ttsStore.getState().stop();
        });
        TrackPlayer.addEventListener(TrackEvent.RemoteSeek, ({ position }) => {
          void seekActiveTTS(position);
        });
        TrackPlayer.addEventListener(TrackEvent.RemoteJumpBackward, ({ interval }) => {
          void seekActiveTTSBy(-interval);
        });
        TrackPlayer.addEventListener(TrackEvent.RemoteJumpForward, ({ interval }) => {
          void seekActiveTTSBy(interval);
        });
        TrackPlayer.addEventListener(TrackEvent.RemoteNext, () => {
          const { jumpToChunk, currentChunkIndex, totalChunks } = ttsStore.getState();
          const nextIndex = currentChunkIndex + 1;
          if (nextIndex < totalChunks) {
            jumpToChunk(nextIndex);
          }
        });
        TrackPlayer.addEventListener(TrackEvent.RemotePrevious, () => {
          const { jumpToChunk, currentChunkIndex } = ttsStore.getState();
          const prevIndex = currentChunkIndex - 1;
          if (prevIndex >= 0) {
            jumpToChunk(prevIndex);
          }
        });

        console.log("[App] bootstrap: done");
        setReady(true);
      } catch (error) {
        console.error("[App] bootstrap failed:", error);
        setBootError(error instanceof Error ? error.message : String(error));
      }
    }
    bootstrap();
  }, []);

  const startupError = bootError ?? fontError?.message ?? null;
  const hideNativeSplash = () => {
    SplashScreen.hideAsync().catch(() => {});
  };

  if (startupError) {
    return (
      <View
        onLayout={hideNativeSplash}
        style={{
          flex: 1,
          backgroundColor: "#1c1c1e",
        }}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
        >
          <Text
            style={{
              color: "#ffffff",
              fontSize: 18,
              fontWeight: "600",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            {i18n.t("common.startupFailed", "Не удалось запустить приложение")}
          </Text>
          <Text style={{ color: "#fca5a5", fontSize: 14, textAlign: "center" }}>
            {startupError}
          </Text>
        </View>
      </View>
    );
  }

  if (!ready || !fontsLoaded || initialThemeMode === null) {
    return (
      <View
        onLayout={hideNativeSplash}
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: systemColorScheme === "dark" ? "#000000" : "#FFFFFF",
        }}
      >
        <AnimatedNarraFace width={56} height={58} color="#A1A1A1" animated={false} />
      </View>
    );
  }

  return (
    <View
      onLayout={hideNativeSplash}
      style={{
        flex: 1,
        backgroundColor: systemColorScheme === "dark" ? "#000000" : "#FFFFFF",
      }}
    >
      <I18nextProvider i18n={i18n}>
        <ThemeProvider initialMode={initialThemeMode}>
          {/* PanelUI пока обслуживает только чат. Его тему свяжем с нашей
              отдельным шагом — сейчас он работает на своей палитре. */}
          {/* background={false}: фон страницы мы красим сами, иначе PanelUI
              положит поверх свой. */}
          <PanelUIProvider background={false}>
            <PanelUIThemeBridge />
            <AppInner />
          </PanelUIProvider>
        </ThemeProvider>
      </I18nextProvider>
    </View>
  );
}

function AppInner() {
  const { colors, isDark } = useTheme();
  const loadBooks = useLibraryStore((s) => s.loadBooks);
  useUpdateChecker();
  useAutoSync(loadBooks);

  const toastBackground =
    Platform.OS === "ios" && isLiquidGlassAvailable() ? (
      <GlassView
        colorScheme={isDark ? "dark" : "light"}
        glassEffectStyle="regular"
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
    ) : undefined;

  const navTheme = useMemo(
    () => ({
      ...(isDark ? DarkTheme : DefaultTheme),
      colors: {
        ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
        background: colors.background,
        card: colors.card,
        text: colors.foreground,
        border: colors.border,
        primary: colors.primary,
      },
    }),
    [colors, isDark],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <CatalogCharacterPortraitPreloader />
        {Platform.OS !== "ios" && <StatusBar style={isDark ? "light" : "dark"} />}
        <ReaderTOCSheetProvider>
          <NavigationContainer theme={navTheme} ref={navigationRef}>
            <RootNavigator />
          </NavigationContainer>
        </ReaderTOCSheetProvider>
        <UpdateDialog />
        <Toaster
          theme={isDark ? "dark" : "light"}
          position="top-center"
          duration={4000}
          visibleToasts={2}
          enableStacking
          richColors={false}
          animation={TOAST_ANIMATION}
          swipeToDismissDirection="horizontal"
          backgroundComponent={toastBackground}
          icons={{
            success: <ToastIcon name="check-circle" color={colors.primary60} />,
            error: <ToastIcon name="x-hexagon" color={colors.primary60} />,
            warning: <ToastIcon name="exclamation-triangle" color={colors.primary60} />,
            info: <ToastIcon name="exclamation-circle" color={colors.primary60} />,
            loading: <ToastLoadingIcon color={colors.primary60} />,
          }}
          toastOptions={{
            style: {
              backgroundColor: colors.card,
              borderRadius: 24,
              borderCurve: "continuous",
              paddingHorizontal: 20,
            },
            titleStyle: {
              color: colors.cardForeground,
              fontFamily: interfaceFontFamily.regular,
              fontSize: 16,
              fontWeight: "400",
            },
            descriptionStyle: {
              display: "none",
            },
            toastContentStyle: {
              alignItems: "center",
            },
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ToastIcon({
  name,
  color,
}: {
  name: MishanaerIconName;
  color: string;
}) {
  return (
    <View pointerEvents="none" style={styles.toastIcon}>
      <MishanaerIcon name={name} size={24} color={color} />
    </View>
  );
}

function ToastLoadingIcon({ color }: { color: string }) {
  return (
    <View pointerEvents="none" style={styles.toastIcon}>
      <AnimatedNarraFace width={23} height={24} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  toastIcon: {
    alignItems: "center",
    flexShrink: 0,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
});
