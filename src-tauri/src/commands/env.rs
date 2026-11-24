use crate::models::{EnvLogEvent, EnvStatus, InitFoldersResult, UpdateCheckResult};
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

static BREW_INSTALL_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static BREW_INSTALL_CANCELLED: AtomicBool = AtomicBool::new(false);

fn brew_pid_slot() -> &'static Mutex<Option<u32>> {
    BREW_INSTALL_PID.get_or_init(|| Mutex::new(None))
}

pub fn kill_process_group(pid: u32) {
    let pgid = format!("-{pid}");
    let _ = std::process::Command::new("/bin/kill")
        .args(["-TERM", &pgid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = std::process::Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", &pgid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

pub fn find_brew_path() -> Option<String> {
    for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

pub fn mirror_env_vars(preset: &str) -> Vec<(&'static str, &'static str)> {
    match preset {
        "tsinghua" => vec![
            (
                "HOMEBREW_API_DOMAIN",
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api",
            ),
            (
                "HOMEBREW_BOTTLE_DOMAIN",
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles",
            ),
            (
                "HOMEBREW_BREW_GIT_REMOTE",
                "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git",
            ),
            (
                "HOMEBREW_CORE_GIT_REMOTE",
                "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git",
            ),
            ("HOMEBREW_PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple"),
        ],
        "ustc" => vec![
            (
                "HOMEBREW_API_DOMAIN",
                "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
            ),
            (
                "HOMEBREW_BOTTLE_DOMAIN",
                "https://mirrors.ustc.edu.cn/homebrew-bottles",
            ),
            (
                "HOMEBREW_BREW_GIT_REMOTE",
                "https://mirrors.ustc.edu.cn/brew.git",
            ),
            (
                "HOMEBREW_CORE_GIT_REMOTE",
                "https://mirrors.ustc.edu.cn/homebrew-core.git",
            ),
        ],
        "aliyun" => vec![
            (
                "HOMEBREW_API_DOMAIN",
                "https://mirrors.aliyun.com/homebrew-bottles/api",
            ),
            (
                "HOMEBREW_BOTTLE_DOMAIN",
                "https://mirrors.aliyun.com/homebrew-bottles",
            ),
            (
                "HOMEBREW_BREW_GIT_REMOTE",
                "https://mirrors.aliyun.com/homebrew/brew.git",
            ),
            (
                "HOMEBREW_CORE_GIT_REMOTE",
                "https://mirrors.aliyun.com/homebrew/homebrew-core.git",
            ),
        ],
        _ => vec![],
    }
}

fn detect_current_mirror() -> String {
    let zprofile = home_dir().join(".zprofile");
    let zshrc = home_dir().join(".zshrc");
    for file in [zprofile, zshrc] {
        if let Ok(content) = std::fs::read_to_string(file) {
            if content.contains("mirrors.tuna.tsinghua.edu.cn") {
                return "tsinghua".to_string();
            }
            if content.contains("mirrors.ustc.edu.cn") {
                return "ustc".to_string();
            }
            if content.contains("mirrors.aliyun.com") {
                return "aliyun".to_string();
            }
        }
    }
    "official".to_string()
}

pub fn icloud_starbox_dir() -> Option<PathBuf> {
    let base = home_dir().join("Library/Mobile Documents/com~apple~CloudDocs");
    if base.exists() {
        Some(base.join("StarBox"))
    } else {
        None
    }
}

#[tauri::command]
pub async fn get_env_status() -> Result<EnvStatus, String> {
    let arch = std::env::consts::ARCH.to_string();

    let macos_version = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "macOS".to_string());

    let xcode_clt_installed = Command::new("xcode-select")
        .arg("-p")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let brew_path = find_brew_path();
    let brew_installed = brew_path.is_some();
    let brew_version = if let Some(ref path) = brew_path {
        Command::new(path)
            .arg("--version")
            .output()
            .await
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
    } else {
        None
    };

    let icloud_dir = icloud_starbox_dir();

    Ok(EnvStatus {
        arch,
        macos_version,
        xcode_clt_installed,
        brew_installed,
        brew_path,
        brew_version,
        mirror_preset: detect_current_mirror(),
        icloud_available: icloud_dir.is_some(),
        icloud_path: icloud_dir.map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn set_brew_mirror(preset: String) -> Result<String, String> {
    let start_marker = "# >>> Star Box Homebrew Mirror >>>";
    let end_marker = "# <<< Star Box Homebrew Mirror <<<";

    let vars = mirror_env_vars(&preset);
    let block = if vars.is_empty() {
        String::new()
    } else {
        let mut lines = vec![start_marker.to_string()];
        for (k, v) in vars {
            lines.push(format!("export {k}=\"{v}\""));
        }
        lines.push(end_marker.to_string());
        format!("\n{}\n", lines.join("\n"))
    };

    for rc_name in [".zprofile", ".zshrc"] {
        let path = home_dir().join(rc_name);
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let cleaned = strip_managed_block(&existing, start_marker, end_marker);
        let next = if block.is_empty() {
            cleaned
        } else {
            format!("{}{}", cleaned.trim_end(), block)
        };
        std::fs::write(&path, next).map_err(|e| format!("写入 {rc_name} 失败: {e}"))?;
    }

    Ok(preset)
}

fn strip_managed_block(input: &str, start: &str, end: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in input.lines() {
        if line.trim() == start {
            skipping = true;
            continue;
        }
        if line.trim() == end {
            skipping = false;
            continue;
        }
        if !skipping {
            out.push(line);
        }
    }
    let mut res = out.join("\n");
    if !res.is_empty() {
        res.push('\n');
    }
    res
}

#[tauri::command]
pub async fn cancel_homebrew_install(app: AppHandle) -> Result<(), String> {
    BREW_INSTALL_CANCELLED.store(true, Ordering::SeqCst);
    let pid_opt = {
        let mut guard = brew_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    if let Some(pid) = pid_opt {
        kill_process_group(pid);
    }
    let _ = app.emit(
        "env-log",
        EnvLogEvent {
            line: "已手动终止 Homebrew 安装进程。".to_string(),
            done: true,
            success: false,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn install_homebrew(app: AppHandle, mirror_preset: String) -> Result<(), String> {
    BREW_INSTALL_CANCELLED.store(false, Ordering::SeqCst);
    let emit = |line: String, done: bool, success: bool| {
        let _ = app.emit("env-log", EnvLogEvent { line, done, success });
    };

    emit(
        format!(
            "正在准备安装 Homebrew（架构：{}，镜像源：{mirror_preset}）...",
            std::env::consts::ARCH
        ),
        false,
        false,
    );

    // 1. Apply mirror environment variables
    let _ = set_brew_mirror(mirror_preset.clone()).await;

    let is_arm = std::env::consts::ARCH == "aarch64";
    let (prefix, repo_dir, brew_bin) = if is_arm {
        ("/opt/homebrew", "/opt/homebrew", "/opt/homebrew/bin/brew")
    } else {
        ("/usr/local", "/usr/local/Homebrew", "/usr/local/bin/brew")
    };

    let brew_git_url = match mirror_preset.as_str() {
        "tsinghua" => "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git",
        "ustc" => "https://mirrors.ustc.edu.cn/brew.git",
        "aliyun" => "https://mirrors.aliyun.com/homebrew/brew.git",
        _ => "https://github.com/Homebrew/brew.git",
    };

    let user = std::env::var("USER").unwrap_or_else(|_| "root".to_string());

    // 2. Create a temporary SUDO_ASKPASS helper that uses macOS native password dialog,
    //    so sudo works seamlessly without a TTY and auto-installs Xcode CLT via softwareupdate!
    let askpass_path = format!("/tmp/starbox-askpass-{}.sh", uuid::Uuid::new_v4());
    let askpass_script = r#"#!/bin/bash
osascript -e 'text returned of (display dialog "Star Box 一键安装 Homebrew 需要管理员密码：" default answer "" with hidden answer with title "Star Box 管理员授权")' 2>/dev/null
"#;
    std::fs::write(&askpass_path, askpass_script)
        .map_err(|e| format!("创建授权辅助脚本失败: {e}"))?;
    let _ = Command::new("chmod").args(["700", &askpass_path]).status().await;

    let prep_dirs = if is_arm {
        format!(
            "sudo -A mkdir -p /opt/homebrew /opt/homebrew/bin /opt/homebrew/etc /opt/homebrew/include /opt/homebrew/lib /opt/homebrew/sbin /opt/homebrew/share /opt/homebrew/var /opt/homebrew/opt /opt/homebrew/Cellar /opt/homebrew/Caskroom && sudo -A chown -R '{user}':admin /opt/homebrew"
        )
    } else {
        format!(
            "sudo -A mkdir -p /usr/local/Homebrew /usr/local/bin /usr/local/etc /usr/local/Frameworks /usr/local/include /usr/local/lib /usr/local/sbin /usr/local/share /usr/local/var/homebrew /usr/local/opt /usr/local/Cellar /usr/local/Caskroom && sudo -A chown -R '{user}':admin /usr/local/Homebrew /usr/local/bin /usr/local/etc /usr/local/Frameworks /usr/local/include /usr/local/lib /usr/local/sbin /usr/local/share /usr/local/var/homebrew /usr/local/opt /usr/local/Cellar /usr/local/Caskroom"
        )
    };

    let full_script = format!(
        r#"set -e
export SUDO_ASKPASS="{askpass_path}"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:{prefix}/bin"

echo "正在获取管理员授权（请在弹窗中输入开机密码）..."
sudo -A -v

# Keep sudo alive in background during CLT download & git fetch
( while true; do sudo -n true; sleep 45; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &
SUDO_KEEPALIVE_PID=$!
trap 'kill $SUDO_KEEPALIVE_PID 2>/dev/null || true; sudo -A rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress 2>/dev/null || true' EXIT

# Auto-install Xcode Command Line Tools via softwareupdate if missing (no GUI popup needed!)
if ! [ -f "/Library/Developer/CommandLineTools/usr/bin/git" ] && ! /usr/bin/xcrun git --version >/dev/null 2>&1; then
  echo "未检测到 Xcode Command Line Tools，正在通过系统更新后台自动下载安装（耗时约 2~5 分钟，请稍候）..."
  sudo -A touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  CLT_LABEL="$(/usr/sbin/softwareupdate -l 2>/dev/null | grep -B 1 -E 'Command Line Tools' | awk -F'*' '/^ *\*/ {{print $2}}' | sed -e 's/^ *Label: //' -e 's/^ *//' | sort -V | tail -n1)"
  if [ -n "$CLT_LABEL" ]; then
    echo "找到安装包：$CLT_LABEL，正在自动下载并安装..."
    sudo -A /usr/sbin/softwareupdate -i "$CLT_LABEL" --verbose
    sudo -A /usr/bin/xcode-select --switch /Library/Developer/CommandLineTools 2>/dev/null || true
  else
    echo "系统更新源未返回 Command Line Tools 列表，尝试触发命令行安装..."
    /usr/bin/xcode-select --install 2>/dev/null || true
  fi
  sudo -A rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi

echo "正在准备 Homebrew 目录权限 ({repo_dir})..."
{prep_dirs}

echo "正在从镜像源拉取 Homebrew 核心仓库：{brew_git_url}"
if [ ! -d "{repo_dir}/.git" ]; then
  git init -q "{repo_dir}"
  git -C "{repo_dir}" remote add origin "{brew_git_url}"
else
  git -C "{repo_dir}" remote set-url origin "{brew_git_url}"
fi
git -C "{repo_dir}" fetch --depth=1 --progress origin HEAD
git -C "{repo_dir}" reset --hard FETCH_HEAD
if [ "{repo_dir}" != "{prefix}" ]; then
  ln -sf "{repo_dir}/bin/brew" "{brew_bin}"
fi
"#
    );

    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-c")
        .arg(&full_script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::commands::proxy::apply_proxy_env(&mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_file(&askpass_path);
            format!("启动安装进程失败: {e}")
        })?;

    if let Some(pid) = child.id() {
        let mut guard = brew_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    let _ = app_out.emit("env-log", EnvLogEvent { line, done: false, success: false });
                }
            }
        }
    });

    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    let _ = app_err.emit("env-log", EnvLogEvent { line, done: false, success: false });
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    {
        let mut guard = brew_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    let _ = tokio::join!(out_task, err_task);
    let _ = std::fs::remove_file(&askpass_path);

    if BREW_INSTALL_CANCELLED.load(Ordering::SeqCst) {
        return Err("已手动终止 Homebrew 安装".to_string());
    }

    if !status.success() || !std::path::Path::new(brew_bin).exists() {
        let msg = "安装未完成（可能密码取消或网络中断），可点击重新尝试。".to_string();
        emit(msg.clone(), true, false);
        return Err(msg);
    }

    // Write brew shellenv to ~/.zprofile
    let shellenv_line = format!("eval \"$({brew_bin} shellenv)\"");
    let zprofile = home_dir().join(".zprofile");
    let existing = std::fs::read_to_string(&zprofile).unwrap_or_default();
    if !existing.contains(brew_bin) {
        let next = format!("{}\n{shellenv_line}\n", existing.trim_end());
        let _ = std::fs::write(&zprofile, next);
    }

    emit("正在验证 Homebrew 运行环境...".into(), false, false);
    let ver_out = Command::new(brew_bin).arg("--version").output().await;
    let ok = ver_out.as_ref().map(|o| o.status.success()).unwrap_or(false);
    if ok {
        let ver_str = ver_out
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
            .unwrap_or_else(|| "Homebrew".to_string());
        emit(format!("Homebrew 安装成功！({ver_str})"), true, true);
        Ok(())
    } else {
        let msg = "Homebrew 文件已拉取但验证失败，请重试。".to_string();
        emit(msg.clone(), true, false);
        Err(msg)
    }
}

fn launch_agent_path() -> PathBuf {
    home_dir().join("Library/LaunchAgents/com.starandget.starbox.plist")
}

#[tauri::command]
pub async fn get_autostart_enabled() -> Result<bool, String> {
    Ok(launch_agent_path().exists())
}

#[tauri::command]
pub async fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    let plist_path = launch_agent_path();
    if !enabled {
        if plist_path.exists() {
            std::fs::remove_file(&plist_path)
                .map_err(|e| format!("移除自启动配置失败: {e}"))?;
        }
        return Ok(false);
    }

    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 LaunchAgents 目录失败: {e}"))?;
    }

    let app_bundle_exe = PathBuf::from("/Applications/Star Box.app/Contents/MacOS/star-box");
    let exe_path = if app_bundle_exe.exists() {
        app_bundle_exe
    } else {
        std::env::current_exe().map_err(|e| format!("获取应用路径失败: {e}"))?
    };

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.starandget.starbox</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#,
        exe_path.to_string_lossy()
    );

    std::fs::write(&plist_path, plist).map_err(|e| format!("写入自启动配置失败: {e}"))?;
    Ok(true)
}

#[derive(Deserialize)]
struct LatestReleaseResp {
    tag_name: String,
    html_url: String,
}

fn parse_semver(v: &str) -> (u32, u32, u32) {
    let clean = v.trim().trim_start_matches('v');
    let mut parts = clean.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

#[tauri::command]
pub async fn check_app_update() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = crate::commands::proxy::build_http_client(std::time::Duration::from_secs(12))
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.github.com/repos/starandget/star-box/releases/latest")
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回 {}", resp.status()));
    }

    let data: LatestReleaseResp = resp
        .json()
        .await
        .map_err(|e| format!("解析版本信息失败: {e}"))?;

    let latest_clean = data.tag_name.trim_start_matches('v').to_string();
    let has_update = parse_semver(&latest_clean) > parse_semver(&current);

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: latest_clean,
        has_update,
        release_url: data.html_url,
    })
}

#[tauri::command]
pub async fn init_workspace_folders(folders: Vec<String>) -> Result<InitFoldersResult, String> {
    let base = home_dir().join("Documents");
    std::fs::create_dir_all(&base).map_err(|e| format!("创建 ~/Documents 失败: {e}"))?;

    let mut created = Vec::new();
    let mut renamed = Vec::new();
    let mut existed = Vec::new();

    for raw in folders {
        let name = raw.trim();
        if name.is_empty() || name.contains('/') || name.contains("..") {
            continue;
        }
        let want_lower = name.to_lowercase();

        // Check case-insensitive existing folder in ~/Documents
        let mut found_actual: Option<String> = None;
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    if let Some(fname) = entry.file_name().to_str() {
                        if fname.to_lowercase() == want_lower {
                            found_actual = Some(fname.to_string());
                            break;
                        }
                    }
                }
            }
        }

        if let Some(old) = found_actual {
            if old != name {
                let old_path = base.join(&old);
                let tmp_path = base.join(format!("{old}.__starbox_tmp__"));
                let new_path = base.join(name);
                if std::fs::rename(&old_path, &tmp_path).is_ok()
                    && std::fs::rename(&tmp_path, &new_path).is_ok()
                {
                    renamed.push(format!("{old} → {name}"));
                }
            }
        }

        let default_dir = base.join(name).join("default");
        if default_dir.exists() {
            existed.push(format!("{name}/default"));
        } else {
            std::fs::create_dir_all(&default_dir)
                .map_err(|e| format!("创建 {name}/default 失败: {e}"))?;
            created.push(format!("{name}/default"));
        }
    }

    Ok(InitFoldersResult {
        base_dir: base.to_string_lossy().to_string(),
        created,
        renamed,
        existed,
    })
}
