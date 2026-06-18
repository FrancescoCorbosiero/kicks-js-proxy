"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowUp, IconArrowDown } from "./icons";
import { pct } from "@/lib/format";

/** Smoothly counts a number up to its target when it enters view / changes. */
export function Counter({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 700,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);
  const from = useRef(0);
  const raf = useRef<number>();

  useEffect(() => {
    const start = performance.now();
    const startVal = from.current;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(startVal + (value - startVal) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value, duration]);

  return (
    <span className="mono">
      {prefix}
      {display.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}

export function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="muted mono">—</span>;
  const cls = Math.abs(value) < 0.05 ? "delta-flat" : value > 0 ? "delta-up" : "delta-down";
  return (
    <span className={`delta ${cls} mono`}>
      {Math.abs(value) < 0.05 ? null : value > 0 ? <IconArrowUp /> : <IconArrowDown />}
      {pct(value)}
    </span>
  );
}

const ACTION_LABEL: Record<string, string> = {
  update: "Update",
  create: "Create",
  noop: "No change",
  skip: "Skip",
};
export function ActionBadge({ action, held }: { action: string; held?: boolean }) {
  if (held) return <span className="badge badge-held"><span className="dot" /> Held</span>;
  return <span className={`badge badge-${action}`}>{ACTION_LABEL[action] ?? action}</span>;
}

export function Avatar({ label }: { label: string }) {
  return <span className="pavatar">{label}</span>;
}

/** Animated mini bar chart. */
export function Bars({ data }: { data: number[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const max = Math.max(...data, 1);
  return (
    <div className="bars">
      {data.map((d, i) => (
        <span
          key={i}
          className="bar"
          style={{
            height: mounted ? `${(d / max) * 100}%` : "4px",
            transitionDelay: `${i * 28}ms`,
          }}
          title={String(d)}
        />
      ))}
    </div>
  );
}

export function Switch({ on, onClick }: { on: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      role="switch"
      aria-checked={on}
      onClick={onClick}
    />
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}
