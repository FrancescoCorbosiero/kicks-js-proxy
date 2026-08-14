"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A pick-or-type field: the dropdown offers what actually exists (with counts),
 * and anything can still be typed by hand.
 *
 * Both halves matter. A plain text input made every scope field a guess — an
 * exactly-matched brand typed as "Adidas" against a catalog spelling "adidas"
 * produced a rule that silently covered nothing. A plain <select> would fix the
 * guessing and lose the ability to name something the catalog has not seen yet
 * (a brand arriving with tomorrow's feed, a SKU being pre-configured). So:
 * options are the truth, free text is the escape hatch, and an entry that
 * matches no option is flagged rather than forbidden.
 */

export interface ComboboxOption {
  value: string;
  /** How many catalog products carry it — shown as the option's right rail. */
  count?: number;
  /** Optional grouping caption rendered above the option. */
  group?: string;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** Shown when the field is empty — i.e. "matches anything". */
  placeholder?: string;
  /** Label for the always-present "no constraint" choice. */
  anyLabel: string;
  /** Text for "use exactly what I typed" when it matches no option. */
  customLabel?: (typed: string) => string;
  /** Message when the filter matches nothing at all. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  anyLabel,
  customLabel,
  emptyLabel,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  // While open the input is a SEARCH box; closed, it displays the value. This
  // is what lets one control be both a picker and a free-text field.
  const shown = open ? query : value;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!open || !q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [open, options, query]);

  // The typed text is worth offering verbatim only when no option already is it.
  const exact = filtered.some((o) => o.value.toLowerCase() === query.trim().toLowerCase());
  const custom = open && query.trim().length > 0 && !exact ? query.trim() : null;

  // Row order: [Any] [custom?] ...options — index arithmetic follows it.
  const rows: { kind: "any" | "custom" | "option"; value: string; option?: ComboboxOption }[] = [
    { kind: "any", value: "" },
    ...(custom ? [{ kind: "custom" as const, value: custom }] : []),
    ...filtered.map((o) => ({ kind: "option" as const, value: o.value, option: o })),
  ];

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function commit(next: string) {
    onChange(next);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + rows.length) % rows.length;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!open) return;
      commit(rows[active]?.value ?? "");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      inputRef.current?.blur();
    }
  }

  // A value the catalog has no product for: legal, but almost always a typo.
  const unmatched =
    value.trim().length > 0 &&
    options.length > 0 &&
    !options.some((o) => o.value.toLowerCase() === value.trim().toLowerCase());

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          disabled={disabled}
          value={shown}
          // Open with nothing typed yet: the field is a search box, so its
          // text is empty — but blanking it would hide the very value being
          // reconsidered. Show it as the placeholder until a query replaces it.
          placeholder={open && value ? value : placeholder}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            "h-8 w-full rounded-md border bg-surface-2 py-1 pl-2 pr-12 text-xs text-ink shadow-xs transition-[border-color,box-shadow] placeholder:text-faint focus-visible:border-accent/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50",
            unmatched ? "border-warn/60" : "border-line",
          )}
        />
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1.5">
          {value && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="✕"
              className="pointer-events-auto rounded p-0.5 text-faint hover:text-skip"
              onMouseDown={(e) => {
                e.preventDefault();
                commit("");
              }}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
          <svg viewBox="0 0 24 24" className="h-3 w-3 text-faint" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full min-w-[13rem] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {rows.map((row, i) => {
            const selected = row.value === value;
            return (
              <li key={`${row.kind}:${row.value}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(row.value);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    i === active ? "bg-accent/12 text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  <span className={cn("min-w-0 flex-1 truncate", selected && "font-semibold text-ink")}>
                    {row.kind === "any" && <span className="text-faint">{anyLabel}</span>}
                    {row.kind === "custom" && (customLabel?.(row.value) ?? `“${row.value}”`)}
                    {row.kind === "option" && row.value}
                  </span>
                  {row.option?.count != null && (
                    <span className="shrink-0 text-[10px] text-faint tnum">{row.option.count}</span>
                  )}
                  {selected && (
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
          {rows.length === 1 && emptyLabel && (
            <li className="px-2 py-1.5 text-xs text-faint">{emptyLabel}</li>
          )}
        </ul>
      )}
    </div>
  );
}
