import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { api } from "@/api";
import { AppIcon } from "@/components/AppIcon";
import { SourceBadge, resolveAppSource } from "@/components/SourceBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { STARTER_PACK_CATEGORIES, STAR_VAULT_APPS } from "@/lib/starVault";
import { cn } from "@/lib/utils";
import type {
  AppItem,
  EnvStatus,
  FeaturedApp,
  InstalledInfo,
  InstallTask,
} from "@/types";

interface StarterPackPageProps {
  env: EnvStatus | null;
  tasks: InstallTask[];
  scanVersion: number;
  onInstallApps: (items: AppItem[]) => void;
  onAddAppsBatch: (items: AppItem[]) => void;
  onGoEnv: () => void;
}

function toAppItem(f: FeaturedApp): AppItem {
  return {
    id: f.id,
    name: f.name,
    group: f.category,
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

export function StarterPackPage({
  env,
  tasks,
  scanVersion,
  onInstallApps,
  onAddAppsBatch,
  onGoEnv,
}: StarterPackPageProps) {
  const [installedMap, setInstalledMap] = useState<Record<string, InstalledInfo>>(
    {}
  );
  const [scanning, setScanning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const didInitSelectionRef = useRef(false);

  const allAppItems = useMemo(
    () => STAR_VAULT_APPS.map((f) => toAppItem(f)),
    []
  );

  const appItemById = useMemo(() => {
    const map = new Map<string, AppItem>();
    for (const item of allAppItems) map.set(item.id, item);
    return map;
  }, [allAppItems]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const list = await api.scanInstalledApps(allAppItems);
      const map: Record<string, InstalledInfo> = {};
      for (const info of list) map[info.id] = info;
      setInstalledMap(map);

      if (!didInitSelectionRef.current) {
        didInitSelectionRef.current = true;
        const missing = STAR_VAULT_APPS.filter(
          (f) => !map[f.id]?.installed
        ).map((f) => f.id);
        setSelectedIds(new Set(missing));
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of prev) {
            if (map[id]?.installed) next.delete(id);
          }
          return next;
        });
      }
    } catch (e) {
      console.error("StarterPack scanInstalledApps failed:", e);
    } finally {
      setScanning(false);
    }
  }, [allAppItems]);

  useEffect(() => {
    runScan();
  }, [runScan, scanVersion]);

  const activeTaskByAppId = useMemo(() => {
    const map = new Map<string, InstallTask>();
    for (const t of tasks) {
      if (t.status === "queued" || t.status === "running") {
        map.set(t.app.id, t);
      }
    }
    return map;
  }, [tasks]);

  const groupedApps = useMemo(() => {
    const map = new Map<string, FeaturedApp[]>();
    for (const cat of STARTER_PACK_CATEGORIES) map.set(cat, []);
    for (const app of STAR_VAULT_APPS) {
      if (!map.has(app.category)) map.set(app.category, []);
      map.get(app.category)!.push(app);
    }
    return Array.from(map.entries()).filter(([, list]) => list.length > 0);
  }, []);

  const totalCount = STAR_VAULT_APPS.length;
  const installedCount = useMemo(
    () =>
      STAR_VAULT_APPS.filter((f) => installedMap[f.id]?.installed).length,
    [installedMap]
  );

  const missingApps = useMemo(
    () => STAR_VAULT_APPS.filter((f) => !installedMap[f.id]?.installed),
    [installedMap]
  );

  const selectableMissingApps = useMemo(
    () => missingApps.filter((f) => !activeTaskByAppId.has(f.id)),
    [missingApps, activeTaskByAppId]
  );

  const selectedItems = useMemo(
    () =>
      STAR_VAULT_APPS.filter(
        (f) =>
          selectedIds.has(f.id) &&
          !installedMap[f.id]?.installed &&
          !activeTaskByAppId.has(f.id)
      ).map((f) => appItemById.get(f.id)!),
    [selectedIds, installedMap, activeTaskByAppId, appItemById]
  );

  const allMissingSelected =
    selectableMissingApps.length > 0 &&
    selectableMissingApps.every((f) => selectedIds.has(f.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleAllMissing = () => {
    if (allMissingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableMissingApps.map((f) => f.id)));
    }
  };

  const handleToggleGroup = (items: FeaturedApp[]) => {
    const groupMissing = items.filter(
      (f) => !installedMap[f.id]?.installed && !activeTaskByAppId.has(f.id)
    );
    if (groupMissing.length === 0) return;
    const allInGroupSelected = groupMissing.every((f) => selectedIds.has(f.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const f of groupMissing) {
        if (allInGroupSelected) next.delete(f.id);
        else next.add(f.id);
      }
      return next;
    });
  };

  const handleBatchInstall = () => {
    if (selectedItems.length === 0) return;
    onAddAppsBatch(selectedItems);
    onInstallApps(selectedItems);
  };

  const handleSingleInstall = (f: FeaturedApp) => {
    const item = appItemById.get(f.id)!;
    onAddAppsBatch([item]);
    onInstallApps([item]);
  };

  const progressPct =
    totalCount > 0 ? Math.round((installedCount / totalCount) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-4 border-b border-border bg-card/80 px-5 backdrop-blur-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <h2 className="shrink-0 text-base font-semibold tracking-tight">
            新机启航
          </h2>
          <span className="hidden sm:inline-block truncate text-xs text-muted-foreground">
            初始装机清单 · 一键批量安装
          </span>
          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
            {installedCount} / {totalCount}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={scanning}
            onClick={runScan}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", scanning && "animate-spin")} />
            重新检测
          </Button>

          {selectableMissingApps.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={handleToggleAllMissing}
            >
              {allMissingSelected ? "取消全选" : "全选未装"}
            </Button>
          )}

          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={selectedItems.length === 0}
            onClick={handleBatchInstall}
          >
            <Rocket className="h-3.5 w-3.5" />
            {selectedItems.length > 0
              ? `一键装机 (${selectedItems.length})`
              : missingApps.length === 0
              ? "已全部就绪"
              : "请先勾选软件"}
          </Button>
        </div>
      </header>

      {/* Main Scroll Canvas */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Progress Banner */}
          <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-2xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {missingApps.length === 0 && !scanning ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Rocket className="h-4 w-4 text-primary" />
                )}
                <span className="text-sm font-semibold text-foreground">
                  {missingApps.length === 0 && !scanning
                    ? "初始装机清单已全部就绪"
                    : `装机进度 ${progressPct}%`}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  已装 {installedCount} · 待装 {missingApps.length}
                  {selectedItems.length > 0
                    ? ` · 已选 ${selectedItems.length}`
                    : ""}
                </span>
              </div>

              {scanning && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="h-3 w-3" />
                  正在检测本机安装状态...
                </span>
              )}
            </div>

            <Progress value={progressPct} className="h-1.5" />
          </div>

          {/* Brew Prerequisite Alert */}
          {env && !env.brew_installed && (
            <Alert variant="warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
                <div>
                  <AlertTitle>尚未检测到 Homebrew</AlertTitle>
                  <AlertDescription>
                    大部分装机软件通过 Homebrew Cask 自动下载安装，建议先前往「本机环境」一键配置 Homebrew。
                  </AlertDescription>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onGoEnv}>
                  去本机环境
                </Button>
              </div>
            </Alert>
          )}

          {/* Grouped App Lists */}
          {groupedApps.map(([category, items]) => {
            const installedInCat = items.filter(
              (f) => installedMap[f.id]?.installed
            ).length;
            const groupMissing = items.filter(
              (f) =>
                !installedMap[f.id]?.installed && !activeTaskByAppId.has(f.id)
            );
            const allGroupSelected =
              groupMissing.length > 0 &&
              groupMissing.every((f) => selectedIds.has(f.id));

            return (
              <section key={category} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">
                      {category}
                    </h3>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                      {items.length}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      已装 {installedInCat}/{items.length}
                    </span>
                  </div>

                  {groupMissing.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleToggleGroup(items)}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
                    >
                      {allGroupSelected ? "取消本组" : "勾选本组"}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((f) => {
                    const info = installedMap[f.id];
                    const isInstalled = !!info?.installed;
                    const activeTask = activeTaskByAppId.get(f.id);
                    const isSelected = selectedIds.has(f.id);
                    const canToggle = !isInstalled && !activeTask;

                    return (
                      <div
                        key={f.id}
                        onClick={() => canToggle && toggleSelect(f.id)}
                        className={cn(
                          "group relative flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-2xs transition-all",
                          canToggle && "cursor-pointer",
                          isInstalled
                            ? "border-border/60 bg-card/75"
                            : isSelected
                            ? "border-primary/55 bg-primary/[0.03] shadow-xs"
                            : "border-border/75 hover:border-primary/35 hover:shadow-sm"
                        )}
                      >
                        {/* Selection Checkbox / Installed Check */}
                        <button
                          type="button"
                          disabled={!canToggle}
                          aria-label={isSelected ? `取消勾选 ${f.name}` : `勾选 ${f.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canToggle) toggleSelect(f.id);
                          }}
                          className={cn(
                            "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors",
                            isInstalled
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              : isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/35 bg-background hover:border-primary/60",
                            canToggle && "cursor-pointer"
                          )}
                        >
                          {(isInstalled || isSelected) && (
                            <Check className="h-3 w-3 stroke-[2.5]" />
                          )}
                        </button>

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

                        <div
                          className="flex shrink-0 items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.website && (
                            <button
                              type="button"
                              title="打开官网"
                              onClick={() => api.openExternal(f.website!)}
                              className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary hover:text-foreground cursor-pointer"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {activeTask ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/12 px-2.5 py-1 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                              <Spinner className="h-2.5 w-2.5" />
                              {activeTask.status === "running" ? "安装中" : "排队中"}
                            </span>
                          ) : isInstalled ? (
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
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleSingleInstall(f)}
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
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
