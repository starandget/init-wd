use crate::commands::env::home_dir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredProxy {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
    /// "system" | "local" | "lan"
    pub source: String,
    /// Human-readable hint for the discovered LAN acceleration endpoint
    pub hint: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

static PROXY_STATE: OnceLock<RwLock<ProxyConfig>> = OnceLock::new();

fn proxy_config_path() -> PathBuf {
    home_dir()
        .join("Library/Application Support/com.starandget.starbox")
        .join("proxy.json")
}

fn load_config_from_disk() -> ProxyConfig {
    let path = proxy_config_path();
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<ProxyConfig>(&s).ok())
        .unwrap_or_default()
}

fn save_config_to_disk(cfg: &ProxyConfig) -> Result<(), String> {
    let path = proxy_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("写入代理配置失败: {e}"))
}

fn state_lock() -> &'static RwLock<ProxyConfig> {
    PROXY_STATE.get_or_init(|| RwLock::new(load_config_from_disk()))
}

fn normalize_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("http://{trimmed}"))
    }
}

/// Returns the active proxy URL if proxy acceleration is enabled.
pub fn active_proxy_url() -> Option<String> {
    let guard = state_lock().read().ok()?;
    if !guard.enabled {
        return None;
    }
    guard.url.as_deref().and_then(normalize_proxy_url)
}

/// Classifies the currently configured Star Box proxy for display in install logs.
pub fn describe_active_proxy() -> String {
    let Some(url) = active_proxy_url() else {
        return "直连（未启用 Star Box 代理）".to_string();
    };
    let host_port = url
        .split("://")
        .nth(1)
        .unwrap_or(url.as_str())
        .split('/')
        .next()
        .unwrap_or("");
    let host = host_port
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_port)
        .trim_matches(['[', ']'])
        .to_lowercase();

    let kind = if host == "127.0.0.1" || host == "localhost" || host == "::1" {
        "本机代理"
    } else if host
        .parse::<Ipv4Addr>()
        .map(|ip| ip.is_private())
        .unwrap_or(false)
    {
        "局域网/手机代理"
    } else {
        "自定义代理"
    };
    format!("{kind} {url}")
}

/// Injects proxy environment variables into any child process (brew, curl, git, bash).
/// Explicitly clears proxy env vars in direct mode so stale shell env cannot hijack traffic.
pub fn apply_proxy_env(cmd: &mut Command) {
    if let Some(url) = active_proxy_url() {
        cmd.env("http_proxy", &url)
            .env("https_proxy", &url)
            .env("all_proxy", &url)
            .env("HTTP_PROXY", &url)
            .env("HTTPS_PROXY", &url)
            .env("ALL_PROXY", &url);
    } else {
        cmd.env_remove("http_proxy")
            .env_remove("https_proxy")
            .env_remove("all_proxy")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY");
    }
}

/// Builds a reqwest::Client that automatically uses the configured Star Box proxy when enabled.
pub fn build_http_client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("StarBox/1.0");
    if let Some(url) = active_proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build()
}

fn port_hint(port: u16) -> &'static str {
    match port {
        1082 | 7890 | 7897 | 6152 => "局域网加速节点",
        8888 | 8889 => "HTTP 调试 / 转发节点",
        1087 | 10808 | 10809 => "本地转发节点",
        1080 => "SOCKS5 转发节点",
        9090 | 9910 | 20171 => "通用加速服务",
        _ => "HTTP / SOCKS 节点",
    }
}

async fn verify_proxy_url(url: &str, timeout_ms: u64) -> Result<u64, String> {
    let proxy = reqwest::Proxy::all(url).map_err(|e| format!("加速节点地址无效: {e}"))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent("StarBox/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    // Lightweight 204 endpoint to verify real outbound proxy forwarding
    let endpoints = [
        "http://cp.cloudflare.com/generate_204",
        "http://captive.apple.com/hotspot-detect.html",
    ];
    let mut last_err = String::from("连接超时");
    for ep in endpoints {
        let start = Instant::now();
        match client.get(ep).send().await {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 204 => {
                return Ok(start.elapsed().as_millis().max(1) as u64);
            }
            Ok(resp) => {
                last_err = format!("HTTP {}", resp.status().as_u16());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }
    Err(last_err)
}

async fn read_macos_system_proxies() -> Vec<(String, u16, String)> {
    let mut out = Vec::new();
    let Ok(output) = Command::new("/usr/sbin/scutil").arg("--proxy").output().await else {
        return out;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut map: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }

    if map.get("HTTPEnable").map(|s| s == "1").unwrap_or(false) {
        if let (Some(host), Some(port_s)) = (map.get("HTTPProxy"), map.get("HTTPPort")) {
            if let Ok(port) = port_s.parse::<u16>() {
                out.push((host.clone(), port, "http".to_string()));
            }
        }
    }
    if map.get("HTTPSEnable").map(|s| s == "1").unwrap_or(false) {
        if let (Some(host), Some(port_s)) = (map.get("HTTPSProxy"), map.get("HTTPSPort")) {
            if let Ok(port) = port_s.parse::<u16>() {
                out.push((host.clone(), port, "http".to_string()));
            }
        }
    }
    if map.get("SOCKSEnable").map(|s| s == "1").unwrap_or(false) {
        if let (Some(host), Some(port_s)) = (map.get("SOCKSProxy"), map.get("SOCKSPort")) {
            if let Ok(port) = port_s.parse::<u16>() {
                out.push((host.clone(), port, "socks5".to_string()));
            }
        }
    }
    out
}

fn is_ignored_iface(iface: &str) -> bool {
    const IGNORED_PREFIXES: [&str; 10] = [
        "lo", "utun", "awdl", "llw", "anpi", "ap", "gif", "stf", "XHC", "ipsec",
    ];
    IGNORED_PREFIXES.iter().any(|p| iface.starts_with(p))
}

async fn get_iface_ipv4(iface: &str) -> Option<Ipv4Addr> {
    let output = Command::new("/usr/sbin/ipconfig")
        .args(["getifaddr", iface])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let ip = s.parse::<Ipv4Addr>().ok()?;
    if !ip.is_loopback() && !ip.is_link_local() {
        Some(ip)
    } else {
        None
    }
}

async fn detect_local_lan_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    let mut seen = HashSet::new();

    // 1. Prioritize the active default-route interface (handles en3/en5/en7/... on Intel Macs)
    if let Ok(output) = Command::new("/sbin/route")
        .args(["-n", "get", "default"])
        .output()
        .await
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if let Some(iface) = trimmed.strip_prefix("interface:") {
                    let iface = iface.trim();
                    if !iface.is_empty() && !is_ignored_iface(iface) {
                        if let Some(ip) = get_iface_ipv4(iface).await {
                            if seen.insert(ip) {
                                ips.push(ip);
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    // 2. Enumerate all UP & RUNNING non-virtual LAN interfaces from ifconfig
    if let Ok(output) = Command::new("/sbin/ifconfig").output().await {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut active_lan_iface = false;
            for line in text.lines() {
                if !line.starts_with(char::is_whitespace) {
                    active_lan_iface = false;
                    if let Some((iface, rest)) = line.split_once(':') {
                        let iface = iface.trim();
                        if !is_ignored_iface(iface)
                            && rest.contains("UP")
                            && rest.contains("RUNNING")
                            && !rest.contains("LOOPBACK")
                        {
                            active_lan_iface = true;
                        }
                    }
                } else if active_lan_iface {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("inet ") {
                        if let Some(ip_str) = rest.split_whitespace().next() {
                            if let Ok(ip) = ip_str.parse::<Ipv4Addr>() {
                                if !ip.is_loopback()
                                    && !ip.is_link_local()
                                    && ip.is_private()
                                    && seen.insert(ip)
                                {
                                    ips.push(ip);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback: probe en0..en10 via ipconfig
    if ips.is_empty() {
        for idx in 0..=10 {
            let iface = format!("en{idx}");
            if let Some(ip) = get_iface_ipv4(&iface).await {
                if seen.insert(ip) {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

fn send_udp_arp_pass(subnets: Vec<[u8; 3]>, own_ips: HashSet<Ipv4Addr>) {
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        let _ = sock.set_nonblocking(true);
        for prefix in subnets {
            for last in 1u8..=254u8 {
                let ip = Ipv4Addr::new(prefix[0], prefix[1], prefix[2], last);
                if own_ips.contains(&ip) {
                    continue;
                }
                let _ = sock.send_to(&[0u8], SocketAddr::from((ip, 9)));
            }
        }
    }
}

/// Sends a lightweight 1-byte UDP packet to each host in the local /24 subnet(s)
/// using a single socket (1 FD) so the macOS kernel resolves ARP for all live devices.
async fn warm_arp_table(local_ips: &[Ipv4Addr]) {
    let mut subnets: Vec<[u8; 3]> = Vec::new();
    let mut own_ips: HashSet<Ipv4Addr> = HashSet::new();
    for &ip in local_ips {
        own_ips.insert(ip);
        let oct = ip.octets();
        let prefix = [oct[0], oct[1], oct[2]];
        if !subnets.contains(&prefix) && subnets.len() < 3 {
            subnets.push(prefix);
        }
    }
    if subnets.is_empty() {
        return;
    }

    let _ = tokio::task::spawn_blocking({
        let subnets = subnets.clone();
        let own_ips = own_ips.clone();
        move || send_udp_arp_pass(subnets, own_ips)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;

    // Second pass catches Wi-Fi devices waking from DTIM power-save (e.g. sleeping iPhone)
    let _ = tokio::task::spawn_blocking(move || send_udp_arp_pass(subnets, own_ips)).await;
    tokio::time::sleep(Duration::from_millis(350)).await;
}

async fn read_arp_neighbors() -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    let mut seen = HashSet::new();
    let Ok(output) = Command::new("/usr/sbin/arp").arg("-an").output().await else {
        return ips;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // Skip unresolved/dead ARP entries
        if line.contains("(incomplete)") {
            continue;
        }
        if let (Some(l), Some(r)) = (line.find('('), line.find(')')) {
            if r > l + 1 {
                if let Ok(ip) = line[l + 1..r].parse::<Ipv4Addr>() {
                    let oct = ip.octets();
                    // Skip multicast / broadcast / link-local
                    if !ip.is_multicast()
                        && !ip.is_broadcast()
                        && !ip.is_link_local()
                        && !ip.is_loopback()
                        && oct[3] != 0
                        && oct[3] != 255
                        && seen.insert(ip)
                    {
                        ips.push(ip);
                    }
                }
            }
        }
    }
    ips
}

#[tauri::command]
pub async fn get_proxy_config() -> Result<ProxyConfig, String> {
    let cfg = state_lock()
        .read()
        .map_err(|_| "读取代理配置失败".to_string())?
        .clone();
    Ok(cfg)
}

#[tauri::command]
pub async fn set_proxy_config(enabled: bool, url: Option<String>) -> Result<ProxyConfig, String> {
    let normalized = url.as_deref().and_then(normalize_proxy_url);
    let next = ProxyConfig {
        enabled: enabled && normalized.is_some(),
        url: normalized,
    };
    save_config_to_disk(&next)?;
    if let Ok(mut guard) = state_lock().write() {
        *guard = next.clone();
    }
    Ok(next)
}

#[tauri::command]
pub async fn test_proxy(url: String) -> Result<ProxyTestResult, String> {
    let Some(normalized) = normalize_proxy_url(&url) else {
        return Ok(ProxyTestResult {
            ok: false,
            latency_ms: None,
            error: Some("请输入有效的加速节点地址（如 http://192.168.1.10:1082）".to_string()),
        });
    };
    match verify_proxy_url(&normalized, 3500).await {
        Ok(ms) => Ok(ProxyTestResult {
            ok: true,
            latency_ms: Some(ms),
            error: None,
        }),
        Err(err) => Ok(ProxyTestResult {
            ok: false,
            latency_ms: None,
            error: Some(err),
        }),
    }
}

#[tauri::command]
pub async fn discover_lan_proxies() -> Result<Vec<DiscoveredProxy>, String> {
    let mut candidate_targets: Vec<(String, u16, &'static str, Option<String>)> = Vec::new();
    let mut seen_pair: HashSet<(String, u16)> = HashSet::new();

    // 1. macOS system proxy (highest priority)
    for (host, port, proto) in read_macos_system_proxies().await {
        if seen_pair.insert((host.clone(), port)) {
            candidate_targets.push((host, port, "system", Some(proto)));
        }
    }

    // 2. Localhost common proxy ports
    let local_ports: [u16; 10] = [7890, 7897, 1082, 6152, 1087, 8888, 8889, 10809, 10808, 1080];
    for port in local_ports {
        let host = "127.0.0.1".to_string();
        if seen_pair.insert((host.clone(), port)) {
            candidate_targets.push((host, port, "local", None));
        }
    }

    // 3. Detect active LAN IPv4(s) and warm ARP table using a single UDP socket (1 FD)
    let local_ips = detect_local_lan_ipv4s().await;
    let local_ip_set: HashSet<Ipv4Addr> = local_ips.iter().copied().collect();
    warm_arp_table(&local_ips).await;

    // 4. Live LAN ARP neighbors (all reachable devices on the same Wi-Fi/Ethernet)
    let arp_ports: [u16; 11] = [1082, 7890, 7897, 6152, 8888, 8889, 1087, 10809, 10808, 9090, 1080];
    let arp_neighbors: Vec<Ipv4Addr> = read_arp_neighbors()
        .await
        .into_iter()
        .filter(|ip| !local_ip_set.contains(ip))
        .collect();
    for ip in &arp_neighbors {
        let host = ip.to_string();
        for port in arp_ports {
            if seen_pair.insert((host.clone(), port)) {
                candidate_targets.push((host.clone(), port, "lan", None));
            }
        }
    }

    // 5. Fallback: if ARP returned no neighbors in the primary subnet, scan top ports directly
    if arp_neighbors.is_empty() {
        if let Some(&my_ip) = local_ips.first() {
            let oct = my_ip.octets();
            let scan_ports: [u16; 5] = [1082, 7890, 7897, 6152, 8888];
            for last in 1u8..=254u8 {
                if last == oct[3] {
                    continue;
                }
                let ip = Ipv4Addr::new(oct[0], oct[1], oct[2], last);
                let host = ip.to_string();
                for port in scan_ports {
                    if seen_pair.insert((host.clone(), port)) {
                        candidate_targets.push((host.clone(), port, "lan", None));
                    }
                }
            }
        }
    }

    // Phase 1: Concurrent TCP connect probe with safe FD concurrency (avoids macOS GUI 256 NOFILE limit)
    let sem = Arc::new(Semaphore::new(48));
    let mut tcp_handles = Vec::with_capacity(candidate_targets.len());
    for (host, port, source, forced_proto) in candidate_targets {
        let permit_sem = Arc::clone(&sem);
        tcp_handles.push(tokio::spawn(async move {
            let _permit = permit_sem.acquire().await.ok()?;
            let connect_timeout = if source == "lan" {
                Duration::from_millis(800)
            } else {
                Duration::from_millis(350)
            };
            if tokio::time::timeout(connect_timeout, TcpStream::connect((host.as_str(), port)))
                .await
                .ok()?
                .is_ok()
            {
                Some((host, port, source, forced_proto))
            } else {
                None
            }
        }));
    }

    let mut open_ports = Vec::new();
    for h in tcp_handles {
        if let Ok(Some(item)) = h.await {
            open_ports.push(item);
        }
    }

    // Phase 2: Verify each open port is a real forwarding HTTP or SOCKS5 proxy
    let verify_sem = Arc::new(Semaphore::new(16));
    let mut verify_handles = Vec::with_capacity(open_ports.len());
    for (host, port, source, forced_proto) in open_ports {
        let permit_sem = Arc::clone(&verify_sem);
        verify_handles.push(tokio::spawn(async move {
            let _permit = permit_sem.acquire().await.ok()?;
            let protos: Vec<&str> = match forced_proto.as_deref() {
                Some("socks5") => vec!["socks5", "http"],
                Some("http") => vec!["http", "socks5"],
                _ if port == 1080 || port == 10808 => vec!["socks5", "http"],
                _ => vec!["http", "socks5"],
            };

            for proto in protos {
                let url = format!("{proto}://{host}:{port}");
                if let Ok(latency_ms) = verify_proxy_url(&url, 3000).await {
                    let hint = if source == "system" {
                        "macOS 系统网络通道".to_string()
                    } else {
                        port_hint(port).to_string()
                    };
                    return Some(DiscoveredProxy {
                        url,
                        host,
                        port,
                        protocol: proto.to_string(),
                        source: source.to_string(),
                        hint,
                        latency_ms,
                    });
                }
            }
            None
        }));
    }

    let mut verified = Vec::new();
    for h in verify_handles {
        if let Ok(Some(proxy)) = h.await {
            verified.push(proxy);
        }
    }

    verified.sort_by_key(|p| p.latency_ms);
    Ok(verified)
}
