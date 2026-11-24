import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Info,
  Power,
  Radar,
  ShieldCheck,
  Smartphone,
  Wifi,
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
import type { DiscoveredProxy, ProxyConfig } from "@/types";

interface ProxyPageProps {
  proxyConfig: ProxyConfig | null;
  onProxyChange: (next: ProxyConfig) => void;
}

export function ProxyPage({ proxyConfig, onProxyChange }: ProxyPageProps) {
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredProxy[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [manualUrl, setManualUrl] = useState(proxyConfig?.url || "");
  const [testing, setTesting] = useState(false);
  const [activeLatency, setActiveLatency] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "destructive" | "info";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (proxyConfig?.url && !manualUrl) {
      setManualUrl(proxyConfig.url);
    }
  }, [proxyConfig?.url]);

  const handleDiscover = async () => {
    setScanning(true);
    setFeedback(null);
    try {
      const list = await api.discoverLanProxies();
      setDiscovered(list);
      setHasScanned(true);
      if (list.length === 0) {
        setFeedback({
          type: "info",
          text: "未在局域网或本机发现可用加速节点。请确认局域网内设备已开启「允许局域网连接」且与 Mac 在同一 Wi-Fi。",
        });
      }
    } catch (e) {
      setFeedback({ type: "destructive", text: `扫描失败: ${String(e)}` });
    } finally {
      setScanning(false);
    }
  };

  const handleEnable = async (url: string, latency?: number) => {
    setFeedback(null);
    try {
      const next = await api.setProxyConfig(true, url);
      onProxyChange(next);
      setManualUrl(next.url || url);
      if (typeof latency === "number") setActiveLatency(latency);
      setFeedback({
        type: "success",
        text: `已启用局域网加速 ${next.url}，后续所有软件安装与 GitHub 下载将自动走此加速通道。`,
      });
    } catch (e) {
      setFeedback({ type: "destructive", text: `启用失败: ${String(e)}` });
    }
  };

  const handleDisable = async () => {
    setFeedback(null);
    try {
      const next = await api.setProxyConfig(false, proxyConfig?.url || null);
      onProxyChange(next);
      setActiveLatency(null);
      setFeedback({ type: "info", text: "已停用局域网加速，恢复直连模式。" });
    } catch (e) {
      setFeedback({ type: "destructive", text: `停用失败: ${String(e)}` });
    }
  };

  const handleTestCurrent = async () => {
    if (!proxyConfig?.url) return;
    setTesting(true);
    setFeedback(null);
    try {
      const res = await api.testProxy(proxyConfig.url);
      if (res.ok) {
        setActiveLatency(res.latency_ms ?? null);
        setFeedback({
          type: "success",
          text: `当前加速通道连通正常（延迟 ${res.latency_ms ?? 0} ms）`,
        });
      } else {
        setActiveLatency(null);
        setFeedback({
          type: "destructive",
          text: `当前加速通道无法连通：${res.error || "连接超时"}`,
        });
      }
    } catch (e) {
      setFeedback({ type: "destructive", text: `测速失败: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const handleTestAndEnableManual = async () => {
    const trimmed = manualUrl.trim();
    if (!trimmed) return;
    setTesting(true);
    setFeedback(null);
    try {
      const res = await api.testProxy(trimmed);
      if (!res.ok) {
        setFeedback({
          type: "destructive",
          text: `加速节点无法连通：${res.error || "连接超时"}`,
        });
        return;
      }
      await handleEnable(trimmed, res.latency_ms ?? undefined);
    } catch (e) {
      setFeedback({ type: "destructive", text: `测试失败: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const isEnabled = Boolean(proxyConfig?.enabled && proxyConfig?.url);

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold tracking-tight">局域网加速</h2>
          {isEnabled ? (
            <Badge variant="success">
              已启用 · {proxyConfig?.url?.replace(/^https?:\/\/|^socks5:\/\//, "")}
            </Badge>
          ) : (
            <Badge variant="secondary">直连模式</Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEnabled && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={handleDisable}
            >
              <Power className="h-3.5 w-3.5" />
              停用加速
            </Button>
          )}
          <Button
            size="sm"
            className="h-8 rounded-full px-4 text-xs"
            disabled={scanning}
            onClick={handleDiscover}
          >
            {scanning ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Radar className="h-3.5 w-3.5" />
            )}
            {scanning ? "扫描局域网中..." : "自动发现局域网加速"}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-4xl space-y-4">
          {feedback && (
            <Alert variant={feedback.type}>
              {feedback.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : feedback.type === "destructive" ? (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <AlertDescription className="mt-0">{feedback.text}</AlertDescription>
            </Alert>
          )}

          {/* 1. 当前加速状态 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck
                    className={cn(
                      "h-4 w-4",
                      isEnabled ? "text-emerald-500" : "text-muted-foreground"
                    )}
                  />
                  <CardTitle className="text-sm">当前下载通道</CardTitle>
                </div>
                {isEnabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={testing}
                    onClick={handleTestCurrent}
                  >
                    {testing ? <Spinner className="h-3 w-3" /> : <Wifi className="h-3 w-3" />}
                    测试连通性
                  </Button>
                )}
              </div>
              <CardDescription>
                启用后仅作用于 Star Box 内部的 Homebrew 安装/升级、GitHub Release 直装与目录搜索，不修改 macOS 全局系统网络设置。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/35 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      isEnabled ? "bg-emerald-500" : "bg-muted-foreground/40"
                    )}
                  />
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {isEnabled ? (
                        <span className="font-mono">{proxyConfig?.url}</span>
                      ) : (
                        "当前未启用局域网加速（直连网络）"
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {isEnabled
                        ? activeLatency !== null
                          ? `已连接 · 最近测速延迟 ${activeLatency} ms`
                          : "所有软件安装与开源镜像下载会自动走此加速通道"
                        : "点击右上角「自动发现局域网加速」可一键扫描同网段可用加速节点"}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. 扫描发现列表 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Radar className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">局域网 & 本机加速节点发现</CardTitle>
                </div>
                {discovered.length > 0 && (
                  <Badge variant="info">{discovered.length} 个可用</Badge>
                )}
              </div>
              <CardDescription>
                自动发现当前 Wi-Fi / 局域网存活设备、本机常用转发端口及系统网络通道，并对每个节点做真实连通性与延迟测速。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {scanning ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Spinner className="h-5 w-5" />
                  <span>正在扫描局域网设备并验证节点延迟...</span>
                </div>
              ) : discovered.length > 0 ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {discovered.map((p) => {
                    const active = isEnabled && proxyConfig?.url === p.url;
                    const sourceLabel =
                      p.source === "lan"
                        ? "局域网设备"
                        : p.source === "system"
                        ? "系统通道"
                        : "本机端口";
                    return (
                      <div
                        key={p.url}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-lg border p-3 transition-colors",
                          active
                            ? "border-emerald-500/60 bg-emerald-500/5"
                            : "border-border bg-muted/20"
                        )}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-xs font-semibold text-foreground">
                              {p.host}:{p.port}
                            </span>
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                              {sourceLabel}
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span className="uppercase">{p.protocol}</span>
                            <span>·</span>
                            <span>{p.hint}</span>
                            <span>·</span>
                            <span className="font-mono text-emerald-600 dark:text-emerald-400">
                              {p.latency_ms} ms
                            </span>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={active ? "outline" : "default"}
                          className="h-7 shrink-0 text-xs"
                          onClick={() =>
                            active
                              ? handleDisable()
                              : handleEnable(p.url, p.latency_ms)
                          }
                        >
                          {active ? "停用" : "启用"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border py-7 text-center text-xs text-muted-foreground">
                  {hasScanned
                    ? "未扫描到可用的局域网或本机加速节点，请检查同网段设备是否已开启「允许局域网连接」，或在下方手动填写。"
                    : "点击右上角「自动发现局域网加速」开始扫描（耗时约 2~3 秒）"}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 3. 手动配置 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm">手动填写加速节点地址</CardTitle>
              </div>
              <CardDescription>
                如果局域网设备使用的是自定义端口，可直接填写 HTTP 或 SOCKS5 节点地址，测试通过后立即启用。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleTestAndEnableManual();
                  }}
                  placeholder="例如 http://192.168.1.105:1082 或 socks5://192.168.1.105:1082"
                  className="h-9 min-w-[260px] flex-1 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                />
                <Button
                  size="sm"
                  className="h-9 px-4 text-xs"
                  disabled={testing || !manualUrl.trim()}
                  onClick={handleTestAndEnableManual}
                >
                  {testing ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  测试并启用
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* 4. 局域网共享说明 */}
          <div className="flex items-start gap-2.5 rounded-xl border border-border/80 bg-muted/30 p-3.5 text-xs text-muted-foreground">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="space-y-1 leading-relaxed">
              <div className="font-medium text-foreground">
                局域网加速常用扫描端口
              </div>
              <div>
                确保加速设备与 Mac 连在同一个 Wi-Fi / 局域网，并在对应网络工具中打开「允许局域网连接」：
                <span className="font-mono text-foreground/85">
                  {" "}
                  1082 · 7890 · 7897 · 6152 · 8888 · 8889 · 10809
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
