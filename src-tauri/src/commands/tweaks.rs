use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGSMainConnectionID() -> i32;
    fn CGSSetSwipeScrollDirection(cid: i32, dir: bool);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacTweaksStatus {
    /// true = 自然滚动（触控板默认），false = 传统滚轮（外接鼠标推荐）
    pub natural_scroll: bool,
    /// true = 长按按键连续输入（关闭重音选字框），false = 系统默认长按弹重音框
    pub key_repeat: bool,
    /// Finder 显示隐藏文件
    pub show_hidden_files: bool,
    /// Finder 显示所有文件扩展名
    pub show_all_extensions: bool,
    /// Finder 显示底部路径栏与状态栏
    pub finder_bars: bool,
    /// 禁止在网络盘和 U 盘生成 .DS_Store
    pub no_ds_store: bool,
    /// Dock 自动隐藏且零延迟弹出
    pub dock_autohide_fast: bool,
    /// 窗口截图去除四周阴影
    pub screencapture_no_shadow: bool,
}

async fn read_defaults_bool(domain: &str, key: &str, default_val: bool) -> bool {
    let Ok(output) = Command::new("defaults")
        .args(["read", domain, key])
        .output()
        .await
    else {
        return default_val;
    };
    if !output.status.success() {
        return default_val;
    }
    let s = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase();
    match s.as_str() {
        "1" | "true" | "yes" => true,
        "0" | "false" | "no" => false,
        _ => default_val,
    }
}

async fn write_defaults_bool(domain: &str, key: &str, val: bool) -> Result<(), String> {
    let bool_str = if val { "true" } else { "false" };
    let status = Command::new("defaults")
        .args(["write", domain, key, "-bool", bool_str])
        .status()
        .await
        .map_err(|e| format!("执行 defaults write 失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("写入 {domain} {key} 失败"))
    }
}

#[tauri::command]
pub async fn get_mac_tweaks() -> Result<MacTweaksStatus, String> {
    let (
        natural_scroll,
        press_and_hold,
        show_hidden_files,
        show_all_extensions,
        pathbar,
        statusbar,
        no_net_ds,
        dock_autohide,
        screencapture_no_shadow,
    ) = tokio::join!(
        read_defaults_bool("-g", "com.apple.swipescrolldirection", true),
        read_defaults_bool("-g", "ApplePressAndHoldEnabled", true),
        read_defaults_bool("com.apple.finder", "AppleShowAllFiles", false),
        read_defaults_bool("-g", "AppleShowAllExtensions", false),
        read_defaults_bool("com.apple.finder", "ShowPathbar", false),
        read_defaults_bool("com.apple.finder", "ShowStatusBar", false),
        read_defaults_bool(
            "com.apple.desktopservices",
            "DSDontWriteNetworkStores",
            false
        ),
        read_defaults_bool("com.apple.dock", "autohide", false),
        read_defaults_bool("com.apple.screencapture", "disable-shadow", false),
    );

    Ok(MacTweaksStatus {
        natural_scroll,
        key_repeat: !press_and_hold,
        show_hidden_files,
        show_all_extensions,
        finder_bars: pathbar && statusbar,
        no_ds_store: no_net_ds,
        dock_autohide_fast: dock_autohide,
        screencapture_no_shadow,
    })
}

#[tauri::command]
pub async fn set_mac_tweak(key: String, enabled: bool) -> Result<MacTweaksStatus, String> {
    match key.as_str() {
        "natural_scroll" => {
            write_defaults_bool("-g", "com.apple.swipescrolldirection", enabled).await?;
            #[cfg(target_os = "macos")]
            unsafe {
                let cid = CGSMainConnectionID();
                CGSSetSwipeScrollDirection(cid, enabled);
            }
        }
        "key_repeat" => {
            // enabled = true means continuous key repeat -> ApplePressAndHoldEnabled = false
            write_defaults_bool("-g", "ApplePressAndHoldEnabled", !enabled).await?;
        }
        "show_hidden_files" => {
            write_defaults_bool("com.apple.finder", "AppleShowAllFiles", enabled).await?;
            let _ = Command::new("killall").arg("Finder").status().await;
        }
        "show_all_extensions" => {
            write_defaults_bool("-g", "AppleShowAllExtensions", enabled).await?;
            let _ = Command::new("killall").arg("Finder").status().await;
        }
        "finder_bars" => {
            write_defaults_bool("com.apple.finder", "ShowPathbar", enabled).await?;
            write_defaults_bool("com.apple.finder", "ShowStatusBar", enabled).await?;
            let _ = Command::new("killall").arg("Finder").status().await;
        }
        "no_ds_store" => {
            write_defaults_bool(
                "com.apple.desktopservices",
                "DSDontWriteNetworkStores",
                enabled,
            )
            .await?;
            write_defaults_bool("com.apple.desktopservices", "DSDontWriteUSBStores", enabled)
                .await?;
        }
        "dock_autohide_fast" => {
            write_defaults_bool("com.apple.dock", "autohide", enabled).await?;
            if enabled {
                let _ = Command::new("defaults")
                    .args(["write", "com.apple.dock", "autohide-delay", "-float", "0"])
                    .status()
                    .await;
                let _ = Command::new("defaults")
                    .args([
                        "write",
                        "com.apple.dock",
                        "autohide-time-modifier",
                        "-float",
                        "0.35",
                    ])
                    .status()
                    .await;
            } else {
                let _ = Command::new("defaults")
                    .args(["delete", "com.apple.dock", "autohide-delay"])
                    .status()
                    .await;
                let _ = Command::new("defaults")
                    .args(["delete", "com.apple.dock", "autohide-time-modifier"])
                    .status()
                    .await;
            }
            let _ = Command::new("killall").arg("Dock").status().await;
        }
        "screencapture_no_shadow" => {
            write_defaults_bool("com.apple.screencapture", "disable-shadow", enabled).await?;
            let _ = Command::new("killall")
                .arg("SystemUIServer")
                .status()
                .await;
        }
        _ => return Err(format!("未知的设置项: {key}")),
    }

    get_mac_tweaks().await
}

#[tauri::command]
pub async fn open_system_pane(pane: String) -> Result<(), String> {
    let url = match pane.as_str() {
        "mouse" => "x-apple.systempreferences:com.apple.Mouse-Settings.extension",
        "trackpad" => "x-apple.systempreferences:com.apple.Trackpad-Settings.extension",
        "keyboard" => "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
        "displays" => "x-apple.systempreferences:com.apple.Displays-Settings.extension",
        "privacy" => "x-apple.systempreferences:com.apple.preference.security",
        "login_items" => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        "network" => "x-apple.systempreferences:com.apple.Network-Settings.extension",
        "sound" => "x-apple.systempreferences:com.apple.Sound-Settings.extension",
        _ => "x-apple.systempreferences:",
    };

    let status = Command::new("open")
        .arg(url)
        .status()
        .await
        .map_err(|e| format!("打开系统设置失败: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("调用系统设置面板失败".to_string())
    }
}
