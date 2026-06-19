import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner used by the shadcn-style primitives. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
