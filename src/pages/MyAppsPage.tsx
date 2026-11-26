import { useMemo, useState } from "react";
import {
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
  FolderUp,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "@/api";
import { AppIcon } from "@/components/AppIcon";
import {
  SourceBadge,
  resolveAppSource,
  resolveLocalAppSource,
} from "@/components/SourceBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { classifyLocalApp, OTHER_GROUP, UNIFIED_APP_GROUPS } from "@/lib/appGroups";
import { STAR_VAULT_APPS } from "@/lib/starVault";
import { cn } from "@/lib/utils";
import type {
  AppItem,
  EnvStatus,
  InstallTask,
  LocalAppCandidate,
} from "@/types";

interface MyAppsPageProps {
  localApps: LocalAppCandidate[];
  localScanning: boolean;
  groups: string[];
  apps: AppItem[];
  scanning: boolean;
  env: EnvStatus | null;
  tasks: InstallTask[];
  onRefreshScan: () => void;
  onUpgradeApps: (items: AppItem[]) => void;
  onUninstallApp: (item: AppItem) => void;
  onGoSettings: () => void;
}

type InstalledFilter = "all" | "brew" | "github" | "direct" | "outdated";

function localToAppItem(c: LocalAppCandidate, fallbackGroup: string): AppItem {
  return {
    id: c.id,
    name: c.name,
    group: fallbackGroup,
    description: c.brew_cask ? `Homebrew Cask: ${c.brew_cask}` : c.app_path,
    kind: c.brew_cask ? "cask" : "direct",
    brew_casks: c.brew_cask ? [c.brew_cask] : [],
    brew_formula: null,
    github_repo: null,
    website: null,
    dock_apps: [c.app_name],
    icon_url: null,
  };
}

export function MyAppsPage({
  localApps,
  localScanning,
  groups,
  apps,
  scanning,
  tasks,
  onRefreshScan,
  onUpgradeApps,
  onUninstallApp,
  onGoSettings,
}: MyAppsPageProps) {
  const [filter, setFilter] = useState<InstalledFilter>("all");
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [uninstallTarget, setUninstallTarget] = useState<{
    name: string;
    detail: string;
    item: AppItem;
  } | null>(null);

  const toggleGroup = (g: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [g]: !prev[g] }));

  const runningIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) {
      if (t.status === "queued" || t.status === "running") {
        s.add(t.app.id);
      }
    }
    return s;
  }, [tasks]);

  const githubMatchNames = useMemo(() => {
    const set = new Set<string>();
    for (const item of [...apps, ...STAR_VAULT_APPS]) {
      if (resolveAppSource(item) === "github") {
        set.add(item.name.toLowerCase());
        for (const d of item.dock_apps || []) {
          set.add(d.toLowerCase());
        }
      }
    }
    return set;
  }, [apps]);

  // Installed stats by source channel
  const sourceCounts = useMemo(() => {
    let brew = 0;
    let github = 0;
    let direct = 0;
    for (const app of localApps) {
      const src = resolveLocalAppSource(app, githubMatchNames);
      if (src === "brew") brew += 1;
      else if (src === "github") github += 1;
      else direct += 1;
    }
    return { brew, github, direct };
  }, [localApps, githubMatchNames]);

  const outdatedApps = useMemo(
    () => localApps.filter((a) => !!a.outdated && !!a.brew_cask),
    [localApps]
  );

  const filteredLocalApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return localApps.filter((app) => {
      const src = resolveLocalAppSource(app, githubMatchNames);
      if (filter === "brew" && src !== "brew") return false;
      if (filter === "github" && src !== "github") return false;
      if (filter === "direct" && src !== "direct") return false;
      if (filter === "outdated" && !app.outdated) return false;
      if (!q) return true;
      return (
        app.name.toLowerCase().includes(q) ||
        app.app_name.toLowerCase().includes(q) ||
        (app.brew_cask || "").toLowerCase().includes(q) ||
        classifyLocalApp(app).toLowerCase().includes(q)
      );
    });
  }, [localApps, githubMatchNames, filter, query]);

  const groupedLocalApps = useMemo(() => {
    const order = [...UNIFIED_APP_GROUPS, OTHER_GROUP];
    const map = new Map<string, LocalAppCandidate[]>();
    for (const g of order) map.set(g, []);
    for (const app of filteredLocalApps) {
      const g = classifyLocalApp(app);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(app);
    }
    return Array.from(map.entries()).filter(([, list]) => list.length > 0);
  }, [filteredLocalApps]);

  const defaultGroup = groups[0] || "本机已装";
  const busyScanning = localScanning || scanning;

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-4 border-b border-border bg-card/80 px-5 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <h2 className="shrink-0 text-base font-semibold tracking-tight">
            已装应用
          </h2>
          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
            {localApps.length}
          </span>
        </div>

        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 rounded-full bg-background/80 pl-8.5 text-xs"
            placeholder="搜索本机已安装软件..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {outdatedApps.length > 0 && (
            <Button
              size="sm"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() =>
                onUpgradeApps(
                  outdatedApps.map((c) => localToAppItem(c, defaultGroup))
                )
              }
            >
              <ArrowUpCircle className="h-3.5 w-3.5" />
              全部更新 ({outdatedApps.length})
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onGoSettings}
            title="备份或同步软件清单"
          >
            <FolderUp className="h-3.5 w-3.5" />
            备份/同步
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={busyScanning}
            onClick={onRefreshScan}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", busyScanning && "animate-spin")}
            />
            刷新
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-6xl space-y-5">
          {/* Filter Pills */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ["all", `全部已装 (${localApps.length})`],
                      ["brew", `Brew 管理 (${sourceCounts.brew})`],
                      ["github", `GitHub 下载 (${sourceCounts.github})`],
                      ["direct", `官网下载 (${sourceCounts.direct})`],
                      ["outdated", `可更新 (${outdatedApps.length})`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setFilter(id)}
                      className={cn(
                        "rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer",
                        filter === id
                          ? "bg-primary/12 text-primary"
                          : "bg-muted/70 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  自动扫描 /Applications 与 ~/Applications
                </span>
              </div>

              {localScanning && localApps.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <Spinner className="h-6 w-6 text-primary" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    正在扫描本机已安装的软件...
                  </p>
                </div>
              ) : filteredLocalApps.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
                  <p className="text-sm text-muted-foreground">
                    {query.trim()
                      ? `没有找到匹配「${query}」的已装软件`
                      : filter === "outdated"
                      ? "所有 Homebrew 管理的软件都已是最新版本"
                      : filter === "github"
                      ? "当前没有通过 GitHub 下载的已装软件"
                      : filter === "direct"
                      ? "当前没有通过官网下载的已装软件"
                      : filter === "brew"
                      ? "当前没有通过 Brew 管理的已装软件"
                      : "未检测到已安装的应用"}
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {groupedLocalApps.map(([group, items]) => {
                    const collapsed = !!collapsedGroups[group];
                    return (
                      <section key={group} className="space-y-3">
                        <div className="flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => toggleGroup(group)}
                            className="flex items-center gap-2 text-left cursor-pointer"
                          >
                            <h3 className="text-sm font-semibold tracking-tight text-foreground">
                              {group}
                            </h3>
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                              {items.length}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleGroup(group)}
                            className="rounded-md p-1 text-muted-foreground hover:bg-secondary cursor-pointer"
                          >
                            {collapsed ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronUp className="h-4 w-4" />
                            )}
                          </button>
                        </div>

                        {!collapsed && (
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                            {items.map((app) => {
                              const busy = runningIds.has(app.id);
                              const appItem = localToAppItem(app, group);
                              return (
                                <div
                                  key={app.id}
                                  className="group flex items-center gap-3 rounded-xl border border-border/80 bg-card p-3.5 transition-all hover:border-primary/35 hover:shadow-xs"
                                >
                                  <AppIcon
                                    name={app.name}
                                    nativeIcon={app.icon_data_url}
                                    size="md"
                                  />

                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <span className="truncate text-sm font-semibold text-foreground">
                                        {app.name}
                                      </span>
                                      <SourceBadge
                                        source={resolveLocalAppSource(
                                          app,
                                          githubMatchNames
                                        )}
                                      />
                                      {app.outdated && (
                                        <Badge variant="warning" className="text-[10px]">
                                          可更新
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                                      {app.brew_cask || app.app_name}
                                    </p>
                                  </div>

                                  <div className="flex shrink-0 items-center gap-1">
                                    {app.outdated && app.brew_cask && (
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy}
                                        className="h-7 rounded-full px-2.5 text-xs"
                                        onClick={() => onUpgradeApps([appItem])}
                                      >
                                        {busy ? (
                                          <Spinner className="h-3 w-3" />
                                        ) : (
                                          "更新"
                                        )}
                                      </Button>
                                    )}

                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 rounded-full px-2.5 text-xs text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10 dark:text-emerald-400"
                                      onClick={() => api.openInstalledApp(app.app_path)}
                                    >
                                      <Play className="h-3 w-3" />
                                      打开
                                    </Button>

                                    <button
                                      type="button"
                                      disabled={busy}
                                      title="卸载此软件"
                                      onClick={() =>
                                        setUninstallTarget({
                                          name: app.name,
                                          detail: app.brew_cask
                                            ? `将通过 Homebrew 卸载 ${app.brew_cask}`
                                            : `将从 ${app.app_path} 移除应用`,
                                          item: appItem,
                                        })
                                      }
                                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
        </div>
      </div>

      {/* Uninstall Confirmation Dialog */}
      {uninstallTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-foreground">
              确认卸载 {uninstallTarget.name}？
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {uninstallTarget.detail}。此操作不可撤销，请确认该应用已关闭。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setUninstallTarget(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  onUninstallApp(uninstallTarget.item);
                  setUninstallTarget(null);
                }}
              >
                确认卸载
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
