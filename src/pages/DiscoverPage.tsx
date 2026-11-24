import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import bundledFeatured from "../../catalog/featured.json";
import { api } from "@/api";
import { AppIcon } from "@/components/AppIcon";
import { SourceBadge, resolveAppSource } from "@/components/SourceBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { isAppInList } from "@/lib/appMatch";
import { cn } from "@/lib/utils";
import type {
  AppItem,
  CatalogEntry,
  FeaturedApp,
  FeaturedCatalog,
  GitHubReleaseInfo,
  InstalledInfo,
} from "@/types";

export type DiscoverMode = "cn" | "global" | "brew" | "github";

interface DiscoverPageProps {
  mode: DiscoverMode;
  onChangeMode: (mode: DiscoverMode) => void;
  groups: string[];
  existingApps: AppItem[];
  scanVersion: number;
  onAddToList: (item: AppItem) => void;
  onAddAppsBatch: (items: AppItem[]) => void;
  onInstallApps: (items: AppItem[]) => void;
  onDirectInstall: (item: AppItem) => void;
}

function toAppItemFromFeatured(f: FeaturedApp, fallbackGroup: string): AppItem {
  return {
    id: f.id,
    name: f.name,
    group: f.category || fallbackGroup,
    description: f.description,
    kind: f.kind,
    brew_casks: f.brew_casks || [],
    brew_formula: f.brew_formula || null,
    github_repo: f.github_repo || null,
    website: f.website || null,
    dock_apps: f.dock_apps || [],
    icon_url: f.icon_url || null,
  };
}

export function DiscoverPage({
  mode,
  onChangeMode,
  groups,
  existingApps,
  scanVersion,
  onAddToList,
  onDirectInstall,
}: DiscoverPageProps) {
  const featuredCatalog = bundledFeatured as FeaturedCatalog;
  const [featuredQuery, setFeaturedQuery] = useState("");
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [featuredInstalledMap, setFeaturedInstalledMap] = useState<
    Record<string, InstalledInfo>
  >({});

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "cask" | "formula">("cask");
  const [results, setResults] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const targetGroup = groups[0] || "网络与日常";

  const [repoInput, setRepoInput] = useState("");
  const [ghLoading, setGhLoading] = useState(false);
  const [ghInfo, setGhInfo] = useState<GitHubReleaseInfo | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const items = featuredCatalog.apps.map((f) =>
      toAppItemFromFeatured(f, targetGroup)
    );
    api
      .scanInstalledApps(items)
      .then((list) => {
        if (cancelled) return;
        const map: Record<string, InstalledInfo> = {};
        for (const info of list) map[info.id] = info;
        setFeaturedInstalledMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [featuredCatalog, targetGroup, scanVersion]);

  const regionCounts = useMemo(() => {
    let cn = 0;
    let global = 0;
    for (const app of featuredCatalog.apps) {
      if (app.region === "cn") cn++;
      else global++;
    }
    return { cn, global, all: featuredCatalog.apps.length };
  }, [featuredCatalog.apps]);

  const regionFilteredApps = useMemo(() => {
    const activeRegion = mode === "global" ? "global" : "cn";
    return featuredCatalog.apps.filter((app) => {
      const r = app.region || "global";
      return r === activeRegion;
    });
  }, [featuredCatalog.apps, mode]);

  const groupedFeatured = useMemo(() => {
    const q = featuredQuery.trim().toLowerCase();
    const filtered = regionFilteredApps.filter((app) => {
      if (!q) return true;
      return (
        app.name.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q) ||
        app.category.toLowerCase().includes(q) ||
        (app.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        (app.brew_casks || []).some((c) => c.toLowerCase().includes(q))
      );
    });

    const map = new Map<string, FeaturedApp[]>();
    for (const c of featuredCatalog.categories) map.set(c, []);
    for (const app of filtered) {
      if (!map.has(app.category)) map.set(app.category, []);
      map.get(app.category)!.push(app);
    }
    return Array.from(map.entries()).filter(([, list]) => list.length > 0);
  }, [featuredCatalog.categories, regionFilteredApps, featuredQuery]);

  const runBrewSearch = async (q: string, k: string, force = false) => {
    setLoading(true);
    setSearchError(null);
    try {
      const data = await api.searchBrewCatalog(q, k, 48, force);
      setResults(data);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (mode !== "brew") return;
    const timer = setTimeout(() => {
      runBrewSearch(query, kindFilter);
    }, 260);
    return () => clearTimeout(timer);
  }, [query, kindFilter, mode]);

  const toAppItemFromBrew = (entry: CatalogEntry): AppItem => ({
    id: `${entry.kind}-${entry.token}`,
    name: entry.name || entry.token,
    group: targetGroup,
    description: entry.desc || null,
    kind: entry.kind,
    brew_casks: entry.kind === "cask" ? [entry.token] : [],
    brew_formula: entry.kind === "formula" ? entry.token : null,
    github_repo: null,
    website: entry.homepage || null,
    dock_apps: entry.app_name ? [entry.app_name] : [],
    icon_url: null,
  });

  const handleInspectGithub = async () => {
    if (!repoInput.trim()) return;
    setGhLoading(true);
    setGhError(null);
    setGhInfo(null);
    try {
      const info = await api.inspectGithubRepo(repoInput);
      setGhInfo(info);
    } catch (e) {
      setGhError(String(e));
    } finally {
      setGhLoading(false);
    }
  };

  const toAppItemFromGithub = (info: GitHubReleaseInfo): AppItem => {
    const shortName = info.repo.split("/")[1] || info.repo;
    return {
      id: `gh-${info.repo.replace("/", "-").toLowerCase()}`,
      name: shortName,
      group: targetGroup,
      description: `GitHub Releases (${info.tag_name})`,
      kind: "github",
      brew_casks: [],
      brew_formula: null,
      github_repo: info.repo,
      website: info.html_url,
      dock_apps: [],
      icon_url: null,
    };
  };

  const toggleCat = (cat: string) =>
    setCollapsedCats((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const isRegionMode = mode === "cn" || mode === "global";

  return (
    <div className="flex h-full flex-col">
      {/* Clean single top bar: Title | Centered Source Switcher | Search */}
      <header className="grid h-13 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-border bg-card/80 px-5 backdrop-blur-md">
        <h2 className="shrink-0 justify-self-start text-base font-semibold tracking-tight">
          浏览软件
        </h2>

        <div className="flex shrink-0 items-center justify-self-center">
          <div className="inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5">
            {(
              [
                ["cn", `银河系 (${regionCounts.cn})`],
                ["global", `河外星系 (${regionCounts.global})`],
                ["brew", "Homebrew"],
                ["github", "GitHub"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => onChangeMode(m)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap",
                  mode === m
                    ? "bg-primary text-primary-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div />
      </header>

      {/* Main Scroll Canvas (no box-in-box!) */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {isRegionMode && (
          <div className="mx-auto max-w-6xl space-y-7">
            {/* Compact Region Header with Centered Search */}
            <div className="grid grid-cols-1 gap-3 border-b border-border pb-3 md:grid-cols-[1fr_minmax(260px,400px)_1fr] md:items-center">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {mode === "cn"
                    ? "🌌 银河系 · 国区常用"
                    : "🪐 河外星系 · 外区常用"}
                </span>
                <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                  {regionFilteredApps.length}
                </span>
              </div>

              <div className="relative w-full">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8.5 rounded-full bg-card pl-8.5 text-xs shadow-2xs"
                  placeholder={`搜索${
                    mode === "cn" ? "银河系" : "河外星系"
                  }软件（名称、描述、标签）...`}
                  value={featuredQuery}
                  onChange={(e) => setFeaturedQuery(e.target.value)}
                />
              </div>

              <div className="flex justify-end">
                {featuredQuery.trim() && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-primary"
                    onClick={() => {
                      setQuery(featuredQuery);
                      onChangeMode("brew");
                    }}
                  >
                    搜 Homebrew 全量库
                  </Button>
                )}
              </div>
            </div>

            {groupedFeatured.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
                <p className="text-sm text-muted-foreground">
                  当前列表暂未收录「{featuredQuery}」
                </p>
                <Button
                  className="mt-3 rounded-full"
                  size="sm"
                  onClick={() => {
                    setQuery(featuredQuery);
                    onChangeMode("brew");
                  }}
                >
                  <Search className="h-3.5 w-3.5" />
                  去 14,000+ Homebrew 全量库搜索「{featuredQuery}」
                </Button>
              </div>
            ) : (
              groupedFeatured.map(([category, items]) => {
                const collapsed = !!collapsedCats[category];
                const installedInCat = items.filter(
                  (f) => featuredInstalledMap[f.id]?.installed
                ).length;

                return (
                  <section key={category} className="space-y-3">
                    {/* Open Canvas Section Heading */}
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => toggleCat(category)}
                        className="flex items-center gap-2 text-left cursor-pointer group"
                      >
                        <h3 className="text-sm font-semibold tracking-tight text-foreground">
                          {category}
                        </h3>
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                          {items.length}
                        </span>
                        {installedInCat > 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            已装 {installedInCat}
                          </span>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleCat(category)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-secondary cursor-pointer"
                      >
                        {collapsed ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronUp className="h-4 w-4" />
                        )}
                      </button>
                    </div>

                    {/* Apple App Store Style Clean Cards */}
                    {!collapsed && (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {items.map((f) => {
                          const appItem = toAppItemFromFeatured(f, targetGroup);
                          const info = featuredInstalledMap[f.id];
                          const isInstalled = !!info?.installed;
                          const inMyList = isAppInList(existingApps, appItem);

                          return (
                            <div
                              key={f.id}
                              className="group relative flex items-center gap-3.5 rounded-xl border border-border/75 bg-card p-3.5 shadow-2xs transition-all hover:border-primary/40 hover:shadow-sm"
                            >
                              <AppIcon
                                name={f.name}
                                nativeIcon={info?.icon_data_url}
                                iconUrl={f.icon_url}
                                website={f.website}
                                githubRepo={f.github_repo}
                                isFormula={f.kind === "formula"}
                                size="md"
                              />

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-[13.5px] font-semibold text-foreground">
                                    {f.name}
                                  </span>
                                  <SourceBadge source={resolveAppSource(f)} />
                                </div>
                                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                  {f.description}
                                </p>
                              </div>

                              <div className="flex shrink-0 items-center gap-1">
                                {/* Hover-reveal subtle utility icons */}
                                <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
                                  {f.website && (
                                    <button
                                      type="button"
                                      title="打开官网"
                                      onClick={() => api.openExternal(f.website!)}
                                      className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer"
                                    >
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={inMyList}
                                    title={inMyList ? "已在我的清单" : "加入我的清单"}
                                    onClick={() => onAddToList(appItem)}
                                    className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-45 cursor-pointer"
                                  >
                                    {inMyList ? (
                                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                                    ) : (
                                      <Plus className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </div>

                                {isInstalled ? (
                                  info?.app_path ? (
                                    <button
                                      type="button"
                                      onClick={() => api.openInstalledApp(info.app_path!)}
                                      className="rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400 transition-colors cursor-pointer"
                                    >
                                      打开
                                    </button>
                                  ) : (
                                    <span className="rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                      已装
                                    </span>
                                  )
                                ) : !appItem.brew_formula &&
                                  appItem.brew_casks.length === 0 &&
                                  !appItem.github_repo &&
                                  appItem.website ? (
                                  <button
                                    type="button"
                                    onClick={() => api.openExternal(appItem.website!)}
                                    className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-400 transition-colors cursor-pointer"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                    官网
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => onDirectInstall(appItem)}
                                    className="rounded-full bg-primary/12 px-3 py-1 text-xs font-medium text-primary hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                                  >
                                    安装
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        )}

        {mode === "brew" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-2xs">
              <div className="relative min-w-64 flex-1 max-w-md">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs"
                  placeholder="搜索 14,000+ Homebrew 软件（raycast、vscode、ffmpeg...）"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1.5">
                {(
                  [
                    ["cask", "桌面应用"],
                    ["formula", "CLI"],
                    ["all", "全部"],
                  ] as const
                ).map(([k, label]) => (
                  <Button
                    key={k}
                    size="sm"
                    className="h-7 text-xs"
                    variant={kindFilter === k ? "default" : "secondary"}
                    onClick={() => setKindFilter(k)}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="刷新索引"
                  onClick={() => runBrewSearch(query, kindFilter, true)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {searchError && (
              <Alert variant="destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <AlertTitle>索引加载失败</AlertTitle>
                  <AlertDescription>{searchError}</AlertDescription>
                </div>
              </Alert>
            )}

            {loading ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card py-16 text-xs text-muted-foreground">
                <Spinner />
                正在加载 Homebrew 软件索引...
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-3 shadow-2xs">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {results.map((entry) => {
                    const id = `${entry.kind}-${entry.token}`;
                    const appItem = toAppItemFromBrew(entry);
                    const added = isAppInList(existingApps, appItem);
                    return (
                      <div
                        key={id}
                        className="flex flex-col justify-between gap-2 rounded-lg border border-border bg-background p-2.5 hover:border-blue-500/40 transition-colors"
                      >
                        <div className="flex items-start gap-2.5">
                          <AppIcon
                            name={entry.name}
                            website={entry.homepage}
                            isFormula={entry.kind === "formula"}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-[13px] font-semibold">
                                {entry.name}
                              </span>
                              <button
                                type="button"
                                onClick={() => onDirectInstall(appItem)}
                                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-500/12 dark:text-blue-400 cursor-pointer"
                              >
                                安装
                              </button>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                              {entry.desc || entry.token}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-1 pt-0.5">
                          <div className="flex items-center gap-1 min-w-0">
                            <SourceBadge
                              source="brew"
                              label={entry.kind === "cask" ? "Brew" : "Brew CLI"}
                            />
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {entry.version}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            {entry.homepage && (
                              <button
                                type="button"
                                title="打开官网"
                                onClick={() => api.openExternal(entry.homepage)}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={added}
                              title={added ? "已在清单" : "加入清单"}
                              onClick={() => onAddToList(appItem)}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-45 cursor-pointer"
                            >
                              {added ? (
                                <Check className="h-3 w-3 text-emerald-500" />
                              ) : (
                                <Plus className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {mode === "github" && (
          <div className="mx-auto max-w-2xl space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>从 GitHub Releases 自动选包安装</CardTitle>
                <CardDescription>
                  输入仓库名（如 clash-verge-rev/clash-verge-rev）或完整链接，自动匹配本机架构的 .dmg / .pkg / .zip。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Input
                  placeholder="owner/repo 或 https://github.com/owner/repo"
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleInspectGithub()}
                />
                <Button
                  disabled={ghLoading || !repoInput.trim()}
                  onClick={handleInspectGithub}
                >
                  {ghLoading ? <Spinner /> : "解析版本"}
                </Button>
              </CardContent>
            </Card>

            {ghError && (
              <Alert variant="destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <AlertTitle>解析失败</AlertTitle>
                  <AlertDescription>{ghError}</AlertDescription>
                </div>
              </Alert>
            )}

            {ghInfo && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <CardTitle className="truncate">{ghInfo.repo}</CardTitle>
                      <SourceBadge source="github" />
                    </div>
                    <Badge variant="info">{ghInfo.tag_name}</Badge>
                  </div>
                  <CardDescription>{ghInfo.release_name}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {ghInfo.asset_name ? (
                    <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs">
                      <div className="font-medium text-foreground">
                        已自动匹配适合本机的安装包：
                      </div>
                      <div className="mt-1 font-mono text-muted-foreground">
                        {ghInfo.asset_name}
                        {ghInfo.asset_size
                          ? ` (${(ghInfo.asset_size / 1_048_576).toFixed(1)} MB)`
                          : ""}
                      </div>
                    </div>
                  ) : (
                    <Alert variant="warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <AlertTitle>未找到可直接安装的 macOS 二进制包</AlertTitle>
                        <AlertDescription>
                          该仓库最新 Release 没有 .dmg / .pkg / macOS .zip 文件。
                        </AlertDescription>
                      </div>
                    </Alert>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => api.openExternal(ghInfo.html_url)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      打开 Release
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onAddToList(toAppItemFromGithub(ghInfo))}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      加入清单
                    </Button>
                    {ghInfo.asset_url && (
                      <Button
                        size="sm"
                        onClick={() => onDirectInstall(toAppItemFromGithub(ghInfo))}
                      >
                        <Download className="h-3.5 w-3.5" />
                        立即下载并安装
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
