import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { api } from "./api";
import { RightToolRail, type RightPanelId } from "./components/RightToolRail";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Button } from "./components/ui/button";
import { isAppInList } from "./lib/appMatch";
import { DockPage } from "./pages/DockPage";
import { DiscoverPage, type DiscoverMode } from "./pages/DiscoverPage";
import { EnvPrepPage } from "./pages/EnvPrepPage";
import { MyAppsPage } from "./pages/MyAppsPage";
import { ProxyPage } from "./pages/ProxyPage";
import { QueuePage } from "./pages/QueuePage";
import { QuickTweaksPage } from "./pages/QuickTweaksPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StarterPackPage } from "./pages/StarterPackPage";
import type {
  AppItem,
  EnvLogEvent,
  EnvStatus,
  InstalledInfo,
  InstallProgressEvent,
  InstallTask,
  LocalAppCandidate,
  NavTab,
  ProxyConfig,
  StarBoxProfile,
  ThemeMode,
  ToastNotice,
  UpdateCheckResult,
} from "./types";

const THEME_STORAGE_KEY = "starbox-theme-mode-v1";

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>("discover");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "warm" || saved === "dark") {
        return saved;
      }
    } catch {
      // ignore
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [profile, setProfile] = useState<StarBoxProfile | null>(null);
  const [installedMap, setInstalledMap] = useState<Record<string, InstalledInfo>>({});
  const [localApps, setLocalApps] = useState<LocalAppCandidate[]>([]);
  const [localScanning, setLocalScanning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanVersion, setScanVersion] = useState(0);

  const [tasks, setTasks] = useState<InstallTask[]>([]);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
  const proxyConfigRef = useRef<ProxyConfig | null>(null);
  proxyConfigRef.current = proxyConfig;
  const [envLogs, setEnvLogs] = useState<string[]>([]);
  const [installingBrew, setInstallingBrew] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<DiscoverMode>("cn");
  const [rightPanel, setRightPanel] = useState<RightPanelId>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);

  const profileRef = useRef<StarBoxProfile | null>(null);
  profileRef.current = profile;
  const tasksRef = useRef<InstallTask[]>([]);
  tasksRef.current = tasks;
  const cancelledTaskIdsRef = useRef<Set<string>>(new Set());
  const pendingQueueRef = useRef<Array<{ task: InstallTask; mirror: string }>>([]);
  const activeWorkersRef = useRef(0);
  const activeAppKeysRef = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((notice: Omit<ToastNotice, "id">) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ ...notice, id: String(Date.now()) });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 4200);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("warm", theme === "warm");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const refreshEnv = useCallback(async () => {
    try {
      const [status, proxy] = await Promise.all([
        api.getEnvStatus(),
        api.getProxyConfig().catch(() => null),
      ]);
      setEnv(status);
      if (proxy) setProxyConfig(proxy);
    } catch (e) {
      console.error("getEnvStatus failed:", e);
    }
  }, []);

  const checkUpdate = useCallback(async () => {
    try {
      const res = await api.checkAppUpdate();
      setUpdateInfo(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  const refreshLocalApps = useCallback(async () => {
    setLocalScanning(true);
    try {
      const list = await api.discoverLocalApps();
      setLocalApps(list);
    } catch (e) {
      console.error("discoverLocalApps failed:", e);
    } finally {
      setLocalScanning(false);
    }
  }, []);

  const refreshScan = useCallback(async (appsList?: AppItem[]) => {
    refreshLocalApps();
    const target = appsList ?? profileRef.current?.apps ?? [];
    if (target.length === 0) return;
    setScanning(true);
    try {
      const res = await api.scanInstalledApps(target);
      const map: Record<string, InstalledInfo> = {};
      for (const info of res) map[info.id] = info;
      setInstalledMap(map);
      setScanVersion((v) => v + 1);
    } catch (e) {
      console.error("scanInstalledApps failed:", e);
    } finally {
      setScanning(false);
    }
  }, [refreshLocalApps]);

  // Initial load
  useEffect(() => {
    (async () => {
      await refreshEnv();
      checkUpdate();
      try {
        const p = await api.loadProfile();
        setProfile(p);
        await refreshScan(p.apps);
      } catch (e) {
        console.error("loadProfile failed:", e);
      }
    })();
  }, [refreshEnv, refreshScan, checkUpdate]);

  // Listen to backend Tauri events
  useEffect(() => {
    const unlistenProgress = listen<InstallProgressEvent>(
      "install-progress",
      (event) => {
        const p = event.payload;
        setTasks((prev) =>
          prev.map((t) => {
            if (t.task_id !== p.task_id) return t;
            if (cancelledTaskIdsRef.current.has(p.task_id) && !p.done) return t;
            const nextStatus = p.done
              ? p.success
                ? "success"
                : "error"
              : "running";
            const nextLogs =
              p.replace_last && t.logs.length > 0
                ? [...t.logs.slice(0, -1), p.message]
                : [...t.logs.slice(-800), p.message];
            return {
              ...t,
              status: nextStatus,
              stage: p.stage,
              progress:
                p.progress !== null
                  ? p.progress
                  : p.done && p.success
                  ? 100
                  : p.replace_last
                  ? t.progress
                  : Math.min(92, t.progress + 3),
              logs: nextLogs,
              error: p.done && !p.success ? p.message : t.error,
            };
          })
        );
      }
    );

    const unlistenEnv = listen<EnvLogEvent>("env-log", (event) => {
      const p = event.payload;
      setEnvLogs((prev) => [...prev.slice(-150), p.line]);
      if (p.done) {
        setInstallingBrew(false);
        refreshEnv();
      }
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenEnv.then((fn) => fn());
    };
  }, [refreshEnv]);

  const persistProfile = useCallback(async (next: StarBoxProfile) => {
    setProfile(next);
    try {
      const saved = await api.saveProfile(next);
      setProfile(saved);
    } catch (e) {
      console.error("saveProfile failed:", e);
    }
  }, []);

  const getInstallConcurrency = useCallback(() => {
    const raw = profileRef.current?.install_concurrency ?? 5;
    return Math.min(5, Math.max(1, Math.round(raw)));
  }, []);

  const drainTaskQueue = useCallback(() => {
    const maxConcurrency = getInstallConcurrency();
    while (
      activeWorkersRef.current < maxConcurrency &&
      pendingQueueRef.current.length > 0
    ) {
      const next = pendingQueueRef.current.shift();
      if (!next) break;
      const { task: t, mirror } = next;
      const appKey = `${t.action}:${t.app.id}`;

      if (cancelledTaskIdsRef.current.has(t.task_id)) {
        cancelledTaskIdsRef.current.delete(t.task_id);
        activeAppKeysRef.current.delete(appKey);
        continue;
      }

      activeWorkersRef.current += 1;
      const activeProxyUrl =
        proxyConfigRef.current?.enabled && proxyConfigRef.current.url
          ? proxyConfigRef.current.url
          : null;
      setTasks((prev) =>
        prev.map((x) =>
          x.task_id === t.task_id
            ? { ...x, status: "running", progress: 8, proxy_url: activeProxyUrl }
            : x
        )
      );

      void (async () => {
        let succeeded = false;
        try {
          if (t.action === "install") {
            await api.installApp(t.task_id, t.app, mirror);
          } else if (t.action === "upgrade") {
            await api.upgradeApp(t.task_id, t.app, mirror);
          } else {
            await api.uninstallApp(t.task_id, t.app);
          }
          succeeded = true;
          setTasks((prev) =>
            prev.map((x) =>
              x.task_id === t.task_id
                ? { ...x, status: "success", progress: 100 }
                : x
            )
          );
        } catch (e) {
          const isCancelled = cancelledTaskIdsRef.current.has(t.task_id);
          cancelledTaskIdsRef.current.delete(t.task_id);
          const errText = isCancelled ? "已手动终止" : String(e);
          setTasks((prev) =>
            prev.map((x) => {
              if (x.task_id !== t.task_id) return x;
              const lastLog = x.logs[x.logs.length - 1];
              return {
                ...x,
                status: "error",
                stage: isCancelled ? "cancelled" : x.stage,
                error: errText,
                logs: lastLog === errText ? x.logs : [...x.logs.slice(-800), errText],
              };
            })
          );
          if (!isCancelled) {
            const actionText =
              t.action === "upgrade"
                ? "更新"
                : t.action === "uninstall"
                ? "卸载"
                : "安装";
            const fallbackUrl =
              t.action === "uninstall"
                ? null
                : t.app.website?.trim() ||
                  (t.app.github_repo?.trim()
                    ? `https://github.com/${t.app.github_repo.trim().replace(/^\/+|\/+$/g, "")}/releases`
                    : null);
            showToast({
              title: `${t.app.name} ${actionText}失败`,
              description: fallbackUrl
                ? `可前往官网手动下载：${fallbackUrl}`
                : "请展开任务队列查看完整命令行日志",
              actionLabel: fallbackUrl ? "打开官网" : "查看日志",
              onAction: () => {
                if (fallbackUrl) {
                  void api.openExternal(fallbackUrl);
                } else {
                  setActiveTab("queue");
                }
              },
            });
          }
        } finally {
          activeWorkersRef.current = Math.max(0, activeWorkersRef.current - 1);
          activeAppKeysRef.current.delete(appKey);
          if (succeeded) {
            const actionText =
              t.action === "upgrade"
                ? "更新"
                : t.action === "uninstall"
                ? "卸载"
                : "安装";
            showToast({
              title: `${t.app.name} ${actionText}完成`,
            });
          }
          void refreshScan();
          drainTaskQueue();
        }
      })();
    }
  }, [getInstallConcurrency, refreshScan, showToast]);

  const enqueueAndRun = useCallback(
    async (items: AppItem[], action: "install" | "upgrade" | "uninstall") => {
      if (items.length === 0) return;
      const mirror =
        profileRef.current?.mirror_preset || env?.mirror_preset || "tsinghua";
      const concurrency = getInstallConcurrency();

      const actionText =
        action === "upgrade" ? "更新" : action === "uninstall" ? "卸载" : "安装";

      // Deduplicate against currently queued/running tasks for the same app
      const freshItems: AppItem[] = [];
      for (const app of items) {
        const key = `${action}:${app.id}`;
        if (!activeAppKeysRef.current.has(key)) {
          activeAppKeysRef.current.add(key);
          freshItems.push(app);
        }
      }
      if (freshItems.length === 0) {
        showToast({ title: "所选软件已在任务队列中" });
        return;
      }

      const newTasks: InstallTask[] = freshItems.map((app) => ({
        task_id: `${action}-${app.id}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`,
        app,
        action,
        status: "queued",
        progress: 2,
        stage: "queued",
        logs: [`已加入队列：${app.name}`],
      }));

      setTasks((prev) => [...newTasks, ...prev]);
      for (const task of newTasks) {
        pendingQueueRef.current.push({ task, mirror });
      }

      // Non-intrusive toast instead of yanking user away from current page
      showToast({
        title:
          freshItems.length === 1
            ? `开始后台${actionText} ${freshItems[0].name}`
            : `已将 ${freshItems.length} 个软件加入后台${actionText}队列`,
        description:
          concurrency > 1
            ? `最多同时并发 ${concurrency} 个任务，完成后自动更新状态`
            : "任务将按顺序依次执行，完成后自动更新状态",
        actionLabel: "查看队列",
        onAction: () => setActiveTab("queue"),
      });

      drainTaskQueue();
    },
    [drainTaskQueue, env?.mirror_preset, getInstallConcurrency, showToast]
  );

  const handleAddAppsBatch = useCallback(
    async (items: AppItem[]) => {
      const current = profileRef.current;
      if (!current || items.length === 0) return;

      const toAdd = items.filter((item) => !isAppInList(current.apps, item));
      if (toAdd.length === 0) {
        showToast({ title: "软件已在「我的清单」中" });
        return;
      }

      const nextGroups = [...current.groups];
      for (const item of toAdd) {
        if (!nextGroups.includes(item.group)) nextGroups.push(item.group);
      }

      const next: StarBoxProfile = {
        ...current,
        groups: nextGroups,
        apps: [...current.apps, ...toAdd],
      };
      await persistProfile(next);
      await refreshScan(next.apps);
      showToast({
        title:
          toAdd.length === 1
            ? `已将 ${toAdd[0].name} 加入清单`
            : `已导入 ${toAdd.length} 款软件到清单`,
      });
    },
    [persistProfile, refreshScan, showToast]
  );

  const handleAddToList = useCallback(
    async (item: AppItem) => {
      await handleAddAppsBatch([item]);
    },
    [handleAddAppsBatch]
  );

  const handleCancelTask = useCallback(
    async (taskId: string) => {
      cancelledTaskIdsRef.current.add(taskId);
      const target = tasksRef.current.find((t) => t.task_id === taskId);
      if (target) {
        activeAppKeysRef.current.delete(`${target.action}:${target.app.id}`);
      }
      pendingQueueRef.current = pendingQueueRef.current.filter(
        (entry) => entry.task.task_id !== taskId
      );
      setTasks((prev) =>
        prev.map((x) =>
          x.task_id === taskId && (x.status === "queued" || x.status === "running")
            ? {
                ...x,
                status: "error",
                stage: "cancelled",
                error: "已手动终止",
                logs: [...x.logs, "正在终止任务..."],
              }
            : x
        )
      );
      try {
        await api.cancelInstallTask(taskId);
      } catch (e) {
        console.error("cancelInstallTask failed:", e);
      }
      showToast({ title: "已终止任务" });
    },
    [showToast]
  );

  const handleCancelAllTasks = useCallback(async () => {
    const active = tasksRef.current.filter(
      (t) => t.status === "queued" || t.status === "running"
    );
    if (active.length === 0) return;
    for (const t of active) {
      cancelledTaskIdsRef.current.add(t.task_id);
    }
    pendingQueueRef.current = [];
    activeAppKeysRef.current.clear();
    setTasks((prev) =>
      prev.map((x) =>
        x.status === "queued" || x.status === "running"
          ? {
              ...x,
              status: "error",
              stage: "cancelled",
              error: "已手动终止",
              logs: [...x.logs, "已手动终止"],
            }
          : x
      )
    );
    await Promise.allSettled(active.map((t) => api.cancelInstallTask(t.task_id)));
    showToast({ title: `已终止全部 ${active.length} 个进行中任务` });
  }, [showToast]);

  const handleChangeInstallConcurrency = useCallback(
    async (value: number) => {
      const clamped = Math.min(5, Math.max(1, Math.round(value)));
      const current = profileRef.current;
      if (!current) return;
      const next: StarBoxProfile = {
        ...current,
        install_concurrency: clamped,
      };
      profileRef.current = next;
      await persistProfile(next);
      drainTaskQueue();
    },
    [drainTaskQueue, persistProfile]
  );

  const handleInstallHomebrew = async (mirror: string) => {
    setInstallingBrew(true);
    setEnvLogs([]);
    try {
      await api.installHomebrew(mirror);
    } catch (e) {
      setEnvLogs((prev) => [...prev, String(e)]);
      setInstallingBrew(false);
    }
  };

  const handleCancelHomebrew = async () => {
    try {
      await api.cancelHomebrewInstall();
    } catch (e) {
      console.error("cancelHomebrewInstall failed:", e);
    } finally {
      setInstallingBrew(false);
      showToast({ title: "已终止 Homebrew 安装" });
    }
  };

  const handleChangeMirror = async (mirror: string) => {
    await api.setBrewMirror(mirror);
    if (profile) {
      await persistProfile({ ...profile, mirror_preset: mirror });
    }
    await refreshEnv();
  };

  const activeTaskCount = useMemo(
    () =>
      tasks.filter((t) => t.status === "queued" || t.status === "running").length,
    [tasks]
  );

  const manageableLocalApps = useMemo(
    () => localApps.filter((a) => a.app_name !== "Star Box.app"),
    [localApps]
  );
  const installedCount = manageableLocalApps.length;
  const installableCount = manageableLocalApps.length;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          env={env}
          proxyConfig={proxyConfig}
          updateInfo={updateInfo}
          activeTaskCount={activeTaskCount}
          installedCount={installedCount}
          totalAppsCount={installableCount}
          theme={theme}
          onChangeTheme={setTheme}
        />

        <main className="min-w-0 flex-1 overflow-hidden bg-background">
          {activeTab === "env" && (
            <EnvPrepPage
              env={env}
              profile={profile}
              envLogs={envLogs}
              installingBrew={installingBrew}
              onRefreshEnv={refreshEnv}
              onInstallHomebrew={handleInstallHomebrew}
              onCancelHomebrew={handleCancelHomebrew}
              onChangeMirror={handleChangeMirror}
            />
          )}

          {activeTab === "proxy" && (
            <ProxyPage
              proxyConfig={proxyConfig}
              onProxyChange={setProxyConfig}
            />
          )}

          {activeTab === "starter" && (
            <StarterPackPage
              env={env}
              tasks={tasks}
              scanVersion={scanVersion}
              onInstallApps={(items) => enqueueAndRun(items, "install")}
              onAddAppsBatch={handleAddAppsBatch}
              onGoEnv={() => setActiveTab("env")}
            />
          )}

          {activeTab === "discover" && (
          <DiscoverPage
            mode={discoverMode}
            onChangeMode={setDiscoverMode}
            groups={profile?.groups || []}
            existingApps={profile?.apps || []}
            scanVersion={scanVersion}
            onAddToList={handleAddToList}
            onAddAppsBatch={handleAddAppsBatch}
            onInstallApps={(items) => enqueueAndRun(items, "install")}
            onDirectInstall={(item) => {
              handleAddToList(item);
              enqueueAndRun([item], "install");
            }}
          />
        )}

        {activeTab === "apps" && (
          <MyAppsPage
            localApps={manageableLocalApps}
            localScanning={localScanning}
            groups={profile?.groups || []}
            apps={profile?.apps || []}
            scanning={scanning}
            env={env}
            tasks={tasks}
            onRefreshScan={() => refreshScan()}
            onUpgradeApps={(items) => enqueueAndRun(items, "upgrade")}
            onUninstallApp={(item) => enqueueAndRun([item], "uninstall")}
            onGoSettings={() => setActiveTab("settings")}
          />
        )}

        {activeTab === "queue" && (
          <QueuePage
            tasks={tasks}
            env={env}
            proxyConfig={proxyConfig}
            installConcurrency={Math.min(5, Math.max(1, profile?.install_concurrency ?? 5))}
            onRetry={(item, action) => enqueueAndRun([item], action)}
            onCancelTask={handleCancelTask}
            onCancelAll={handleCancelAllTasks}
            onClearFinished={() =>
              setTasks((prev) =>
                prev.filter((t) => t.status === "queued" || t.status === "running")
              )
            }
            onGoSettings={() => setActiveTab("settings")}
            onGoProxy={() => setActiveTab("proxy")}
          />
        )}

        {activeTab === "dock" && (
          <DockPage
            localApps={localApps}
            groups={profile?.groups || []}
            apps={profile?.apps || []}
            dockSystemApps={profile?.dock_system_apps || []}
            installedMap={installedMap}
          />
        )}

        {activeTab === "tweaks" && <QuickTweaksPage />}

          {activeTab === "settings" && (
          <SettingsPage
            env={env}
            profile={profile}
            updateInfo={updateInfo}
            theme={theme}
            onChangeTheme={setTheme}
            installConcurrency={Math.min(5, Math.max(1, profile?.install_concurrency ?? 5))}
            onChangeInstallConcurrency={handleChangeInstallConcurrency}
            envLogs={envLogs}
            installingBrew={installingBrew}
            onRefreshEnv={refreshEnv}
            onCheckUpdate={checkUpdate}
            onInstallHomebrew={handleInstallHomebrew}
            onCancelHomebrew={handleCancelHomebrew}
            onChangeMirror={handleChangeMirror}
            onProfileUpdated={(next) => {
              setProfile(next);
              refreshScan(next.apps);
            }}
          />
        )}
        </main>

        <RightToolRail
          activePanel={rightPanel}
          onChangePanel={setRightPanel}
          tasks={tasks}
          activeTaskCount={activeTaskCount}
          onCancelTask={handleCancelTask}
          onCancelAllTasks={handleCancelAllTasks}
          onGoQueue={() => {
            setRightPanel(null);
            setActiveTab("queue");
          }}
        />
      </div>

      <StatusBar
        activeTab={activeTab}
        env={env}
        proxyConfig={proxyConfig}
        updateInfo={updateInfo}
        activeTaskCount={activeTaskCount}
        installedCount={installedCount}
        totalAppsCount={installableCount}
        onSelectTab={setActiveTab}
        onOpenActivity={() => setRightPanel("activity")}
      />

      {/* Non-intrusive bottom-right Toast */}
      {toast && (
        <div className="fixed right-12 bottom-9 z-50 flex max-w-sm items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-foreground">
              {toast.title}
            </div>
            {toast.description && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {toast.description}
              </div>
            )}
          </div>
          {toast.actionLabel && toast.onAction && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 shrink-0 text-xs"
              onClick={() => {
                toast.onAction?.();
                setToast(null);
              }}
            >
              {toast.actionLabel}
            </Button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
