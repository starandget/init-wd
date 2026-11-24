import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  GripVertical,
  History,
  Info,
  Lock,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/api";
import { AppIcon } from "@/components/AppIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  classifyLocalApp,
  MENUBAR_GROUP,
  OTHER_GROUP,
  UNIFIED_APP_GROUPS,
} from "@/lib/appGroups";
import { cn } from "@/lib/utils";
import type {
  AppItem,
  DockApplyResult,
  DockBackup,
  InstalledInfo,
  LocalAppCandidate,
} from "@/types";

interface DockPageProps {
  localApps: LocalAppCandidate[];
  groups: string[];
  apps: AppItem[];
  dockSystemApps: string[];
  installedMap: Record<string, InstalledInfo>;
}

interface DockGroup {
  id: string;
  name: string;
  appIds: string[];
  /** Newly created empty groups stay visible until they receive an app */
  keepEmpty?: boolean;
}

interface SavedDockState {
  groups: DockGroup[];
  hiddenAppIds: string[];
}

const STORAGE_KEY = "starbox-dock-layout-v2";

// Fixed Group 1 (always locked at the front of the Dock)
const FIXED_FIRST_GROUP_LABELS = [
  "访达",
  "启动台",
  "Safari",
  "照片",
  "日历",
  "备忘录",
  "App Store",
  "系统设置",
  "终端",
];

const FIXED_SYSTEM_DOCK_PATHS = [
  "/System/Applications/Apps.app,/System/Applications/Launchpad.app",
  "/Applications/Safari.app",
  "/System/Applications/Photos.app",
  "/System/Applications/Calendar.app",
  "/System/Applications/Notes.app",
  "/System/Applications/App Store.app",
  "/System/Applications/System Settings.app,/System/Applications/System Preferences.app",
  "/System/Applications/Utilities/Terminal.app",
];

function buildDefaultGroups(localApps: LocalAppCandidate[]): {
  groups: DockGroup[];
  hiddenAppIds: string[];
} {
  const order = [...UNIFIED_APP_GROUPS, OTHER_GROUP] as string[];
  const map = new Map<string, string[]>();
  for (const g of order) map.set(g, []);
  const hiddenAppIds: string[] = [];
  for (const app of localApps) {
    const g = classifyLocalApp(app);
    if (g === MENUBAR_GROUP) {
      hiddenAppIds.push(app.id);
      continue;
    }
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(app.id);
  }
  const groups = order
    .filter((name) => name !== MENUBAR_GROUP)
    .map((name) => ({
      id: `grp-${name}`,
      name,
      appIds: map.get(name) || [],
    }))
    .filter((g) => g.appIds.length > 0);
  return { groups, hiddenAppIds };
}

function pruneEmptyGroups(groups: DockGroup[]): DockGroup[] {
  return groups.filter((g) => g.appIds.length > 0 || g.keepEmpty);
}

function mergeSaved(
  localApps: LocalAppCandidate[],
  saved: SavedDockState | null
): { groups: DockGroup[]; hiddenAppIds: string[] } {
  const validIds = new Set(localApps.map((a) => a.id));
  if (!saved || !Array.isArray(saved.groups)) {
    return buildDefaultGroups(localApps);
  }

  const placed = new Set<string>();
  const hiddenAppIds = (saved.hiddenAppIds || []).filter((id) => {
    if (!validIds.has(id) || placed.has(id)) return false;
    placed.add(id);
    return true;
  });

  const groups: DockGroup[] = [];
  for (const g of saved.groups) {
    const kept = (g.appIds || []).filter((id) => {
      if (!validIds.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    if (kept.length > 0 || g.keepEmpty) {
      groups.push({
        id: g.id || `grp-${g.name}-${Math.random().toString(36).slice(2, 6)}`,
        name: g.name,
        appIds: kept,
        keepEmpty: kept.length === 0 ? g.keepEmpty : false,
      });
    }
  }

  // Place newly discovered local apps into their default category
  const byName = new Map(groups.map((g) => [g.name, g]));
  for (const app of localApps) {
    if (placed.has(app.id)) continue;
    const cat = classifyLocalApp(app);
    if (cat === MENUBAR_GROUP) {
      hiddenAppIds.push(app.id);
      continue;
    }
    let target = byName.get(cat);
    if (!target) {
      target = { id: `grp-${cat}`, name: cat, appIds: [] };
      groups.push(target);
      byName.set(cat, target);
    }
    target.appIds.push(app.id);
    target.keepEmpty = false;
  }

  return { groups: pruneEmptyGroups(groups), hiddenAppIds };
}

export function DockPage({ localApps }: DockPageProps) {
  const [groups, setGroups] = useState<DockGroup[]>([]);
  const [hiddenAppIds, setHiddenAppIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [query, setQuery] = useState("");

  // Drag states
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dragApp, setDragApp] = useState<{
    sourceGroupId: string | "hidden";
    appId: string;
  } | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverAppKey, setDragOverAppKey] = useState<string | null>(null);
  const [dragOverHidden, setDragOverHidden] = useState(false);

  const clearDragState = () => {
    setDragGroupId(null);
    setDragApp(null);
    setDragOverGroupId(null);
    setDragOverAppKey(null);
    setDragOverHidden(false);
  };

  const [backups, setBackups] = useState<DockBackup[]>([]);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [result, setResult] = useState<DockApplyResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const appById = useMemo(() => {
    const m = new Map<string, LocalAppCandidate>();
    for (const a of localApps) m.set(a.id, a);
    return m;
  }, [localApps]);

  // Hydrate when localApps loads
  useEffect(() => {
    if (localApps.length === 0) return;
    let saved: SavedDockState | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) as SavedDockState;
    } catch {
      // ignore
    }
    const merged = mergeSaved(localApps, saved);
    setGroups(merged.groups);
    setHiddenAppIds(merged.hiddenAppIds);
    setHydrated(true);
  }, [localApps]);

  // Persist changes
  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload: SavedDockState = { groups, hiddenAppIds };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [hydrated, groups, hiddenAppIds]);

  const loadBackups = async () => {
    try {
      const list = await api.listDockBackups();
      setBackups(list);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadBackups();
  }, []);

  const totalDockApps = useMemo(
    () => groups.reduce((acc, g) => acc + g.appIds.length, 0),
    [groups]
  );

  // Create an empty group immediately (no name required)
  const handleCreateGroup = () => {
    const id = `grp-custom-${Date.now()}`;
    setGroups((prev) => [
      { id, name: id, appIds: [], keepEmpty: true },
      ...prev,
    ]);
    setMessage(null);
  };

  // Delete group (moves its apps to hidden tray so none are lost)
  const handleDeleteGroup = (groupId: string) => {
    const target = groups.find((g) => g.id === groupId);
    if (!target) return;
    if (target.appIds.length > 0) {
      setHiddenAppIds((prev) => [
        ...prev,
        ...target.appIds.filter((id) => !prev.includes(id)),
      ]);
    }
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  };

  // Move group up / down
  const moveGroup = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= groups.length) return;
    setGroups((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(nextIdx, 0, moved);
      return copy;
    });
  };

  // Remove a single app from Dock into hidden tray (auto-deletes group if empty)
  const moveAppToHidden = (groupId: string, appId: string) => {
    setGroups((prev) =>
      pruneEmptyGroups(
        prev.map((g) =>
          g.id === groupId
            ? {
                ...g,
                appIds: g.appIds.filter((id) => id !== appId),
                keepEmpty: false,
              }
            : g
        )
      )
    );
    setHiddenAppIds((prev) => (prev.includes(appId) ? prev : [...prev, appId]));
  };

  // Drop handler on a group card (reorder groups OR move an app into this group)
  const handleDropOnGroup = (targetGroupId: string) => {
    if (dragGroupId && dragGroupId !== targetGroupId) {
      setGroups((prev) => {
        const fromIdx = prev.findIndex((g) => g.id === dragGroupId);
        const toIdx = prev.findIndex((g) => g.id === targetGroupId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        const copy = [...prev];
        const [moved] = copy.splice(fromIdx, 1);
        copy.splice(toIdx, 0, moved);
        return copy;
      });
    } else if (dragApp) {
      if (dragApp.sourceGroupId === targetGroupId) {
        // Dropped on empty space of the same group -> move to the end of this group
        setGroups((prev) =>
          prev.map((g) => {
            if (g.id !== targetGroupId) return g;
            const filtered = g.appIds.filter((id) => id !== dragApp.appId);
            return { ...g, appIds: [...filtered, dragApp.appId], keepEmpty: false };
          })
        );
        clearDragState();
        return;
      }
      if (dragApp.sourceGroupId === "hidden") {
        setHiddenAppIds((prev) => prev.filter((id) => id !== dragApp.appId));
      }
      setGroups((prev) =>
        pruneEmptyGroups(
          prev.map((g) => {
            if (g.id === dragApp.sourceGroupId) {
              return {
                ...g,
                appIds: g.appIds.filter((id) => id !== dragApp.appId),
                keepEmpty: false,
              };
            }
            if (g.id === targetGroupId) {
              return {
                ...g,
                appIds: g.appIds.includes(dragApp.appId)
                  ? g.appIds
                  : [...g.appIds, dragApp.appId],
                keepEmpty: false,
              };
            }
            return g;
          })
        )
      );
    }
    clearDragState();
  };

  // Drop handler on a specific app tile (reorder within group OR cross-group insert)
  const handleDropOnApp = (targetGroupId: string, targetAppId: string) => {
    if (!dragApp) {
      clearDragState();
      return;
    }
    if (
      dragApp.sourceGroupId === targetGroupId &&
      dragApp.appId === targetAppId
    ) {
      clearDragState();
      return;
    }

    if (dragApp.sourceGroupId === "hidden") {
      setHiddenAppIds((prev) => prev.filter((id) => id !== dragApp.appId));
    }

    setGroups((prev) => {
      const next = prev.map((g) => ({ ...g, appIds: [...g.appIds] }));
      if (dragApp.sourceGroupId === targetGroupId) {
        // Same-group reorder: compute indices BEFORE splicing so both L->R and R->L work
        const dst = next.find((g) => g.id === targetGroupId);
        if (dst) {
          const fromIdx = dst.appIds.indexOf(dragApp.appId);
          const toIdx = dst.appIds.indexOf(targetAppId);
          if (fromIdx !== -1 && toIdx !== -1) {
            const [moved] = dst.appIds.splice(fromIdx, 1);
            dst.appIds.splice(toIdx, 0, moved);
          }
          dst.keepEmpty = false;
        }
        return pruneEmptyGroups(next);
      }

      if (dragApp.sourceGroupId !== "hidden") {
        const src = next.find((g) => g.id === dragApp.sourceGroupId);
        if (src) {
          src.appIds = src.appIds.filter((id) => id !== dragApp.appId);
          src.keepEmpty = false;
        }
      }
      const dst = next.find((g) => g.id === targetGroupId);
      if (dst) {
        dst.appIds = dst.appIds.filter((id) => id !== dragApp.appId);
        const idx = dst.appIds.indexOf(targetAppId);
        if (idx === -1) dst.appIds.push(dragApp.appId);
        else dst.appIds.splice(idx, 0, dragApp.appId);
        dst.keepEmpty = false;
      }
      return pruneEmptyGroups(next);
    });
    clearDragState();
  };

  // Drop handler on hidden tray
  const handleDropOnHidden = () => {
    if (!dragApp || dragApp.sourceGroupId === "hidden") {
      clearDragState();
      return;
    }
    moveAppToHidden(dragApp.sourceGroupId, dragApp.appId);
    clearDragState();
  };

  const handleResetDefault = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    const defaults = buildDefaultGroups(localApps);
    setGroups(defaults.groups);
    setHiddenAppIds(defaults.hiddenAppIds);
    setMessage("已重置为默认分类顺序（菜单栏常驻应用默认不放 Dock）");
  };

  const handleApplyDock = async () => {
    setApplying(true);
    setMessage(null);
    setResult(null);
    try {
      const nonEmpty = groups.filter((g) => g.appIds.length > 0);
      const orderedGroupNames = nonEmpty.map((g) => g.name);
      const orderedItems: AppItem[] = [];
      for (const g of nonEmpty) {
        for (const id of g.appIds) {
          const c = appById.get(id);
          if (!c) continue;
          orderedItems.push({
            id: c.id,
            name: c.name,
            group: g.name,
            description: null,
            kind: c.brew_cask ? "cask" : "direct",
            brew_casks: c.brew_cask ? [c.brew_cask] : [],
            brew_formula: null,
            github_repo: null,
            website: null,
            dock_apps: [c.app_path, c.app_name],
            icon_url: null,
          });
        }
      }
      const res = await api.applyDockLayout(
        orderedGroupNames,
        orderedItems,
        FIXED_SYSTEM_DOCK_PATHS
      );
      setResult(res);
      await loadBackups();
    } catch (e) {
      setMessage(`整理失败: ${String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  const handleRestore = async (backupPath: string) => {
    setRestoring(backupPath);
    setMessage(null);
    try {
      await api.restoreDockBackup(backupPath);
      setMessage("已成功恢复选中的 Dock 备份！");
    } catch (e) {
      setMessage(`恢复失败: ${String(e)}`);
    } finally {
      setRestoring(null);
    }
  };

  // Search filter (Read/Query in CRUD)
  const q = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => {
        const matchedIds = g.appIds.filter((id) => {
          const app = appById.get(id);
          return app && app.name.toLowerCase().includes(q);
        });
        return { ...g, appIds: matchedIds };
      })
      .filter((g) => g.appIds.length > 0);
  }, [groups, q, appById]);

  const hiddenApps = useMemo(
    () =>
      hiddenAppIds
        .map((id) => appById.get(id))
        .filter((a): a is LocalAppCandidate => !!a)
        .filter((a) => !q || a.name.toLowerCase().includes(q)),
    [hiddenAppIds, appById, q]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-5">
        <h2 className="shrink-0 text-base font-semibold tracking-tight">
          Dock 整理
        </h2>

        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 rounded-full bg-background/80 pl-8.5 text-xs"
            placeholder="搜索应用..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleCreateGroup}
          >
            <Plus className="h-3.5 w-3.5" />
            新建分组
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleResetDefault}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置默认
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-full px-4 text-xs"
            disabled={applying}
            onClick={handleApplyDock}
          >
            {applying ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            一键应用（{totalDockApps}）
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-6xl space-y-2.5">
          {result && (
            <Alert variant="success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <AlertTitle>
                  Dock 整理完成（共排列 {result.added_count} 个应用）
                </AlertTitle>
                <AlertDescription>
                  原 Dock 已自动备份，不满意可随时在底部一键还原。
                </AlertDescription>
              </div>
            </Alert>
          )}

          {message && (
            <Alert variant="info">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription className="mt-0">{message}</AlertDescription>
            </Alert>
          )}

          {/* Fixed Group 1 (Locked System Apps) */}
          <div
            title="系统固定组（默认置顶，不可修改或删除）"
            className="flex items-center gap-3 rounded-xl border border-border/80 bg-muted/35 px-3 py-2.5"
          >
            <span className="flex shrink-0 items-center text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
            </span>
            <div className="flex flex-1 flex-wrap gap-1.5">
              {FIXED_FIRST_GROUP_LABELS.map((label) => (
                <span
                  key={label}
                  className="rounded-md border border-border/70 bg-card/80 px-2.5 py-1 text-xs font-medium text-foreground/85"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Custom Draggable Groups (Top-to-Bottom = Left-to-Right in Dock) */}
          <div className="space-y-2.5">
            {visibleGroups.map((group, idx) => {
              const appsInGroup = group.appIds
                .map((id) => appById.get(id))
                .filter((a): a is LocalAppCandidate => !!a);

              return (
                <div
                  key={group.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      if (dragOverGroupId === group.id) setDragOverGroupId(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDropOnGroup(group.id);
                  }}
                  className={cn(
                    "group/row flex items-center gap-2.5 rounded-xl border border-border/85 bg-card px-3 py-2 transition-all",
                    dragGroupId === group.id && "opacity-60 ring-2 ring-primary/40",
                    dragOverGroupId === group.id &&
                      dragGroupId !== group.id &&
                      "border-primary/60 ring-2 ring-primary/25"
                  )}
                >
                  {/* Left Drag Handle for Group Reordering */}
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", `group:${group.id}`);
                      setDragApp(null);
                      setDragGroupId(group.id);
                    }}
                    onDragEnd={clearDragState}
                    title="按住拖动调整分组顺序"
                    className="flex shrink-0 cursor-grab items-center self-stretch px-0.5 text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4" />
                  </div>

                  {/* Direct Draggable App Icons Grid */}
                  <div className="flex min-h-[58px] flex-1 flex-wrap items-center gap-1.5">
                    {appsInGroup.length === 0 ? (
                      <div className="w-full py-2.5 text-center text-xs text-muted-foreground">
                        将任意应用图标拖到这里
                      </div>
                    ) : (
                      appsInGroup.map((app) => {
                        const isDragging =
                          dragApp?.sourceGroupId === group.id &&
                          dragApp?.appId === app.id;
                        const tileKey = `${group.id}:${app.id}`;
                        const isDragOver =
                          dragOverAppKey === tileKey &&
                          !(
                            dragApp?.sourceGroupId === group.id &&
                            dragApp?.appId === app.id
                          );
                        return (
                          <div
                            key={app.id}
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", `app:${app.id}`);
                              setDragGroupId(null);
                              setDragApp({
                                sourceGroupId: group.id,
                                appId: app.id,
                              });
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                              if (dragOverGroupId !== group.id) {
                                setDragOverGroupId(group.id);
                              }
                              if (dragOverAppKey !== tileKey) {
                                setDragOverAppKey(tileKey);
                              }
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                                if (dragOverAppKey === tileKey) setDragOverAppKey(null);
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDropOnApp(group.id, app.id);
                            }}
                            onDragEnd={clearDragState}
                            title={`拖动「${app.name}」可组内调序或跨组移动`}
                            className={cn(
                              "group/tile relative flex w-[66px] select-none flex-col items-center gap-1 rounded-lg border border-transparent p-1.5 transition-all hover:border-border hover:bg-muted/50 cursor-grab active:cursor-grabbing",
                              isDragging && "opacity-40 ring-2 ring-primary/50",
                              isDragOver && "border-primary bg-primary/10 ring-2 ring-primary/40"
                            )}
                          >
                            <button
                              type="button"
                              title="移出 Dock"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveAppToHidden(group.id, app.id);
                              }}
                              className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-xs transition-opacity hover:bg-destructive hover:text-destructive-foreground group-hover/tile:opacity-100 cursor-pointer"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                            <AppIcon
                              name={app.name}
                              nativeIcon={app.icon_data_url}
                              size="sm"
                            />
                            <span className="w-full truncate text-center text-[10.5px] leading-tight font-medium text-foreground/90">
                              {app.name}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Right Compact Group Actions */}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover/row:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground"
                      disabled={idx === 0}
                      title="上移分组"
                      onClick={() => moveGroup(idx, -1)}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground"
                      disabled={idx === visibleGroups.length - 1}
                      title="下移分组"
                      onClick={() => moveGroup(idx, 1)}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      title="删除分组（图标会移至下方未放入区）"
                      onClick={() => handleDeleteGroup(group.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Unassigned / Excluded from Dock Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (!dragOverHidden) setDragOverHidden(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOverHidden(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDropOnHidden();
            }}
            className={cn(
              "rounded-lg border border-dashed border-border bg-muted/20 p-2.5 transition-colors",
              dragOverHidden && "border-primary bg-primary/5 ring-2 ring-primary/25"
            )}
          >
            <div className="flex items-center justify-between pb-1.5">
              <span className="text-xs font-semibold text-muted-foreground">
                暂不放入 Dock（{hiddenApps.length}）
              </span>
              <span className="text-[10.5px] text-muted-foreground">
                将不想放进 Dock 的图标拖到这里，随时可拖回上方分组
              </span>
            </div>
            {hiddenApps.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {hiddenApps.map((app) => (
                  <div
                    key={app.id}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", `hidden:${app.id}`);
                      setDragGroupId(null);
                      setDragApp({ sourceGroupId: "hidden", appId: app.id });
                    }}
                    onDragEnd={clearDragState}
                    className="flex select-none items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-1 text-[11px] opacity-80 hover:opacity-100 cursor-grab active:cursor-grabbing"
                  >
                    <AppIcon
                      name={app.name}
                      nativeIcon={app.icon_data_url}
                      size="xs"
                    />
                    <span className="max-w-[100px] truncate">{app.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dock Backups & Restore */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm">历史备份与一键还原</CardTitle>
              </div>
              <CardDescription>
                每次应用前都会自动备份当前 Dock 配置（最多保留最近 5 条），随时可一键回滚
              </CardDescription>
            </CardHeader>
            <CardContent>
              {backups.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  暂无历史备份（首次点击「一键应用」时会自动生成）
                </p>
              ) : (
                <div className="space-y-2">
                  {backups.map((b) => (
                    <div
                      key={b.path}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs font-medium text-foreground">
                          {b.filename}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {b.created_at} · {(b.size_bytes / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={restoring === b.path}
                        onClick={() => handleRestore(b.path)}
                      >
                        {restoring === b.path ? (
                          <Spinner className="h-3 w-3" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        恢复此备份
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
