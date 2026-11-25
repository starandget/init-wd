import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  RotateCcw,
  Smartphone,
  Square,
  Trash2,
  Wifi,
  XCircle,
} from "lucide-react";
import { api } from "@/api";
import { AppIcon } from "@/components/AppIcon";
import { SourceBadge, resolveAppSource } from "@/components/SourceBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type {
  AppItem,
  EnvStatus,
  InstallTask,
  ProxyConfig,
} from "@/types";

function classifyProxyDisplay(url?: string | null): {
  kind: "direct" | "local" | "lan" | "custom";
  shortLabel: string;
  fullLabel: string;
} {
  const trimmed = url?.trim();
  if (!trimmed) {
    return { kind: "direct", shortLabel: "直连", fullLabel: "直连网络（未启用代理）" };
  }
  const hostPort = trimmed.replace(/^[a-z0-9+.-]+:\/\//i, "").split("/")[0] || trimmed;
  const host = hostPort.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return {
      kind: "local",
      shortLabel: `本机代理 ${hostPort}`,
      fullLabel: `本机代理 ${trimmed}`,
    };
  }
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return {
      kind: "lan",
      shortLabel: `局域网/手机代理 ${hostPort}`,
      fullLabel: `局域网/手机代理 ${trimmed}`,
    };
  }
  return {
    kind: "custom",
    shortLabel: `代理 ${hostPort}`,
    fullLabel: `自定义代理 ${trimmed}`,
  };
}

function getFallbackWebsite(app: AppItem): string | null {
  const w = app.website?.trim();
  if (w) return w;
  const repo = app.github_repo?.trim().replace(/^\/+|\/+$/g, "");
  if (repo) return `https://github.com/${repo}/releases`;
  return null;
}

function TerminalLogBox({ logs }: { logs: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(logs.join("\n")).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="relative rounded-lg bg-zinc-950 border border-zinc-800/80">
      {logs.length > 0 && (
        <button
          type="button"
          onClick={handleCopy}
          title="复制完整命令行日志"
          className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded bg-zinc-800/90 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-white cursor-pointer"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      )}
      <div
        ref={boxRef}
        className="max-h-64 overflow-y-auto p-3 pr-16 font-mono text-[11px] leading-relaxed text-zinc-200 select-text"
      >
        {logs.length === 0 ? (
          <span className="text-zinc-500">暂无日志输出</span>
        ) : (
          logs.map((line, i) => {
            const cls = line.startsWith("$ ")
              ? "text-emerald-400 font-semibold"
              : line.startsWith("# ")
              ? "text-sky-400"
              : line.startsWith("[exit code:")
              ? "text-amber-400"
              : "text-zinc-200";
            return (
              <div key={i} className={`whitespace-pre-wrap break-all ${cls}`}>
                {line}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

interface QueuePageProps {
  tasks: InstallTask[];
  env?: EnvStatus | null;
  proxyConfig?: ProxyConfig | null;
  installConcurrency?: number;
  onRetry: (item: AppItem, action: InstallTask["action"]) => void;
  onCancelTask: (taskId: string) => void;
  onCancelAll: () => void;
  onClearFinished: () => void;
  onGoSettings?: () => void;
  onGoProxy?: () => void;
}

export function QueuePage({
  tasks,
  proxyConfig,
  installConcurrency = 5,
  onRetry,
  onCancelTask,
  onCancelAll,
  onClearFinished,
  onGoSettings,
  onGoProxy,
}: QueuePageProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string, currentOpen: boolean) =>
    setExpanded((prev) => ({ ...prev, [id]: !currentOpen }));

  const hasFinished = tasks.some(
    (t) => t.status === "success" || t.status === "error"
  );
  const hasActive = tasks.some(
    (t) => t.status === "queued" || t.status === "running"
  );

  const activeProxyInfo = classifyProxyDisplay(
    proxyConfig?.enabled ? proxyConfig.url : null
  );

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="titlebar-no-drag flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">任务队列</h2>
          <button
            type="button"
            onClick={onGoSettings}
            title="前往设置调整并发数（1~5）"
            className="rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors cursor-pointer"
          >
            最多 {installConcurrency} 路并发
          </button>
          <button
            type="button"
            onClick={onGoProxy}
            title={`${activeProxyInfo.fullLabel} · 点击前往「局域网加速」切换`}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
              activeProxyInfo.kind === "direct"
                ? "border-border bg-muted/60 text-muted-foreground hover:text-foreground"
                : activeProxyInfo.kind === "lan"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15"
                : "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-500/15"
            }`}
          >
            {activeProxyInfo.kind === "lan" ? (
              <Smartphone className="h-3 w-3" />
            ) : activeProxyInfo.kind === "local" ? (
              <Wifi className="h-3 w-3" />
            ) : (
              <Globe className="h-3 w-3" />
            )}
            <span className="font-mono">{activeProxyInfo.shortLabel}</span>
          </button>
        </div>
        <div className="titlebar-no-drag flex items-center gap-2">
          {hasActive && (
            <Button
              size="sm"
              variant="destructive"
              onClick={onCancelAll}
            >
              <Square className="h-3 w-3 fill-current" />
              全部终止
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!hasFinished}
            onClick={onClearFinished}
          >
            <Trash2 className="h-3.5 w-3.5" />
            清理已完成
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-sm font-medium text-foreground">
              当前没有运行中的任务
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              在「发现软件」或「我的清单」中点击安装，任务会显示在这里
            </p>
          </div>
        ) : (
          tasks.map((task) => {
            const defaultOpen = task.status === "running" || task.status === "error";
            const isOpen =
              task.task_id in expanded ? expanded[task.task_id] : defaultOpen;
            const fallbackUrl = getFallbackWebsite(task.app);
            const actionLabel =
              task.action === "upgrade"
                ? "更新"
                : task.action === "uninstall"
                ? "卸载"
                : "安装";
            return (
              <Card key={task.task_id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <AppIcon
                        name={task.app.name}
                        iconUrl={task.app.icon_url}
                        website={task.app.website}
                        githubRepo={task.app.github_repo}
                        isFormula={task.app.kind === "formula"}
                        size="sm"
                      />
                      {task.status === "running" || task.status === "queued" ? (
                        <Spinner className="h-4 w-4 text-muted-foreground" />
                      ) : task.status === "success" ? (
                        <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="h-4.5 w-4.5 shrink-0 text-destructive" />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">
                            {actionLabel} {task.app.name}
                          </span>
                          <SourceBadge source={resolveAppSource(task.app)} />
                          {task.action !== "uninstall" && (() => {
                            const pInfo = classifyProxyDisplay(
                              task.status === "queued"
                                ? proxyConfig?.enabled
                                  ? proxyConfig.url
                                  : null
                                : task.proxy_url
                            );
                            return (
                              <button
                                type="button"
                                onClick={onGoProxy}
                                title={`${pInfo.fullLabel} · 点击切换代理`}
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium transition-colors cursor-pointer ${
                                  pInfo.kind === "direct"
                                    ? "border-border bg-muted/60 text-muted-foreground hover:text-foreground"
                                    : pInfo.kind === "lan"
                                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                    : "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                                }`}
                              >
                                {pInfo.shortLabel}
                              </button>
                            );
                          })()}
                          <Badge
                            variant={
                              task.status === "success"
                                ? "success"
                                : task.status === "error"
                                ? "destructive"
                                : "info"
                            }
                          >
                            {task.status === "queued"
                              ? "排队中"
                              : task.status === "running"
                              ? `${task.progress}%`
                              : task.status === "success"
                              ? "完成"
                              : task.stage === "cancelled"
                              ? "已终止"
                              : "失败"}
                          </Badge>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {task.logs[task.logs.length - 1] ||
                            task.stage ||
                            "等待执行..."}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {(task.status === "running" || task.status === "queued") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-destructive/40 text-destructive hover:bg-destructive/10"
                          onClick={() => onCancelTask(task.task_id)}
                        >
                          <Square className="h-3 w-3 fill-current" />
                          终止
                        </Button>
                      )}
                      {task.status === "error" && (
                        <>
                          {task.action !== "uninstall" && fallbackUrl && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => api.openExternal(fallbackUrl)}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              官网手动下载
                            </Button>
                          )}
                          <Button size="sm" onClick={() => onRetry(task.app, task.action)}>
                            <RotateCcw className="h-3.5 w-3.5" />
                            重试
                          </Button>
                        </>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="展开日志"
                        onClick={() => toggleExpand(task.task_id, isOpen)}
                      >
                        {isOpen ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <Progress
                    value={Math.max(4, task.progress)}
                    indicatorClassName={
                      task.status === "error"
                        ? "bg-destructive"
                        : task.status === "success"
                        ? "bg-emerald-500"
                        : "bg-primary"
                    }
                  />

                  {task.status === "error" && fallbackUrl && task.stage !== "cancelled" && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs">
                      <span className="truncate text-muted-foreground">
                        官网下载链接：
                        <button
                          type="button"
                          onClick={() => api.openExternal(fallbackUrl)}
                          className="ml-1 font-mono text-primary underline underline-offset-2 hover:opacity-80 cursor-pointer"
                        >
                          {fallbackUrl}
                        </button>
                      </span>
                    </div>
                  )}

                  {isOpen && <TerminalLogBox logs={task.logs} />}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
