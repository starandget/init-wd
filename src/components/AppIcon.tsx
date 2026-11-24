import { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";

interface AppIconProps {
  name: string;
  nativeIcon?: string | null;
  iconUrl?: string | null;
  website?: string | null;
  githubRepo?: string | null;
  isFormula?: boolean;
  size?: "xs" | "compact" | "sm" | "md";
}

const GRADIENTS = [
  "from-blue-500 to-cyan-500",
  "from-indigo-500 to-purple-500",
  "from-emerald-500 to-teal-500",
  "from-orange-500 to-amber-500",
  "from-rose-500 to-pink-500",
  "from-sky-500 to-indigo-500",
];

function extractHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch {
    return null;
  }
}

function pickGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return GRADIENTS[hash % GRADIENTS.length];
}

export function AppIcon({
  name,
  nativeIcon,
  iconUrl,
  website,
  githubRepo,
  isFormula = false,
  size = "md",
}: AppIconProps) {
  const sources = useMemo(() => {
    const list: string[] = [];
    if (nativeIcon) list.push(nativeIcon);
    if (iconUrl) list.push(iconUrl);

    const host = extractHost(website);
    if (host && host !== "github.com") {
      list.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
      list.push(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`);
    }

    if (githubRepo && githubRepo.includes("/")) {
      const owner = githubRepo.split("/")[0];
      if (owner) {
        list.push(`https://github.com/${encodeURIComponent(owner)}.png?size=128`);
      }
    }
    return list;
  }, [nativeIcon, iconUrl, website, githubRepo]);

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(0);
  }, [sources]);
  const src = sources[idx];

  const boxClass =
    size === "xs"
      ? "h-5 w-5 rounded-md"
      : size === "compact"
        ? "h-8 w-8 rounded-lg"
        : size === "sm"
          ? "h-9 w-9 rounded-lg"
          : "h-10 w-10 rounded-xl";

  if (src) {
    return (
      <div
        className={`${boxClass} flex shrink-0 items-center justify-center overflow-hidden border border-border bg-muted/60`}
      >
        <img
          src={src}
          alt={name}
          loading="lazy"
          draggable={false}
          className="h-full w-full select-none object-contain p-1"
          onError={() => setIdx((n) => n + 1)}
        />
      </div>
    );
  }

  if (isFormula) {
    return (
      <div
        className={`${boxClass} flex shrink-0 items-center justify-center bg-zinc-800 text-zinc-100 shadow-xs`}
      >
        <Terminal className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div
      className={`${boxClass} flex shrink-0 items-center justify-center bg-gradient-to-br ${pickGradient(
        name
      )} text-xs font-bold text-white shadow-xs`}
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}
