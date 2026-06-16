import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-neutral-200 bg-neutral-100 text-neutral-700",
        update: "border-amber-200 bg-amber-100 text-amber-800",
        create: "border-emerald-200 bg-emerald-100 text-emerald-800",
        noop: "border-neutral-200 bg-neutral-100 text-neutral-500",
        skip: "border-rose-200 bg-rose-100 text-rose-700",
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
