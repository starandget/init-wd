use crate::commands::catalog::inspect_github_repo;
use crate::commands::env::{find_brew_path, home_dir, kill_process_group, mirror_env_vars};
use crate::models::{AppItem, InstallProgressEvent, InstalledInfo, LocalAppCandidate};
use base64::Engine as _;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};
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
static ADMIN_SHELL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn active_tasks() -> &'static Mutex<HashMap<String, TaskControl>> {
    ACTIVE_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn admin_shell_lock() -> &'static tokio::sync::Mutex<()> {
    ADMIN_SHELL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
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
fn emit_progress_ex(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    stage: &str,
    message: impl Into<String>,
    progress: Option<u8>,
    done: bool,
    success: bool,
    replace_last: bool,
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
            replace_last,
        },
    );
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
    emit_progress_ex(app, task_id, app_id, stage, message, progress, done, success, false);
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

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn format_cmd_line(program: &str, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(program.to_string());
    for arg in args {
        if arg.is_empty()
            || arg.chars().any(|c| {
                c.is_whitespace()
                    || matches!(c, '\'' | '"' | '$' | '`' | '\\' | '&' | '|' | ';' | '(' | ')')
            })
        {
            parts.push(shell_quote(arg));
        } else {
            parts.push((*arg).to_string());
        }
    }
    format!("$ {}", parts.join(" "))
}

fn parse_percent_from_progress_line(line: &str) -> Option<u8> {
    let trimmed = line.trim();
    let pct_idx = trimmed.rfind('%')?;
    let before = &trimmed[..pct_idx];
    let num_start = before
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    let val: f32 = before[num_start..].parse().ok()?;
    if !(0.0..=100.0).contains(&val) {
        return None;
    }
    // Map 0..100% download into 20..88% overall task progress
    let mapped = 20.0 + (val * 0.68);
    Some(mapped.round().clamp(20.0, 88.0) as u8)
}

async fn pump_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    app: AppHandle,
    task_id: String,
    app_id: String,
    stage: String,
    collected: Arc<Mutex<String>>,
) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    let mut prev_was_cr = false;
    let mut has_open_cr_line = false;
    let mut last_cr_emit = Instant::now() - Duration::from_secs(1);

    let emit_line = |raw_bytes: &[u8],
                     is_cr: bool,
                     has_open: &mut bool,
                     last_cr: &mut Instant| {
        let raw = String::from_utf8_lossy(raw_bytes);
        let clean = strip_ansi(&raw);
        let trimmed_end = clean.trim_end_matches(['\r', '\n']);
        if trimmed_end.trim().is_empty() {
            if !is_cr {
                *has_open = false;
            }
            return;
        }
        if is_cr {
            if last_cr.elapsed() < Duration::from_millis(120) {
                return;
            }
            *last_cr = Instant::now();
        }
        if !is_cr {
            let mut guard = collected.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() < 65_536 {
                guard.push_str(trimmed_end);
                guard.push('\n');
            }
        }
        let replace = *has_open;
        *has_open = is_cr;
        let pct = parse_percent_from_progress_line(trimmed_end);
        emit_progress_ex(
            &app,
            &task_id,
            &app_id,
            &stage,
            trimmed_end.to_string(),
            pct,
            false,
            false,
            replace,
        );
    };

    loop {
        let read_res = if !pending.is_empty() || prev_was_cr {
            tokio::time::timeout(Duration::from_millis(150), reader.read(&mut buf)).await
        } else {
            Ok(reader.read(&mut buf).await)
        };

        match read_res {
            Err(_) => {
                // Idle flush for live progress bar lines ending with or paused after `\r`
                if !pending.is_empty() {
                    emit_line(&pending, true, &mut has_open_cr_line, &mut last_cr_emit);
                    pending.clear();
                }
                prev_was_cr = false;
            }
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                for &b in &buf[..n] {
                    if prev_was_cr {
                        prev_was_cr = false;
                        if b == b'\n' {
                            // Standard PTY CRLF line ending
                            emit_line(&pending, false, &mut has_open_cr_line, &mut last_cr_emit);
                            pending.clear();
                            continue;
                        }
                        // Standalone CR: in-place progress bar overwrite
                        emit_line(&pending, true, &mut has_open_cr_line, &mut last_cr_emit);
                        pending.clear();
                    }

                    if b == b'\r' {
                        prev_was_cr = true;
                    } else if b == b'\n' {
                        emit_line(&pending, false, &mut has_open_cr_line, &mut last_cr_emit);
                        pending.clear();
                    } else {
                        pending.push(b);
                    }
                }
            }
            Ok(Err(_)) => break,
        }
    }

    if !pending.is_empty() {
        emit_line(&pending, false, &mut has_open_cr_line, &mut last_cr_emit);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_cmd_stream_inner(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    stage: &str,
    program: &str,
    args: &[&str],
    extra_env: &[(&str, String)],
    ctrl: &TaskControl,
    use_pty: bool,
) -> Result<(bool, String), String> {
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }

    let cmd_preview = if matches!(stage, "brew" | "download") {
        if let Some(proxy_url) = crate::commands::proxy::active_proxy_url() {
            format!(
                "$ https_proxy={} {}",
                shell_quote(&proxy_url),
                format_cmd_line(program, args).trim_start_matches("$ ")
            )
        } else {
            format_cmd_line(program, args)
        }
    } else {
        format_cmd_line(program, args)
    };

    emit_progress(
        app,
        task_id,
        app_id,
        stage,
        cmd_preview,
        None,
        false,
        false,
    );

    let mut cmd = if use_pty && Path::new("/usr/bin/script").exists() {
        let mut c = Command::new("/usr/bin/script");
        c.args(["-q", "/dev/null", program]).args(args);
        c.env("TERM", "xterm-256color").env("COLUMNS", "80");
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };

    cmd.env(
        "PATH",
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
    )
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::commands::proxy::apply_proxy_env(&mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动进程 {program}: {e}"))?;

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
    let collected = Arc::new(Mutex::new(String::new()));

    let t1 = {
        let app_c = app.clone();
        let tid_c = task_id.to_string();
        let aid_c = app_id.to_string();
        let st_c = stage.to_string();
        let col_c = Arc::clone(&collected);
        tokio::spawn(async move {
            if let Some(out) = stdout {
                pump_stream(out, app_c, tid_c, aid_c, st_c, col_c).await;
            }
        })
    };

    let t2 = {
        let app_c = app.clone();
        let tid_c = task_id.to_string();
        let aid_c = app_id.to_string();
        let st_c = stage.to_string();
        let col_c = Arc::clone(&collected);
        tokio::spawn(async move {
            if let Some(err) = stderr {
                pump_stream(err, app_c, tid_c, aid_c, st_c, col_c).await;
            }
        })
    };

    let status = child.wait().await.map_err(|e| e.to_string())?;
    ctrl.set_pid(None);
    let _ = tokio::join!(t1, t2);
    if ctrl.is_cancelled() {
        return Err("已手动终止".to_string());
    }

    let output = collected
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !status.success() {
        let code_str = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        emit_progress(
            app,
            task_id,
            app_id,
            stage,
            format!("[exit code: {code_str}]"),
            None,
            false,
            false,
        );
    }
    Ok((status.success(), output))
}

#[allow(clippy::too_many_arguments)]
async fn run_cmd_stream(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    stage: &str,
    program: &str,
    args: &[&str],
    extra_env: &[(&str, String)],
    ctrl: &TaskControl,
) -> Result<(bool, String), String> {
    run_cmd_stream_inner(app, task_id, app_id, stage, program, args, extra_env, ctrl, false).await
}

#[allow(clippy::too_many_arguments)]
async fn run_cmd_stream_pty(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    stage: &str,
    program: &str,
    args: &[&str],
    extra_env: &[(&str, String)],
    ctrl: &TaskControl,
) -> Result<(bool, String), String> {
    run_cmd_stream_inner(app, task_id, app_id, stage, program, args, extra_env, ctrl, true).await
}

fn brew_output_is_lock_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("another active homebrew")
        || lower.contains("has already locked")
        || lower.contains("already locked")
        || lower.contains("process is already in progress")
}

async fn run_brew_stream(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    brew_path: &str,
    args: &[&str],
    mirror_preset: &str,
    ctrl: &TaskControl,
) -> Result<(bool, String), String> {
    let mut env_pairs: Vec<(&str, String)> = vec![
        ("HOMEBREW_NO_AUTO_UPDATE", "1".to_string()),
        ("HOMEBREW_NO_COLOR", "1".to_string()),
        // Force single-stream curl progress bar (##### 42.3%) in PTY instead of quiet multi-download table
        ("HOMEBREW_DOWNLOAD_CONCURRENCY", "1".to_string()),
    ];
    for (k, v) in mirror_env_vars(mirror_preset) {
        env_pairs.push((k, v.to_string()));
    }

    const MAX_LOCK_RETRIES: u8 = 2;
    let mut attempt: u8 = 0;
    loop {
        let (ok, out) =
            run_cmd_stream_pty(app, task_id, app_id, "brew", brew_path, args, &env_pairs, ctrl)
                .await?;
        if ok || attempt >= MAX_LOCK_RETRIES || !brew_output_is_lock_conflict(&out) {
            return Ok((ok, out));
        }
        attempt += 1;
        emit_progress(
            app,
            task_id,
            app_id,
            "brew",
            format!("# 检测到 Homebrew 并发锁冲突，3 秒后自动重试 ({attempt}/{MAX_LOCK_RETRIES})..."),
            None,
            false,
            false,
        );
        for _ in 0..15 {
            if ctrl.is_cancelled() {
                return Err("已手动终止".to_string());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

fn find_first_with_ext(dir: &Path, ext: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 {
        return None;
    }
    let root_canon = std::fs::canonicalize(dir).ok()?;
    let ext_lower = ext.to_lowercase();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((dir.to_path_buf(), max_depth));

    while let Some((current, remaining_depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        children.sort();

        let mut subdirs: Vec<PathBuf> = Vec::new();
        for p in children {
            // Never follow symlinks (e.g. DMG's `Applications -> /Applications` symlink).
            let Ok(meta) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            let ft = meta.file_type();
            if ft.is_symlink() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Skip hidden metadata files (._*, .Trash, .fseventsd) and macOS zip resource dirs.
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }

            let name_lower = name.to_lowercase();
            if name_lower.ends_with(&ext_lower) {
                let valid_kind = if ext_lower == ".app" {
                    ft.is_dir() && p.join("Contents/Info.plist").exists()
                } else {
                    ft.is_file() || ft.is_dir()
                };
                if valid_kind {
                    if let Ok(p_canon) = std::fs::canonicalize(&p) {
                        if p_canon.starts_with(&root_canon) && p_canon != root_canon {
                            return Some(p);
                        }
                    }
                }
                continue;
            }

            if remaining_depth > 1 && ft.is_dir() && !name_lower.ends_with(".app") {
                subdirs.push(p);
            }
        }

        for sub in subdirs {
            queue.push_back((sub, remaining_depth - 1));
        }
    }
    None
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn validate_app_bundle_source(
    app_bundle: &Path,
    allowed_root: &Path,
    dest: &Path,
) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(app_bundle)
        .map_err(|e| format!("无法读取安装包内的 .app 信息: {e}"))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
        return Err("安装包内的目标不是有效的 .app 目录（已拦截符号链接）".to_string());
    }

    let name = app_bundle
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| {
            !n.is_empty()
                && !n.starts_with('.')
                && !n.contains('/')
                && !n.contains("..")
                && n.to_lowercase().ends_with(".app")
        })
        .ok_or_else(|| "无效的 .app 路径".to_string())?;

    let root_canon = std::fs::canonicalize(allowed_root)
        .map_err(|e| format!("无法解析安装临时目录: {e}"))?;
    let src_canon = std::fs::canonicalize(app_bundle)
        .map_err(|e| format!("无法解析 .app 源路径: {e}"))?;

    if !src_canon.starts_with(&root_canon) || src_canon == root_canon {
        return Err(format!(
            "安全校验失败：检测到源路径越界 ({})，已中止安装以保护现有应用",
            src_canon.display()
        ));
    }

    let apps_dir = Path::new("/Applications");
    let apps_canon = std::fs::canonicalize(apps_dir).unwrap_or_else(|_| apps_dir.to_path_buf());
    if src_canon.starts_with(&apps_canon) {
        return Err(format!(
            "安全校验失败：源路径位于 /Applications 内 ({})，已中止安装",
            src_canon.display()
        ));
    }

    if let Ok(dst_canon) = std::fs::canonicalize(dest) {
        if src_canon == dst_canon {
            return Err("安全校验失败：源路径与目标路径相同，已中止安装".to_string());
        }
    }

    Ok(name.to_string())
}

async fn run_admin_shell(
    shell_cmd: &str,
    log_ctx: Option<(&AppHandle, &str, &str, &str)>,
) -> Result<bool, String> {
    // Serialize macOS administrator auth & PKG installer calls across concurrent tasks.
    let _admin_guard = admin_shell_lock().lock().await;
    if let Some((app, task_id, app_id, stage)) = log_ctx {
        emit_progress(
            app,
            task_id,
            app_id,
            stage,
            format!("$ sudo sh -c {}", shell_quote(shell_cmd)),
            None,
            false,
            false,
        );
    }
    let escaped = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped}\" with administrator privileges");
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("调起系统授权失败: {e}"))?;

    if let Some((app, task_id, app_id, stage)) = log_ctx {
        for raw in [
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ] {
            for line in strip_ansi(&raw).lines() {
                if !line.trim().is_empty() {
                    emit_progress(app, task_id, app_id, stage, line.to_string(), None, false, false);
                }
            }
        }
        if !output.status.success() {
            let code = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            emit_progress(
                app,
                task_id,
                app_id,
                stage,
                format!("[exit code: {code}]"),
                None,
                false,
                false,
            );
        }
    }

    Ok(output.status.success())
}

async fn copy_app_to_applications(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    app_bundle: &Path,
    allowed_root: &Path,
    ctrl: &TaskControl,
) -> Result<String, String> {
    copy_app_to_dir(
        app_bundle,
        allowed_root,
        Path::new("/Applications"),
        true,
        Some((app, task_id, app_id, ctrl)),
    )
    .await
}

async fn copy_app_to_dir(
    app_bundle: &Path,
    allowed_root: &Path,
    target_dir: &Path,
    allow_admin_fallback: bool,
    log_ctx: Option<(&AppHandle, &str, &str, &TaskControl)>,
) -> Result<String, String> {
    let provisional_name = app_bundle
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无效的 .app 路径".to_string())?;
    let dest = target_dir.join(provisional_name);
    let name = validate_app_bundle_source(app_bundle, allowed_root, &dest)?;
    let dest = target_dir.join(&name);

    let uid = uuid::Uuid::new_v4().simple().to_string();
    let stage = target_dir.join(format!(".{name}.starbox-stage-{uid}"));
    let backup = target_dir.join(format!(".{name}.starbox-backup-{uid}"));

    let src_s = app_bundle.to_string_lossy();
    let dst_s = dest.to_string_lossy();
    let stage_s = stage.to_string_lossy();
    let bak_s = backup.to_string_lossy();

    // Try user-level atomic stage-and-swap first so an existing app is never deleted before ditto succeeds.
    let stage_ok = if let Some((app, task_id, app_id, ctrl)) = log_ctx {
        run_cmd_stream(
            app,
            task_id,
            app_id,
            "install",
            "ditto",
            &[src_s.as_ref(), stage_s.as_ref()],
            &[],
            ctrl,
        )
        .await?
        .0
    } else {
        Command::new("ditto")
            .args([src_s.as_ref(), stage_s.as_ref()])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    };

    if stage_ok {
        if let Some((app, task_id, app_id, ctrl)) = log_ctx {
            let _ = run_cmd_stream(
                app,
                task_id,
                app_id,
                "install",
                "xattr",
                &["-dr", "com.apple.quarantine", stage_s.as_ref()],
                &[],
                ctrl,
            )
            .await;
        } else {
            let _ = Command::new("xattr")
                .args(["-dr", "com.apple.quarantine", stage_s.as_ref()])
                .status()
                .await;
        }

        if dest.symlink_metadata().is_ok() {
            if std::fs::rename(&dest, &backup).is_ok() {
                if std::fs::rename(&stage, &dest).is_ok() {
                    if let Some((app, task_id, app_id, _)) = log_ctx {
                        emit_progress(
                            app,
                            task_id,
                            app_id,
                            "install",
                            format!("$ mv {} {}", shell_quote(stage_s.as_ref()), shell_quote(dst_s.as_ref())),
                            Some(96),
                            false,
                            false,
                        );
                    }
                    let _ = std::fs::remove_dir_all(&backup);
                    return Ok(dst_s.to_string());
                }
                let _ = std::fs::rename(&backup, &dest);
            }
            let _ = std::fs::remove_dir_all(&stage);
        } else if std::fs::rename(&stage, &dest).is_ok() {
            if let Some((app, task_id, app_id, _)) = log_ctx {
                emit_progress(
                    app,
                    task_id,
                    app_id,
                    "install",
                    format!("$ mv {} {}", shell_quote(stage_s.as_ref()), shell_quote(dst_s.as_ref())),
                    Some(96),
                    false,
                    false,
                );
            }
            return Ok(dst_s.to_string());
        } else {
            let _ = std::fs::remove_dir_all(&stage);
        }
    } else {
        let _ = std::fs::remove_dir_all(&stage);
    }

    if !allow_admin_fallback {
        return Err("复制应用失败".to_string());
    }

    // Fallback to native macOS administrator privileges dialog using the same safe stage-and-swap.
    let q_src = shell_quote(src_s.as_ref());
    let q_dst = shell_quote(dst_s.as_ref());
    let q_stage = shell_quote(stage_s.as_ref());
    let q_bak = shell_quote(bak_s.as_ref());
    let cmd = format!(
        "set -e; rm -rf {q_stage} {q_bak}; if ! ditto {q_src} {q_stage}; then rm -rf {q_stage} || true; exit 1; fi; (xattr -dr com.apple.quarantine {q_stage} >/dev/null 2>&1 || true); if [ -e {q_dst} ] || [ -L {q_dst} ]; then mv {q_dst} {q_bak}; if ! mv {q_stage} {q_dst}; then mv {q_bak} {q_dst} || true; rm -rf {q_stage} || true; exit 1; fi; rm -rf {q_bak} || true; else mv {q_stage} {q_dst}; fi"
    );
    let admin_log = log_ctx.map(|(app, tid, aid, _)| (app, tid, aid, "install"));
    if run_admin_shell(&cmd, admin_log).await? && dest.exists() {
        Ok(dst_s.to_string())
    } else {
        Err("管理员授权被取消或复制应用失败".to_string())
    }
}

async fn install_pkg_file(
    app: &AppHandle,
    task_id: &str,
    app_id: &str,
    pkg_path: &Path,
) -> Result<(), String> {
    let p = pkg_path.to_string_lossy();
    let cmd = format!("installer -verboseR -pkg {} -target /", shell_quote(p.as_ref()));
    if run_admin_shell(&cmd, Some((app, task_id, app_id, "install"))).await? {
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
    ctrl: &TaskControl,
) -> Result<(), String> {
    let lower = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if lower.ends_with(".dmg") {
        let mnt = work_dir.join("mnt");
        std::fs::create_dir_all(&mnt).map_err(|e| e.to_string())?;
        emit_progress(app, task_id, app_id, "install", "# Mounting DMG...", Some(82), false, false);

        let (attach_ok, _) = run_cmd_stream(
            app,
            task_id,
            app_id,
            "install",
            "hdiutil",
            &[
                "attach",
                file.to_string_lossy().as_ref(),
                "-readonly",
                "-nobrowse",
                "-mountpoint",
                mnt.to_string_lossy().as_ref(),
            ],
            &[],
            ctrl,
        )
        .await?;

        if !attach_ok {
            return Err("无法挂载 DMG 安装包".to_string());
        }

        let res = if let Some(app_bundle) = find_first_with_ext(&mnt, ".app", 2) {
            emit_progress(
                app,
                task_id,
                app_id,
                "install",
                format!("# Found app bundle: {}", app_bundle.display()),
                Some(90),
                false,
                false,
            );
            copy_app_to_applications(app, task_id, app_id, &app_bundle, &mnt, ctrl)
                .await
                .map(|_| ())
        } else if let Some(pkg) = find_first_with_ext(&mnt, ".pkg", 2) {
            emit_progress(
                app,
                task_id,
                app_id,
                "install",
                format!("# Found installer package: {}", pkg.display()),
                Some(90),
                false,
                false,
            );
            install_pkg_file(app, task_id, app_id, &pkg).await
        } else {
            Err("DMG 镜像中未找到 .app 或 .pkg".to_string())
        };

        let _ = run_cmd_stream(
            app,
            task_id,
            app_id,
            "install",
            "hdiutil",
            &["detach", mnt.to_string_lossy().as_ref(), "-force"],
            &[],
            ctrl,
        )
        .await;

        res
    } else if lower.ends_with(".pkg") {
        install_pkg_file(app, task_id, app_id, file).await
    } else if lower.ends_with(".zip") {
        let unzip = work_dir.join("unzip");
        std::fs::create_dir_all(&unzip).map_err(|e| e.to_string())?;
        emit_progress(app, task_id, app_id, "install", "# Extracting ZIP archive...", Some(82), false, false);

        let (ok, _) = run_cmd_stream(
            app,
            task_id,
            app_id,
            "install",
            "ditto",
            &[
                "-x",
                "-k",
                file.to_string_lossy().as_ref(),
                unzip.to_string_lossy().as_ref(),
            ],
            &[],
            ctrl,
        )
        .await?;

        if !ok {
            return Err("ZIP 解压失败".to_string());
        }

        if let Some(app_bundle) = find_first_with_ext(&unzip, ".app", 3) {
            emit_progress(
                app,
                task_id,
                app_id,
                "install",
                format!("# Found app bundle: {}", app_bundle.display()),
                Some(90),
                false,
                false,
            );
            copy_app_to_applications(app, task_id, app_id, &app_bundle, &unzip, ctrl)
                .await
                .map(|_| ())
        } else if let Some(pkg) = find_first_with_ext(&unzip, ".pkg", 3) {
            install_pkg_file(app, task_id, app_id, &pkg).await
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
        format!("# Fetching latest release from https://api.github.com/repos/{repo}/releases/latest"),
        Some(15),
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
        format!("# Release {}: {} ({asset_url})", rel.tag_name, asset_name),
        Some(25),
        false,
        false,
    );

    let curl_res = run_cmd_stream_pty(
        app,
        task_id,
        app_id,
        "download",
        "/usr/bin/curl",
        &[
            "-fL",
            "--progress-bar",
            "--retry",
            "2",
            "-o",
            file_path.to_string_lossy().as_ref(),
            asset_url.as_str(),
        ],
        &[],
        ctrl,
    )
    .await;

    match curl_res {
        Ok((true, _)) => {}
        Ok((false, _)) => {
            let _ = std::fs::remove_dir_all(&work_dir);
            return Err(format!("curl 下载 {asset_name} 失败"));
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work_dir);
            return Err(e);
        }
    }

    if ctrl.is_cancelled() {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err("已手动终止".to_string());
    }

    let res = install_downloaded_package(app, task_id, app_id, &file_path, &work_dir, ctrl).await;
    let _ = std::fs::remove_dir_all(&work_dir);
    res
}

fn resolve_website_fallback(item: &AppItem) -> Option<String> {
    if let Some(ref w) = item.website {
        let trimmed = w.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(ref repo) = item.github_repo {
        let trimmed = repo.trim().trim_matches('/');
        if !trimmed.is_empty() {
            return Some(format!("https://github.com/{trimmed}/releases"));
        }
    }
    None
}

fn brew_output_needs_adopt(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("already an app")
        || lower.contains("already exists")
        || lower.contains("--adopt")
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
        format!("# 代理通道: {}", crate::commands::proxy::describe_active_proxy()),
        Some(10),
        false,
        false,
    );

    let has_brew_target = item
        .brew_formula
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || !item.brew_casks.is_empty();
    let has_github_target = item
        .github_repo
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // 1. Always try Homebrew first (formula / casks)
    if has_brew_target {
        if let Some(brew) = find_brew_path() {
            if let Some(ref formula) = item.brew_formula {
                let f = formula.trim();
                if !f.is_empty() {
                    emit_progress(&app, &task_id, &item.id, "brew", format!("# [1/3] Homebrew Formula: {f}"), Some(15), false, false);
                    let res = run_brew_stream(
                        &app,
                        &task_id,
                        &item.id,
                        &brew,
                        &["install", f],
                        &mirror_preset,
                        ctrl,
                    )
                    .await;
                    if ctrl.is_cancelled() {
                        emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                        return Err("已手动终止".to_string());
                    }
                    if matches!(res, Ok((true, _))) {
                        emit_progress(&app, &task_id, &item.id, "done", format!("{} 安装完成（Homebrew）", item.name), Some(100), true, true);
                        return Ok(());
                    }
                }
            }

            for cask in &item.brew_casks {
                let c = cask.trim();
                if c.is_empty() {
                    continue;
                }
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".to_string());
                }
                emit_progress(&app, &task_id, &item.id, "brew", format!("# [1/3] Homebrew Cask: {c}"), Some(20), false, false);
                let first_res = run_brew_stream(
                    &app,
                    &task_id,
                    &item.id,
                    &brew,
                    &["install", "--cask", c],
                    &mirror_preset,
                    ctrl,
                )
                .await;
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".to_string());
                }
                let (first_ok, first_out) = match first_res {
                    Ok(v) => v,
                    Err(e) => {
                        emit_progress(&app, &task_id, &item.id, "brew", format!("# brew 执行出错: {e}"), None, false, false);
                        (false, String::new())
                    }
                };
                if first_ok {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 安装完成（Homebrew）", item.name), Some(100), true, true);
                    return Ok(());
                }

                // Only try --adopt when Homebrew reports an existing app conflict
                if brew_output_needs_adopt(&first_out) {
                    emit_progress(&app, &task_id, &item.id, "brew", format!("# 检测到已有同名应用，尝试 --adopt 接管: {c}"), Some(40), false, false);
                    let adopt_res = run_brew_stream(
                        &app,
                        &task_id,
                        &item.id,
                        &brew,
                        &["install", "--cask", "--adopt", c],
                        &mirror_preset,
                        ctrl,
                    )
                    .await;
                    if ctrl.is_cancelled() {
                        emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                        return Err("已手动终止".to_string());
                    }
                    if matches!(adopt_res, Ok((true, _))) {
                        emit_progress(&app, &task_id, &item.id, "done", format!("{} 已安装并接管（Homebrew）", item.name), Some(100), true, true);
                        return Ok(());
                    }
                }
            }
        } else {
            emit_progress(&app, &task_id, &item.id, "brew", "# 未检测到 Homebrew，跳过 brew 安装", Some(15), false, false);
        }
    }

    if ctrl.is_cancelled() {
        emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
        return Err("已手动终止".to_string());
    }

    // 2. Fallback to GitHub Releases if configured
    if has_github_target {
        if let Some(ref repo) = item.github_repo {
            let repo = repo.trim();
            emit_progress(
                &app,
                &task_id,
                &item.id,
                "github",
                if has_brew_target {
                    format!("# [2/3] Homebrew 未成功，回退到 GitHub Releases: {repo}")
                } else {
                    format!("# [2/3] 使用 GitHub Releases 安装: {repo}")
                },
                Some(50),
                false,
                false,
            );
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
                    emit_progress(&app, &task_id, &item.id, "github", format!("# GitHub Releases 安装失败: {e}"), None, false, false);
                }
            }
        }
    }

    // 3. Final fallback: provide official website link for manual download
    let msg = if let Some(url) = resolve_website_fallback(&item) {
        format!("# [3/3] 无法自动安装，请前往官网下载: {url}")
    } else {
        format!("{} 自动安装失败，且未配置官网链接", item.name)
    };
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

    emit_progress(
        &app,
        &task_id,
        &item.id,
        "start",
        format!("# 代理通道: {}", crate::commands::proxy::describe_active_proxy()),
        Some(10),
        false,
        false,
    );

    if let Some(brew) = find_brew_path() {
        if let Some(ref formula) = item.brew_formula {
            let f = formula.trim();
            if !f.is_empty() {
                emit_progress(&app, &task_id, &item.id, "brew", format!("# [1/3] Homebrew upgrade formula: {f}"), Some(20), false, false);
                let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["upgrade", f], &mirror_preset, ctrl).await;
                if ctrl.is_cancelled() {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err("已手动终止".into());
                }
                if matches!(res, Ok((true, _))) {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 已更新到最新版本（Homebrew）", item.name), Some(100), true, true);
                    return Ok(());
                }
            }
        }
        for cask in &item.brew_casks {
            let c = cask.trim();
            if c.is_empty() {
                continue;
            }
            emit_progress(&app, &task_id, &item.id, "brew", format!("# [1/3] Homebrew upgrade cask: {c}"), Some(20), false, false);
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["upgrade", "--cask", c], &mirror_preset, ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            if matches!(res, Ok((true, _))) {
                emit_progress(&app, &task_id, &item.id, "done", format!("{} 已更新到最新版本（Homebrew）", item.name), Some(100), true, true);
                return Ok(());
            }
        }
    }

    if let Some(ref repo) = item.github_repo {
        let repo = repo.trim();
        if !repo.is_empty() {
            emit_progress(&app, &task_id, &item.id, "github", format!("# [2/3] 回退到 GitHub Releases 更新: {repo}"), Some(50), false, false);
            match install_via_github(&app, &task_id, &item.id, repo, ctrl).await {
                Ok(()) => {
                    emit_progress(&app, &task_id, &item.id, "done", format!("{} 已更新完成（GitHub Releases）", item.name), Some(100), true, true);
                    return Ok(());
                }
                Err(e) if ctrl.is_cancelled() => {
                    emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                    return Err(e);
                }
                Err(e) => {
                    emit_progress(&app, &task_id, &item.id, "github", format!("# GitHub Releases 更新失败: {e}"), None, false, false);
                }
            }
        }
    }

    let msg = if let Some(url) = resolve_website_fallback(&item) {
        format!("# [3/3] 无法自动更新，请前往官网下载最新版: {url}")
    } else {
        "无法自动更新该软件".to_string()
    };
    emit_progress(&app, &task_id, &item.id, "error", &msg, None, true, false);
    Err(msg)
}

#[tauri::command]
pub async fn uninstall_app(app: AppHandle, task_id: String, item: AppItem) -> Result<(), String> {
    let guard = TaskGuard::register(&task_id);
    let ctrl = &guard.ctrl;

    emit_progress(&app, &task_id, &item.id, "start", format!("# Uninstalling {}", item.name), Some(20), false, false);

    if let Some(brew) = find_brew_path() {
        if let Some(ref formula) = item.brew_formula {
            let res = run_brew_stream(&app, &task_id, &item.id, &brew, &["uninstall", formula.as_str()], "official", ctrl).await;
            if ctrl.is_cancelled() {
                emit_progress(&app, &task_id, &item.id, "cancelled", "已手动终止", None, true, false);
                return Err("已手动终止".into());
            }
            if matches!(res, Ok((true, _))) {
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
            if matches!(res, Ok((true, _))) {
                emit_progress(&app, &task_id, &item.id, "done", format!("{} 已卸载", item.name), Some(100), true, true);
                return Ok(());
            }
        }
    }

    if let Some(path) = find_existing_app(&item.dock_apps) {
        if !path.starts_with("/System/") {
            emit_progress(&app, &task_id, &item.id, "uninstall", format!("$ rm -rf {}", shell_quote(&path)), None, false, false);
            let rm_ok = std::fs::remove_dir_all(&path).is_ok()
                || run_admin_shell(
                    &format!("rm -rf {}", shell_quote(&path)),
                    Some((&app, &task_id, &item.id, "uninstall")),
                )
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
            if !file_name.ends_with(".app") || file_name == "Safari.app" {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn make_fake_app(dir: &Path, name: &str) -> PathBuf {
        let app = dir.join(name);
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), "<plist/>").unwrap();
        app
    }

    #[test]
    fn dmg_applications_symlink_is_never_followed() {
        let tmp = std::env::temp_dir().join(format!("starbox-test-{}", uuid::Uuid::new_v4()));
        let fake_apps = tmp.join("fake_applications");
        let mnt = tmp.join("mnt");
        std::fs::create_dir_all(&fake_apps).unwrap();
        std::fs::create_dir_all(&mnt).unwrap();

        // Populate fake /Applications with Star Box.app
        make_fake_app(&fake_apps, "Star Box.app");
        // Create DMG-style `Applications -> fake_applications` symlink (alphabetically before Clash Verge.app)
        symlink(&fake_apps, mnt.join("Applications")).unwrap();
        // Actual app in DMG
        let clash = make_fake_app(&mnt, "Clash Verge.app");

        let found = find_first_with_ext(&mnt, ".app", 2);
        assert_eq!(found, Some(clash));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn dmg_with_only_applications_symlink_returns_none() {
        let tmp = std::env::temp_dir().join(format!("starbox-test-{}", uuid::Uuid::new_v4()));
        let fake_apps = tmp.join("fake_applications");
        let mnt = tmp.join("mnt");
        std::fs::create_dir_all(&fake_apps).unwrap();
        std::fs::create_dir_all(&mnt).unwrap();

        make_fake_app(&fake_apps, "Star Box.app");
        symlink(&fake_apps, mnt.join("Applications")).unwrap();

        let found = find_first_with_ext(&mnt, ".app", 2);
        assert_eq!(found, None);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn zip_skips_macosx_and_prefers_shallow_app() {
        let tmp = std::env::temp_dir().join(format!("starbox-test-{}", uuid::Uuid::new_v4()));
        let unzip = tmp.join("unzip");
        std::fs::create_dir_all(unzip.join("__MACOSX")).unwrap();
        make_fake_app(&unzip.join("__MACOSX"), "._Clash Verge.app");
        make_fake_app(&unzip.join("__MACOSX"), "Fake.app");

        let nested = unzip.join("release");
        std::fs::create_dir_all(&nested).unwrap();
        let real_app = make_fake_app(&nested, "Clash Verge.app");

        let found = find_first_with_ext(&unzip, ".app", 3);
        assert_eq!(found, Some(real_app));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_app_bundle_rejects_escaped_symlink_source() {
        let tmp = std::env::temp_dir().join(format!("starbox-test-{}", uuid::Uuid::new_v4()));
        let fake_apps = tmp.join("fake_applications");
        let mnt = tmp.join("mnt");
        std::fs::create_dir_all(&fake_apps).unwrap();
        std::fs::create_dir_all(&mnt).unwrap();

        let star_box = make_fake_app(&fake_apps, "Star Box.app");
        symlink(&fake_apps, mnt.join("Applications")).unwrap();
        let escaped = mnt.join("Applications").join("Star Box.app");

        // Even though `escaped` itself is not a symlink (its parent is), canonicalize catches escape!
        let err = validate_app_bundle_source(&escaped, &mnt, &star_box).unwrap_err();
        assert!(err.contains("越界"), "unexpected error: {err}");

        // Direct symlink to .app is also rejected
        let direct_link = mnt.join("Star Box.app");
        symlink(&star_box, &direct_link).unwrap();
        let err2 = validate_app_bundle_source(&direct_link, &mnt, &star_box).unwrap_err();
        assert!(err2.contains("符号链接"), "unexpected error: {err2}");

        // Real app inside mnt passes
        let clash = make_fake_app(&mnt, "Clash Verge.app");
        let ok = validate_app_bundle_source(
            &clash,
            &mnt,
            &fake_apps.join("Clash Verge.app"),
        );
        assert_eq!(ok.unwrap(), "Clash Verge.app");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn real_dmg_with_applications_symlink_installs_app_and_preserves_existing() {
        let tmp = std::env::temp_dir().join(format!("starbox-dmg-test-{}", uuid::Uuid::new_v4()));
        let dmg_src = tmp.join("dmg_src");
        let dmg_file = tmp.join("ClashVergeTest.dmg");
        let mnt = tmp.join("mnt");
        let target_apps = tmp.join("target_apps");
        std::fs::create_dir_all(&dmg_src).unwrap();
        std::fs::create_dir_all(&mnt).unwrap();
        std::fs::create_dir_all(&target_apps).unwrap();

        // Pre-existing Star Box.app in target dir (must remain untouched!)
        let star_box = make_fake_app(&target_apps, "Star Box.app");
        std::fs::write(star_box.join("Contents/marker.txt"), "star-box-intact").unwrap();

        // Pre-existing old Clash Verge.app to also verify atomic upgrade
        let old_clash = make_fake_app(&target_apps, "Clash Verge.app");
        std::fs::write(old_clash.join("Contents/version.txt"), "v1").unwrap();

        // Build real DMG source containing symlink `Applications -> /Applications` AND real `Clash Verge.app`
        symlink(Path::new("/Applications"), dmg_src.join("Applications")).unwrap();
        let src_clash = make_fake_app(&dmg_src, "Clash Verge.app");
        std::fs::write(src_clash.join("Contents/version.txt"), "v2").unwrap();

        let create = Command::new("hdiutil")
            .args([
                "create",
                "-volname",
                "ClashVergeTest",
                "-srcfolder",
                dmg_src.to_string_lossy().as_ref(),
                "-ov",
                "-format",
                "UDZO",
                dmg_file.to_string_lossy().as_ref(),
            ])
            .status()
            .await
            .unwrap();
        assert!(create.success(), "hdiutil create failed");

        let attach = Command::new("hdiutil")
            .args([
                "attach",
                dmg_file.to_string_lossy().as_ref(),
                "-readonly",
                "-nobrowse",
                "-quiet",
                "-mountpoint",
                mnt.to_string_lossy().as_ref(),
            ])
            .status()
            .await
            .unwrap();
        assert!(attach.success(), "hdiutil attach failed");

        let found = find_first_with_ext(&mnt, ".app", 2);
        assert_eq!(
            found.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()),
            Some("Clash Verge.app"),
            "must select Clash Verge.app, not anything from /Applications symlink"
        );

        let installed = copy_app_to_dir(found.as_ref().unwrap(), &mnt, &target_apps, false, None)
            .await
            .unwrap();
        assert_eq!(PathBuf::from(&installed), target_apps.join("Clash Verge.app"));

        // Verify Clash Verge.app upgraded cleanly to v2
        let ver = std::fs::read_to_string(target_apps.join("Clash Verge.app/Contents/version.txt")).unwrap();
        assert_eq!(ver, "v2");

        // Verify Star Box.app is completely untouched
        let marker = std::fs::read_to_string(target_apps.join("Star Box.app/Contents/marker.txt")).unwrap();
        assert_eq!(marker, "star-box-intact");

        // Verify no leftover staging/backup dirs in target_apps
        let leftovers: Vec<_> = std::fs::read_dir(&target_apps)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("starbox-"))
            .collect();
        assert!(leftovers.is_empty(), "unexpected leftover staging/backup dirs: {leftovers:?}");

        let _ = Command::new("hdiutil")
            .args(["detach", mnt.to_string_lossy().as_ref(), "-quiet", "-force"])
            .status()
            .await;
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn strip_ansi_and_format_cmd_line_preserve_raw_cli_output() {
        assert_eq!(
            strip_ansi("\x1b[34m==>\x1b[0m Downloading \x1b[1mhttps://example.com/a.dmg\x1b[0m"),
            "==> Downloading https://example.com/a.dmg"
        );
        assert_eq!(
            format_cmd_line("/opt/homebrew/bin/brew", &["install", "--cask", "clash-verge-rev"]),
            "$ /opt/homebrew/bin/brew install --cask clash-verge-rev"
        );
        assert_eq!(
            format_cmd_line("ditto", &["/tmp/Clash Verge.app", "/Applications/Clash Verge.app"]),
            "$ ditto '/tmp/Clash Verge.app' '/Applications/Clash Verge.app'"
        );
        assert_eq!(
            parse_percent_from_progress_line("###########################################                                59.2%"),
            Some(60)
        );
        assert_eq!(
            parse_percent_from_progress_line("######################################################################### 100.0%"),
            Some(88)
        );
        assert_eq!(parse_percent_from_progress_line("==> Downloading https://example.com/a.dmg"), None);
    }

    #[test]
    fn brew_adopt_detection_and_website_fallback() {
        assert!(brew_output_needs_adopt("Error: It seems there is already an App at '/Applications/Clash Verge.app'."));
        assert!(!brew_output_needs_adopt("curl: (28) Connection timed out"));
        assert!(brew_output_is_lock_conflict("Error: Another active Homebrew process is already in progress."));
        assert!(brew_output_is_lock_conflict("Error: Process 1234 has already locked /opt/homebrew/var/homebrew/locks/foo."));
        assert!(!brew_output_is_lock_conflict("curl: (28) Connection timed out"));

        let mut item = AppItem {
            id: "test".into(),
            name: "Test".into(),
            description: None,
            group: "dev".into(),
            kind: "cask".into(),
            brew_casks: vec![],
            brew_formula: None,
            github_repo: Some("owner/repo".into()),
            website: Some("https://example.com/download".into()),
            dock_apps: vec![],
            icon_url: None,
        };
        assert_eq!(
            resolve_website_fallback(&item).as_deref(),
            Some("https://example.com/download")
        );
        item.website = None;
        assert_eq!(
            resolve_website_fallback(&item).as_deref(),
            Some("https://github.com/owner/repo/releases")
        );
    }
}
