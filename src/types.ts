export interface EnvStatus {
  arch: string;
  macos_version: string;
  xcode_clt_installed: boolean;
  brew_installed: boolean;
  brew_path: string | null;
  brew_version: string | null;
  mirror_preset: "tsinghua" | "ustc" | "aliyun" | "official" | string;
  icloud_available: boolean;
  icloud_path: string | null;
}

export interface AppItem {
  id: string;
  name: string;
  group: string;
  description?: string | null;
  kind: "cask" | "formula" | "github" | "direct" | "system" | string;
  brew_casks: string[];
  brew_formula?: string | null;
  github_repo?: string | null;
  website?: string | null;
  dock_apps: string[];
  icon_url?: string | null;
}

export interface InstalledInfo {
  id: string;
  installed: boolean;
  via_brew: boolean;
  app_path: string | null;
  outdated: boolean;
  icon_data_url?: string | null;
}

export interface CatalogEntry {
  token: string;
  name: string;
  desc: string;
  homepage: string;
  version: string;
  kind: "cask" | "formula";
  app_name: string | null;
}

export interface FeaturedApp {
  id: string;
  name: string;
  region?: "cn" | "global";
  category: string;
  description: string;
  tags?: string[];
  kind: "cask" | "formula" | "github" | "direct";
  brew_casks?: string[];
  brew_formula?: string | null;
  github_repo?: string | null;
  website?: string | null;
  dock_apps?: string[];
  icon_url?: string | null;
}

export interface StarterPackGroup {
  group: string;
  apps: string[];
}

export interface FeaturedCatalog {
  version: number;
  updated_at: string;
  categories: string[];
  starter_pack?: StarterPackGroup[];
  apps: FeaturedApp[];
}

export interface GitHubReleaseInfo {
  repo: string;
  tag_name: string;
  release_name: string;
  html_url: string;
  asset_name: string | null;
  asset_url: string | null;
  asset_size: number | null;
}

export interface InstallProgressEvent {
  task_id: string;
  app_id: string;
  stage: string;
  message: string;
  progress: number | null;
  done: boolean;
  success: boolean;
  replace_last?: boolean;
}

export interface EnvLogEvent {
  line: string;
  done: boolean;
  success: boolean;
}

export interface DockBackup {
  filename: string;
  path: string;
  created_at: string;
  size_bytes: number;
}

export interface DockApplyResult {
  backup_path: string;
  added_count: number;
  missing_apps: string[];
}

export interface InitFoldersResult {
  base_dir: string;
  created: string[];
  renamed: string[];
  existed: string[];
}

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  release_url: string;
  download_url?: string | null;
  asset_name?: string | null;
  asset_size?: number | null;
  release_notes?: string | null;
}

export interface SelfUpdateProgressEvent {
  stage: string;
  message: string;
  progress: number;
  done: boolean;
  success: boolean;
}

export interface LocalAppCandidate {
  id: string;
  name: string;
  app_name: string;
  app_path: string;
  brew_cask: string | null;
  outdated?: boolean;
  icon_data_url?: string | null;
}

export interface ToastNotice {
  id: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface StarBoxProfile {
  version: number;
  updated_at: string;
  mirror_preset: string;
  install_concurrency?: number;
  groups: string[];
  apps: AppItem[];
  dock_system_apps: string[];
}

export type TaskStatus = "queued" | "running" | "success" | "error";

export interface InstallTask {
  task_id: string;
  app: AppItem;
  action: "install" | "upgrade" | "uninstall";
  status: TaskStatus;
  progress: number;
  stage: string;
  logs: string[];
  error?: string;
  proxy_url?: string | null;
}

export type ThemeMode = "light" | "warm" | "dark";

export type NavTab =
  | "env"
  | "proxy"
  | "lan_server"
  | "starter"
  | "discover"
  | "apps"
  | "dock"
  | "tweaks"
  | "theme"
  | "settings"
  | "queue";

export interface MacTweaksStatus {
  natural_scroll: boolean;
  key_repeat: boolean;
  show_hidden_files: boolean;
  show_all_extensions: boolean;
  finder_bars: boolean;
  no_ds_store: boolean;
  dock_autohide_fast: boolean;
  screencapture_no_shadow: boolean;
}

export type MacTweakKey = keyof MacTweaksStatus;

export interface ProxyConfig {
  enabled: boolean;
  url: string | null;
}

export interface DiscoveredProxy {
  url: string;
  host: string;
  port: number;
  protocol: string;
  source: "system" | "local" | "lan" | string;
  hint: string;
  latency_ms: number;
}

export interface ProxyTestResult {
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
}

export interface LanServerLogEntry {
  id: number;
  time: string;
  client_ip: string;
  method: string;
  path: string;
  status: number;
  detail: string | null;
}

export interface LanNoteItem {
  id: number;
  time: string;
  sender: string;
  text: string;
}

export interface LanServerStatus {
  running: boolean;
  root_dir: string | null;
  port: number;
  show_hidden: boolean;
  serve_index: boolean;
  allow_upload: boolean;
  urls: string[];
  primary_url: string | null;
  started_at: string | null;
  request_count: number;
  recent_logs: LanServerLogEntry[];
  notes: LanNoteItem[];
}
