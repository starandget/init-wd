use crate::commands::catalog::inspect_github_repo;
use crate::commands::env::{find_brew_path, home_dir, kill_process_group, mirror_env_vars};
use crate::models::{AppItem, InstallProgressEvent, InstalledInfo, LocalAppCandidate};
use base64::Engine as _;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Clone)]
struct TaskControl {
    cancelled: Arc<AtomicBool>,
    child_pid: Arc<Mutex<Option<u32>>>,
}

impl TaskControl {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            child_pid: Arc::new(Mutex::new(None)),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn set_pid(&self, pid: Option<u32>) {
        let mut g = self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
        *g = pid;
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pid_opt = {
            let mut g = self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
            g.take()
        };
        if let Some(pid) = pid_opt {
            kill_process_group(pid);
        }
    }
}

static ACTIVE_TASKS: OnceLock<Mutex<HashMap<String, TaskControl>>> = OnceLock::new();

fn active_tasks() -> &'static Mutex<HashMap<String, TaskControl>> {
    ACTIVE_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct TaskGuard {
    task_id: String,
    ctrl: TaskControl,
}

impl TaskGuard {
    fn register(task_id: &str) -> Self {
        let ctrl = TaskControl::new();
        {
            let mut map = active_tasks().lock().unwrap_or_else(|e| e.into_inner());
            map.insert(task_id.to_string(), ctrl.clone());
        }
        Self {
            task_id: task_id.to_string(),
            ctrl,
        }
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        let mut map = active_tasks().lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&self.task_id);
    }
}

#[tauri::command]
pub async fn cancel_install_task(task_id: String) -> Result<(), String> {
    let ctrl_opt = {
        let map = active_tasks().lock().unwrap_or_else(|e| e.into_inner());
        map.get(&task_id).cloned()
    };
    if let Some(ctrl) = ctrl_opt {
        ctrl.cancel();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    stage: &str,
    message: impl Into<String>,
    progress: Option<u8>,
    done: bool,
    success: bool,
) {
    let _ = app.emit(
        "install-progress",
        InstallProgressEvent {
            task_id: task_id.to_string(),
            app_id: app_id.to_string(),
            stage: stage.to_string(),
            message: message.into(),
            progress,
            done,
            success,
        },
    );
}

pub fn find_existing_app(candidates: &[String]) -> Option<String> {
    let home = home_dir();
    let search_dirs = [
        PathBuf::from("/Applications"),
        home.join("Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];

    for raw in candidates {
        for cand in raw.split(',') {
            let c = cand.trim();
            if c.is_empty() {
                continue;
            }
            if c.starts_with('/') {
                if Path::new(c).exists() {
                    return Some(c.to_string());
                }
                continue;
            }
            for dir in &search_dirs {
                let p = dir.join(c);
                if p.exists() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

async fn get_brew_installed_sets() -> (HashSet<String>, HashSet<String>, HashSet<String>) {
    let mut casks = HashSet::new();
    let mut formulas = HashSet::new();
    let mut outdated = HashSet::new();

    let Some(brew) = find_brew_path() else {
        return (casks, formulas, outdated);
    };

    let (c_out, f_out, o_out) = tokio::join!(
        Command::new(&brew).args(["list", "--cask", "-1"]).output(),
        Command::new(&brew).args(["list", "--formula", "-1"]).output(),
        Command::new(&brew).args(["outdated", "--quiet"]).output()
    );

    if let Ok(out) = c_out {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let t = line.trim();
                if !t.is_empty() {
                    casks.insert(t.to_string());
                }
            }
        }
    }

    if let Ok(out) = f_out {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let t = line.trim();
                if !t.is_empty() {
                    formulas.insert(t.to_string());
                }
            }
        }
    }

    if let Ok(out) = o_out {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let t = line.trim();
                if !t.is_empty() {
                    outdated.insert(t.to_string());
                }
            }
        }
    }

    (casks, formulas, outdated)
}

/// Maps lowercased `.app` bundle filename (e.g. `"clash verge.app"`) -> Homebrew cask token
/// (e.g. `"clash-verge-rev"`) using local `brew info --cask --json=v2 --installed`.
async fn get_brew_cask_app_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(brew) = find_brew_path() else {
        return map;
    };

    let Ok(out) = Command::new(&brew)
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .args(["info", "--cask", "--json=v2", "--installed"])
        .output()
        .await
    else {
        return map;
    };
    if !out.status.success() {
        return map;
    }

    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return map;
    };
    let Some(casks) = json.get("casks").and_then(|v| v.as_array()) else {
        return map;
    };

    for cask in casks {
        let Some(token) = cask.get("token").and_then(|v| v.as_str()) else {
            continue;
        };

        // 1. Exact `app` artifact names (including `{ "target": "Renamed.app" }`)
        if let Some(artifacts) = cask.get("artifacts").and_then(|v| v.as_array()) {
            for art in artifacts {
                let Some(app_arr) = art.get("app").and_then(|v| v.as_array()) else {
                    continue;
                };
                let mut target_name: Option<&str> = None;
                let mut source_name: Option<&str> = None;
                for item in app_arr {
                    if let Some(s) = item.as_str() {
                        if source_name.is_none() {
                            source_name = Some(s);
                        }
                    } else if let Some(t) = item.get("target").and_then(|v| v.as_str()) {
                        target_name = Some(t);
                    }
                }
                if let Some(raw) = target_name.or(source_name) {
                    if let Some(fname) = Path::new(raw).file_name().and_then(|n| n.to_str()) {
                        map.insert(fname.to_lowercase(), token.to_string());
                    }
                }
            }
        }

        // 2. Fallback: display names (covers `.pkg`-based casks like Microsoft Edge / Docker)
        if let Some(names) = cask.get("name").and_then(|v| v.as_array()) {
            for n in names {
                if let Some(name_str) = n.as_str() {
                    let trimmed = name_str.trim();
                    if !trimmed.is_empty() {
                        let key = if trimmed.to_lowercase().ends_with(".app") {
                            trimmed.to_lowercase()
                        } else {
                            format!("{}.app", trimmed.to_lowercase())
                        };
                        map.entry(key).or_insert_with(|| token.to_string());
                    }
                }
            }
        }
    }

    map
}

fn icon_cache_dir() -> PathBuf {
    home_dir().join("Library/Caches/com.starandget.starbox/icons")
}

fn find_icns_in_app(app_path: &Path) -> Option<PathBuf> {
    let resources = app_path.join("Contents/Resources");
    if !resources.exists() {
        return None;
    }

    // Try reading CFBundleIconFile from Info.plist via defaults
    let info_plist = app_path.join("Contents/Info.plist");
    if info_plist.exists() {
        if let Ok(out) = std::process::Command::new("defaults")
            .args(["read", info_plist.to_string_lossy().as_ref(), "CFBundleIconFile"])
            .output()
        {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !raw.is_empty() {
                    let filename = if raw.ends_with(".icns") {
                        raw
                    } else {
                        format!("{raw}.icns")
                    };
                    let p = resources.join(filename);
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
    }

    // Fallback: pick first .icns in Contents/Resources
    if let Ok(entries) = std::fs::read_dir(&resources) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("icns") {
                return Some(p);
            }
        }
    }
    None
}

async fn extract_app_icon_data_url(app_id: &str, app_path: &str) -> Option<String> {
    let cache_dir = icon_cache_dir();
    let _ = std::fs::create_dir_all(&cache_dir);
    let safe_id: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // Include a lightweight FNV-1a hash of app_path so path changes (e.g. Steam stub -> real .app)
    // automatically refresh the cached icon instead of serving a stale icon.
    let mut path_hash: u32 = 2166136261;
    for b in app_path.as_bytes() {
        path_hash ^= *b as u32;
        path_hash = path_hash.wrapping_mul(16777619);
    }
    let png_path = cache_dir.join(format!("{safe_id}-{path_hash:08x}.png"));

    if !png_path.exists() {
        let icns = find_icns_in_app(Path::new(app_path))?;
        let status = Command::new("sips")
            .args([
                "-s",
                "format",
                "png",
                "-z",
                "128",
                "128",
                icns.to_string_lossy().as_ref(),
                "--out",
                png_path.to_string_lossy().as_ref(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .ok()?;
        if !status.success() {
            return None;
        }
    }

    let bytes = std::fs::read(&png_path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

#[tauri::command]
pub async fn scan_installed_apps(apps: Vec<AppItem>) -> Result<Vec<InstalledInfo>, String> {
    let (brew_casks, brew_formulas, outdated_set) = get_brew_installed_sets().await;

    let mut results = Vec::with_capacity(apps.len());
    for item in apps {
        let mut via_brew = false;
        let mut is_outdated = false;

        if let Some(ref f) = item.brew_formula {
            if brew_formulas.contains(f) {
                via_brew = true;
                if outdated_set.contains(f) {
                    is_outdated = true;
                }
            }
        }

        for c in &item.brew_casks {
            if brew_casks.contains(c) {
                via_brew = true;
                if outdated_set.contains(c) {
                    is_outdated = true;
                }
                break;
            }
        }

        let mut candidates = item.dock_apps.clone();
        candidates.push(format!("{}.app", item.name));
        let app_path = find_existing_app(&candidates);
        let installed = via_brew || app_path.is_some();

        let icon_data_url = if let Some(ref path) = app_path {
            extract_app_icon_data_url(&item.id, path).await
        } else {
            None
        };

        results.push(InstalledInfo {
            id: item.id,
            installed,
            via_brew,
            app_path,
            outdated: is_outdated,
            icon_data_url,
        });
    }

    Ok(results)
}

async fn run_brew_stream(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    brew_path: &str,
    args: &[&str],
    mirror_preset: &str,
    ctrl: &TaskControl,
) -> Result<bool, String> {
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }

    let mut cmd = Command::new(brew_path);
    cmd.args(args)
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env(
            "PATH",
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::commands::proxy::apply_proxy_env(&mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    for (k, v) in mirror_env_vars(mirror_preset) {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 brew 进程: {e}"))?;

    ctrl.set_pid(child.id());
    if ctrl.is_cancelled() {
        if let Some(pid) = child.id() {
            kill_process_group(pid);
        }
        ctrl.set_pid(None);
        return Err("已手动终止".to_string());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_o = app.clone();
    let tid_o = task_id.to_string();
    let aid_o = app_id.to_string();
    let t1 = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit_progress(&app_o, &tid_o, &aid_o, "brew", line, None, false, false);
                }
            }
        }
    });

    let app_e = app.clone();
    let tid_e = task_id.to_string();
    let aid_e = app_id.to_string();
    let t2 = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit_progress(&app_e, &tid_e, &aid_e, "brew", line, None, false, false);
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    ctrl.set_pid(None);
    let _ = tokio::join!(t1, t2);
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }
    Ok(status.success())
}

fn find_first_with_ext(dir: &Path, ext: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if name.to_lowercase().ends_with(ext) {
                return Some(p);
            }
        }
        if p.is_dir() && !p.to_string_lossy().ends_with(".app") {
            if let Some(found) = find_first_with_ext(&p, ext, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

async fn run_admin_shell(shell_cmd: &str) -> Result<bool, String> {
    let escaped = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped}\" with administrator privileges");
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("调起系统授权失败: {e}"))?;
    Ok(output.status.success())
}

async fn copy_app_to_applications(app_bundle: &Path) -> Result<String, String> {
    let name = app_bundle
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无效的 .app 路径".to_string())?;
    let dest = PathBuf::from("/Applications").join(name);
    let src_s = app_bundle.to_string_lossy();
    let dst_s = dest.to_string_lossy();

    // Try user-level copy first
    let direct_ok = if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
        Command::new("ditto")
            .args([src_s.as_ref(), dst_s.as_ref()])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        Command::new("ditto")
            .args([src_s.as_ref(), dst_s.as_ref()])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    };

    if direct_ok {
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine", dst_s.as_ref()])
            .status()
            .await;
        return Ok(dst_s.to_string());
    }

    // Fallback to native macOS administrator privileges dialog
    let cmd = format!(
        "rm -rf '{}' && ditto '{}' '{}' && xattr -dr com.apple.quarantine '{}' || true",
        dst_s.replace('\'', "'\\''"),
        src_s.replace('\'', "'\\''"),
        dst_s.replace('\'', "'\\''"),
        dst_s.replace('\'', "'\\''")
    );
    if run_admin_shell(&cmd).await? {
        Ok(dst_s.to_string())
    } else {
        Err("管理员授权被取消或复制应用失败".to_string())
    }
}

async fn install_pkg_file(pkg_path: &Path) -> Result<(), String> {
    let p = pkg_path.to_string_lossy();
    let cmd = format!("installer -pkg '{}' -target /", p.replace('\'', "'\\''"));
    if run_admin_shell(&cmd).await? {
        Ok(())
    } else {
        Err("PKG 安装被取消或失败".to_string())
    }
}

async fn install_downloaded_package(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    file: &Path,
    work_dir: &Path,
) -> Result<(), String> {
    let lower = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if lower.ends_with(".dmg") {
        let mnt = work_dir.join("mnt");
        std::fs::create_dir_all(&mnt).map_err(|e| e.to_string())?;
        emit_progress(app, task_id, app_id, "install", "正在挂载 DMG 镜像...", Some(85), false, false);

        let attach = Command::new("hdiutil")
            .args([
                "attach",
                file.to_string_lossy().as_ref(),
                "-nobrowse",
                "-quiet",
                "-mountpoint",
                mnt.to_string_lossy().as_ref(),
            ])
            .status()
            .await
            .map_err(|e| format!("挂载 DMG 失败: {e}"))?;

        if !attach.success() {
            return Err("无法挂载 DMG 安装包".to_string());
        }

        let res = if let Some(app_bundle) = find_first_with_ext(&mnt, ".app", 2) {
            emit_progress(
                app,
                task_id,
                app_id,
                "install",
                format!("正在安装 {} 到 /Applications...", app_bundle.file_name().unwrap_or_default().to_string_lossy()),
                Some(92),
                false,
                false,
            );
            copy_app_to_applications(&app_bundle).await.map(|_| ())
        } else if let Some(pkg) = find_first_with_ext(&mnt, ".pkg", 2) {
            emit_progress(app, task_id, app_id, "install", "正在运行 PKG 安装程序（需要管理员授权）...", Some(92), false, false);
            install_pkg_file(&pkg).await
        } else {
            Err("DMG 镜像中未找到 .app 或 .pkg".to_string())
        };

        let _ = Command::new("hdiutil")
            .args(["detach", mnt.to_string_lossy().as_ref(), "-quiet", "-force"])
            .status()
            .await;

        res
    } else if lower.ends_with(".pkg") {
        emit_progress(app, task_id, app_id, "install", "正在运行 PKG 安装程序（需要管理员授权）...", Some(90), false, false);
        install_pkg_file(file).await
    } else if lower.ends_with(".zip") {
        let unzip = work_dir.join("unzip");
        std::fs::create_dir_all(&unzip).map_err(|e| e.to_string())?;
        emit_progress(app, task_id, app_id, "install", "正在解压 ZIP 安装包...", Some(85), false, false);

        let st = Command::new("ditto")
            .args([
                "-x",
                "-k",
                file.to_string_lossy().as_ref(),
                unzip.to_string_lossy().as_ref(),
            ])
            .status()
            .await
            .map_err(|e| format!("解压 ZIP 失败: {e}"))?;

        if !st.success() {
            return Err("ZIP 解压失败".to_string());
        }

        if let Some(app_bundle) = find_first_with_ext(&unzip, ".app", 3) {
            emit_progress(app, task_id, app_id, "install", "正在复制到 /Applications 并清理隔离属性...", Some(92), false, false);
            copy_app_to_applications(&app_bundle).await.map(|_| ())
        } else if let Some(pkg) = find_first_with_ext(&unzip, ".pkg", 3) {
            install_pkg_file(&pkg).await
        } else {
            Err("ZIP 包中未找到 .app 或 .pkg".to_string())
        }
    } else {
        Err(format!("不支持的安装包格式: {lower}"))
    }
}

async fn install_via_github(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    repo: &str,
    ctrl: &TaskControl,
) -> Result<(), String> {
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }
    emit_progress(
        app,
        task_id,
        app_id,
        "github",
        format!("正在从 GitHub Releases 查找 {repo} 的 macOS 安装包..."),
        Some(10),
        false,
        false,
    );

    let rel = inspect_github_repo(repo.to_string()).await?;
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }
    let asset_url = rel
        .asset_url
        .ok_or_else(|| format!("仓库 {repo} 最新版本没有可用的 macOS 安装包"))?;
    let asset_name = rel
        .asset_name
        .unwrap_or_else(|| "installer.dmg".to_string());

    let work_dir = std::env::temp_dir().join(format!("starbox-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    let file_path = work_dir.join(&asset_name);

    emit_progress(
        app,
        task_id,
        app_id,
        "download",
        format!("开始下载 {asset_name} ({})...", rel.tag_name),
        Some(15),
        false,
        false,
    );

    let client = crate::commands::proxy::build_http_client(std::time::Duration::from_secs(600))
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&asset_url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    if !resp.status().is_success() {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(format!("下载返回错误状态码 {}", resp.status()));
    }

    let total = resp.content_length().or(rel.asset_size).unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut last_pct: u8 = 0;

    while let Some(chunk) = stream.next().await {
        if ctrl.is_cancelled() {
            drop(file);
            let _ = std::fs::remove_dir_all(&work_dir);
            return Err("已手动终止".to_string());
        }
        let data = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&data).await.map_err(|e| e.to_string())?;
        downloaded += data.len() as u64;
        if let Some(ratio) = (downloaded * 65).checked_div(total) {
            let pct = (15 + ratio) as u8;
            if pct >= last_pct + 4 || pct >= 80 {
                last_pct = pct;
                let mb_done = downloaded as f64 / 1_048_576.0;
                let mb_total = total as f64 / 1_048_576.0;
                emit_progress(
                    app,
                    task_id,
                    app_id,
                    "download",
                    format!("下载中 {mb_done:.1} MB / {mb_total:.1} MB"),
                    Some(pct),
                    false,
                    false,
                );
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    if ctrl.is_cancelled() {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err("已手动终止".to_string());
    }

    let res = install_downloaded_package(app, task_id, app_id, &file_path, &work_dir).await;
    let _ = std::fs::remove_dir_all(&work_dir);
    res
}

#[tauri::command]
pub async fn install_app(
    app: AppHandle,
    task_id: String,
    item: AppItem,
    mirror_preset: String,
) -> Result<(), String> {
    let guard = TaskGuard::register(&task_id);
    let ctrl = &guard.ctrl;

    emit_progress(
        &app,
        &task_id,
        &item.id,
        "start",
        format!("开始安装 {}", item.name),
        Some(5),
        false,
        false,
    );

    // 1. Formula
    if let Some(ref formula) = item.brew_formula {
        let Some(brew) = find_brew_path() else {
            let msg = "未安装 Homebrew，无法安装命令行工具".to_string();
            emit_progress(&app, &task_id, &item.id, "error", &msg, None, true, false);
            return Err(msg);
        };
        let ok = match run_brew_stream(
            &app,
            &task_id,
            &item.id,
            &brew,
            &["install", formula.as_str()],
            &mirror_preset,
            ctrl,
        )
        .await
        {
            Ok(v) => v,
            Err(e) if ctrl.is_cancelled() => {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err(e);
            }
            Err(e) => {
                emit_progress(&app, &task_id, &item.id, "error", &e, None, true, false);
                return Err(e);
            }
        };
        if ok {
            emit_progress(&app, &task_id, &item.id, "done", format!("{} 安装完成", item.name), Some(100), true, true);
            return Ok(());
        }
        let msg = format!("brew install {formula} 失败");
        emit_progress(&app, &task_id, &item.id, "error", &msg, None, true, false);
        return Err(msg);
    }

    // 2. Try Brew Casks
    if !item.brew_casks.is_empty() {
        if let Some(brew) = find_brew_path() {
            for cask in &item.brew_casks {
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".to_string());
                }
                emit_progress(
                    &app,
                    &task_id,
                    &item.id,
                    "brew",
                    format!("尝试通过 Homebrew Cask 安装: {cask}"),
                    Some(25),
                    false,
                    false,
                );
                let first_res = run_brew_stream(
                    &app,
                    &task_id,
                    &item.id,
                    &brew,
                    &["install", "--cask", cask.as_str()],
                    &mirror_preset,
                    ctrl,
                )
                .await;
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".to_string());
                }
                if first_res.unwrap_or(false) {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 安装完成（Homebrew）", item.name), Some(100), true, true);
                    return Ok(());
                }

                // Try --adopt if app already exists
                emit_progress(
                    &app,
                    &task_id,
                    &item.id,
                    "brew",
                    format!("尝试 --adopt 接管已有应用: {cask}"),
                    Some(45),
                    false,
                    false,
                );
                let adopt_res = run_brew_stream(
                    &app,
                    &task_id,
                    &item.id,
                    &brew,
                    &["install", "--cask", "--adopt", cask.as_str()],
                    &mirror_preset,
                    ctrl,
                )
                .await;
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".to_string());
                }
                if adopt_res.unwrap_or(false) {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 已安装并接管（Homebrew）", item.name), Some(100), true, true);
                    return Ok(());
                }
            }
        }
    }

    if ctrl.is_cancelled() {
        emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
        return Err("已手动终止".to_string());
    }

    // 3. Fallback to GitHub Releases
    if let Some(ref repo) = item.github_repo {
        if !repo.trim().is_empty() {
            match install_via_github(&app, &task_id, &item.id, repo, ctrl).await {
                Ok(()) => {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 安装完成（GitHub Releases）", item.name), Some(100), true, true);
                    return Ok(());
                }
                Err(e) if ctrl.is_cancelled() => {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err(e);
                }
                Err(e) => {
                    emit_progress(&app, &task_id, &item.id, "error", format!("GitHub 安装失败: {e}"), None, true, false);
                    return Err(e);
                }
            }
        }
    }

    let msg = format!("{} 自动安装失败，请点击前往官网手动下载", item.name);
    emit_progress(&app, &task_id, &item.id, "error", &msg, None, true, false);
    Err(msg)
}

#[tauri::command]
pub async fn upgrade_app(
    app: AppHandle,
    task_id: String,
    item: AppItem,
    mirror_preset: String,
) -> Result<(), String> {
    let guard = TaskGuard::register(&task_id);
    let ctrl = &guard.ctrl;

    emit_progress(&app, &task_id, &item.id, "start", format!("正在更新 {}...", item.name), Some(10), false, false);

    if let Some(brew) = find_brew_path() {
        if let Some(ref formula) = item.brew_formula {
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["upgrade", formula.as_str()], &mirror_preset, ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            let ok = res?;
            emit_progress(&app, &task_id, &item.id, if ok { "done" } else { "error" }, if ok { "更新完成" } else { "更新失败" }, Some(100), true, ok);
            return if ok { Ok(()) } else { Err("更新失败".into()) };
        }
        for cask in &item.brew_casks {
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["upgrade", "--cask", cask.as_str()], &mirror_preset, ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            if res.unwrap_or(false) {
                emit_progress(&app, &task_id, &item.id, "done", format!("{} 已更新到最新版本", item.name), Some(100), true, true);
                return Ok(());
            }
        }
    }

    if let Some(ref repo) = item.github_repo {
        if !repo.trim().is_empty() {
            if let Err(e) = install_via_github(&app, &task_id, &item.id, repo, ctrl).await {
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                }
                return Err(e);
            }
            emit_progress(&app, &task_id, &item.id, "done", format!("{} 已更新完成", item.name), Some(100), true, true);
            return Ok(());
        }
    }

    emit_progress(&app, &task_id, &item.id, "error", "无法自动更新该软件", None, true, false);
    Err("无法自动更新该软件".into())
}

#[tauri::command]
pub async fn uninstall_app(app: AppHandle, task_id: String, item: AppItem) -> Result<(), String> {
    let guard = TaskGuard::register(&task_id);
    let ctrl = &guard.ctrl;

    emit_progress(&app, &task_id, &item.id, "start", format!("正在卸载 {}...", item.name), Some(20), false, false);

    if let Some(brew) = find_brew_path() {
        if let Some(ref formula) = item.brew_formula {
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["uninstall", formula.as_str()], "official", ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            if res.unwrap_or(false) {
                emit_progress(&app, &task_id, &item.id, "done", format!("{} 已卸载", item.name), Some(100), true, true);
                return Ok(());
            }
        }
        for cask in &item.brew_casks {
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["uninstall", "--cask", cask.as_str()], "official", ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            if res.unwrap_or(false) {
                emit_progress(&app, &task_id, &item.id, "done", format!("{} 已卸载", item.name), Some(100), true, true);
                return Ok(());
            }
        }
    }

    if let Some(path) = find_existing_app(&item.dock_apps) {
        if !path.starts_with("/System/") {
            let rm_ok = std::fs::remove_dir_all(&path).is_ok()
                || run_admin_shell(&format!("rm -rf '{}'", path.replace('\'', "'\\''")))
                    .await
                    .unwrap_or(false);
            if rm_ok {
                emit_progress(&app, &task_id, &item.id, "done", format!("已移除 {path}"), Some(100), true, true);
                return Ok(());
            }
        }
    }

    emit_progress(&app, &task_id, &item.id, "error", "卸载失败", None, true, false);
    Err("卸载失败".into())
}

#[tauri::command]
pub async fn open_installed_app(app_path: String) -> Result<(), String> {
    let st = Command::new("open")
        .arg(&app_path)
        .status()
        .await
        .map_err(|e| format!("无法启动应用: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("启动应用失败: {app_path}"))
    }
}

fn slugify_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Steam creates lightweight `.app` launcher stubs in `~/Applications/` whose only executable is
/// `Contents/MacOS/run.sh` (`open steam://rungameid/...`). Those stubs carry an outdated/generic
/// icon and cause a duplicate Dock icon when the real `.app` inside `Steam/steamapps/common/` runs.
/// When detected, resolve to the actual `.app` bundle inside Steam's `common` directory.
fn resolve_steam_stub_app(app_path: &Path, display_name: &str) -> PathBuf {
    let run_sh = app_path.join("Contents/MacOS/run.sh");
    if !run_sh.exists() {
        return app_path.to_path_buf();
    }
    let Ok(script) = std::fs::read_to_string(&run_sh) else {
        return app_path.to_path_buf();
    };
    if !script.contains("steam://") {
        return app_path.to_path_buf();
    }
    let steam_common = home_dir()
        .join("Library/Application Support/Steam/steamapps/common")
        .join(display_name);
    if let Ok(entries) = std::fs::read_dir(&steam_common) {
        let mut candidates: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
            .collect();
        candidates.sort();
        if let Some(real_app) = candidates.into_iter().next() {
            return real_app;
        }
    }
    app_path.to_path_buf()
}

#[tauri::command]
pub async fn discover_local_apps() -> Result<Vec<LocalAppCandidate>, String> {
    let ((brew_casks, _, outdated_set), cask_app_map) =
        tokio::join!(get_brew_installed_sets(), get_brew_cask_app_map());
    let mut found = Vec::new();
    let mut seen_names = HashSet::new();

    let dirs = [PathBuf::from("/Applications"), home_dir().join("Applications")];
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Some(file_name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !file_name.ends_with(".app") || file_name == "Safari.app" || file_name == "Star Box.app" {
                continue;
            }
            let display = file_name.trim_end_matches(".app").to_string();
            let key = display.to_lowercase();
            if !seen_names.insert(key) {
                continue;
            }

            let slug = slugify_name(&display);
            let compact = slug.replace('-', "");
            let matched_cask = cask_app_map
                .get(&file_name.to_lowercase())
                .cloned()
                .or_else(|| {
                    brew_casks
                        .iter()
                        .find(|c| {
                            let cl = c.to_lowercase();
                            cl == slug || cl.replace('-', "") == compact
                        })
                        .cloned()
                });

            let id = format!("local-{}", if slug.is_empty() { display.clone() } else { slug });
            let resolved_p = resolve_steam_stub_app(&p, &display);
            let path_str = resolved_p.to_string_lossy().to_string();
            let resolved_app_name = resolved_p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(file_name)
                .to_string();
            let icon_data_url = extract_app_icon_data_url(&id, &path_str).await;

            let is_outdated = matched_cask
                .as_ref()
                .map(|c| outdated_set.contains(c))
                .unwrap_or(false);

            found.push(LocalAppCandidate {
                id,
                name: display,
                app_name: resolved_app_name,
                app_path: path_str,
                brew_cask: matched_cask,
                outdated: is_outdated,
                icon_data_url,
            });
        }
    }

    found.sort_by_key(|a| a.name.to_lowercase());
    Ok(found)
}
