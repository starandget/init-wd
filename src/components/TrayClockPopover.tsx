import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Moon,
  Plus,
  Power,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CityDef {
  id: string;
  name: string;
  enName: string;
  timeZone: string;
}

const DEFAULT_CITIES: CityDef[] = [
  { id: "shanghai", name: "上海", enName: "Shanghai", timeZone: "Asia/Shanghai" },
  { id: "los-angeles", name: "洛杉矶", enName: "Los Angeles", timeZone: "America/Los_Angeles" },
];

const PRESET_CITIES: CityDef[] = [
  ...DEFAULT_CITIES,
  { id: "tokyo", name: "东京", enName: "Tokyo", timeZone: "Asia/Tokyo" },
  { id: "singapore", name: "新加坡", enName: "Singapore", timeZone: "Asia/Singapore" },
  { id: "london", name: "伦敦", enName: "London", timeZone: "Europe/London" },
  { id: "new-york", name: "纽约", enName: "New York", timeZone: "America/New_York" },
  { id: "sydney", name: "悉尼", enName: "Sydney", timeZone: "Australia/Sydney" },
  { id: "paris", name: "巴黎", enName: "Paris", timeZone: "Europe/Paris" },
];

const STORAGE_KEY = "starbox-tray-cities-v1";

function getOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const mins = match[3] ? parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + mins);
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
}

function formatZone(date: Date, timeZone: string) {
  const timeStr = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value || "";
  const mo = parts.find((p) => p.type === "month")?.value || "";
  const d = parts.find((p) => p.type === "day")?.value || "";
  const w = parts.find((p) => p.type === "weekday")?.value || "";

  const hourNum = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(date),
    10
  );

  const offsetMinutes = getOffsetMinutes(date, timeZone);
  const utcLabel = formatUtcOffset(offsetMinutes);
  const isDay = hourNum >= 6 && hourNum < 18;
  const dateStr = `${y}-${mo}-${d}`;
  const fullStandard = `${dateStr} ${timeStr} ${utcLabel}`;

  return { timeStr, dateStr, weekday: w, offsetMinutes, utcLabel, isDay, fullStandard };
}

export function TrayClockPopover() {
  const [now, setNow] = useState<Date>(() => new Date());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const [cities, setCities] = useState<CityDef[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return DEFAULT_CITIES;
  });

  useEffect(() => {
    const apply = () => {
      const saved = localStorage.getItem("starbox-theme-mode-v1");
      const mode =
        saved === "light" || saved === "warm" || saved === "dark"
          ? saved
          : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      document.documentElement.classList.toggle("dark", mode === "dark");
      document.documentElement.classList.toggle("warm", mode === "warm");
    };
    apply();
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", apply);
    window.addEventListener("storage", apply);
    return () => {
      media?.removeEventListener("change", apply);
      window.removeEventListener("storage", apply);
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cities));
    } catch {
      // ignore
    }
  }, [cities]);

  const utcInfo = useMemo(() => formatZone(now, "UTC"), [now]);
  const shInfo = useMemo(() => formatZone(now, "Asia/Shanghai"), [now]);

  const availableToAdd = useMemo(
    () => PRESET_CITIES.filter((p) => !cities.some((c) => c.id === p.id)),
    [cities]
  );

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1400);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-muted/50 p-3 text-foreground select-none">
      {/* Top Bar: Brand + UTC + Add City */}
      <div className="flex shrink-0 items-center justify-between px-0.5 pb-2">
        <div className="flex items-center gap-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-blue-600 to-cyan-500 text-white">
            <Sparkles className="h-3 w-3" />
          </div>
          <span className="text-xs font-semibold tracking-tight">世界时间</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleCopy("utc", utcInfo.fullStandard)}
            title="点击复制 UTC 标准时间"
            className="flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Globe className="h-2.5 w-2.5 text-blue-500" />
            <span>UTC</span>
            <span className="font-semibold text-foreground tabular-nums">
              {utcInfo.timeStr}
            </span>
            {copiedId === "utc" && <Check className="h-2.5 w-2.5 text-emerald-500" />}
          </button>

          {availableToAdd.length > 0 && (
            <button
              type="button"
              title="添加城市"
              onClick={() => setShowPicker((v) => !v)}
              className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Inline City Picker */}
      {showPicker && availableToAdd.length > 0 && (
        <div className="mb-2 flex shrink-0 flex-wrap gap-1 rounded-lg border border-border bg-card p-2">
          {availableToAdd.map((city) => (
            <button
              key={city.id}
              type="button"
              onClick={() => {
                setCities((prev) => [...prev, city]);
                if (availableToAdd.length <= 1) setShowPicker(false);
              }}
              className="inline-flex items-center gap-0.5 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium hover:bg-secondary/70 cursor-pointer"
            >
              <Plus className="h-2.5 w-2.5" />
              {city.name}
            </button>
          ))}
        </div>
      )}

      {/* Scrollable City Cards */}
      <div className="flex-1 space-y-2 overflow-y-auto pr-0.5">
        {cities.map((city) => {
          const info = formatZone(now, city.timeZone);
          const diffHours = (info.offsetMinutes - shInfo.offsetMinutes) / 60;
          const dayRel =
            info.dateStr === shInfo.dateStr
              ? "今天"
              : info.dateStr < shInfo.dateStr
              ? "昨天"
              : "明天";
          const diffText =
            diffHours === 0
              ? "本地标准时间"
              : diffHours > 0
              ? `${dayRel} · 快 ${diffHours} 小时`
              : `${dayRel} · 慢 ${Math.abs(diffHours)} 小时`;

          return (
            <div
              key={city.id}
              onClick={() => handleCopy(city.id, info.fullStandard)}
              title="点击复制标准时间"
              className="group rounded-xl border border-border bg-card p-3 shadow-2xs transition-colors hover:border-blue-500/40 cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{city.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {city.enName}
                  </span>
                  <Badge
                    variant={info.offsetMinutes >= 0 ? "info" : "warning"}
                    className="font-mono text-[10px]"
                  >
                    {info.utcLabel}
                  </Badge>
                </div>

                <div className="flex items-center gap-1">
                  {info.isDay ? (
                    <Sun className="h-3.5 w-3.5 text-amber-500" />
                  ) : (
                    <Moon className="h-3.5 w-3.5 text-indigo-400" />
                  )}
                  {copiedId === city.id ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                  {cities.length > 1 && (
                    <button
                      type="button"
                      title="移除城市"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCities((prev) => prev.filter((c) => c.id !== city.id));
                      }}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span className="font-mono text-2xl font-bold tracking-tight tabular-nums">
                  {info.timeStr}
                </span>
                <div className="text-right">
                  <div className="font-mono text-[11px] text-foreground/80">
                    {info.dateStr} {info.weekday}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {diffText}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Actions */}
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-border/70 pt-2">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 flex-1 text-xs"
          onClick={() => invoke("open_main_window")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开 Star Box
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          title="退出 Star Box"
          onClick={() => invoke("quit_app")}
        >
          <Power className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
