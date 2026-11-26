import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe,
  Info,
  MessageSquareText,
  Play,
  QrCode,
  RefreshCw,
  Send,
  Server,
  Square,
  Trash2,
  Upload,
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
import { generateQrMatrix, qrToSvgPath } from "@/lib/qrcode";
import { cn } from "@/lib/utils";
import type { LanServerStatus } from "@/types";

interface LanServerPageProps {
  status: LanServerStatus | null;
  onStatusChange: (next: LanServerStatus) => void;
}

const PORT_PRESETS = [8080, 8888, 3000, 9000];

export function LanServerPage({ status, onStatusChange }: LanServerPageProps) {
  const [rootDir, setRootDir] = useState(status?.root_dir || "");
  const [portInput, setPortInput] = useState(String(status?.port || 8080));
  const [showHidden, setShowHidden] = useState(status?.show_hidden ?? false);
  const [serveIndex, setServeIndex] = useState(status?.serve_index ?? false);
  const [allowUpload, setAllowUpload] = useState(status?.allow_upload ?? false);

  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [copiedNoteId, setCopiedNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [sendingNote, setSendingNote] = useState(false);
  const [selectedQrUrl, setSelectedQrUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "destructive" | "info";
    text: string;
  } | null>(null);

  const hydratedRef = useRef(false);

  // Sync saved config on initial async hydration, and keep toggle flags synced
  useEffect(() => {
    if (!status) return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      setRootDir(status.root_dir || "");
      setPortInput(String(status.port || 8080));
    }
    setShowHidden(status.show_hidden);
    setServeIndex(status.serve_index);
    setAllowUpload(status.allow_upload);
  }, [status]);

  useEffect(() => {
    if (status?.running && status.primary_url) {
      if (!selectedQrUrl || !status.urls.includes(selectedQrUrl)) {
        setSelectedQrUrl(status.primary_url);
      }
    } else if (!status?.running) {
      setSelectedQrUrl(null);
    }
  }, [status?.running, status?.primary_url, status?.urls, selectedQrUrl]);

  const parsedPort = Number.parseInt(portInput, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;

  const isRunning = Boolean(status?.running);
  const needsRestart =
    isRunning &&
    (rootDir.trim() !== (status?.root_dir || "") ||
      (portValid && parsedPort !== status?.port));

  const activeQrUrl = selectedQrUrl || status?.primary_url || null;
  const qrData = useMemo(() => {
    if (!activeQrUrl) return null;
    const matrix = generateQrMatrix(activeQrUrl);
    if (!matrix) return null;
    return {
      size: matrix.size,
      path: qrToSvgPath(matrix),
    };
  }, [activeQrUrl]);

  const handlePickDir = async () => {
    try {
      const picked = await api.pickDirectoryDialog(rootDir || undefined);
      if (!picked) return;
      setRootDir(picked);
      setFeedback(null);
      if (!isRunning && portValid) {
        const next = await api.updateLanServerConfig({
          rootDir: picked,
          port: parsedPort,
          showHidden,
          serveIndex,
          allowUpload,
        });
        onStatusChange(next);
      }
    } catch (e) {
      setFeedback({ type: "destructive", text: `选择目录失败: ${String(e)}` });
    }
  };

  const handleStartOrRestart = async () => {
    const trimmed = rootDir.trim();
    if (!trimmed) {
      setFeedback({ type: "destructive", text: "请先选择一个本地目录" });
      return;
    }
    if (!portValid) {
      setFeedback({
        type: "destructive",
        text: "端口需为 1024 ~ 65535 之间的整数",
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.startLanServer({
        rootDir: trimmed,
        port: parsedPort,
        showHidden,
        serveIndex,
        allowUpload,
      });
      onStatusChange(next);
      setSelectedQrUrl(next.primary_url);
      setFeedback({
        type: "success",
        text: `局域网服务器已启动，同 Wi-Fi 设备可访问 ${next.primary_url || `http://127.0.0.1:${next.port}`}`,
      });
    } catch (e) {
      setFeedback({ type: "destructive", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.stopLanServer();
      onStatusChange(next);
      setFeedback({ type: "info", text: "局域网服务器已停止" });
    } catch (e) {
      setFeedback({ type: "destructive", text: `停止失败: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleOption = async (
    key: "showHidden" | "serveIndex" | "allowUpload",
    value: boolean
  ) => {
    const nextShowHidden = key === "showHidden" ? value : showHidden;
    const nextServeIndex = key === "serveIndex" ? value : serveIndex;
    const nextAllowUpload = key === "allowUpload" ? value : allowUpload;

    setShowHidden(nextShowHidden);
    setServeIndex(nextServeIndex);
    setAllowUpload(nextAllowUpload);

    try {
      const next = await api.updateLanServerConfig({
        rootDir: rootDir.trim() || null,
        port: portValid ? parsedPort : status?.port || 8080,
        showHidden: nextShowHidden,
        serveIndex: nextServeIndex,
        allowUpload: nextAllowUpload,
      });
      onStatusChange(next);
    } catch (e) {
      setFeedback({ type: "destructive", text: `保存选项失败: ${String(e)}` });
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => {
        setCopiedUrl((prev) => (prev === url ? null : prev));
      }, 1800);
    } catch {
      setFeedback({ type: "info", text: `请手动复制地址：${url}` });
    }
  };

  const handleRefreshStatus = async () => {
    try {
      const next = await api.getLanServerStatus();
      onStatusChange(next);
    } catch (e) {
      setFeedback({ type: "destructive", text: `刷新状态失败: ${String(e)}` });
    }
  };

  const handleClearLogs = async () => {
    try {
      const next = await api.clearLanServerLogs();
      onStatusChange(next);
    } catch (e) {
      setFeedback({ type: "destructive", text: `清空日志失败: ${String(e)}` });
    }
  };

  const handleSendNote = async () => {
    const text = noteDraft.trim();
    if (!text) return;
    setSendingNote(true);
    try {
      const next = await api.addLanNote(text);
      onStatusChange(next);
      setNoteDraft("");
    } catch (e) {
      setFeedback({ type: "destructive", text: `发送文本失败: ${String(e)}` });
    } finally {
      setSendingNote(false);
    }
  };

  const handleCopyNote = async (id: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedNoteId(id);
      window.setTimeout(() => {
        setCopiedNoteId((prev) => (prev === id ? null : prev));
      }, 1600);
    } catch {
      setFeedback({ type: "info", text: "复制失败，请手动选中复制" });
    }
  };

  const handleClearNotes = async () => {
    try {
      const next = await api.clearLanNotes();
      onStatusChange(next);
    } catch (e) {
      setFeedback({ type: "destructive", text: `清空快传失败: ${String(e)}` });
    }
  };

  const logs = status?.recent_logs || [];
  const notes = status?.notes || [];

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold tracking-tight">局域网文件共享</h2>
          {isRunning ? (
            <Badge variant="success">运行中 · :{status?.port}</Badge>
          ) : (
            <Badge variant="secondary">未启动</Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isRunning && status?.primary_url && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => api.openExternal(status.primary_url!)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              浏览器打开
            </Button>
          )}
          {isRunning ? (
            <>
              {needsRestart && (
                <Button
                  size="sm"
                  className="h-8 rounded-full px-3.5 text-xs"
                  disabled={busy || !rootDir.trim() || !portValid}
                  onClick={handleStartOrRestart}
                >
                  {busy ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  应用并重启
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={handleStop}
              >
                {busy ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )}
                停止服务
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="h-8 rounded-full px-4 text-xs"
              disabled={busy || !rootDir.trim() || !portValid}
              onClick={handleStartOrRestart}
            >
              {busy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
              启动服务器
            </Button>
          )}
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

          {/* 1. 目录与服务配置 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm">共享目录与端口配置</CardTitle>
              </div>
              <CardDescription>
                选择一个本地文件夹对外展示，同局域网下的手机、平板或电脑打开浏览器即可直接浏览与下载文件。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 目录选择 */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  展示目录
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={rootDir}
                    onChange={(e) => setRootDir(e.target.value)}
                    placeholder="点击右侧「选择目录」或输入本地文件夹路径，例如 /Users/you/Downloads"
                    className="h-9 min-w-[240px] flex-1 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-9 px-3.5 text-xs"
                    onClick={handlePickDir}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    选择目录
                  </Button>
                  {rootDir.trim() && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 px-3 text-xs"
                      title="在访达中打开"
                      onClick={() =>
                        api.openFolderInFinder(rootDir.trim()).catch((e) =>
                          setFeedback({ type: "destructive", text: String(e) })
                        )
                      }
                    >
                      访达打开
                    </Button>
                  )}
                </div>
              </div>

              {/* 端口设置 */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/25 px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-medium text-foreground">
                    监听端口
                  </span>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    className={cn(
                      "h-8 w-24 rounded-md border bg-background px-2.5 font-mono text-xs outline-none focus:border-primary",
                      portValid ? "border-input" : "border-destructive"
                    )}
                  />
                  {!portValid && (
                    <span className="text-[11px] text-destructive">
                      需在 1024 ~ 65535 之间
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">常用：</span>
                  {PORT_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPortInput(String(p))}
                      className={cn(
                        "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer",
                        parsedPort === p
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* 功能开关（支持热生效） */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <ToggleOptionCard
                  icon={<Globe className="h-3.5 w-3.5" />}
                  title="渲染 index.html"
                  desc="存在 index.html 时展示静态网页"
                  checked={serveIndex}
                  onToggle={(v) => handleToggleOption("serveIndex", v)}
                />
                <ToggleOptionCard
                  icon={<Upload className="h-3.5 w-3.5" />}
                  title="允许局域网上传"
                  desc="访客可直接上传文件到当前目录"
                  checked={allowUpload}
                  onToggle={(v) => handleToggleOption("allowUpload", v)}
                />
                <ToggleOptionCard
                  icon={<Eye className="h-3.5 w-3.5" />}
                  title="显示隐藏文件"
                  desc="展示以 . 开头的文件和文件夹"
                  checked={showHidden}
                  onToggle={(v) => handleToggleOption("showHidden", v)}
                />
              </div>
            </CardContent>
          </Card>

          {/* 2. 访问地址与扫码 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Server
                    className={cn(
                      "h-4 w-4",
                      isRunning ? "text-emerald-500" : "text-muted-foreground"
                    )}
                  />
                  <CardTitle className="text-sm">局域网访问入口</CardTitle>
                </div>
                {isRunning && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={handleRefreshStatus}
                  >
                    <RefreshCw className="h-3 w-3" />
                    刷新网卡 IP
                  </Button>
                )}
              </div>
              <CardDescription>
                确保访问设备与本机连接在同一个 Wi-Fi / 局域网下；支持在线预览图片、PDF、音视频（含进度条拖拽）与大文件流式下载。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isRunning && status ? (
                <div className="flex flex-col gap-4 md:flex-row md:items-start">
                  {/* Left: URL list + metadata */}
                  <div className="min-w-0 flex-1 space-y-2.5">
                    {status.urls.map((url, idx) => {
                      const isLocal = url.includes("127.0.0.1");
                      const isSelected = activeQrUrl === url;
                      return (
                        <div
                          key={url}
                          onClick={() => setSelectedQrUrl(url)}
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer",
                            isSelected
                              ? "border-emerald-500/60 bg-emerald-500/5"
                              : "border-border bg-muted/20 hover:bg-muted/40"
                          )}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-mono text-xs font-semibold text-foreground">
                                {url}
                              </span>
                              <Badge
                                variant={idx === 0 && !isLocal ? "success" : "outline"}
                                className="px-1.5 py-0 text-[10px]"
                              >
                                {isLocal ? "本机" : idx === 0 ? "局域网 · 推荐" : "局域网"}
                              </Badge>
                            </div>
                          </div>
                          <div
                            className="flex shrink-0 items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => handleCopyUrl(url)}
                            >
                              {copiedUrl === url ? (
                                <>
                                  <Check className="h-3 w-3 text-emerald-500" />
                                  已复制
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  复制
                                </>
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => api.openExternal(url)}
                            >
                              <ExternalLink className="h-3 w-3" />
                              打开
                            </Button>
                          </div>
                        </div>
                      );
                    })}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/30 px-3.5 py-2 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        目录：
                        <span className="font-mono text-foreground/85">
                          {status.root_dir}
                        </span>
                      </span>
                      {status.started_at && (
                        <span>启动于 {status.started_at}</span>
                      )}
                      <span className="tabular-nums">
                        累计请求 {status.request_count} 次
                      </span>
                    </div>
                  </div>

                  {/* Right: QR Code */}
                  {qrData && activeQrUrl && (
                    <div className="flex shrink-0 flex-col items-center gap-2 rounded-xl border border-border bg-muted/20 p-3.5">
                      <div className="rounded-lg bg-white p-2.5 shadow-2xs">
                        <svg
                          viewBox={`-2 -2 ${qrData.size + 4} ${qrData.size + 4}`}
                          className="h-32 w-32"
                          shapeRendering="crispEdges"
                          aria-label={`QR Code for ${activeQrUrl}`}
                        >
                          <rect
                            x={-2}
                            y={-2}
                            width={qrData.size + 4}
                            height={qrData.size + 4}
                            fill="#ffffff"
                          />
                          <path d={qrData.path} fill="#111827" />
                        </svg>
                      </div>
                      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <QrCode className="h-3 w-3" />
                        <span>手机扫码直接访问</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                  选择上方共享目录并点击右上角「启动服务器」，即可生成局域网访问链接与二维码
                </div>
              )}
            </CardContent>
          </Card>

          {/* 3. 局域网文字快传 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MessageSquareText className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">局域网文字快传</CardTitle>
                  {notes.length > 0 && (
                    <Badge variant="outline" className="tabular-nums">
                      {notes.length} 条
                    </Badge>
                  )}
                </div>
                {notes.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={handleClearNotes}
                  >
                    <Trash2 className="h-3 w-3" />
                    清空
                  </Button>
                )}
              </div>
              <CardDescription>
                与手机、平板或 Windows 浏览器双向实时互传文本、链接与验证码（纯内存暂存，不写磁盘）。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendNote();
                    }
                  }}
                  placeholder="输入文字或链接按回车发送，局域网设备打开网页右上角「快传文本」即可一键复制"
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-primary"
                />
                <Button
                  size="sm"
                  className="h-9 px-3.5 text-xs"
                  disabled={sendingNote || !noteDraft.trim()}
                  onClick={handleSendNote}
                >
                  {sendingNote ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  发送
                </Button>
              </div>

              {notes.length > 0 ? (
                <div className="max-h-52 space-y-2 overflow-y-auto pr-0.5">
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/25 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {n.sender}
                          </span>
                          <span className="tabular-nums">{n.time}</span>
                        </div>
                        <div className="whitespace-pre-wrap break-all text-xs text-foreground">
                          {n.text}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 px-2.5 text-xs"
                        onClick={() => handleCopyNote(n.id, n.text)}
                      >
                        {copiedNoteId === n.id ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-500" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            复制
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
                  暂无快传记录，可在上方输入发送，或在手机网页点击「快传文本」发回本机
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. 实时访问日志 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm">实时访问日志</CardTitle>
                  {logs.length > 0 && (
                    <Badge variant="outline" className="tabular-nums">
                      最近 {logs.length} 条
                    </Badge>
                  )}
                </div>
                {logs.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={handleClearLogs}
                  >
                    <Trash2 className="h-3 w-3" />
                    清空
                  </Button>
                )}
              </div>
              <CardDescription>
                实时记录局域网设备的目录浏览、文件下载与上传请求。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {logs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  暂无访问记录
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto rounded-lg border border-border bg-muted/25 divide-y divide-border/60 font-mono text-[11px]">
                  {logs.map((entry) => {
                    const statusColor =
                      entry.status >= 500
                        ? "text-destructive"
                        : entry.status >= 400
                        ? "text-amber-600 dark:text-amber-400"
                        : entry.status >= 300
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-emerald-600 dark:text-emerald-400";
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/40"
                      >
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {entry.time}
                        </span>
                        <span className="w-28 shrink-0 truncate text-foreground/80">
                          {entry.client_ip}
                        </span>
                        <span className="w-13 shrink-0 font-semibold text-primary">
                          {entry.method}
                        </span>
                        <span className={cn("w-8 shrink-0 font-semibold", statusColor)}>
                          {entry.status}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {entry.path}
                        </span>
                        {entry.detail && (
                          <span className="shrink-0 text-muted-foreground">
                            {entry.detail}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ToggleOptionCard({
  icon,
  title,
  desc,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!checked)}
      className={cn(
        "flex items-start justify-between gap-2.5 rounded-lg border p-3 text-left transition-colors cursor-pointer",
        checked
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-muted/20 hover:bg-muted/35"
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <span className={checked ? "text-primary" : "text-muted-foreground"}>
            {icon}
          </span>
          <span>{title}</span>
        </div>
        <div className="text-[11px] leading-snug text-muted-foreground">
          {desc}
        </div>
      </div>
      <span
        className={cn(
          "mt-0.5 inline-flex h-4.5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-primary" : "bg-muted-foreground/30"
        )}
      >
        <span
          className={cn(
            "h-3.5 w-3.5 rounded-full bg-white shadow-2xs transition-transform",
            checked ? "translate-x-3.5" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}
