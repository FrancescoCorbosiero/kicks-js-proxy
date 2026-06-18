"use client";

import { useMemo, useState } from "react";
import { SAMPLE_CONFIG } from "@/lib/sample";
import { buildAllPlans, statsFor, type PlanX, type PlanItemX } from "@/lib/engine";
import { money } from "@/lib/format";
import { Delta, ActionBadge, Avatar, Switch, Segmented, Counter } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { IconChevron, IconBolt, IconCheck, IconLock, IconFilter } from "@/components/icons";

type Filter = "all" | "update" | "held" | "create" | "skip";

export default function PlanPage() {
  const toast = useToast();
  const plans = useMemo(() => buildAllPlans(SAMPLE_CONFIG), []);
  const stats = useMemo(() => statsFor(plans), [plans]);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(plans.map((p) => [p.stockxId, true])),
  );
  const [dryRun, setDryRun] = useState(SAMPLE_CONFIG.apply.dryRunByDefault);

  // Selection: actionable items default-selected; held items opt-in.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const p of plans) for (const it of p.items) {
      if ((it.action === "update" || it.action === "create") && !it.held) s.add(it.stockxVariantId);
    }
    return s;
  });

  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);

  const visible = (it: PlanItemX) => {
    if (query && !it.title.toLowerCase().includes(query.toLowerCase()) && !it.sizeLabel.includes(query)) return false;
    if (filter === "all") return true;
    if (filter === "held") return it.held;
    return it.action === filter;
  };

  const filteredPlans = plans
    .map((p) => ({ ...p, items: p.items.filter(visible) }))
    .filter((p) => p.items.length > 0);

  const selectableIds = useMemo(() => {
    const ids: string[] = [];
    for (const p of plans) for (const it of p.items) if (it.action === "update" || it.action === "create") ids.push(it.stockxVariantId);
    return ids;
  }, [plans]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleGroup = (p: PlanX, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const it of p.items) {
        if (it.action === "update" || it.action === "create") on ? n.add(it.stockxVariantId) : n.delete(it.stockxVariantId);
      }
      return n;
    });

  const selectAll = () => setSelected(new Set(selectableIds));
  const clearAll = () => setSelected(new Set());

  const apply = () => {
    if (selected.size === 0) return;
    setApplying(true);
    setProgress(0);
    const total = selected.size;
    let done = 0;
    const timer = setInterval(() => {
      done += Math.max(1, Math.round(total / 18));
      setProgress(Math.min(100, (done / total) * 100));
      if (done >= total) {
        clearInterval(timer);
        setTimeout(() => {
          setApplying(false);
          setProgress(0);
          if (dryRun) {
            toast({ kind: "info", title: "Dry run complete", msg: `${total} changes validated — nothing written to the store.` });
          } else {
            toast({ kind: "ok", title: "Changes applied", msg: `${total} variations updated across ${filteredPlans.length} products.` });
            clearAll();
          }
        }, 320);
      }
    }, 90);
  };

  const heldCount = stats.held;

  return (
    <div className="page" style={{ paddingBottom: 104 }}>
      {/* Toolbar */}
      <div className="card card-pad row between wrap" style={{ gap: 14, position: "sticky", top: 64, zIndex: 12 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${stats.variants}` },
              { value: "update", label: `Updates ${stats.update}` },
              { value: "create", label: `New ${stats.create}` },
              { value: "held", label: `Held ${heldCount}` },
              { value: "skip", label: `Skipped ${stats.skip}` },
            ]}
          />
          <div className="searchbox" style={{ width: 230 }}>
            <IconFilter style={{ width: 15, height: 15 }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter rows…" />
          </div>
        </div>
        <div className="row" style={{ gap: 14 }}>
          <button className="btn btn-sm btn-ghost" onClick={selectAll}>Select all</button>
          <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear</button>
        </div>
      </div>

      {heldCount > 0 && (
        <div className="card card-pad row" style={{ gap: 12, borderColor: "color-mix(in oklab, var(--warn) 30%, var(--line))" }}>
          <span className="toast-ico warn" style={{ background: "color-mix(in oklab, var(--warn) 18%, transparent)", color: "var(--warn)" }}>
            <IconLock style={{ width: 16, height: 16 }} />
          </span>
          <div className="col grow">
            <span style={{ fontWeight: 650 }}>{heldCount} change{heldCount > 1 ? "s" : ""} held for review</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              These exceed the {SAMPLE_CONFIG.apply.requireApprovalAboveDeltaPercent}% delta guardrail and won’t apply unless you opt them in.
            </span>
          </div>
          <button className="btn btn-sm" onClick={() => setFilter("held")}>Review held</button>
        </div>
      )}

      {/* Plan groups */}
      {filteredPlans.map((p) => {
        const groupSelectable = p.items.filter((i) => i.action === "update" || i.action === "create");
        const groupSelected = groupSelectable.filter((i) => selected.has(i.stockxVariantId)).length;
        const allOn = groupSelectable.length > 0 && groupSelected === groupSelectable.length;
        const isOpen = open[p.stockxId];
        return (
          <div className="card" key={p.stockxId}>
            <div className="card-head" style={{ cursor: "pointer" }} onClick={() => setOpen((o) => ({ ...o, [p.stockxId]: !o[p.stockxId] }))}>
              <IconChevron style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s", color: "var(--ink-3)" }} />
              <Avatar label={p.image} />
              <div className="col">
                <h3>{p.title}</h3>
                <span className="sub mono">{p.sku} · {p.currency}</span>
              </div>
              <div className="grow" />
              <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <span className="muted" style={{ fontSize: 12.5 }}>{groupSelected}/{groupSelectable.length} selected</span>
                {groupSelectable.length > 0 && <Switch on={allOn} onClick={() => toggleGroup(p, !allOn)} />}
              </div>
            </div>

            {isOpen && (
              <div className="tablewrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }} />
                      <th>Size</th>
                      <th>Rule</th>
                      <th className="num">Current</th>
                      <th className="num">Proposed</th>
                      <th className="num">Δ</th>
                      <th>Action</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((it) => {
                      const actionable = it.action === "update" || it.action === "create";
                      const isSel = selected.has(it.stockxVariantId);
                      return (
                        <tr key={it.stockxVariantId} style={{ opacity: !actionable ? 0.62 : 1 }}>
                          <td>
                            {actionable ? (
                              <Check on={isSel} held={it.held && !isSel} onClick={() => toggle(it.stockxVariantId)} />
                            ) : null}
                          </td>
                          <td className="mono" style={{ fontWeight: 600 }}>{it.sizeLabel}</td>
                          <td>{it.ruleId ? <span className="badge">{it.ruleId}</span> : <span className="muted">—</span>}</td>
                          <td className="num mono">{money(it.currentPrice, p.currency)}</td>
                          <td className="num mono" style={{ fontWeight: 650 }}>{money(it.proposedPrice, p.currency)}</td>
                          <td className="num"><Delta value={it.deltaPercent} /></td>
                          <td><ActionBadge action={it.action} held={it.held} /></td>
                          <td className="muted" style={{ fontSize: 12 }}>{it.reason ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {filteredPlans.length === 0 && (
        <div className="card card-pad col" style={{ alignItems: "center", gap: 8, padding: 48, textAlign: "center" }}>
          <span className="muted">No rows match this filter.</span>
          <button className="btn btn-sm" onClick={() => { setFilter("all"); setQuery(""); }}>Reset filters</button>
        </div>
      )}

      {/* Sticky apply bar */}
      <div className="apply-bar">
        <div className="apply-inner card">
          <div className="row" style={{ gap: 14 }}>
            <span className="row" style={{ gap: 8 }}>
              <span className="mono" style={{ fontSize: 20, fontWeight: 750 }}><Counter value={selected.size} /></span>
              <span className="muted">change{selected.size === 1 ? "" : "s"} selected</span>
            </span>
            <span className="divider-v" />
            <label className="row" style={{ gap: 9, cursor: "pointer" }}>
              <Switch on={dryRun} onClick={() => setDryRun((d) => !d)} />
              <span style={{ fontWeight: 600 }}>Dry run</span>
              <span className="muted" style={{ fontSize: 12 }}>{dryRun ? "validate only" : "writes to store"}</span>
            </label>
          </div>

          <div className="row" style={{ gap: 12 }}>
            {applying && (
              <div className="row" style={{ gap: 10, minWidth: 160 }}>
                <div className="track grow" style={{ width: 120 }}><span style={{ width: `${progress}%` }} /></div>
                <span className="mono muted" style={{ fontSize: 12.5 }}>{Math.round(progress)}%</span>
              </div>
            )}
            <button
              className={`btn ${dryRun ? "" : "btn-primary"}`}
              disabled={selected.size === 0 || applying}
              onClick={apply}
              style={{ minWidth: 168 }}
            >
              {applying ? <span className="spinner" /> : dryRun ? <IconCheck style={{ width: 16, height: 16 }} /> : <IconBolt style={{ width: 16, height: 16 }} />}
              {applying ? "Working…" : dryRun ? "Validate plan" : `Apply ${selected.size}`}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .apply-bar { position: fixed; left: var(--sb, 248px); right: 0; bottom: 0; padding: 14px 28px; z-index: 14;
          background: linear-gradient(180deg, transparent, var(--bg) 40%); pointer-events: none; transition: left var(--med) var(--ease); }
        .apply-inner { pointer-events: auto; display: flex; align-items: center; justify-content: space-between;
          gap: 16px; padding: 12px 16px; box-shadow: var(--shadow-pop); border-color: var(--line-strong);
          max-width: 1360px; margin: 0 auto; }
        .divider-v { width: 1px; height: 26px; background: var(--line); }
        @media (max-width: 920px){ .apply-bar { left: 0; } .apply-inner { flex-direction: column; align-items: stretch; } }
      `}</style>
    </div>
  );
}

function Check({ on, held, onClick }: { on: boolean; held?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        width: 20, height: 20, borderRadius: 6, display: "grid", placeItems: "center",
        border: `1.5px solid ${on ? "var(--accent)" : held ? "var(--warn)" : "var(--line-strong)"}`,
        background: on ? "var(--accent)" : "transparent",
        color: "var(--accent-ink)", transition: "all .14s var(--ease)",
      }}
    >
      {on && <IconCheck style={{ width: 14, height: 14 }} />}
    </button>
  );
}
