import { getFilledIconImageSource, getStrokeIconImageSource } from "@/components/ui/MishanaerIcon";
import { NativeButton } from "@/components/ui/NativeButton";
import { SyncButton } from "@/components/ui/SyncButton";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { LibraryScreen } from "@/screens/LibraryScreen";
import { NotesScreen } from "@/screens/NotesScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { ReadingTabScreen } from "@/screens/ReadingTabScreen";
import { SearchScreen } from "@/screens/SearchScreen";
import { useTheme } from "@/styles/ThemeContext";
import {
  fontFamily,
  largeTitleFontFamily,
  largeTitleFontSize,
  titleFontFamily,
} from "@/styles/theme";
import {
  type NativeBottomTabIcon,
  createNativeBottomTabNavigator,
} from "@react-navigation/bottom-tabs/unstable";
import type { NavigatorScreenParams } from "@react-navigation/native";
import {
  type NativeStackNavigationOptions,
  createNativeStackNavigator,
} from "@react-navigation/native-stack";
import { useSyncStore } from "@readany/core/stores";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { NATIVE_SCROLL_EDGE_EFFECTS } from "./scroll-edge-effects";

export type LibraryTabStackParamList = {
  LibraryHome: { initialSection?: "catalog" | "my-books" } | undefined;
};
export type ReadingTabStackParamList = { ReadingHome: undefined };
export type ChatsTabStackParamList = { ChatsHome: undefined };
export type ProfileTabStackParamList = {
  ProfileHome: undefined;
  ProfileNotes: { bookId?: string } | undefined;
  ProfileSearch: undefined;
};
export type TabParamList = {
  Library: NavigatorScreenParams<LibraryTabStackParamList> | undefined;
  Reading: undefined;
  Chats: undefined;
  Profile: NavigatorScreenParams<ProfileTabStackParamList> | undefined;
};

const Tab = createNativeBottomTabNavigator<TabParamList>();
const LibraryStack = createNativeStackNavigator<LibraryTabStackParamList>();
const ReadingStack = createNativeStackNavigator<ReadingTabStackParamList>();
const ChatsStack = createNativeStackNavigator<ChatsTabStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileTabStackParamList>();

const TAB_ICONS = {
  Library: getFilledIconImageSource("book"),
  Reading: getStrokeIconImageSource("book-open"),
  Chats: getFilledIconImageSource("chat-bubbles"),
  Profile: getFilledIconImageSource("person"),
} as const;

function tabIcon(source: (typeof TAB_ICONS)[keyof typeof TAB_ICONS]): NativeBottomTabIcon {
  return { type: "image", source };
}

function useTabStackScreenOptions(): NativeStackNavigationOptions {
  const { colors, isDark } = useTheme();

  return {
    headerShown: true,
    statusBarHidden: false,
    statusBarStyle: isDark ? "light" : "dark",
    headerTransparent: Platform.OS === "ios",
    headerStyle: {
      backgroundColor: Platform.OS === "ios" ? "transparent" : colors.background,
    },
    headerShadowVisible: false,
    headerTintColor: colors.foreground,
    headerTitleStyle: {
      color: colors.foreground,
      fontFamily: titleFontFamily,
      fontWeight: "600",
    },
    scrollEdgeEffects: NATIVE_SCROLL_EDGE_EFFECTS,
    contentStyle: { backgroundColor: colors.background },
  };
}

/** iOS large-title options shared by the tab stack home screens. */
export function useLargeTitleOptions(): NativeStackNavigationOptions {
  const { colors } = useTheme();

  return Platform.OS === "ios"
    ? {
        headerLargeTitleEnabled: true,
        headerLargeTitleShadowVisible: false,
        headerLargeTitleStyle: {
          color: colors.foreground,
          fontFamily: largeTitleFontFamily,
          fontSize: largeTitleFontSize,
          fontWeight: "400",
        },
      }
    : {};
}

function LibraryTabStackNavigator() {
  const { t } = useTranslation();
  const screenOptions = useTabStackScreenOptions();
  const largeTitleOptions = useLargeTitleOptions();

  return (
    <LibraryStack.Navigator screenOptions={screenOptions}>
      <LibraryStack.Screen
        name="LibraryHome"
        component={LibraryScreen}
        options={{
          title: t("tabs.library", "Библиотека"),
          ...largeTitleOptions,
        }}
      />
    </LibraryStack.Navigator>
  );
}

function ReadingTabStackNavigator() {
  const { t } = useTranslation();
  const screenOptions = useTabStackScreenOptions();
  const largeTitleOptions = useLargeTitleOptions();

  return (
    <ReadingStack.Navigator screenOptions={screenOptions}>
      <ReadingStack.Screen
        name="ReadingHome"
        component={ReadingTabScreen}
        options={{
          title: t("tabs.reading", "Читалка"),
          ...largeTitleOptions,
        }}
      />
    </ReadingStack.Navigator>
  );
}

function ChatsTabStackNavigator() {
  const { t } = useTranslation();
  const screenOptions = useTabStackScreenOptions();
  const largeTitleOptions = useLargeTitleOptions();

  return (
    <ChatsStack.Navigator screenOptions={screenOptions}>
      <ChatsStack.Screen
        name="ChatsHome"
        component={ChatsScreen}
        options={{
          title: t("tabs.myPath", "Мой путь"),
          ...largeTitleOptions,
        }}
      />
    </ChatsStack.Navigator>
  );
}

function ProfileTabStackNavigator() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const screenOptions = useTabStackScreenOptions();
  const largeTitleOptions = useLargeTitleOptions();
  const syncNow = useSyncStore((state) => state.syncNow);
  const syncStatus = useSyncStore((state) => state.status);
  const syncBackendType = useSyncStore((state) => state.backendType);
  const loadSyncConfig = useSyncStore((state) => state.loadConfig);
  const isSyncBusy = syncStatus !== "idle" && syncStatus !== "error";

  useEffect(() => {
    if (!syncBackendType) void loadSyncConfig();
  }, [loadSyncConfig, syncBackendType]);

  const handleSync = useCallback(() => {
    if (!isSyncBusy) void syncNow();
  }, [isSyncBusy, syncNow]);

  return (
    <ProfileStack.Navigator screenOptions={screenOptions}>
      <ProfileStack.Screen
        name="ProfileHome"
        component={ProfileScreen}
        options={{
          title: t("tabs.profile", "Профиль"),
          ...largeTitleOptions,
          ...(Platform.OS === "ios"
            ? {
                unstable_headerRightItems: () =>
                  syncBackendType
                    ? [
                        {
                          type: "button" as const,
                          label: t("common.sync", "Синхронизировать"),
                          accessibilityLabel: t("common.sync", "Синхронизировать"),
                          icon: {
                            type: "image" as const,
                            source: getStrokeIconImageSource("repeat"),
                          },
                          disabled: isSyncBusy,
                          onPress: handleSync,
                        },
                      ]
                    : [],
              }
            : {
                headerRight: () => <SyncButton size={20} color={colors.mutedForeground} />,
              }),
        }}
      />
      <ProfileStack.Screen
        name="ProfileSearch"
        component={SearchScreen}
        options={{
          title: t("tabs.search", "Поиск"),
          headerTitle: "",
          headerLargeTitleEnabled: false,
        }}
      />
      <ProfileStack.Screen
        name="ProfileNotes"
        component={NotesScreen}
        options={({ navigation }) => ({
          title: t("tabs.notes", "Заметки"),
          ...(Platform.OS === "ios"
            ? {
                unstable_headerRightItems: () => [
                  {
                    type: "button" as const,
                    label: t("notes.addNote", "Добавить заметку"),
                    accessibilityLabel: t("notes.addNote", "Добавить заметку"),
                    icon: {
                      type: "image" as const,
                      source: getStrokeIconImageSource("plus"),
                    },
                    onPress: () =>
                      navigation
                        .getParent()
                        ?.getParent()
                        ?.navigate("ManualNote" as never),
                  },
                ],
              }
            : {
                headerRight: () => (
                  <NativeButton
                    label={t("common.add", "Добавить")}
                    accessibilityLabel={t("notes.addNote", "Добавить заметку")}
                    icon="add"
                    size="small"
                    variant="tertiary"
                    onPress={() =>
                      navigation
                        .getParent()
                        ?.getParent()
                        ?.navigate("ManualNote" as never)
                    }
                  />
                ),
              }),
        })}
      />
    </ProfileStack.Navigator>
  );
}

export function TabNavigator() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.primary80,
        tabBarLabelVisibilityMode: "labeled",
        tabBarLabelStyle: { fontFamily: fontFamily.regular },
        tabBarStyle: Platform.OS === "ios" ? undefined : { backgroundColor: colors.background },
        tabBarBlurEffect: "systemDefault",
        tabBarControllerMode: "auto",
        tabBarMinimizeBehavior: "none",
      }}
    >
      <Tab.Screen
        name="Library"
        component={LibraryTabStackNavigator}
        options={{
          title: t("tabs.library", "Библиотека"),
          tabBarLabel: t("tabs.library", "Библиотека"),
          tabBarIcon: tabIcon(TAB_ICONS.Library),
        }}
      />
      <Tab.Screen
        name="Reading"
        component={ReadingTabStackNavigator}
        options={{
          title: t("tabs.reading", "Читалка"),
          tabBarLabel: t("tabs.reading", "Читалка"),
          tabBarIcon: tabIcon(TAB_ICONS.Reading),
        }}
      />
      <Tab.Screen
        name="Chats"
        component={ChatsTabStackNavigator}
        options={{
          title: t("tabs.myPath", "Мой путь"),
          tabBarLabel: t("tabs.myPath", "Мой путь"),
          tabBarIcon: tabIcon(TAB_ICONS.Chats),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileTabStackNavigator}
        options={{
          title: t("tabs.profile", "Профиль"),
          tabBarLabel: t("tabs.profile", "Профиль"),
          tabBarIcon: tabIcon(TAB_ICONS.Profile),
          tabBarMinimizeBehavior: "none",
        }}
      />
    </Tab.Navigator>
  );
}
