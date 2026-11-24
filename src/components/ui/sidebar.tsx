import * as React from "react";
import { cn } from "@/lib/utils";

export function SidebarGroup({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col px-2.5 py-1.5", className)}
      {...props}
    />
  );
}

export function SidebarGroupLabel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-6 shrink-0 items-center px-2 text-[11px] font-medium tracking-wide text-sidebar-foreground/55 select-none",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SidebarGroupContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-group-content"
      className={cn(
        "mt-1 w-full rounded-xl border border-sidebar-border/75 bg-card/65 p-1 text-sm shadow-2xs",
        className
      )}
      {...props}
    />
  );
}

export function SidebarMenu({
  className,
  ...props
}: React.HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({
  className,
  ...props
}: React.LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

interface SidebarMenuButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
}

export function SidebarMenuButton({
  isActive = false,
  className,
  ...props
}: SidebarMenuButtonProps) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all outline-none cursor-pointer",
        isActive
          ? "bg-primary/12 text-primary font-semibold before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-1 before:rounded-r-full before:bg-primary"
          : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}

export function SidebarMenuBadge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-md px-1 text-[10.5px] font-medium tabular-nums text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
