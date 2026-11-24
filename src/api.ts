import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppItem,
  CatalogEntry,
  DockApplyResult,
  DockBackup,
  EnvStatus,
  GitHubReleaseInfo,
  InstalledInfo,
  StarBoxProfile,
} from "./types";

export const api = {
  getEnvStatus: () => invoke<EnvStatus>("get_env_status"),
  setBrewMirror: (preset: string) => invoke<string>("set_brew_mirror", { preset }),
  installHomebrew: (mirrorPreset: string) =>
    invoke<void>("install_homebrew", { mirrorPreset }),
  cancelHomebrewInstall: () => invoke<void>("cancel_homebrew_install"),
  getAutostartEnabled: () => invoke<boolean>("get_autostart_enabled"),
  setAutostartEnabled: (enabled: boolean) =>
    invoke<boolean>("set_autostart_enabled", { enabled }),
  checkAppUpdate: () =>
    invoke<import("./types").UpdateCheckResult>("check_app_update"),
  initWorkspaceFolders: (folders: string[]) =>
    invoke<import("./types").InitFoldersResult>("init_workspace_folders", {
      folders,
    }),

  searchBrewCatalog: (
    query: string,
    kind: string = "all",
    limit: number = 40,
    forceRefresh: boolean = false
  ) =>
    invoke<CatalogEntry[]>("search_brew_catalog", {
      query,
      kind,
      limit,
      forceRefresh,
    }),

  inspectGithubRepo: (repoInput: string) =>
    invoke<GitHubReleaseInfo>("inspect_github_repo", { repoInput }),

  fetchFeaturedCatalog: (forceRefresh: boolean = false) =>
    invoke<import("./types").FeaturedCatalog>("fetch_featured_catalog", {
      forceRefresh,
    }),

  scanInstalledApps: (apps: AppItem[]) =>
    invoke<InstalledInfo[]>("scan_installed_apps", { apps }),

  installApp: (taskId: string, item: AppItem, mirrorPreset: string) =>
    invoke<void>("install_app", { taskId, item, mirrorPreset }),

  upgradeApp: (taskId: string, item: AppItem, mirrorPreset: string) =>
    invoke<void>("upgrade_app", { taskId, item, mirrorPreset }),

  uninstallApp: (taskId: string, item: AppItem) =>
    invoke<void>("uninstall_app", { taskId, item }),

  cancelInstallTask: (taskId: string) =>
    invoke<void>("cancel_install_task", { taskId }),

  openInstalledApp: (appPath: string) =>
    invoke<void>("open_installed_app", { appPath }),

  discoverLocalApps: () =>
    invoke<import("./types").LocalAppCandidate[]>("discover_local_apps"),

  listDockBackups: () => invoke<DockBackup[]>("list_dock_backups"),

  applyDockLayout: (
    groups: string[],
    apps: AppItem[],
    systemApps: string[]
  ) =>
    invoke<DockApplyResult>("apply_dock_layout", {
      groups,
      apps,
      systemApps,
    }),

  restoreDockBackup: (backupPath: string) =>
    invoke<void>("restore_dock_backup", { backupPath }),

  loadProfile: () => invoke<StarBoxProfile>("load_profile"),
  saveProfile: (profile: StarBoxProfile) =>
    invoke<StarBoxProfile>("save_profile", { profile }),
  resetDefaultProfile: () => invoke<StarBoxProfile>("reset_default_profile"),

  exportProfileDialog: async (profile: StarBoxProfile): Promise<string | null> => {
    const path = await saveDialog({
      title: "导出 Star Box 配置文件",
      defaultPath: "starbox-profile.json",
      filters: [{ name: "Star Box 配置", extensions: ["json"] }],
    });
    if (!path) return null;
    await invoke<void>("export_profile_to_path", { path, profile });
    return path;
  },

  importProfileDialog: async (): Promise<StarBoxProfile | null> => {
    const selected = await openDialog({
      title: "导入 Star Box 配置文件",
      multiple: false,
      filters: [{ name: "Star Box 配置", extensions: ["json"] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return invoke<StarBoxProfile>("import_profile_from_path", { path: selected });
  },

  syncProfileIcloud: (direction: "push" | "pull", profile?: StarBoxProfile) =>
    invoke<StarBoxProfile>("sync_profile_icloud", {
      direction,
      profile: profile ?? null,
    }),

  getProxyConfig: () =>
    invoke<import("./types").ProxyConfig>("get_proxy_config"),
  setProxyConfig: (enabled: boolean, url: string | null) =>
    invoke<import("./types").ProxyConfig>("set_proxy_config", { enabled, url }),
  testProxy: (url: string) =>
    invoke<import("./types").ProxyTestResult>("test_proxy", { url }),
  discoverLanProxies: () =>
    invoke<import("./types").DiscoveredProxy[]>("discover_lan_proxies"),

  getMacTweaks: () =>
    invoke<import("./types").MacTweaksStatus>("get_mac_tweaks"),
  setMacTweak: (key: import("./types").MacTweakKey, enabled: boolean) =>
    invoke<import("./types").MacTweaksStatus>("set_mac_tweak", {
      key,
      enabled,
    }),
  openSystemPane: (pane: string) =>
    invoke<void>("open_system_pane", { pane }),

  openExternal: async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  },
};
