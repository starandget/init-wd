import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AppItem, FeaturedApp, LocalAppCandidate } from "@/types";

export type AppSourceKind = "brew" | "github" | "direct";

export function resolveAppSource(
  app: Pick<AppItem | FeaturedApp, "kind" | "brew_casks" | "brew_formula" | "github_repo">
): AppSourceKind {
  if (
    app.kind === "cask" ||
    app.kind === "formula" ||
    (app.brew_casks && app.brew_casks.length > 0) ||
    !!app.brew_formula
  ) {
    return "brew";
  }
  if (app.kind === "github" || !!app.github_repo) {
    return "github";
  }
  return "direct";
}

export function resolveLocalAppSource(
  local: LocalAppCandidate,
  githubMatchNames?: Set<string>
): AppSourceKind {
  if (local.brew_cask) return "brew";
  if (githubMatchNames) {
    if (
      githubMatchNames.has(local.app_name.toLowerCase()) ||
      githubMatchNames.has(local.name.toLowerCase())
    ) {
      return "github";
    }
  }
  return "direct";
}

const SOURCE_META: Record<
  AppSourceKind,
  {
    label: string;
    title: string;
    variant: "warning" | "info" | "secondary";
  }
> = {
  brew: {
    label: "Brew",
    title: "由 Homebrew 管理安装与更新",
    variant: "warning",
  },
  github: {
    label: "GitHub",
    title: "从 GitHub Releases 下载安装",
    variant: "info",
  },
  direct: {
    label: "官网下载",
    title: "通过官网直接下载安装",
    variant: "secondary",
  },
};

interface SourceBadgeProps {
  source: AppSourceKind;
  label?: string;
  className?: string;
}

export function SourceBadge({ source, label, className }: SourceBadgeProps) {
  const meta = SOURCE_META[source];
  return (
    <Badge
      variant={meta.variant}
      title={meta.title}
      className={cn("shrink-0 px-1.5 py-0 text-[10px] leading-4", className)}
    >
      {label ?? meta.label}
    </Badge>
  );
}
