use crate::commands::env::home_dir;
use crate::commands::installer::find_existing_app;
use crate::models::{AppItem, DockApplyResult, DockBackup};
use chrono::{DateTime, Local};
use std::path::PathBuf;
use tokio::process::Command;

const MAX_DOCK_BACKUPS: usize = 5;

fn backup_dir() -> PathBuf {
    home_dir()
        .join("Library/Application Support/com.starandget.starbox")
        .join("dock-backups")
}

fn prune_old_backups(dir: &PathBuf, max_keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("plist") {
                return None;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, p))
        })
        .collect();

    if files.len() <= max_keep {
        return;
    }
    // Newest first
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, old_path) in files.into_iter().skip(max_keep) {
        let _ = std::fs::remove_file(old_path);
    }
}

#[tauri::command]
pub async fn list_dock_backups() -> Result<Vec<DockBackup>, String> {
    let mut backups = Vec::new();

    // App-managed backups
    let dir = backup_dir();
    if dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("plist") {
                    if let Ok(meta) = entry.metadata() {
                        let created = meta
                            .modified()
                            .ok()
                            .map(|t| DateTime::<Local>::from(t).format("%Y-%m-%d %H:%M:%S").to_string())
                            .unwrap_or_default();
                        backups.push(DockBackup {
                            filename: entry.file_name().to_string_lossy().to_string(),
                            path: p.to_string_lossy().to_string(),
                            created_at: created,
                            size_bytes: meta.len(),
                        });
                    }
                }
            }
        }
    }

    // Legacy backups from 00-mac-setup.sh in ~/dock-backup-*.plist
    let home = home_dir();
    if let Ok(entries) = std::fs::read_dir(&home) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("dock-backup-") && name.ends_with(".plist") {
                if let Ok(meta) = entry.metadata() {
                    let created = meta
                        .modified()
                        .ok()
                        .map(|t| DateTime::<Local>::from(t).format("%Y-%m-%d %H:%M:%S").to_string())
                        .unwrap_or_default();
                    backups.push(DockBackup {
                        filename: format!("{name} (脚本备份)"),
                        path: entry.path().to_string_lossy().to_string(),
                        created_at: created,
                        size_bytes: meta.len(),
                    });
                }
            }
        }
    }

    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    backups.truncate(MAX_DOCK_BACKUPS);
    Ok(backups)
}

async fn dock_add_app(app_path: &str) -> Result<(), String> {
    // Resolve symlinks (e.g. /Applications/Safari.app -> Cryptexes real bundle)
    // so macOS Dock stores the actual .app bundle instead of an alias with a corner arrow.
    let resolved_path = std::fs::canonicalize(app_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| app_path.to_string());
    let xml = format!(
        "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>{resolved_path}</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
    );
    let st = Command::new("defaults")
        .args(["write", "com.apple.dock", "persistent-apps", "-array-add", &xml])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("写入 Dock 失败: {resolved_path}"))
    }
}

async fn dock_add_spacer() -> Result<(), String> {
    let xml = "<dict><key>tile-data</key><dict/><key>tile-type</key><string>small-spacer-tile</string></dict>";
    let _ = Command::new("defaults")
        .args(["write", "com.apple.dock", "persistent-apps", "-array-add", xml])
        .status()
        .await;
    Ok(())
}

#[tauri::command]
pub async fn apply_dock_layout(
    groups: Vec<String>,
    apps: Vec<AppItem>,
    system_apps: Vec<String>,
) -> Result<DockApplyResult, String> {
    let dir = backup_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let backup_path = dir.join(format!("dock-backup-{stamp}.plist"));
    let backup_str = backup_path.to_string_lossy().to_string();

    let export = Command::new("defaults")
        .args(["export", "com.apple.dock", &backup_str])
        .status()
        .await
        .map_err(|e| format!("备份 Dock 失败: {e}"))?;

    if !export.success() {
        return Err("备份当前 Dock 配置失败，已中止操作".to_string());
    }

    // Keep only the latest 5 backups on disk
    prune_old_backups(&dir, MAX_DOCK_BACKUPS);

    // Clear left app section only (preserve right-side folders/trash)
    let _ = Command::new("defaults")
        .args(["write", "com.apple.dock", "persistent-apps", "-array"])
        .status()
        .await;

    let mut added_count = 0usize;
    let mut last_spacer = false;
    let mut missing_apps = Vec::new();

    for sys in &system_apps {
        if let Some(found) = find_existing_app(std::slice::from_ref(sys)) {
            if dock_add_app(&found).await.is_ok() {
                added_count += 1;
                last_spacer = false;
            }
        }
    }

    for group in &groups {
        let group_apps: Vec<&AppItem> = apps
            .iter()
            .filter(|a| a.group == *group && !a.dock_apps.is_empty())
            .collect();
        if group_apps.is_empty() {
            continue;
        }

        if added_count > 0 && !last_spacer {
            let _ = dock_add_spacer().await;
            last_spacer = true;
        }

        for item in group_apps {
            if let Some(found) = find_existing_app(&item.dock_apps) {
                if dock_add_app(&found).await.is_ok() {
                    added_count += 1;
                    last_spacer = false;
                }
            } else {
                missing_apps.push(item.name.clone());
            }
        }
    }

    let _ = Command::new("killall").arg("Dock").status().await;

    Ok(DockApplyResult {
        backup_path: backup_str,
        added_count,
        missing_apps,
    })
}

#[tauri::command]
pub async fn restore_dock_backup(backup_path: String) -> Result<(), String> {
    let st = Command::new("defaults")
        .args(["import", "com.apple.dock", &backup_path])
        .status()
        .await
        .map_err(|e| format!("恢复 Dock 失败: {e}"))?;

    if !st.success() {
        return Err("导入 Dock 备份文件失败".to_string());
    }

    let _ = Command::new("killall").arg("Dock").status().await;
    Ok(())
}
