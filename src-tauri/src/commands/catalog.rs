use crate::commands::env::home_dir;
use crate::models::{CatalogEntry, GitHubReleaseInfo};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::sync::RwLock;

static CATALOG_CACHE: OnceLock<RwLock<Option<Vec<CatalogEntry>>>> = OnceLock::new();

fn cache_lock() -> &'static RwLock<Option<Vec<CatalogEntry>>> {
    CATALOG_CACHE.get_or_init(|| RwLock::new(None))
}

fn cache_dir() -> PathBuf {
    home_dir().join("Library/Caches/com.starandget.starbox")
}

#[derive(Deserialize)]
struct RawCask {
    token: String,
    #[serde(default)]
    name: Vec<String>,
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    artifacts: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawFormula {
    name: String,
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    versions: Option<RawFormulaVersions>,
}

#[derive(Deserialize)]
struct RawFormulaVersions {
    #[serde(default)]
    stable: Option<String>,
}

fn extract_app_name(artifacts: &[serde_json::Value]) -> Option<String> {
    for art in artifacts {
        if let Some(arr) = art.get("app").and_then(|v| v.as_array()) {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if s.ends_with(".app") {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

async fn fetch_json_with_fallback(
    client: &reqwest::Client,
    urls: &[&str],
    cache_file: &PathBuf,
    force_refresh: bool,
) -> Result<String, String> {
    if !force_refresh && cache_file.exists() {
        if let Ok(meta) = std::fs::metadata(cache_file) {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().map(|d| d.as_secs() < 86400).unwrap_or(false) {
                    if let Ok(text) = std::fs::read_to_string(cache_file) {
                        if !text.is_empty() {
                            return Ok(text);
                        }
                    }
                }
            }
        }
    }

    let mut last_err = String::new();
    for url in urls {
        match client.get(*url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await {
                    if !text.is_empty() {
                        if let Some(p) = cache_file.parent() {
                            let _ = std::fs::create_dir_all(p);
                        }
                        let _ = std::fs::write(cache_file, &text);
                        return Ok(text);
                    }
                }
            }
            Ok(resp) => last_err = format!("HTTP {} from {}", resp.status(), url),
            Err(e) => last_err = format!("请求 {url} 失败: {e}"),
        }
    }

    if cache_file.exists() {
        if let Ok(text) = std::fs::read_to_string(cache_file) {
            if !text.is_empty() {
                return Ok(text);
            }
        }
    }

    Err(format!("无法获取 Homebrew 软件索引: {last_err}"))
}

async fn ensure_catalog_loaded(force_refresh: bool) -> Result<Vec<CatalogEntry>, String> {
    if !force_refresh {
        let guard = cache_lock().read().await;
        if let Some(ref entries) = *guard {
            return Ok(entries.clone());
        }
    }

    let client = crate::commands::proxy::build_http_client(std::time::Duration::from_secs(25))
        .map_err(|e| e.to_string())?;

    let dir = cache_dir();
    let cask_file = dir.join("cask.json");
    let formula_file = dir.join("formula.json");

    let (cask_res, formula_res) = tokio::join!(
        fetch_json_with_fallback(
            &client,
            &[
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api/cask.json",
                "https://formulae.brew.sh/api/cask.json",
            ],
            &cask_file,
            force_refresh,
        ),
        fetch_json_with_fallback(
            &client,
            &[
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api/formula.json",
                "https://formulae.brew.sh/api/formula.json",
            ],
            &formula_file,
            force_refresh,
        )
    );

    let mut entries = Vec::with_capacity(15000);

    if let Ok(text) = cask_res {
        if let Ok(casks) = serde_json::from_str::<Vec<RawCask>>(&text) {
            for c in casks {
                let display_name = c.name.first().cloned().unwrap_or_else(|| c.token.clone());
                let app_name = extract_app_name(&c.artifacts);
                entries.push(CatalogEntry {
                    token: c.token,
                    name: display_name,
                    desc: c.desc.unwrap_or_default(),
                    homepage: c.homepage.unwrap_or_default(),
                    version: c.version.unwrap_or_default(),
                    kind: "cask".to_string(),
                    app_name,
                });
            }
        }
    }

    if let Ok(text) = formula_res {
        if let Ok(formulas) = serde_json::from_str::<Vec<RawFormula>>(&text) {
            for f in formulas {
                entries.push(CatalogEntry {
                    token: f.name.clone(),
                    name: f.name,
                    desc: f.desc.unwrap_or_default(),
                    homepage: f.homepage.unwrap_or_default(),
                    version: f.versions.and_then(|v| v.stable).unwrap_or_default(),
                    kind: "formula".to_string(),
                    app_name: None,
                });
            }
        }
    }

    if entries.is_empty() {
        return Err("未能加载到 Homebrew 软件索引，请检查网络连接".to_string());
    }

    let mut guard = cache_lock().write().await;
    *guard = Some(entries.clone());
    Ok(entries)
}

#[tauri::command]
pub async fn search_brew_catalog(
    query: String,
    kind: Option<String>,
    limit: Option<usize>,
    force_refresh: Option<bool>,
) -> Result<Vec<CatalogEntry>, String> {
    let entries = ensure_catalog_loaded(force_refresh.unwrap_or(false)).await?;
    let q = query.trim().to_lowercase();
    let max_items = limit.unwrap_or(40).min(100);
    let kind_filter = kind.unwrap_or_else(|| "all".to_string());

    if q.is_empty() {
        return Ok(entries
            .into_iter()
            .filter(|e| kind_filter == "all" || e.kind == kind_filter)
            .take(max_items)
            .collect());
    }

    let mut scored: Vec<(u8, &CatalogEntry)> = Vec::new();
    for entry in &entries {
        if kind_filter != "all" && entry.kind != kind_filter {
            continue;
        }
        let token_l = entry.token.to_lowercase();
        let name_l = entry.name.to_lowercase();
        let desc_l = entry.desc.to_lowercase();

        let score = if token_l == q || name_l == q {
            0
        } else if token_l.starts_with(&q) || name_l.starts_with(&q) {
            1
        } else if token_l.contains(&q) || name_l.contains(&q) {
            2
        } else if desc_l.contains(&q) {
            3
        } else {
            continue;
        };

        let tie_breaker = if entry.kind == "cask" { 0 } else { 1 };
        scored.push((score * 2 + tie_breaker, entry));
    }

    scored.sort_by_key(|(s, _)| *s);
    Ok(scored
        .into_iter()
        .take(max_items)
        .map(|(_, e)| e.clone())
        .collect())
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn pick_best_mac_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    let arch = std::env::consts::ARCH;
    let is_arm = arch == "aarch64" || arch == "arm64";

    let candidates: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| {
            let n = a.name.to_lowercase();
            let valid_ext = n.ends_with(".dmg") || n.ends_with(".pkg") || n.ends_with(".zip");
            let excluded = n.contains("blockmap")
                || n.contains("sha256")
                || n.ends_with(".sig")
                || n.contains("linux")
                || n.contains("windows")
                || n.contains("win32")
                || n.contains("win64")
                || n.contains("android")
                || n.contains("ios")
                || n.contains("server");
            if !valid_ext || excluded {
                return false;
            }
            if n.ends_with(".zip") {
                n.contains("mac")
                    || n.contains("darwin")
                    || n.contains("osx")
                    || n.contains("apple")
                    || n.contains("universal")
            } else {
                true
            }
        })
        .collect();

    if candidates.is_empty() {
        return None;
    }

    if is_arm {
        if let Some(a) = candidates.iter().find(|a| {
            let n = a.name.to_lowercase();
            n.contains("arm64") || n.contains("aarch64") || n.contains("silicon")
        }) {
            return Some(*a);
        }
    } else if let Some(a) = candidates.iter().find(|a| {
        let n = a.name.to_lowercase();
        (n.contains("x64") || n.contains("x86_64") || n.contains("amd64") || n.contains("intel"))
            && !n.contains("arm64")
            && !n.contains("aarch64")
    }) {
        return Some(*a);
    }

    if let Some(a) = candidates
        .iter()
        .find(|a| a.name.to_lowercase().contains("universal"))
    {
        return Some(*a);
    }

    if is_arm {
        if let Some(a) = candidates.iter().find(|a| {
            let n = a.name.to_lowercase();
            !n.contains("x64")
                && !n.contains("x86_64")
                && !n.contains("amd64")
                && !n.contains("intel")
        }) {
            return Some(*a);
        }
    } else if let Some(a) = candidates.iter().find(|a| {
        let n = a.name.to_lowercase();
        !n.contains("arm64") && !n.contains("aarch64")
    }) {
        return Some(*a);
    }

    candidates.first().copied()
}

pub fn normalize_github_repo(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let stripped = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("github.com/"))
        .unwrap_or(trimmed);
    let parts: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1].trim_end_matches(".git")))
    } else {
        None
    }
}

#[tauri::command]
pub async fn inspect_github_repo(repo_input: String) -> Result<GitHubReleaseInfo, String> {
    let repo = normalize_github_repo(&repo_input)
        .ok_or_else(|| "请输入有效的 GitHub 仓库（如 owner/repo 或 GitHub 链接）".to_string())?;

    let client = crate::commands::proxy::build_http_client(std::time::Duration::from_secs(20))
        .map_err(|e| e.to_string())?;

    let latest_url = format!("https://api.github.com/repos/{repo}/releases/latest");
    if let Ok(resp) = client.get(&latest_url).send().await {
        if resp.status().is_success() {
            if let Ok(rel) = resp.json::<GhRelease>().await {
                if let Some(asset) = pick_best_mac_asset(&rel.assets) {
                    return Ok(GitHubReleaseInfo {
                        repo,
                        tag_name: rel.tag_name.clone(),
                        release_name: rel.name.unwrap_or(rel.tag_name),
                        html_url: rel.html_url,
                        asset_name: Some(asset.name.clone()),
                        asset_url: Some(asset.browser_download_url.clone()),
                        asset_size: Some(asset.size),
                    });
                }
            }
        }
    }

    let list_url = format!("https://api.github.com/repos/{repo}/releases?per_page=10");
    let resp = client
        .get(&list_url)
        .send()
        .await
        .map_err(|e| format!("访问 GitHub API 失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回状态码 {}", resp.status()));
    }

    let releases = resp
        .json::<Vec<GhRelease>>()
        .await
        .map_err(|e| format!("解析 GitHub Release 失败: {e}"))?;

    for rel in &releases {
        if let Some(asset) = pick_best_mac_asset(&rel.assets) {
            return Ok(GitHubReleaseInfo {
                repo,
                tag_name: rel.tag_name.clone(),
                release_name: rel.name.clone().unwrap_or_else(|| rel.tag_name.clone()),
                html_url: rel.html_url.clone(),
                asset_name: Some(asset.name.clone()),
                asset_url: Some(asset.browser_download_url.clone()),
                asset_size: Some(asset.size),
            });
        }
    }

    if let Some(first) = releases.first() {
        Ok(GitHubReleaseInfo {
            repo,
            tag_name: first.tag_name.clone(),
            release_name: first.name.clone().unwrap_or_else(|| first.tag_name.clone()),
            html_url: first.html_url.clone(),
            asset_name: None,
            asset_url: None,
            asset_size: None,
        })
    } else {
        Err(format!("仓库 {repo} 暂无可用的 Release 版本"))
    }
}

#[tauri::command]
pub async fn fetch_featured_catalog(force_refresh: Option<bool>) -> Result<serde_json::Value, String> {
    let client = crate::commands::proxy::build_http_client(std::time::Duration::from_secs(15))
        .map_err(|e| e.to_string())?;

    let cache_file = cache_dir().join("featured.json");
    let text = fetch_json_with_fallback(
        &client,
        &[
            "https://cdn.jsdelivr.net/gh/starandget/star-box@main/catalog/featured.json",
            "https://raw.githubusercontent.com/starandget/star-box/main/catalog/featured.json",
        ],
        &cache_file,
        force_refresh.unwrap_or(false),
    )
    .await?;

    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("解析精选软件表失败: {e}"))
}
