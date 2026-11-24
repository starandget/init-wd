import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Plus,
  RefreshCw,
  Square,
  X,
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
import type { EnvStatus, InitFoldersResult, StarBoxProfile } from "@/types";

interface EnvPrepPageProps {
  env: EnvStatus | null;
  profile: StarBoxProfile | null;
  envLogs: string[];
  installingBrew: boolean;
  onRefreshEnv: () => void;
  onInstallHomebrew: (mirror: string) => void;
  onCancelHomebrew: () => void;
  onChangeMirror: (mirror: string) => Promise<void>;
}

const MIRRORS = [
  { id: "tsinghua", name: "清华大学镜像源", desc: "国内推荐，稳定快速" },
  { id: "ustc", name: "中科大镜像源", desc: "教育网与电信联通友好" },
  { id: "aliyun", name: "阿里云镜像源", desc: "CDN 覆盖广" },
  { id: "official", name: "Homebrew 官方源", desc: "国际网络或加速环境推荐" },
];

export function EnvPrepPage({
  env,
  profile,
  envLogs,
  installingBrew,
  onRefreshEnv,
  onInstallHomebrew,
  onCancelHomebrew,
  onChangeMirror,
}: EnvPrepPageProps) {
  const [mirrorSaving, setMirrorSaving] = useState(false);
  const [notice, setNotice] = useState<{
    type: "success" | "destructive";
    text: string;
  } | null>(null);

  const [folders, setFolders] = useState<string[]>(["_Chatgpt", "_Google"]);
  const [newFolder, setNewFolder] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderRes, setFolderRes] = useState<InitFoldersResult | null>(null);
  const [folderErr, setFolderErr] = useState<string | null>(null);

  const currentMirror =
    profile?.mirror_preset || env?.mirror_preset || "tsinghua";

  const handleSelectMirror = async (id: string) => {
    setMirrorSaving(true);
    setNotice(null);
    try {
      await onChangeMirror(id);
      setNotice({
        type: "success",
        text: `已切换镜像源为「${MIRRORS.find((m) => m.id === id)?.name}」`,
      });
    } catch (e) {
      setNotice({ type: "destructive", text: `切换镜像源失败: ${String(e)}` });
    } finally {
      setMirrorSaving(false);
    }
  };

  const handleInitFolders = async () => {
    setFolderBusy(true);
    setFolderErr(null);
    setFolderRes(null);
    try {
      const res = await api.initWorkspaceFolders(folders);
      setFolderRes(res);
    } catch (e) {
      setFolderErr(String(e));
    } finally {
      setFolderBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <h2 className="text-base font-semibold tracking-tight">本机环境</h2>
        <Button size="sm" variant="outline" onClick={onRefreshEnv}>
          <RefreshCw className="h-3.5 w-3.5" />
          重新检测环境
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <div className="mx-auto max-w-4xl space-y-4">
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

          {/* 1. 本机环境状态 + 一键安装 Homebrew */}
          <Card>
            <CardHeader>
              <CardTitle>本机环境检测</CardTitle>
              <CardDescription>
                自动检测芯片架构、Xcode 命令行工具与 Homebrew 安装状态（支持 Apple Silicon 与 Intel）
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">处理器架构</div>
                  <div className="mt-1 text-sm font-semibold">
                    {env?.arch === "aarch64"
                      ? "Apple Silicon (arm64)"
                      : env?.arch === "x86_64"
                      ? "Intel (x86_64)"
                      : env?.arch || "检测中..."}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    macOS {env?.macos_version || "—"}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">
                    Xcode Command Line Tools
                  </div>
                  <div className="mt-1.5">
                    {env?.xcode_clt_installed ? (
                      <Badge variant="success">已安装</Badge>
                    ) : (
                      <Badge variant="warning">未安装</Badge>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {env?.xcode_clt_installed
                      ? "已就绪"
                      : "安装 Homebrew 时将静默自动安装"}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Homebrew 引擎</div>
                  <div className="mt-1.5">
                    {env?.brew_installed ? (
                      <Badge variant="success">
                        <CheckCircle2 className="h-3 w-3" />
                        已就绪
                      </Badge>
                    ) : (
                      <Badge variant="warning">未安装</Badge>
                    )}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {env?.brew_version || "点击下方按钮一键安装"}
                  </div>
                </div>
              </div>

              {!env?.brew_installed && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5">
                  <div className="text-xs">
                    <div className="font-medium text-foreground">
                      一键安装 Homebrew
                    </div>
                    <div className="text-muted-foreground">
                      自动通过系统更新安装 Xcode CLT 并从国内镜像拉取 Homebrew，卡住可随时终止
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {installingBrew && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={onCancelHomebrew}
                      >
                        <Square className="h-3 w-3 fill-current" />
                        终止安装
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={installingBrew}
                      onClick={() => onInstallHomebrew(currentMirror)}
                    >
                      {installingBrew ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {installingBrew ? "安装中..." : "开始安装 Homebrew"}
                    </Button>
                  </div>
                </div>
              )}

              {envLogs.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200">
                  {envLogs.map((l, idx) => (
                    <div key={idx}>{l}</div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2. Homebrew 下载镜像源 */}
          <Card>
            <CardHeader>
              <CardTitle>Homebrew 下载镜像源</CardTitle>
              <CardDescription>
                用于加速 Homebrew 本体安装/更新、软件目录索引（API）及命令行工具（Formula）下载；切换后自动写入 ~/.zprofile 与 ~/.zshrc 并即时生效。注：桌面端 App（Cask）安装包仍从各软件官网下载。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {MIRRORS.map((m) => {
                const active = currentMirror === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={mirrorSaving}
                    onClick={() => handleSelectMirror(m.id)}
                    className={cn(
                      "flex flex-col items-start rounded-lg border p-3.5 text-left transition-all cursor-pointer",
                      active
                        ? "border-primary bg-primary/6"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-sm font-semibold">{m.name}</span>
                      {active && <Badge variant="info">当前使用</Badge>}
                    </div>
                    <span className="mt-1 text-xs text-muted-foreground">
                      {m.desc}
                    </span>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* 3. 工作目录初始化 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-primary" />
                常用工作目录初始化
              </CardTitle>
              <CardDescription>
                在文稿目录（~/Documents/）下一键创建常用工作文件夹及 default 子目录，已存在的会自动跳过
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {folders.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-1 font-mono text-xs"
                  >
                    ~/Documents/{f}/default
                    <button
                      type="button"
                      onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                      className="text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newFolder.trim()) {
                      const v = newFolder.trim();
                      if (!folders.includes(v)) setFolders((p) => [...p, v]);
                      setNewFolder("");
                    }
                  }}
                  placeholder="添加自定义目录名（如 _Work）"
                  className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus:border-primary"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const v = newFolder.trim();
                    if (v && !folders.includes(v)) setFolders((p) => [...p, v]);
                    setNewFolder("");
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加
                </Button>
                <Button
                  size="sm"
                  disabled={folderBusy || folders.length === 0}
                  onClick={handleInitFolders}
                >
                  {folderBusy ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  )}
                  一键创建目录
                </Button>
              </div>

              {folderRes && (
                <Alert variant="success">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <AlertDescription className="mt-0">
                    完成：新建 {folderRes.created.length} 个，已存在跳过{" "}
                    {folderRes.existed.length} 个。
                  </AlertDescription>
                </Alert>
              )}
              {folderErr && (
                <Alert variant="destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <AlertDescription className="mt-0">{folderErr}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
