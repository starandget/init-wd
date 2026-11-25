import { ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  EnvStatus,
  LanServerStatus,
  NavTab,
  ProxyConfig,
  UpdateCheckResult,
} from "@/types";

interface StatusBarProps {
  activeTab: NavTab;
  env: EnvStatus | null;
  proxyConfig?: ProxyConfig | null;
  lanServerStatus?: LanServerStatus | null;
  updateInfo: UpdateCheckResult | null;
  activeTaskCount: number;
  installedCount: number;
  totalAppsCount: number;
  onSelectTab: (tab: NavTab) => void;
  onOpenActivity: () => void;
}

const TAB_LABELS: Record<NavTab, string> = {
  env: "本机环境",
  proxy: "局域网加速",
  lan_server: "局域网服务",
  starter: "新机启航",
  discover: "浏览软件",
  apps: "我的软件",
  dock: "Dock 整理",
  tweaks: "快捷设置",
  theme: "主题",
  settings: "设置",
  queue: "任务队列",
};

const MIRROR_LABELS: Record<string, string> = {
  tsinghua: "清华源",
  ustc: "中科大源",
  aliyun: "阿里云源",
  official: "官方源",
};

export function StatusBar({
  activeTab,
  env,
  proxyConfig,
  lanServerStatus,
  updateInfo,
  activeTaskCount,
  installedCount,
  onSelectTab,
  onOpenActivity,
}: StatusBarProps) {
  const mirrorLabel =
    MIRROR_LABELS[env?.mirror_preset || "tsinghua"] || "清华源";
  const archLabel =
    env?.arch === "aarch64"
      ? "Apple Silicon (arm64)"
      : env?.arch === "x86_64"
      ? "Intel (x86_64)"
      : env?.arch || "macOS";

  return (
    <footer className="relative flex h-7 shrink-0 items-center justify-between border-t border-sidebar-border bg-sidebar px-3 text-[11px] text-muted-foreground select-none">
      {/* Left: Breadcrumb */}
      <div className="flex items-center gap-1">
        <span className="font-medium text-foreground/80">Star Box</span>
        <ChevronRight className="h-3 w-3 opacity-50" />
        <span>{TAB_LABELS[activeTab]}</span>
      </div>

      {/* Center: Combined Environment & Status Telemetry */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2.5 whitespace-nowrap">
        <button
          type="button"
          onClick={() => onSelectTab("env")}
          className="flex items-center gap-1 hover:text-foreground cursor-pointer"
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              env?.brew_installed ? "bg-emerald-500" : "bg-amber-500"
            )}
          />
          <span>{env?.brew_installed ? "Brew 就绪" : "未装 Brew"}</span>
        </button>

        <span className="opacity-35">·</span>

        <button
          type="button"
          onClick={() => onSelectTab("env")}
          className="hover:text-foreground cursor-pointer"
        >
          {archLabel}
        </button>

        <span className="opacity-35">·</span>

        <span>macOS {env?.macos_version || "—"}</span>

        <span className="opacity-35">·</span>

        <button
          type="button"
          onClick={() => onSelectTab("apps")}
          className="tabular-nums hover:text-foreground cursor-pointer"
        >
          本机已装 {installedCount}
        </button>

        <span className="opacity-35">·</span>

        <button
          type="button"
          onClick={() => onSelectTab("env")}
          className="hover:text-foreground cursor-pointer"
        >
          {mirrorLabel}
        </button>

        {proxyConfig?.enabled && proxyConfig.url && (
          <>
            <span className="opacity-35">·</span>
            <button
              type="button"
              onClick={() => onSelectTab("proxy")}
              title={`当前下载加速通道：${proxyConfig.url}`}
              className="flex items-center gap-1 text-emerald-600 hover:underline dark:text-emerald-400 cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>加速 {proxyConfig.url.replace(/^https?:\/\/|^socks5:\/\//, "")}</span>
            </button>
          </>
        )}

        {lanServerStatus?.running && (
          <>
            <span className="opacity-35">·</span>
            <button
              type="button"
              onClick={() => onSelectTab("lan_server")}
              title={`局域网文件服务运行中：${lanServerStatus.primary_url || `:${lanServerStatus.port}`}`}
              className="flex items-center gap-1 text-emerald-600 hover:underline dark:text-emerald-400 cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>服务 :{lanServerStatus.port}</span>
            </button>
          </>
        )}
      </div>

      {/* Right: Running Tasks + Version */}
      <div className="flex items-center gap-3">
        {activeTaskCount > 0 && (
          <button
            type="button"
            onClick={onOpenActivity}
            className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
          >
            <Spinner className="h-2.5 w-2.5" />
            <span>运行中 {activeTaskCount}</span>
          </button>
        )}

        <span className="font-mono text-[10.5px] opacity-80">
          v{updateInfo?.current_version || "0.0.4"}
        </span>
      </div>
    </footer>
  );
}
