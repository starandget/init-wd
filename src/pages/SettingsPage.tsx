import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  CloudDownload,
  CloudUpload,
  ExternalLink,
  FileDown,
  FileUp,
  Moon,
  Power,
  RefreshCw,
  RotateCcw,
  Sun,
} from "lucide-react";
import { api } from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import type {
  EnvStatus,
  StarBoxProfile,
  ThemeMode,
  UpdateCheckResult,
} from "@/types";

interface SettingsPageProps {
  env: EnvStatus | null;
  profile: StarBoxProfile | null;
  updateInfo: UpdateCheckResult | null;
  theme?: ThemeMode;
  onChangeTheme?: (theme: ThemeMode) => void;
  envLogs?: string[];
  installingBrew?: boolean;
  onRefreshEnv?: () => void;
  onCheckUpdate: () => Promise<UpdateCheckResult | null>;
  onInstallHomebrew?: (mirror: string) => void;
  onCancelHomebrew?: () => void;
  onChangeMirror?: (mirror: string) => Promise<void>;
  onProfileUpdated: (next: StarBoxProfile) => void;
}

type SettingsTab = "general" | "theme" | "sync";

const THEMES: {
  id: ThemeMode;
  name: string;
  subtitle: string;
  desc: string;
  icon: typeof Sun;
  preview: {
    bg: string;
    sidebar: string;
    card: string;
    border: string;
    primary: string;
    text: string;
    muted: string;
  };
}[] = [
  {
    id: "light",
    name: "浅色",
    subtitle: "清爽苹果风",
    desc: "高对比度纯白卡片配柔和浅灰底色，适合白天明亮办公环境。",
    icon: Sun,
    preview: {
      bg: "#f6f7f9",
      sidebar: "#ffffff",
      card: "#ffffff",
      border: "#e5e7eb",
      primary: "#2563eb",
      text: "#18181b",
      muted: "#d4d4d8",
    },
  },
  {
    id: "warm",
    name: "暖白",
    subtitle: "护眼纸张风",
    desc: "低蓝光羊皮纸底色配陶土橘主色调，长时间阅读与整理软件更护眼。",
    icon: BookOpen,
    preview: {
      bg: "#faf9f5",
      sidebar: "#f5f4ed",
      card: "#fffefa",
      border: "#e5e2d7",
      primary: "#d97757",
      text: "#141413",
      muted: "#ddd9cc",
    },
  },
  {
    id: "dark",
    name: "深色",
    subtitle: "夜间专注模式",
    desc: "深邃炭黑界面搭配柔和亮蓝点缀，夜间使用不刺眼。",
    icon: Moon,
    preview: {
      bg: "#121215",
      sidebar: "#16161a",
      card: "#1a1a1f",
      border: "#2b2b33",
      primary: "#3b82f6",
      text: "#f4f4f5",
      muted: "#32323d",
    },
  },
];

export function SettingsPage({
  env,
  profile,
  updateInfo,
  theme = "light",
  onChangeTheme,
  onCheckUpdate,
  onProfileUpdated,
}: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [notice, setNotice] = useState<{
    type: "success" | "destructive";
    text: string;
  } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    api.getAutostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const handleToggleAutostart = async () => {
    setAutostartBusy(true);
    try {
      const next = await api.setAutostartEnabled(!autostart);
      setAutostart(next);
    } catch {
      // ignore
    } finally {
      setAutostartBusy(false);
    }
  };

  const handleManualCheckUpdate = async () => {
    setCheckingUpdate(true);
    setNotice(null);
    try {
      const res = await onCheckUpdate();
      if (res) {
        setNotice({
          type: "success",
          text: res.has_update
            ? `发现新版本 v${res.latest_version}（当前 v${res.current_version}）`
            : `当前已是最新版本 v${res.current_version}`,
        });
      }
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleExport = async () => {
    if (!profile) return;
    try {
      const path = await api.exportProfileDialog(profile);
      if (path) {
        setNotice({ type: "success", text: `配置已导出到: ${path}` });
      }
    } catch (e) {
      setNotice({ type: "destructive", text: `导出失败: ${String(e)}` });
    }
  };

  const handleImport = async () => {
    try {
      const next = await api.importProfileDialog();
      if (next) {
        onProfileUpdated(next);
        setNotice({
          type: "success",
          text: `已成功导入配置（共 ${next.apps.length} 项软件）`,
        });
      }
    } catch (e) {
      setNotice({ type: "destructive", text: `导入失败: ${String(e)}` });
    }
  };

  const handleIcloudSync = async (direction: "push" | "pull") => {
    setSyncBusy(true);
    setNotice(null);
    try {
      const next = await api.syncProfileIcloud(
        direction,
        direction === "push" && profile ? profile : undefined
      );
      onProfileUpdated(next);
      setNotice({
        type: "success",
        text:
          direction === "push"
            ? "已将当前软件清单上传至 iCloud Drive！"
            : `已从 iCloud Drive 恢复软件清单（共 ${next.apps.length} 项）！`,
      });
    } catch (e) {
      setNotice({ type: "destructive", text: String(e) });
    } finally {
      setSyncBusy(false);
    }
  };

  const handleReset = async () => {
    setSyncBusy(true);
    setNotice(null);
    try {
      const def = await api.resetDefaultProfile();
      onProfileUpdated(def);
      setNotice({ type: "success", text: "已重置为默认软件清单" });
    } catch (e) {
      setNotice({ type: "destructive", text: String(e) });
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar with Centered Category Switcher */}
      <header className="relative flex h-13 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <h2 className="text-base font-semibold tracking-tight">设置</h2>

        <div className="absolute left-1/2 -translate-x-1/2 inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5">
          {(
            [
              ["general", "常规"],
              ["theme", "主题"],
              ["sync", "数据与同步"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setTab(id);
                setNotice(null);
              }}
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
          {notice && (
            <Alert variant={notice.type}>
              {notice.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <AlertDescription className="mt-0">{notice.text}</AlertDescription>
            </Alert>
          )}

          {/* 1. 常规 */}
          {tab === "general" && (
            <Card>
              <CardHeader>
                <CardTitle>应用偏好与版本更新</CardTitle>
                <CardDescription>
                  管理开机自启动常驻菜单栏，以及检查 Star Box 最新版本
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                  <div className="flex items-start gap-2.5">
                    <Power className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium">登录 Mac 时自动启动</div>
                      <div className="text-xs text-muted-foreground">
                        开启后重启电脑会自动在右上角菜单栏就位，随时查看世界时间与软件状态
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={autostart ? "default" : "outline"}
                    disabled={autostartBusy}
                    onClick={handleToggleAutostart}
                  >
                    {autostart ? "已开启" : "未开启"}
                  </Button>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>Star Box 当前版本</span>
                      <Badge variant="secondary" className="font-mono">
                        v{updateInfo?.current_version || "0.0.1"}
                      </Badge>
                      {updateInfo?.has_update && (
                        <Badge variant="info">
                          有新版 v{updateInfo.latest_version}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      点击检查 GitHub Releases 最新正式版安装包
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {updateInfo?.has_update && (
                      <Button
                        size="sm"
                        onClick={() => api.openExternal(updateInfo.release_url)}
                      >
                        去下载
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={checkingUpdate}
                      onClick={handleManualCheckUpdate}
                    >
                      {checkingUpdate ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      检查更新
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 2. 主题 */}
          {tab === "theme" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">界面配色方案</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  切换后实时生效并自动保存，同时同步到顶部菜单栏时钟浮窗。
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {THEMES.map((item) => {
                  const Icon = item.icon;
                  const active = theme === item.id;
                  const p = item.preview;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onChangeTheme?.(item.id)}
                      className={cn(
                        "group flex flex-col overflow-hidden rounded-xl border text-left transition-all cursor-pointer",
                        active
                          ? "border-primary ring-2 ring-primary/20 bg-card shadow-sm"
                          : "border-border bg-card hover:border-primary/45"
                      )}
                    >
                      <div
                        className="h-32 w-full p-3"
                        style={{ backgroundColor: p.bg }}
                      >
                        <div
                          className="flex h-full w-full overflow-hidden rounded-lg border"
                          style={{ borderColor: p.border }}
                        >
                          <div
                            className="flex w-12 flex-col gap-1.5 border-r p-2"
                            style={{
                              backgroundColor: p.sidebar,
                              borderColor: p.border,
                            }}
                          >
                            <div className="flex gap-1">
                              <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            </div>
                            <div
                              className="mt-1.5 h-2 w-full rounded-sm"
                              style={{ backgroundColor: p.primary }}
                            />
                            <div
                              className="h-1.5 w-7 rounded-sm"
                              style={{ backgroundColor: p.muted }}
                            />
                          </div>
                          <div className="flex flex-1 flex-col gap-2 p-2">
                            <div className="flex items-center justify-between">
                              <div
                                className="h-2 w-12 rounded-sm"
                                style={{ backgroundColor: p.text, opacity: 0.75 }}
                              />
                              <div
                                className="h-3 w-8 rounded-full"
                                style={{ backgroundColor: p.primary }}
                              />
                            </div>
                            <div className="grid flex-1 grid-cols-2 gap-1.5">
                              <div
                                className="rounded-md border p-1.5"
                                style={{
                                  backgroundColor: p.card,
                                  borderColor: p.border,
                                }}
                              >
                                <div
                                  className="h-2 w-8 rounded-sm"
                                  style={{ backgroundColor: p.muted }}
                                />
                              </div>
                              <div
                                className="rounded-md border p-1.5"
                                style={{
                                  backgroundColor: p.card,
                                  borderColor: p.border,
                                }}
                              >
                                <div
                                  className="h-2 w-8 rounded-sm"
                                  style={{ backgroundColor: p.muted }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5 text-primary" />
                            <span className="text-sm font-semibold text-foreground">
                              {item.name}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              · {item.subtitle}
                            </span>
                          </div>
                          {active && (
                            <Badge variant="info" className="gap-0.5 text-[10px]">
                              <Check className="h-2.5 w-2.5" />
                              使用中
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {item.desc}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. 数据与同步 */}
          {tab === "sync" && (
            <Card>
              <CardHeader>
                <CardTitle>配置导入导出与 iCloud 同步</CardTitle>
                <CardDescription>
                  换新 Mac 时一键恢复全部软件清单、分组与 Dock 布局
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleExport}>
                    <FileDown className="h-3.5 w-3.5" />
                    导出 JSON 配置
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleImport}>
                    <FileUp className="h-3.5 w-3.5" />
                    导入 JSON 配置
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={syncBusy}
                    onClick={handleReset}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    恢复默认清单
                  </Button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>iCloud Drive 云端同步</span>
                      <Badge
                        variant={env?.icloud_available ? "success" : "secondary"}
                      >
                        {env?.icloud_available
                          ? "已检测到 iCloud"
                          : "未开启 iCloud Drive"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      无需登录额外账号，直接通过 macOS 原生 iCloud Drive 在多台 Mac 间同步清单
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!env?.icloud_available || syncBusy}
                      onClick={() => handleIcloudSync("pull")}
                    >
                      <CloudDownload className="h-3.5 w-3.5" />
                      从 iCloud 拉取
                    </Button>
                    <Button
                      size="sm"
                      disabled={!env?.icloud_available || syncBusy}
                      onClick={() => handleIcloudSync("push")}
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      上传到 iCloud
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
