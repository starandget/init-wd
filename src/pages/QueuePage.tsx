import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RotateCcw,
  Square,
  Trash2,
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
} from "@/types";

interface QueuePageProps {
  tasks: InstallTask[];
  env?: EnvStatus | null;
  onRetry: (item: AppItem) => void;
  onCancelTask: (taskId: string) => void;
  onCancelAll: () => void;
  onClearFinished: () => void;
  onGoSettings?: () => void;
}

export function QueuePage({
  tasks,
  onRetry,
  onCancelTask,
  onCancelAll,
  onClearFinished,
}: QueuePageProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const hasFinished = tasks.some(
    (t) => t.status === "success" || t.status === "error"
  );
  const hasActive = tasks.some(
    (t) => t.status === "queued" || t.status === "running"
  );

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-13 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <h2 className="titlebar-no-drag text-base font-semibold tracking-tight">任务队列</h2>
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
            const isOpen = !!expanded[task.task_id];
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
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">
                            {actionLabel} {task.app.name}
                          </span>
                          <SourceBadge source={resolveAppSource(task.app)} />
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
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
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
                          {task.app.website && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => api.openExternal(task.app.website!)}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              官网手动下载
                            </Button>
                          )}
                          <Button size="sm" onClick={() => onRetry(task.app)}>
                            <RotateCcw className="h-3.5 w-3.5" />
                            重试
                          </Button>
                        </>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="展开日志"
                        onClick={() => toggleExpand(task.task_id)}
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

                  {isOpen && (
                    <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200">
                      {task.logs.length === 0 ? (
                        <span className="text-zinc-500">暂无日志输出</span>
                      ) : (
                        task.logs.map((line, i) => <div key={i}>{line}</div>)
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
