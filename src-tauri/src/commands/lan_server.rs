use crate::commands::env::home_dir;
use crate::commands::proxy::detect_local_lan_ipv4s;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const DEFAULT_PORT: u16 = 8080;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_UPLOAD_BYTES: u64 = 10 * 1024 * 1024 * 1024; // 10 GiB safety cap
const MAX_RECENT_LOGS: usize = 120;
const STREAM_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanServerConfig {
    pub root_dir: Option<String>,
    pub port: u16,
    pub show_hidden: bool,
    pub serve_index: bool,
    pub allow_upload: bool,
}

impl Default for LanServerConfig {
    fn default() -> Self {
        Self {
            root_dir: None,
            port: DEFAULT_PORT,
            show_hidden: false,
            serve_index: false,
            allow_upload: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanServerLogEntry {
    pub id: u64,
    pub time: String,
    pub client_ip: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanServerStatus {
    pub running: bool,
    pub root_dir: Option<String>,
    pub port: u16,
    pub show_hidden: bool,
    pub serve_index: bool,
    pub allow_upload: bool,
    pub urls: Vec<String>,
    pub primary_url: Option<String>,
    pub started_at: Option<String>,
    pub request_count: u64,
    pub recent_logs: Vec<LanServerLogEntry>,
}

struct ServerRuntime {
    config: LanServerConfig,
    running: bool,
    urls: Vec<String>,
    primary_url: Option<String>,
    started_at: Option<String>,
    request_count: u64,
    log_seq: u64,
    recent_logs: VecDeque<LanServerLogEntry>,
    shutdown_tx: Option<watch::Sender<bool>>,
    accept_handle: Option<JoinHandle<()>>,
}

impl ServerRuntime {
    fn new(config: LanServerConfig) -> Self {
        Self {
            config,
            running: false,
            urls: Vec::new(),
            primary_url: None,
            started_at: None,
            request_count: 0,
            log_seq: 0,
            recent_logs: VecDeque::with_capacity(MAX_RECENT_LOGS),
            shutdown_tx: None,
            accept_handle: None,
        }
    }

    fn snapshot(&self) -> LanServerStatus {
        LanServerStatus {
            running: self.running,
            root_dir: self.config.root_dir.clone(),
            port: self.config.port,
            show_hidden: self.config.show_hidden,
            serve_index: self.config.serve_index,
            allow_upload: self.config.allow_upload,
            urls: self.urls.clone(),
            primary_url: self.primary_url.clone(),
            started_at: self.started_at.clone(),
            request_count: self.request_count,
            recent_logs: self.recent_logs.iter().cloned().collect(),
        }
    }
}

static SERVER_STATE: OnceLock<Arc<RwLock<ServerRuntime>>> = OnceLock::new();

fn config_path() -> PathBuf {
    home_dir()
        .join("Library/Application Support/com.starandget.starbox")
        .join("lan_server.json")
}

fn load_config_from_disk() -> LanServerConfig {
    let mut cfg = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<LanServerConfig>(&s).ok())
        .unwrap_or_default();
    if cfg.port == 0 {
        cfg.port = DEFAULT_PORT;
    }
    cfg
}

fn save_config_to_disk(cfg: &LanServerConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("保存局域网服务器配置失败: {e}"))
}

fn runtime_state() -> &'static Arc<RwLock<ServerRuntime>> {
    SERVER_STATE.get_or_init(|| Arc::new(RwLock::new(ServerRuntime::new(load_config_from_disk()))))
}

fn record_log(
    app: &AppHandle,
    client_ip: &str,
    method: &str,
    path: &str,
    status: u16,
    detail: Option<String>,
) {
    let entry = {
        let mut guard = match runtime_state().write() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.request_count = guard.request_count.saturating_add(1);
        guard.log_seq = guard.log_seq.saturating_add(1);
        let entry = LanServerLogEntry {
            id: guard.log_seq,
            time: Local::now().format("%H:%M:%S").to_string(),
            client_ip: client_ip.to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status,
            detail,
        };
        guard.recent_logs.push_front(entry.clone());
        while guard.recent_logs.len() > MAX_RECENT_LOGS {
            guard.recent_logs.pop_back();
        }
        entry
    };
    let _ = app.emit("lan-server-log", &entry);
}

fn validate_port(port: u16) -> Result<u16, String> {
    if port < 1024 {
        return Err("端口请设置在 1024 ~ 65535 之间（避免需要管理员权限的系统保留端口）".to_string());
    }
    Ok(port)
}

async fn stop_running_server_internal() {
    let (tx, handle) = {
        let mut guard = match runtime_state().write() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.running = false;
        guard.urls.clear();
        guard.primary_url = None;
        guard.started_at = None;
        (guard.shutdown_tx.take(), guard.accept_handle.take())
    };

    if let Some(tx) = tx {
        let _ = tx.send(true);
    }
    if let Some(handle) = handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }
}

async fn build_access_urls(port: u16) -> (Vec<String>, Option<String>) {
    let lan_ips = detect_local_lan_ipv4s().await;
    let mut urls: Vec<String> = lan_ips
        .into_iter()
        .map(|ip| format!("http://{ip}:{port}"))
        .collect();
    let primary = urls
        .first()
        .cloned()
        .or_else(|| Some(format!("http://127.0.0.1:{port}")));
    urls.push(format!("http://127.0.0.1:{port}"));
    (urls, primary)
}

#[tauri::command]
pub async fn get_lan_server_status() -> Result<LanServerStatus, String> {
    let mut snapshot = runtime_state()
        .read()
        .map_err(|e| e.to_string())?
        .snapshot();

    if snapshot.running {
        let (urls, primary_url) = build_access_urls(snapshot.port).await;
        if let Ok(mut guard) = runtime_state().write() {
            if guard.running {
                guard.urls = urls.clone();
                guard.primary_url = primary_url.clone();
            }
        }
        snapshot.urls = urls;
        snapshot.primary_url = primary_url;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn update_lan_server_config(
    root_dir: Option<String>,
    port: u16,
    show_hidden: bool,
    serve_index: bool,
    allow_upload: bool,
) -> Result<LanServerStatus, String> {
    let port = validate_port(port)?;
    let normalized_root = root_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let snapshot = {
        let mut guard = runtime_state().write().map_err(|e| e.to_string())?;
        // Only update root_dir and port in config when not running, or save desired values
        if !guard.running {
            guard.config.root_dir = normalized_root;
            guard.config.port = port;
        }
        guard.config.show_hidden = show_hidden;
        guard.config.serve_index = serve_index;
        guard.config.allow_upload = allow_upload;
        save_config_to_disk(&guard.config)?;
        guard.snapshot()
    };
    Ok(snapshot)
}

#[tauri::command]
pub async fn start_lan_server(
    app: AppHandle,
    root_dir: String,
    port: u16,
    show_hidden: bool,
    serve_index: bool,
    allow_upload: bool,
) -> Result<LanServerStatus, String> {
    let port = validate_port(port)?;
    let trimmed_root = root_dir.trim().to_string();
    if trimmed_root.is_empty() {
        return Err("请先选择要展示的本地目录".to_string());
    }

    let root_path = PathBuf::from(&trimmed_root);
    let meta = fs::metadata(&root_path)
        .await
        .map_err(|_| format!("目录不存在或无权限访问：{trimmed_root}"))?;
    if !meta.is_dir() {
        return Err(format!("所选路径不是有效目录：{trimmed_root}"));
    }
    let canonical_root = fs::canonicalize(&root_path)
        .await
        .map_err(|e| format!("解析目录路径失败: {e}"))?;

    // Stop any previous server instance cleanly so the port is released
    stop_running_server_internal().await;

    let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(bind_addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("端口 {port} 已被其他程序占用，请更换端口后重试")
        } else {
            format!("启动监听 0.0.0.0:{port} 失败: {e}")
        }
    })?;

    let (urls, primary_url) = build_access_urls(port).await;
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let canonical_for_loop = canonical_root.clone();
    let app_for_loop = app.clone();
    let accept_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer_addr)) => {
                            let root = canonical_for_loop.clone();
                            let app_handle = app_for_loop.clone();
                            tokio::spawn(async move {
                                handle_connection(stream, peer_addr, root, app_handle).await;
                            });
                        }
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    });

    let cfg = LanServerConfig {
        root_dir: Some(trimmed_root),
        port,
        show_hidden,
        serve_index,
        allow_upload,
    };
    let _ = save_config_to_disk(&cfg);

    let snapshot = {
        let mut guard = runtime_state().write().map_err(|e| e.to_string())?;
        guard.config = cfg;
        guard.running = true;
        guard.urls = urls;
        guard.primary_url = primary_url;
        guard.started_at = Some(Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
        guard.request_count = 0;
        guard.recent_logs.clear();
        guard.shutdown_tx = Some(shutdown_tx);
        guard.accept_handle = Some(accept_handle);
        guard.snapshot()
    };

    Ok(snapshot)
}

#[tauri::command]
pub async fn stop_lan_server() -> Result<LanServerStatus, String> {
    stop_running_server_internal().await;
    let snapshot = runtime_state()
        .read()
        .map_err(|e| e.to_string())?
        .snapshot();
    Ok(snapshot)
}

#[tauri::command]
pub async fn clear_lan_server_logs() -> Result<LanServerStatus, String> {
    let snapshot = {
        let mut guard = runtime_state().write().map_err(|e| e.to_string())?;
        guard.recent_logs.clear();
        guard.snapshot()
    };
    Ok(snapshot)
}

#[tauri::command]
pub async fn open_folder_in_finder(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径为空".to_string());
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg(trimmed)
        .status()
        .await
        .map_err(|e| format!("无法打开访达: {e}"))?;
    if !status.success() {
        return Err("打开访达失败，请检查目录是否存在".to_string());
    }
    Ok(())
}

/// Gracefully stops the server on app exit if running.
pub fn shutdown_if_running() {
    if let Ok(mut guard) = runtime_state().write() {
        guard.running = false;
        if let Some(tx) = guard.shutdown_tx.take() {
            let _ = tx.send(true);
        }
    }
}

// ============================================================================
// HTTP/1.1 Server Implementation
// ============================================================================

struct HttpRequestHead {
    method: String,
    raw_path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    leftover: Vec<u8>,
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequestHead, u16> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];

    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() >= MAX_HEADER_BYTES {
            return Err(431);
        }
        let n = match tokio::time::timeout(Duration::from_secs(15), stream.read(&mut tmp)).await {
            Ok(Ok(0)) => return Err(400),
            Ok(Ok(n)) => n,
            Ok(Err(_)) => return Err(400),
            Err(_) => return Err(408),
        };
        buf.extend_from_slice(&tmp[..n]);
    };

    let header_bytes = &buf[..header_end];
    let leftover = buf[header_end + 4..].to_vec();
    let header_text = std::str::from_utf8(header_bytes).map_err(|_| 400u16)?;

    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or(400u16)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(400u16)?.to_uppercase();
    let target = parts.next().ok_or(400u16)?;
    let _version = parts.next().ok_or(400u16)?;

    let (raw_path, query_str) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q)),
        None => (target.to_string(), None),
    };

    let mut query = HashMap::new();
    if let Some(qs) = query_str {
        for pair in qs.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => (pair, ""),
            };
            if let (Ok(dk), Ok(dv)) = (percent_decode(k), percent_decode(v)) {
                query.insert(dk, dv);
            }
        }
    }

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    Ok(HttpRequestHead {
        method,
        raw_path,
        query,
        headers,
        leftover,
    })
}

async fn handle_connection(
    mut stream: TcpStream,
    peer_addr: SocketAddr,
    canonical_root: PathBuf,
    app: AppHandle,
) {
    let client_ip = peer_addr.ip().to_string();
    let req = match read_http_request(&mut stream).await {
        Ok(r) => r,
        Err(status) => {
            let _ = write_simple_response(&mut stream, status, "text/plain; charset=utf-8", "Bad Request", false).await;
            return;
        }
    };

    let (show_hidden, serve_index, allow_upload) = runtime_state()
        .read()
        .map(|g| (g.config.show_hidden, g.config.serve_index, g.config.allow_upload))
        .unwrap_or((false, false, false));

    let decoded_path = match percent_decode(&req.raw_path) {
        Ok(p) => p,
        Err(_) => {
            let _ = write_simple_response(&mut stream, 400, "text/plain; charset=utf-8", "Invalid URL encoding", false).await;
            record_log(&app, &client_ip, &req.method, &req.raw_path, 400, Some("非法 URL 编码".to_string()));
            return;
        }
    };

    if req.method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAllow: GET, HEAD, POST, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    // Handle file upload endpoint
    if req.method == "POST" && decoded_path == "/__starbox_upload" {
        handle_upload(
            &mut stream,
            &req,
            &canonical_root,
            show_hidden,
            allow_upload,
            &client_ip,
            &app,
        )
        .await;
        return;
    }

    if req.method != "GET" && req.method != "HEAD" {
        let _ = write_simple_response(&mut stream, 405, "text/plain; charset=utf-8", "Method Not Allowed", false).await;
        record_log(&app, &client_ip, &req.method, &decoded_path, 405, None);
        return;
    }

    let head_only = req.method == "HEAD";

    // Resolve safe filesystem path
    let resolved = match resolve_safe_path(&canonical_root, &decoded_path, show_hidden).await {
        Ok(p) => p,
        Err(status) => {
            let msg = match status {
                403 => "403 Forbidden",
                404 => "404 Not Found",
                _ => "400 Bad Request",
            };
            let _ = write_simple_response(&mut stream, status, "text/plain; charset=utf-8", msg, head_only).await;
            if decoded_path != "/favicon.ico" {
                record_log(&app, &client_ip, &req.method, &decoded_path, status, None);
            }
            return;
        }
    };

    let meta = match fs::metadata(&resolved).await {
        Ok(m) => m,
        Err(_) => {
            let _ = write_simple_response(&mut stream, 404, "text/plain; charset=utf-8", "404 Not Found", head_only).await;
            record_log(&app, &client_ip, &req.method, &decoded_path, 404, None);
            return;
        }
    };

    if meta.is_dir() {
        // Redirect /foo -> /foo/ so relative links work properly
        if !decoded_path.ends_with('/') {
            let location = format!("{}/", percent_encode_path(&decoded_path));
            let resp = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            return;
        }

        // Optional index.html rendering
        if serve_index {
            let index_candidate = resolved.join("index.html");
            if let Ok(canon_idx) = fs::canonicalize(&index_candidate).await {
                if canon_idx.starts_with(&canonical_root) && canon_idx.is_file() {
                    let status = serve_file(
                        &mut stream,
                        &canon_idx,
                        &req.headers,
                        false,
                        head_only,
                    )
                    .await;
                    record_log(
                        &app,
                        &client_ip,
                        &req.method,
                        &decoded_path,
                        status,
                        Some("index.html".to_string()),
                    );
                    return;
                }
            }
        }

        match render_directory_html(&resolved, &decoded_path, show_hidden, allow_upload).await {
            Ok(html) => {
                let _ = write_simple_response(
                    &mut stream,
                    200,
                    "text/html; charset=utf-8",
                    &html,
                    head_only,
                )
                .await;
                record_log(&app, &client_ip, &req.method, &decoded_path, 200, Some("目录浏览".to_string()));
            }
            Err(e) => {
                let _ = write_simple_response(
                    &mut stream,
                    500,
                    "text/plain; charset=utf-8",
                    &format!("读取目录失败: {e}"),
                    head_only,
                )
                .await;
                record_log(&app, &client_ip, &req.method, &decoded_path, 500, Some(e));
            }
        }
        return;
    }

    if meta.is_file() {
        let force_download = req
            .query
            .get("download")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let status = serve_file(
            &mut stream,
            &resolved,
            &req.headers,
            force_download,
            head_only,
        )
        .await;
        let detail = if force_download {
            Some(format!("下载 · {}", format_bytes(meta.len())))
        } else {
            Some(format_bytes(meta.len()))
        };
        record_log(&app, &client_ip, &req.method, &decoded_path, status, detail);
    } else {
        let _ = write_simple_response(&mut stream, 404, "text/plain; charset=utf-8", "Not a file", head_only).await;
    }
}

async fn handle_upload(
    stream: &mut TcpStream,
    req: &HttpRequestHead,
    canonical_root: &Path,
    show_hidden: bool,
    allow_upload: bool,
    client_ip: &str,
    app: &AppHandle,
) {
    if !allow_upload {
        let _ = write_json_response(stream, 403, r#"{"ok":false,"error":"当前服务器为只读模式，未开启上传"}"#).await;
        record_log(app, client_ip, "POST", "/__starbox_upload", 403, Some("只读拒绝".to_string()));
        return;
    }

    let content_length: u64 = match req.headers.get("content-length").and_then(|v| v.parse::<u64>().ok()) {
        Some(n) if n <= MAX_UPLOAD_BYTES => n,
        Some(_) => {
            let _ = write_json_response(stream, 413, r#"{"ok":false,"error":"文件大小超过单文件上限 (10 GB)"}"#).await;
            record_log(app, client_ip, "POST", "/__starbox_upload", 413, Some("文件过大".to_string()));
            return;
        }
        None => {
            let _ = write_json_response(stream, 411, r#"{"ok":false,"error":"缺少 Content-Length 请求头"}"#).await;
            return;
        }
    };

    let dir_param = req.query.get("dir").cloned().unwrap_or_else(|| "/".to_string());
    let raw_name = req.query.get("name").cloned().unwrap_or_default();
    let filename = raw_name.trim().to_string();

    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
        || (!show_hidden && filename.starts_with('.'))
    {
        let _ = write_json_response(stream, 400, r#"{"ok":false,"error":"文件名不合法"}"#).await;
        record_log(app, client_ip, "POST", &dir_param, 400, Some("非法文件名".to_string()));
        return;
    }

    let target_dir = match resolve_safe_path(canonical_root, &dir_param, show_hidden).await {
        Ok(p) if p.is_dir() => p,
        Ok(_) => {
            let _ = write_json_response(stream, 400, r#"{"ok":false,"error":"目标路径不是目录"}"#).await;
            return;
        }
        Err(status) => {
            let _ = write_json_response(stream, status, r#"{"ok":false,"error":"目标目录不可访问"}"#).await;
            return;
        }
    };

    let final_path = choose_non_colliding_path(&target_dir, &filename);
    let final_name = final_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.clone());

    let mut file = match File::create(&final_path).await {
        Ok(f) => f,
        Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": format!("创建文件失败: {e}") }).to_string();
            let _ = write_json_response(stream, 500, &body).await;
            return;
        }
    };

    let mut written: u64 = 0;
    let initial_take = (req.leftover.len() as u64).min(content_length) as usize;
    if initial_take > 0 {
        if let Err(e) = file.write_all(&req.leftover[..initial_take]).await {
            let _ = fs::remove_file(&final_path).await;
            let body = serde_json::json!({ "ok": false, "error": format!("写入失败: {e}") }).to_string();
            let _ = write_json_response(stream, 500, &body).await;
            return;
        }
        written += initial_take as u64;
    }

    let mut buf = vec![0u8; STREAM_CHUNK_SIZE];
    while written < content_length {
        let to_read = ((content_length - written) as usize).min(buf.len());
        match tokio::time::timeout(Duration::from_secs(60), stream.read(&mut buf[..to_read])).await {
            Ok(Ok(0)) => {
                let _ = fs::remove_file(&final_path).await;
                let _ = write_json_response(stream, 400, r#"{"ok":false,"error":"上传连接中断"}"#).await;
                record_log(app, client_ip, "UPLOAD", &final_name, 400, Some("传输中断".to_string()));
                return;
            }
            Ok(Ok(n)) => {
                if let Err(e) = file.write_all(&buf[..n]).await {
                    let _ = fs::remove_file(&final_path).await;
                    let body = serde_json::json!({ "ok": false, "error": format!("写入磁盘失败: {e}") }).to_string();
                    let _ = write_json_response(stream, 500, &body).await;
                    return;
                }
                written += n as u64;
            }
            Ok(Err(_)) | Err(_) => {
                let _ = fs::remove_file(&final_path).await;
                record_log(app, client_ip, "UPLOAD", &final_name, 408, Some("上传超时".to_string()));
                return;
            }
        }
    }

    let _ = file.flush().await;

    let display_path = if dir_param.ends_with('/') {
        format!("{dir_param}{final_name}")
    } else {
        format!("{dir_param}/{final_name}")
    };
    record_log(
        app,
        client_ip,
        "UPLOAD",
        &display_path,
        200,
        Some(format!("已保存 · {}", format_bytes(written))),
    );

    let body = serde_json::json!({
        "ok": true,
        "filename": final_name,
        "size": written,
    })
    .to_string();
    let _ = write_json_response(stream, 200, &body).await;
}

fn choose_non_colliding_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let alt = dir.join(format!("{stem} ({i}){ext}"));
        if !alt.exists() {
            return alt;
        }
    }
    dir.join(format!("{stem}-{}{ext}", Local::now().timestamp()))
}

async fn serve_file(
    stream: &mut TcpStream,
    file_path: &Path,
    headers: &HashMap<String, String>,
    force_download: bool,
    head_only: bool,
) -> u16 {
    let mut file = match File::open(file_path).await {
        Ok(f) => f,
        Err(_) => {
            let _ = write_simple_response(stream, 404, "text/plain; charset=utf-8", "404 Not Found", head_only).await;
            return 404;
        }
    };
    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(_) => {
            let _ = write_simple_response(stream, 500, "text/plain; charset=utf-8", "Read metadata failed", head_only).await;
            return 500;
        }
    };
    let total_len = meta.len();
    let mime = guess_mime_type(file_path);

    let disposition_header = if force_download {
        let name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string());
        let encoded = percent_encode_component(&name);
        format!("Content-Disposition: attachment; filename*=UTF-8''{encoded}\r\n")
    } else {
        String::new()
    };

    let range_spec = headers
        .get("range")
        .and_then(|v| parse_range_header(v, total_len));

    let (status_code, status_text, start, end, content_range_header) = match (headers.contains_key("range"), range_spec) {
        (true, Some((s, e))) => (
            206u16,
            "Partial Content",
            s,
            e,
            format!("Content-Range: bytes {s}-{e}/{total_len}\r\n"),
        ),
        (true, None) if total_len > 0 => {
            let resp = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total_len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            return 416;
        }
        _ => (
            200u16,
            "OK",
            0u64,
            total_len.saturating_sub(1),
            String::new(),
        ),
    };

    let content_len = if total_len == 0 {
        0
    } else {
        end.saturating_sub(start) + 1
    };

    let header_block = format!(
        "HTTP/1.1 {status_code} {status_text}\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {content_len}\r\n\
         Accept-Ranges: bytes\r\n\
         Cache-Control: no-cache\r\n\
         {content_range_header}{disposition_header}Connection: close\r\n\r\n"
    );

    if stream.write_all(header_block.as_bytes()).await.is_err() {
        return status_code;
    }

    if head_only || content_len == 0 {
        let _ = stream.flush().await;
        return status_code;
    }

    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return 500;
    }

    let mut remaining = content_len;
    let mut buf = vec![0u8; STREAM_CHUNK_SIZE];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        match file.read(&mut buf[..to_read]).await {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).await.is_err() {
                    break;
                }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush().await;
    status_code
}

async fn write_simple_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
    head_only: bool,
) -> std::io::Result<()> {
    let reason = status_reason(status);
    let bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if !head_only {
        stream.write_all(bytes).await?;
    }
    stream.flush().await
}

async fn write_json_response(stream: &mut TcpStream, status: u16, json: &str) -> std::io::Result<()> {
    write_simple_response(stream, status, "application/json; charset=utf-8", json, false).await
}

fn status_reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

async fn resolve_safe_path(
    canonical_root: &Path,
    decoded_url_path: &str,
    show_hidden: bool,
) -> Result<PathBuf, u16> {
    if decoded_url_path.contains('\0') || decoded_url_path.contains('\\') {
        return Err(400);
    }

    let mut rel = PathBuf::new();
    for seg in decoded_url_path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(403);
        }
        if !show_hidden && seg.starts_with('.') {
            return Err(403);
        }
        rel.push(seg);
    }

    let candidate = canonical_root.join(&rel);
    let resolved = fs::canonicalize(&candidate).await.map_err(|_| 404u16)?;
    if !resolved.starts_with(canonical_root) {
        return Err(403);
    }
    Ok(resolved)
}

fn parse_range_header(header_val: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let spec = header_val.trim().strip_prefix("bytes=")?;
    // Only handle single-range requests; ignore multi-range
    if spec.contains(',') {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() {
        // Suffix range: bytes=-500
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        return Some((start, total_len - 1));
    }

    let start: u64 = start_s.parse().ok()?;
    if start >= total_len {
        return None;
    }
    let end = if end_s.is_empty() {
        total_len - 1
    } else {
        let parsed: u64 = end_s.parse().ok()?;
        parsed.min(total_len - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

fn percent_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(());
            }
            let hi = hex_val(bytes[i + 1]).ok_or(())?;
            let lo = hex_val(bytes[i + 2]).ok_or(())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_encode_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut val = bytes as f64;
    let mut idx = 0;
    while val >= 1024.0 && idx < UNITS.len() - 1 {
        val /= 1024.0;
        idx += 1;
    }
    if val >= 100.0 {
        format!("{val:.0} {}", UNITS[idx])
    } else {
        format!("{val:.1} {}", UNITS[idx])
    }
}

fn format_modified(time: Option<SystemTime>) -> String {
    let Some(t) = time else {
        return "—".to_string();
    };
    let dt: DateTime<Local> = DateTime::from(t);
    dt.format("%Y-%m-%d %H:%M").to_string()
}

fn guess_mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" | "markdown" | "csv" | "yaml" | "yml" | "toml" | "ini" | "conf"
        | "rs" | "ts" | "tsx" | "jsx" | "py" | "go" | "java" | "c" | "cpp" | "h" | "sh"
        | "zsh" | "swift" => "text/plain; charset=utf-8",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "dmg" => "application/x-apple-diskimage",
        "pkg" => "application/octet-stream",
        "apk" => "application/vnd.android.package-archive",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn file_badge_kind(name: &str, is_dir: bool) -> (&'static str, &'static str) {
    if is_dir {
        return ("dir", "目录");
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" | "heic" => ("img", "图片"),
        "mp4" | "mov" | "webm" | "mkv" | "m4v" | "avi" => ("vid", "视频"),
        "mp3" | "wav" | "m4a" | "flac" | "ogg" | "aac" => ("aud", "音频"),
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "md" | "txt" => ("doc", "文档"),
        "zip" | "tar" | "gz" | "tgz" | "7z" | "rar" | "dmg" | "pkg" | "apk" => ("arc", "压缩/包"),
        "html" | "css" | "js" | "ts" | "tsx" | "jsx" | "json" | "rs" | "py" | "go" | "sh" | "yml" | "yaml" => ("code", "代码"),
        _ => ("file", "文件"),
    }
}

struct DirEntryItem {
    name: String,
    is_dir: bool,
    size: u64,
    modified: Option<SystemTime>,
}

async fn render_directory_html(
    dir_path: &Path,
    url_path: &str,
    show_hidden: bool,
    allow_upload: bool,
) -> Result<String, String> {
    let mut rd = fs::read_dir(dir_path)
        .await
        .map_err(|e| format!("无法读取目录: {e}"))?;

    let mut entries = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let Ok(meta) = ent.metadata().await else {
            continue;
        };
        entries.push(DirEntryItem {
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().ok(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let folder_count = entries.iter().filter(|e| e.is_dir).count();
    let file_count = entries.len() - folder_count;
    let total_file_bytes: u64 = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();

    // Build breadcrumbs
    let mut crumbs_html = String::from(r#"<a href="/" class="crumb">根目录</a>"#);
    let trimmed = url_path.trim_matches('/');
    let mut acc = String::new();
    if !trimmed.is_empty() {
        for seg in trimmed.split('/') {
            if seg.is_empty() {
                continue;
            }
            acc.push('/');
            acc.push_str(&percent_encode_component(seg));
            crumbs_html.push_str(r#"<span class="sep">/</span>"#);
            crumbs_html.push_str(&format!(
                r#"<a href="{acc}/" class="crumb">{}</a>"#,
                html_escape(seg)
            ));
        }
    }

    // Build rows
    let mut rows_html = String::new();
    if !trimmed.is_empty() {
        rows_html.push_str(
            r#"<tr class="row" data-name="..">
                <td class="col-name"><a class="item-link" href="../"><span class="ico ico-dir">↑</span><span class="fname">返回上一级 (..)</span></a></td>
                <td class="col-type"><span class="tag">上级</span></td>
                <td class="col-size">—</td>
                <td class="col-time">—</td>
                <td class="col-act"></td>
            </tr>"#,
        );
    }

    for item in &entries {
        let encoded = percent_encode_component(&item.name);
        let href = if item.is_dir {
            format!("{encoded}/")
        } else {
            encoded.clone()
        };
        let (kind, label) = file_badge_kind(&item.name, item.is_dir);
        let icon_glyph = match kind {
            "dir" => "📁",
            "img" => "🖼️",
            "vid" => "🎬",
            "aud" => "🎵",
            "doc" => "📄",
            "arc" => "📦",
            "code" => "💻",
            _ => "📎",
        };
        let escaped_name = html_escape(&item.name);
        let size_str = if item.is_dir {
            "—".to_string()
        } else {
            format_bytes(item.size)
        };
        let time_str = format_modified(item.modified);
        let action_html = if item.is_dir {
            format!(r#"<a class="act-btn" href="{href}">打开</a>"#)
        } else {
            format!(r#"<a class="act-btn" href="{href}?download=1">下载</a>"#)
        };

        rows_html.push_str(&format!(
            r#"<tr class="row" data-name="{}">
                <td class="col-name"><a class="item-link" href="{href}"><span class="ico ico-{kind}">{icon_glyph}</span><span class="fname">{escaped_name}</span></a></td>
                <td class="col-type"><span class="tag">{label}</span></td>
                <td class="col-size">{size_str}</td>
                <td class="col-time">{time_str}</td>
                <td class="col-act">{action_html}</td>
            </tr>"#,
            html_escape(&item.name.to_lowercase())
        ));
    }

    if entries.is_empty() {
        rows_html.push_str(
            r#"<tr><td colspan="5" class="empty">当前目录为空</td></tr>"#,
        );
    }

    let upload_section = if allow_upload {
        r#"<section class="upload-box" id="uploadBox">
                <div class="upload-top">
                    <div>
                        <div class="upload-title">上传文件到此目录</div>
                        <div class="upload-sub">支持拖拽或多个文件选择，直接传输到 Mac 共享目录</div>
                    </div>
                    <label class="btn-primary">
                        选择文件上传
                        <input id="fileInput" type="file" multiple hidden />
                    </label>
                </div>
                <div class="upload-progress" id="uploadProgress" hidden>
                    <div class="progress-meta">
                        <span id="uploadLabel">准备上传...</span>
                        <span id="uploadPct">0%</span>
                    </div>
                    <div class="progress-track"><div class="progress-bar" id="uploadBar"></div></div>
                </div>
            </section>"#
            .to_string()
    } else {
        String::new()
    };

    let upload_script = if allow_upload {
        let dir_json = serde_json::to_string(url_path).unwrap_or_else(|_| "\"/\"".to_string());
        format!(
            r#"
            (function() {{
                const currentDir = {dir_json};
                const box = document.getElementById('uploadBox');
                const input = document.getElementById('fileInput');
                const prog = document.getElementById('uploadProgress');
                const label = document.getElementById('uploadLabel');
                const pct = document.getElementById('uploadPct');
                const bar = document.getElementById('uploadBar');

                async function uploadFiles(fileList) {{
                    const files = Array.from(fileList || []);
                    if (!files.length) return;
                    prog.hidden = false;
                    for (let i = 0; i < files.length; i++) {{
                        const f = files[i];
                        label.textContent = `正在上传 (${{i + 1}}/${{files.length}}): ${{f.name}}`;
                        pct.textContent = '0%';
                        bar.style.width = '0%';
                        await new Promise((resolve, reject) => {{
                            const xhr = new XMLHttpRequest();
                            const url = '/__starbox_upload?dir=' + encodeURIComponent(currentDir) + '&name=' + encodeURIComponent(f.name);
                            xhr.open('POST', url);
                            xhr.upload.onprogress = (e) => {{
                                if (e.lengthComputable && e.total > 0) {{
                                    const p = Math.round((e.loaded / e.total) * 100);
                                    pct.textContent = p + '%';
                                    bar.style.width = p + '%';
                                }}
                            }};
                            xhr.onload = () => {{
                                if (xhr.status >= 200 && xhr.status < 300) resolve();
                                else reject(new Error(xhr.responseText || ('HTTP ' + xhr.status)));
                            }};
                            xhr.onerror = () => reject(new Error('网络连接中断'));
                            xhr.send(f);
                        }}).catch(err => {{
                            alert('上传失败: ' + err.message);
                        }});
                    }}
                    label.textContent = '上传完成，正在刷新...';
                    pct.textContent = '100%';
                    bar.style.width = '100%';
                    setTimeout(() => location.reload(), 300);
                }}

                input.addEventListener('change', (e) => uploadFiles(e.target.files));
                ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => {{
                    e.preventDefault();
                    box.classList.add('dragover');
                }}));
                ['dragleave', 'drop'].forEach(ev => box.addEventListener(ev, e => {{
                    e.preventDefault();
                    box.classList.remove('dragover');
                }}));
                box.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
            }})();
            "#
        )
    } else {
        String::new()
    };

    let title_path = html_escape(url_path);
    let summary = format!(
        "{folder_count} 个文件夹 · {file_count} 个文件{}",
        if total_file_bytes > 0 {
            format!(" · 共 {}", format_bytes(total_file_bytes))
        } else {
            String::new()
        }
    );

    Ok(format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Star Box 局域网共享 · {title_path}</title>
<style>
  :root {{
    --bg: #f6f7f9;
    --card: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --muted: #6b7280;
    --accent: #2563eb;
    --accent-soft: rgba(37, 99, 235, 0.1);
    --hover: #f3f4f6;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #0f1115;
      --card: #171a21;
      --border: #262b36;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #60a5fa;
      --accent-soft: rgba(96, 165, 250, 0.14);
      --hover: #1f2430;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }}
  .wrap {{
    max-width: 980px;
    margin: 0 auto;
    padding: 20px 16px 40px;
  }}
  .header {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }}
  .brand {{
    display: flex;
    align-items: center;
    gap: 10px;
  }}
  .badge {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    background: var(--accent-soft);
    color: var(--accent);
  }}
  .summary {{
    font-size: 12px;
    color: var(--muted);
  }}
  .search {{
    width: 240px;
    max-width: 100%;
    height: 36px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-size: 13px;
    outline: none;
  }}
  .search:focus {{ border-color: var(--accent); }}
  .crumbs {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    margin-bottom: 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card);
    font-size: 13px;
  }}
  .crumb {{
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
  }}
  .crumb:hover {{ text-decoration: underline; }}
  .sep {{ color: var(--muted); opacity: 0.6; }}
  .upload-box {{
    margin-bottom: 14px;
    padding: 14px 16px;
    border-radius: 12px;
    border: 1px dashed var(--border);
    background: var(--card);
    transition: border-color .15s, background .15s;
  }}
  .upload-box.dragover {{
    border-color: var(--accent);
    background: var(--accent-soft);
  }}
  .upload-top {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }}
  .upload-title {{ font-size: 13px; font-weight: 600; }}
  .upload-sub {{ font-size: 12px; color: var(--muted); }}
  .btn-primary {{
    display: inline-flex;
    align-items: center;
    padding: 7px 14px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
  }}
  .upload-progress {{ margin-top: 10px; }}
  .progress-meta {{
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 4px;
  }}
  .progress-track {{
    height: 6px;
    border-radius: 999px;
    background: var(--hover);
    overflow: hidden;
  }}
  .progress-bar {{
    height: 100%;
    width: 0;
    background: var(--accent);
    transition: width .12s;
  }}
  .card {{
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--card);
    overflow: hidden;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }}
  thead th {{
    text-align: left;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--hover);
  }}
  tbody td {{
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }}
  tbody tr:last-child td {{ border-bottom: none; }}
  tbody tr:hover {{ background: var(--hover); }}
  .item-link {{
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--text);
    text-decoration: none;
    min-width: 0;
  }}
  .item-link:hover .fname {{ color: var(--accent); }}
  .ico {{
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: var(--hover);
    font-size: 14px;
  }}
  .fname {{
    font-weight: 500;
    word-break: break-all;
  }}
  .tag {{
    display: inline-block;
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 11px;
    color: var(--muted);
    background: var(--hover);
    white-space: nowrap;
  }}
  .col-size, .col-time {{
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }}
  .col-act {{ text-align: right; white-space: nowrap; }}
  .act-btn {{
    display: inline-block;
    padding: 4px 10px;
    border-radius: 7px;
    border: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    font-size: 12px;
    font-weight: 500;
  }}
  .act-btn:hover {{
    border-color: var(--accent);
    color: var(--accent);
  }}
  .empty {{
    text-align: center;
    color: var(--muted);
    padding: 42px 16px;
  }}
  @media (max-width: 640px) {{
    .col-type, .col-time {{ display: none; }}
    .search {{ width: 100%; }}
  }}
</style>
</head>
<body>
  <div class="wrap">
    <header class="header">
      <div class="brand">
        <span class="badge">Star Box 局域网文件服务</span>
        <span class="summary">{summary}</span>
      </div>
      <input id="filterInput" class="search" type="search" placeholder="筛选当前目录文件..." />
    </header>

    <nav class="crumbs">{crumbs_html}</nav>
    {upload_section}

    <main class="card">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th class="col-type">类型</th>
            <th class="col-size">大小</th>
            <th class="col-time">修改时间</th>
            <th class="col-act">操作</th>
          </tr>
        </thead>
        <tbody id="fileRows">
          {rows_html}
        </tbody>
      </table>
    </main>
  </div>
  <script>
    const filterInput = document.getElementById('filterInput');
    filterInput.addEventListener('input', () => {{
      const q = filterInput.value.trim().toLowerCase();
      document.querySelectorAll('#fileRows tr.row').forEach(tr => {{
        const name = tr.getAttribute('data-name') || '';
        tr.style.display = (!q || name === '..' || name.includes(q)) ? '' : 'none';
      }});
    }});
    {upload_script}
  </script>
</body>
</html>"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode_utf8() {
        assert_eq!(percent_decode("/%E6%B5%8B%E8%AF%95%20file.txt").unwrap(), "/测试 file.txt");
        assert!(percent_decode("/bad%2").is_err());
    }

    #[test]
    fn test_parse_range_header() {
        assert_eq!(parse_range_header("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range_header("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range_header("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_range_header("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range_header("bytes=1000-1200", 1000), None);
        assert_eq!(parse_range_header("bytes=500-200", 1000), None);
    }

    #[tokio::test]
    async fn test_resolve_safe_path_blocks_traversal_and_hidden() {
        let tmp = std::env::temp_dir().join(format!("starbox_lan_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp).await;
        fs::create_dir_all(tmp.join("sub")).await.unwrap();
        fs::write(tmp.join("sub/hello.txt"), b"hi").await.unwrap();
        fs::write(tmp.join(".secret"), b"nope").await.unwrap();
        let root = fs::canonicalize(&tmp).await.unwrap();

        assert!(resolve_safe_path(&root, "/sub/hello.txt", false).await.is_ok());
        assert_eq!(resolve_safe_path(&root, "/../etc/passwd", false).await, Err(403));
        assert_eq!(resolve_safe_path(&root, "/.secret", false).await, Err(403));
        assert!(resolve_safe_path(&root, "/.secret", true).await.is_ok());

        let _ = fs::remove_dir_all(&tmp).await;
    }
}
