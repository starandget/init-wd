import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Minus,
  Square,
  XCircle,
} from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { InstallTask } from "@/types";

export type RightPanelId = "activity" | null;

interface RightToolRailProps {
  activePanel: RightPanelId;
  onChangePanel: (panel: RightPanelId) => void;
  tasks: InstallTask[];
  activeTaskCount: number;
  onCancelTask: (taskId: string) => void;
  onCancelAllTasks: () => void;
  onGoQueue: () => void;
}

export function RightToolRail({
  activePanel,
  onChangePanel,
  tasks,
  activeTaskCount,
  onCancelTask,
  onCancelAllTasks,
  onGoQueue,
}: RightToolRailProps) {
  const toggle = (id: Exclude<RightPanelId, null>) => {
    onChangePanel(activePanel === id ? null : id);
  };

  return (
    <div className="flex h-full shrink-0 select-none">
      {/* Expandable Side Panel */}
      {activePanel && (
        <aside className="flex h-full w-[268px] shrink-0 flex-col border-l border-border bg-card">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-xs font-semibold text-foreground">
              实时任务
            </span>
            <div className="flex items-center gap-1">
              {activeTaskCount > 0 && (
                <button
                  type="button"
                  onClick={onCancelAllTasks}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10 cursor-pointer"
                >
                  全部终止
                </button>
              )}
              <button
                type="button"
                onClick={() => onChangePanel(null)}
                title="收起"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {activePanel === "activity" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
                {tasks.length === 0 ? (
                  <div className="py-14 text-center text-xs text-muted-foreground">
                    当前没有运行中的任务
                  </div>
                ) : (
                  tasks.slice(0, 12).map((t) => {
                    const fallbackUrl =
                      t.app.website?.trim() ||
                      (t.app.github_repo?.trim()
                        ? `https://github.com/${t.app.github_repo.trim().replace(/^\/+|\/+$/g, "")}/releases`
                        : null);
                    return (
                    <div
                      key={t.task_id}
                      className="space-y-1.5 rounded-lg border border-border/80 bg-muted/30 p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {t.status === "running" || t.status === "queued" ? (
                            <Spinner className="h-3 w-3 shrink-0 text-primary" />
                          ) : t.status === "success" ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                          )}
                          <span className="truncate text-xs font-medium">
                            {t.app.name}
                          </span>
                        </div>
                        {(t.status === "running" || t.status === "queued") && (
                          <button
                            type="button"
                            onClick={() => onCancelTask(t.task_id)}
                            title="终止任务"
                            className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/12 cursor-pointer"
                          >
                            <Square className="h-2.5 w-2.5 fill-current" />
                            终止
                          </button>
                        )}
                        {t.status === "error" && fallbackUrl && t.stage !== "cancelled" && (
                          <button
                            type="button"
                            onClick={() => api.openExternal(fallbackUrl)}
                            title={fallbackUrl}
                            className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/12 cursor-pointer"
                          >
                            <ExternalLink className="h-2.5 w-2.5" />
                            官网
                          </button>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {t.logs[t.logs.length - 1] || "等待中..."}
                      </div>
                      <Progress
                        value={Math.max(4, t.progress)}
                        className="h-1"
                        indicatorClassName={
                          t.status === "error"
                            ? "bg-destructive"
                            : t.status === "success"
                            ? "bg-emerald-500"
                            : "bg-primary"
                        }
                      />
                    </div>
                  );
                  })
                )}
              </div>
              <div className="border-t border-border p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-full text-xs"
                  onClick={onGoQueue}
                >
                  打开完整任务队列
                </Button>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* Right Tool Rail Strip */}
      <aside className="flex h-full w-10 shrink-0 flex-col items-center justify-between border-l border-sidebar-border bg-sidebar py-2.5">
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={() => toggle("activity")}
            title="实时任务"
            className={cn(
              "relative flex h-7.5 w-7.5 items-center justify-center rounded-lg transition-colors cursor-pointer",
              activePanel === "activity"
                ? "bg-primary/14 text-primary"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <Activity className="h-4 w-4" />
            {activeTaskCount > 0 && (
              <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        </div>

        {/* Reserved bottom area for future edge widgets */}
        <div />
      </aside>
    </div>
  );
}
