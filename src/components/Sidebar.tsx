import {
  ArrowUpRight,
  BookOpen,
  Compass,
  Cpu,
  Download,
  LayoutGrid,
  Moon,
  Package,
  Rocket,
  Server,
  Settings,
  SlidersHorizontal,
  Sun,
  Wifi,
} from "lucide-react";
import { api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type {
  EnvStatus,
  LanServerStatus,
  NavTab,
  ProxyConfig,
  SelfUpdateProgressEvent,
  ThemeMode,
  UpdateCheckResult,
} from "@/types";

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  env: EnvStatus | null;
  proxyConfig?: ProxyConfig | null;
  lanServerStatus?: LanServerStatus | null;
  updateInfo: UpdateCheckResult | null;
  selfUpdateState?: SelfUpdateProgressEvent | null;
  selfUpdating?: boolean;
  onSelfUpdate?: () => void;
  activeTaskCount: number;
  installedCount: number;
  totalAppsCount: number;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
}

interface NavGroupConfig {
  id: string;
  label: string;
  items: { id: NavTab; label: string; icon: typeof Package }[];
}

const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: "env",
    label: "装机准备",
    items: [{ id: "env", label: "本机环境", icon: Cpu }],
  },
  {
    id: "lan",
    label: "局域网",
    items: [
      { id: "proxy", label: "下载加速", icon: Wifi },
      { id: "lan_server", label: "文件共享", icon: Server },
    ],
  },
  {
    id: "apps",
    label: "软件中心",
    items: [
      { id: "starter", label: "新机启航", icon: Rocket },
      { id: "discover", label: "发现应用", icon: Compass },
      { id: "apps", label: "已装应用", icon: Package },
      { id: "queue", label: "任务队列", icon: Download },
    ],
  },
  {
    id: "tools",
    label: "桌面",
    items: [{ id: "dock", label: "Dock 整理", icon: LayoutGrid }],
  },
  {
    id: "system",
    label: "系统",
    items: [
      { id: "tweaks", label: "快捷调优", icon: SlidersHorizontal },
      { id: "settings", label: "偏好设置", icon: Settings },
    ],
  },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  proxyConfig,
  lanServerStatus,
  updateInfo,
  selfUpdateState,
  selfUpdating = false,
  onSelfUpdate,
  activeTaskCount,
  installedCount,
  theme,
  onChangeTheme,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <img
          src="/app-icon.png"
          alt="Star Box"
          draggable={false}
          className="h-9 w-9 shrink-0 rounded-xl object-contain"
        />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">
            Star Box
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            macOS 软件中心
          </p>
        </div>
      </div>

      {/* Non-collapsible Inset Card Groups */}
      <nav className="flex-1 space-y-1 overflow-y-auto py-1">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active}
                        onClick={() => onSelectTab(item.id)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">{item.label}</span>
                        {item.id === "proxy" &&
                          proxyConfig?.enabled &&
                          proxyConfig.url && (
                            <span
                              title={`已启用局域网加速 ${proxyConfig.url}`}
                              className="h-2 w-2 rounded-full bg-emerald-500"
                            />
                          )}
                        {item.id === "lan_server" &&
                          lanServerStatus?.running && (
                            <span
                              title={`局域网服务运行中 :${lanServerStatus.port}`}
                              className="h-2 w-2 rounded-full bg-emerald-500"
                            />
                          )}
                        {item.id === "apps" && installedCount > 0 && (
                          <SidebarMenuBadge>{installedCount}</SidebarMenuBadge>
                        )}
                        {item.id === "queue" && activeTaskCount > 0 && (
                          <Badge variant="info">{activeTaskCount}</Badge>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </nav>

      <div className="px-3">
        <Separator />
      </div>

      {/* Bottom Environment Status */}
      <div className="space-y-2.5 p-3.5">
        {updateInfo?.has_update && (
          selfUpdating ? (
            <div className="space-y-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
              <div className="flex items-center justify-between font-medium">
                <span>正在更新 v{updateInfo.latest_version}</span>
                <span className="tabular-nums">{selfUpdateState?.progress ?? 0}%</span>
              </div>
              <Progress value={selfUpdateState?.progress ?? 0} className="h-1" />
              <div className="truncate text-[10.5px] opacity-85">
                {selfUpdateState?.message || "正在准备更新..."}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() =>
                updateInfo.download_url && onSelfUpdate
                  ? onSelfUpdate()
                  : api.openExternal(updateInfo.release_url)
              }
              className="flex w-full items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-500/15 dark:text-blue-300 cursor-pointer"
            >
              <span>
                {updateInfo.download_url
                  ? `一键更新 v${updateInfo.latest_version}`
                  : `发现新版 v${updateInfo.latest_version}`}
              </span>
              {updateInfo.download_url ? (
                <Download className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5" />
              )}
            </button>
          )
        )}

        <div className="space-y-1.5">
          <span className="px-0.5 text-[11px] font-medium text-muted-foreground">
            外观主题
          </span>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-0.5">
            {(
              [
                ["light", "浅色", Sun],
                ["dark", "深色", Moon],
                ["warm", "暖白", BookOpen],
              ] as const
            ).map(([mode, label, Icon]) => {
              const active = theme === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChangeTheme(mode)}
                  className={cn(
                    "flex items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition-colors cursor-pointer",
                    active
                      ? "bg-card text-foreground shadow-2xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
