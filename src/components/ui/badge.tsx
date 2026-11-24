import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        warning:
          "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        destructive:
          "border-destructive/20 bg-destructive/10 text-destructive",
        info:
          "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
