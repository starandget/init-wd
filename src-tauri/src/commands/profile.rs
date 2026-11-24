use crate::commands::env::{home_dir, icloud_starbox_dir};
use crate::models::{AppItem, StarBoxProfile};
use chrono::Utc;
use std::path::PathBuf;

fn profile_path() -> PathBuf {
    home_dir()
        .join("Library/Application Support/com.starandget.starbox")
        .join("profile.json")
}

pub fn default_profile() -> StarBoxProfile {
    StarBoxProfile {
        version: 1,
        updated_at: Utc::now().to_rfc3339(),
        mirror_preset: "tsinghua".to_string(),
        install_concurrency: 5,
        groups: vec![
            "网络与日常".to_string(),
            "AI 助手".to_string(),
            "开发与沟通".to_string(),
            "命令行工具".to_string(),
            "游戏与娱乐".to_string(),
            "系统监控".to_string(),
        ],
        apps: vec![
            AppItem {
                id: "terminal".into(),
                name: "终端".into(),
                group: "网络与日常".into(),
                description: Some("macOS 系统自带终端（仅用于 Dock 排列）".into()),
                kind: "system".into(),
                brew_casks: vec![],
                brew_formula: None,
                github_repo: None,
                website: None,
                dock_apps: vec!["/System/Applications/Utilities/Terminal.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "clash-verge-rev".into(),
                name: "Clash Verge Rev".into(),
                group: "网络与日常".into(),
                description: Some("基于 Tauri 的现代化网络代理客户端".into()),
                kind: "cask".into(),
                brew_casks: vec!["clash-verge-rev".into()],
                brew_formula: None,
                github_repo: Some("clash-verge-rev/clash-verge-rev".into()),
                website: Some("https://github.com/clash-verge-rev/clash-verge-rev/releases".into()),
                dock_apps: vec!["Clash Verge.app".into(), "Clash Verge Rev.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "yuque".into(),
                name: "语雀".into(),
                group: "网络与日常".into(),
                description: Some("文档与知识库协作工具".into()),
                kind: "cask".into(),
                brew_casks: vec!["yuque".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.yuque.com/download".into()),
                dock_apps: vec!["语雀.app".into(), "Yuque.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "google-chrome".into(),
                name: "Google Chrome".into(),
                group: "网络与日常".into(),
                description: Some("主流跨平台网页浏览器".into()),
                kind: "cask".into(),
                brew_casks: vec!["google-chrome".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.google.com/chrome/".into()),
                dock_apps: vec!["Google Chrome.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "snipaste".into(),
                name: "Snipaste".into(),
                group: "网络与日常".into(),
                description: Some("高效截图与贴图工具（常驻菜单栏）".into()),
                kind: "cask".into(),
                brew_casks: vec!["snipaste".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.snipaste.com/download.html".into()),
                dock_apps: vec![],
                icon_url: None,
            },
            AppItem {
                id: "chatgpt".into(),
                name: "ChatGPT".into(),
                group: "AI 助手".into(),
                description: Some("OpenAI 官方 macOS 桌面客户端".into()),
                kind: "cask".into(),
                brew_casks: vec!["chatgpt".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://openai.com/chatgpt/download/".into()),
                dock_apps: vec!["ChatGPT.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "antigravity".into(),
                name: "Google Antigravity".into(),
                group: "AI 助手".into(),
                description: Some("Google AI 编程与智能体工作台".into()),
                kind: "cask".into(),
                brew_casks: vec!["antigravity".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://antigravity.google/download".into()),
                dock_apps: vec!["Antigravity.app".into(), "Google Antigravity.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "workbuddy".into(),
                name: "WorkBuddy".into(),
                group: "AI 助手".into(),
                description: Some("AI 办公协作助手".into()),
                kind: "cask".into(),
                brew_casks: vec!["workbuddy-cn".into(), "workbuddy-ai".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.workbuddy.ai/".into()),
                dock_apps: vec!["WorkBuddy.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "trae".into(),
                name: "Trae".into(),
                group: "AI 助手".into(),
                description: Some("AI 原生代码编辑器".into()),
                kind: "cask".into(),
                brew_casks: vec!["trae".into(), "trae-cn".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.trae.ai/download".into()),
                dock_apps: vec!["Trae.app".into(), "Trae CN.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "yuanbao".into(),
                name: "元宝".into(),
                group: "AI 助手".into(),
                description: Some("腾讯混元 AI 桌面助手".into()),
                kind: "cask".into(),
                brew_casks: vec!["yuanbao".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://yuanbao.tencent.com/download".into()),
                dock_apps: vec!["元宝.app".into(), "Yuanbao.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "github-desktop".into(),
                name: "GitHub Desktop".into(),
                group: "开发与沟通".into(),
                description: Some("可视化 Git 仓库管理工具".into()),
                kind: "cask".into(),
                brew_casks: vec!["github".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://desktop.github.com/".into()),
                dock_apps: vec!["GitHub Desktop.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "sublime-text".into(),
                name: "Sublime Text".into(),
                group: "开发与沟通".into(),
                description: Some("轻量高速文本与代码编辑器".into()),
                kind: "cask".into(),
                brew_casks: vec!["sublime-text".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.sublimetext.com/download".into()),
                dock_apps: vec!["Sublime Text.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "openidea".into(),
                name: "OpenIDEA".into(),
                group: "开发与沟通".into(),
                description: Some("来自 GitHub Releases 的开源 IDE 助手".into()),
                kind: "github".into(),
                brew_casks: vec![],
                brew_formula: None,
                github_repo: Some("l0ng-ai/openidea".into()),
                website: Some("https://github.com/l0ng-ai/openidea/releases".into()),
                dock_apps: vec!["OpenIDEA.app".into(), "openidea.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "jetbrains-toolbox".into(),
                name: "JetBrains Toolbox".into(),
                group: "开发与沟通".into(),
                description: Some("JetBrains 全家桶安装与版本管理器".into()),
                kind: "cask".into(),
                brew_casks: vec!["jetbrains-toolbox".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://www.jetbrains.com/toolbox-app/".into()),
                dock_apps: vec![],
                icon_url: None,
            },
            AppItem {
                id: "wechat".into(),
                name: "微信".into(),
                group: "开发与沟通".into(),
                description: Some("微信 macOS 桌面版".into()),
                kind: "cask".into(),
                brew_casks: vec!["wechat".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://mac.weixin.qq.com/".into()),
                dock_apps: vec!["WeChat.app".into(), "微信.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "neteasemusic".into(),
                name: "网易云音乐".into(),
                group: "开发与沟通".into(),
                description: Some("网易云音乐 macOS 客户端".into()),
                kind: "cask".into(),
                brew_casks: vec!["neteasemusic".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://music.163.com/#/download".into()),
                dock_apps: vec!["NeteaseMusic.app".into(), "网易云音乐.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "cli-gh".into(),
                name: "GitHub CLI (gh)".into(),
                group: "命令行工具".into(),
                description: Some("GitHub 官方命令行工具".into()),
                kind: "formula".into(),
                brew_casks: vec![],
                brew_formula: Some("gh".into()),
                github_repo: None,
                website: Some("https://cli.github.com/".into()),
                dock_apps: vec![],
                icon_url: None,
            },
            AppItem {
                id: "steam".into(),
                name: "Steam".into(),
                group: "游戏与娱乐".into(),
                description: Some("Steam 游戏平台".into()),
                kind: "cask".into(),
                brew_casks: vec!["steam".into()],
                brew_formula: None,
                github_repo: None,
                website: Some("https://store.steampowered.com/about/".into()),
                dock_apps: vec!["Steam.app".into()],
                icon_url: None,
            },
            AppItem {
                id: "activity-monitor".into(),
                name: "活动监视器".into(),
                group: "系统监控".into(),
                description: Some("macOS 系统自带性能监控工具".into()),
                kind: "system".into(),
                brew_casks: vec![],
                brew_formula: None,
                github_repo: None,
                website: None,
                dock_apps: vec!["/System/Applications/Utilities/Activity Monitor.app".into()],
                icon_url: None,
            },
        ],
        dock_system_apps: vec![
            "/System/Applications/Apps.app,/System/Applications/Launchpad.app".into(),
            "/Applications/Safari.app".into(),
            "/System/Applications/Photos.app".into(),
            "/System/Applications/Calendar.app".into(),
            "/System/Applications/Notes.app".into(),
            "/System/Applications/App Store.app".into(),
            "/System/Applications/System Settings.app,/System/Applications/System Preferences.app"
                .into(),
        ],
    }
}

#[tauri::command]
pub async fn load_profile() -> Result<StarBoxProfile, String> {
    let path = profile_path();
    if path.exists() {
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
        let mut profile: StarBoxProfile =
            serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?;
        profile.install_concurrency = profile.install_concurrency.clamp(1, 5);
        Ok(profile)
    } else {
        let def = default_profile();
        let _ = save_profile(def.clone()).await;
        Ok(def)
    }
}

#[tauri::command]
pub async fn save_profile(mut profile: StarBoxProfile) -> Result<StarBoxProfile, String> {
    profile.install_concurrency = profile.install_concurrency.clamp(1, 5);
    profile.updated_at = Utc::now().to_rfc3339();
    let path = profile_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&profile)
        .map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(profile)
}

#[tauri::command]
pub async fn reset_default_profile() -> Result<StarBoxProfile, String> {
    let def = default_profile();
    save_profile(def).await
}

#[tauri::command]
pub async fn export_profile_to_path(path: String, profile: StarBoxProfile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&profile)
        .map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("导出文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn import_profile_from_path(path: String) -> Result<StarBoxProfile, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let profile: StarBoxProfile =
        serde_json::from_str(&content).map_err(|e| format!("配置文件格式无效: {e}"))?;
    save_profile(profile).await
}

#[tauri::command]
pub async fn sync_profile_icloud(
    direction: String,
    profile: Option<StarBoxProfile>,
) -> Result<StarBoxProfile, String> {
    let dir = icloud_starbox_dir().ok_or_else(|| "未检测到本机 iCloud Drive 目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 iCloud 目录失败: {e}"))?;
    let file = dir.join("profile.json");

    match direction.as_str() {
        "push" => {
            let p = profile.ok_or_else(|| "缺少待同步的配置数据".to_string())?;
            let saved = save_profile(p).await?;
            let json = serde_json::to_string_pretty(&saved)
                .map_err(|e| format!("序列化失败: {e}"))?;
            std::fs::write(&file, json).map_err(|e| format!("写入 iCloud 失败: {e}"))?;
            Ok(saved)
        }
        "pull" => {
            if !file.exists() {
                return Err("iCloud 中还没有 Star Box 配置文件，请先上传".to_string());
            }
            let content =
                std::fs::read_to_string(&file).map_err(|e| format!("读取 iCloud 配置失败: {e}"))?;
            let imported: StarBoxProfile =
                serde_json::from_str(&content).map_err(|e| format!("iCloud 配置解析失败: {e}"))?;
            save_profile(imported).await
        }
        _ => Err("不支持的同步方向".to_string()),
    }
}
