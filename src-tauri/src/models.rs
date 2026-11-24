use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvStatus {
    pub arch: String,
    pub macos_version: String,
    pub xcode_clt_installed: bool,
    pub brew_installed: bool,
    pub brew_path: Option<String>,
    pub brew_version: Option<String>,
    pub mirror_preset: String,
    pub icloud_available: bool,
    pub icloud_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppItem {
    pub id: String,
    pub name: String,
    pub group: String,
    #[serde(default)]
    pub description: Option<String>,
    /// "cask" | "formula" | "github" | "direct" | "system"
    pub kind: String,
    #[serde(default)]
    pub brew_casks: Vec<String>,
    #[serde(default)]
    pub brew_formula: Option<String>,
    #[serde(default)]
    pub github_repo: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub dock_apps: Vec<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledInfo {
    pub id: String,
    pub installed: bool,
    pub via_brew: bool,
    pub app_path: Option<String>,
    pub outdated: bool,
    pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub token: String,
    pub name: String,
    pub desc: String,
    pub homepage: String,
    pub version: String,
    /// "cask" | "formula"
    pub kind: String,
    pub app_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubReleaseInfo {
    pub repo: String,
    pub tag_name: String,
    pub release_name: String,
    pub html_url: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgressEvent {
    pub task_id: String,
    pub app_id: String,
    pub stage: String,
    pub message: String,
    pub progress: Option<u8>,
    pub done: bool,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvLogEvent {
    pub line: String,
    pub done: bool,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockBackup {
    pub filename: String,
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockApplyResult {
    pub backup_path: String,
    pub added_count: usize,
    pub missing_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitFoldersResult {
    pub base_dir: String,
    pub created: Vec<String>,
    pub renamed: Vec<String>,
    pub existed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAppCandidate {
    pub id: String,
    pub name: String,
    pub app_name: String,
    pub app_path: String,
    pub brew_cask: Option<String>,
    pub outdated: bool,
    pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarBoxProfile {
    pub version: u32,
    pub updated_at: String,
    pub mirror_preset: String,
    pub groups: Vec<String>,
    pub apps: Vec<AppItem>,
    pub dock_system_apps: Vec<String>,
}
