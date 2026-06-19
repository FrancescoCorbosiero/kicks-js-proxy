import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-tight whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-line bg-surface-2 text-muted",
        update: "border-update/25 bg-update/12 text-update",
        create: "border-create/25 bg-create/12 text-create",
        noop: "border-line bg-surface-2 text-faint",
        skip: "border-skip/25 bg-skip/12 text-skip",
        accent: "border-accent/30 bg-accent/15 text-accent-text",
        up: "border-up/25 bg-up/12 text-up",
        down: "border-down/25 bg-down/12 text-down",
        warn: "border-warn/25 bg-warn/12 text-warn",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
