import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Camera,
  FileCode2,
  FolderOpen,
  HardDrive,
  Keyboard,
  Monitor,
  Mouse,
  PanelBottom,
  PanelBottomClose,
  Shield,
  SlidersHorizontal,
  Touchpad,
  Wifi,
} from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { MacTweakKey, MacTweaksStatus } from "@/types";

type TweaksTab = "input" | "finder" | "dock" | "panes";

interface TweakItemConfig {
  key: MacTweakKey;
  title: string;
  desc: string;
  icon: typeof Mouse;
  onLabel?: string;
  offLabel?: string;
}

const INPUT_TWEAKS: TweakItemConfig[] = [
  {
    key: "natural_scroll",
    title: "滚轮方向（自然滚动 / 传统滚轮）",
    desc: "开启为触控板自然滚动（内容随手指移动）；关闭为 Windows 传统外接鼠标滚轮方向，点击即刻全局生效",
    icon: Mouse,
    onLabel: "自然滚动",
    offLabel: "传统滚轮",
  },
  {
    key: "key_repeat",
    title: "键盘长按连续输入",
    desc: "开启后长按字母键会连续输入（适合写代码 / Vim / 游戏），关闭 macOS 默认的长按弹出重音选字框",
    icon: Keyboard,
    onLabel: "已开启",
    offLabel: "未开启",
  },
];

const FINDER_TWEAKS: TweakItemConfig[] = [
  {
    key: "show_hidden_files",
    title: "显示隐藏文件",
    desc: "在访达（Finder）中直接显示以 . 开头的隐藏文件与配置目录（如 .git、.zshrc）",
    icon: FolderOpen,
  },
  {
    key: "show_all_extensions",
    title: "显示所有文件扩展名",
    desc: "在访达中始终完整显示 .app、.png、.json 等文件后缀名，防止文件名伪装",
    icon: FileCode2,
  },
  {
    key: "finder_bars",
    title: "显示底部路径栏与状态栏",
    desc: "在访达窗口底部常驻显示完整目录层级路径与磁盘剩余可用空间",
    icon: PanelBottom,
  },
  {
    key: "no_ds_store",
    title: "禁止在 U 盘与局域网盘生成 .DS_Store",
    desc: "避免插拔移动硬盘或访问 SMB / NAS 共享目录时留下大量隐藏的 .DS_Store 文件",
    icon: HardDrive,
  },
];

const DOCK_SCREENSHOT_TWEAKS: TweakItemConfig[] = [
  {
    key: "dock_autohide_fast",
    title: "Dock 自动隐藏 + 零延迟弹出",
    desc: "开启程序坞自动隐藏，并移除 macOS 默认的鼠标停顿等待延迟，贴边即刻丝滑呼出",
    icon: PanelBottomClose,
  },
  {
    key: "screencapture_no_shadow",
    title: "窗口截图去除四周大黑影",
    desc: "使用 Cmd+Shift+4+空格 截取单个窗口时，自动去掉四周巨大的透明阴影边框",
    icon: Camera,
  },
];

const SYSTEM_PANES = [
  { id: "mouse", label: "鼠标设置", desc: "轨迹速度、滚轮速度与副键", icon: Mouse },
  { id: "trackpad", label: "触控板", desc: "轻点点按、三指手势与缩放", icon: Touchpad },
  { id: "keyboard", label: "键盘与快捷键", desc: "按键重复速率、修饰键与输入法", icon: Keyboard },
  { id: "displays", label: "显示器", desc: "分辨率缩放、刷新率与多屏排列", icon: Monitor },
  { id: "privacy", label: "隐私与安全性", desc: "辅助功能、完全磁盘访问与安全性授权", icon: Shield },
  { id: "login_items", label: "登录项与后台扩展", desc: "管理开机自启软件与后台常驻服务", icon: SlidersHorizontal },
  { id: "network", label: "网络与 Wi-Fi", desc: "DNS、硬件代理与防火墙配置", icon: Wifi },
];

export function QuickTweaksPage() {
  const [tab, setTab] = useState<TweaksTab>("input");
  const [status, setStatus] = useState<MacTweaksStatus | null>(null);
  const [busyKey, setBusyKey] = useState<MacTweakKey | null>(null);

  const loadTweaks = useCallback(async () => {
    try {
      const res = await api.getMacTweaks();
      setStatus(res);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadTweaks();
  }, [loadTweaks]);

  const handleToggle = async (item: TweakItemConfig) => {
    if (!status || busyKey) return;
    const nextVal = !status[item.key];
    setBusyKey(item.key);
    try {
      const updated = await api.setMacTweak(item.key, nextVal);
      setStatus(updated);
    } catch {
      // ignore
    } finally {
      setBusyKey(null);
    }
  };

  const renderTweakRow = (item: TweakItemConfig) => {
    const Icon = item.icon;
    const enabled = Boolean(status?.[item.key]);
    const isBusy = busyKey === item.key;

    return (
      <div
        key={item.key}
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5"
      >
        <div className="flex items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">{item.title}</div>
            <div className="text-xs text-muted-foreground">{item.desc}</div>
          </div>
        </div>
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          className="shrink-0"
          disabled={!status || isBusy}
          onClick={() => handleToggle(item)}
        >
          {isBusy && <Spinner className="h-3.5 w-3.5" />}
          {enabled ? item.onLabel || "已开启" : item.offLabel || "未开启"}
        </Button>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar with Centered Category Switcher (matches SettingsPage) */}
      <header className="relative flex h-13 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <h2 className="text-base font-semibold tracking-tight">快捷设置</h2>

        <div className="absolute left-1/2 -translate-x-1/2 inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5">
          {(
            [
              ["input", "鼠标与键盘"],
              ["finder", "访达与文件"],
              ["dock", "Dock 与截图"],
              ["panes", "系统直达"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors cursor-pointer",
                tab === id
                  ? "bg-primary text-primary-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-3xl space-y-4">
          {tab === "input" && (
            <Card>
              <CardHeader>
                <CardTitle>鼠标与键盘</CardTitle>
                <CardDescription>
                  解决外接鼠标滚轮方向相反、长按字母不连续输入等高频痛点，点击即刻全局生效
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {INPUT_TWEAKS.map(renderTweakRow)}
              </CardContent>
            </Card>
          )}

          {tab === "finder" && (
            <Card>
              <CardHeader>
                <CardTitle>访达（Finder）与文件系统</CardTitle>
                <CardDescription>
                  切换后会自动刷新访达窗口使其立即生效
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {FINDER_TWEAKS.map(renderTweakRow)}
              </CardContent>
            </Card>
          )}

          {tab === "dock" && (
            <Card>
              <CardHeader>
                <CardTitle>程序坞（Dock）与系统截图</CardTitle>
                <CardDescription>
                  让 Dock 贴边零延迟秒弹、窗口截图干净无四周黑影
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {DOCK_SCREENSHOT_TWEAKS.map(renderTweakRow)}
              </CardContent>
            </Card>
          )}

          {tab === "panes" && (
            <Card>
              <CardHeader>
                <CardTitle>系统设置面板一键直达</CardTitle>
                <CardDescription>
                  无需在 macOS「系统设置」里层层翻找，点击直接唤起对应设置面板
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {SYSTEM_PANES.map((pane) => {
                  const Icon = pane.icon;
                  return (
                    <div
                      key={pane.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5"
                    >
                      <div className="flex items-start gap-2.5">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">{pane.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {pane.desc}
                          </div>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => api.openSystemPane(pane.id)}
                      >
                        打开
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
