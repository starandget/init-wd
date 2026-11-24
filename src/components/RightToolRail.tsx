import { useEffect, useState } from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Minus,
  Square,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { InstallTask } from "@/types";

export type RightPanelId = "activity" | "clock" | null;

interface RightToolRailProps {
  activePanel: RightPanelId;
  onChangePanel: (panel: RightPanelId) => void;
  tasks: InstallTask[];
  activeTaskCount: number;
  onCancelTask: (taskId: string) => void;
  onCancelAllTasks: () => void;
  onGoQueue: () => void;
}

const CLOCK_ZONES = [
  { id: "shanghai", label: "上海", sub: "UTC+8", tz: "Asia/Shanghai" },
  { id: "la", label: "洛杉矶", sub: "PT", tz: "America/Los_Angeles" },
  { id: "utc", label: "协调世界时", sub: "UTC+0", tz: "UTC" },
  { id: "tokyo", label: "东京", sub: "UTC+9", tz: "Asia/Tokyo" },
];

function formatClock(date: Date, tz: string) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(date);
  return { time, day };
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
  const [now, setNow] = useState(() => new Date());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (activePanel !== "clock") return;
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [activePanel]);

  const toggle = (id: Exclude<RightPanelId, null>) => {
    onChangePanel(activePanel === id ? null : id);
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1200);
  };

  return (
    <div className="flex h-full shrink-0 select-none">
      {/* Expandable Side Panel */}
      {activePanel && (
        <aside className="flex h-full w-[268px] shrink-0 flex-col border-l border-border bg-card">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-xs font-semibold text-foreground">
              {activePanel === "activity" ? "实时任务" : "世界时钟"}
            </span>
            <div className="flex items-center gap-1">
              {activePanel === "activity" && activeTaskCount > 0 && (
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
                  tasks.slice(0, 12).map((t) => (
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
                      </div>
                      <div className="truncate text-[10.5px] text-muted-foreground">
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
                  ))
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

          {activePanel === "clock" && (
            <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
              {CLOCK_ZONES.map((z) => {
                const { time, day } = formatClock(now, z.tz);
                const copied = copiedId === z.id;
                return (
                  <button
                    key={z.id}
                    type="button"
                    onClick={() =>
                      handleCopy(z.id, `${z.label} ${day} ${time}`)
                    }
                    className="group flex w-full items-center justify-between rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/60 cursor-pointer"
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-foreground">
                          {z.label}
                        </span>
                        <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground">
                          {z.sub}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                        {day}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {time}
                      </span>
                      {copied ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </div>
                  </button>
                );
              })}
              <p className="px-1 pt-1 text-[10.5px] text-muted-foreground">
                点击卡片复制时间，后续小工具可直接扩展到右侧栏。
              </p>
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

          <button
            type="button"
            onClick={() => toggle("clock")}
            title="世界时钟"
            className={cn(
              "flex h-7.5 w-7.5 items-center justify-center rounded-lg transition-colors cursor-pointer",
              activePanel === "clock"
                ? "bg-primary/14 text-primary"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <Clock className="h-4 w-4" />
          </button>
        </div>

        {/* Reserved bottom area for future edge widgets */}
        <div />
      </aside>
    </div>
  );
}
