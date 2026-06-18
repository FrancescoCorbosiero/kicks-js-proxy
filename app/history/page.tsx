"use client";

import { useState } from "react";
import { RUN_HISTORY } from "@/lib/sample";
import { compactTime, relTime } from "@/lib/format";
import { Bars } from "@/components/ui";
import { IconCheck, IconWarn, IconPlay, IconPause } from "@/components/icons";

export default function HistoryPage() {
  const [selected, setSelected] = useState<string>(RUN_HISTORY[0].id);
  const run = RUN_HISTORY.find((r) => r.id === selected) ?? RUN_HISTORY[0];
  const bd = [
    { k: "Updated", v: run.updated, c: "var(--info)" },
    { k: "Created", v: run.created, c: "var(--down)" },
    { k: "Skipped", v: run.skipped, c: "var(--ink-3)" },
    { k: "Held", v: run.held, c: "var(--warn)" },
    { k: "Failed", v: run.failed, c: "var(--up)" },
  ];
  const max = Math.max(...bd.map((b) => b.v), 1);

  return (
    <div className="page">
      <div className="two-col" style={{ gridTemplateColumns: "1fr 1.4fr", alignItems: "start" }}>
        {/* Timeline */}
        <div className="card">
          <div className="card-head">
            <h3>Runs</h3>
            <div className="grow" />
            <label className="row" style={{ gap: 8, fontSize: 12.5 }}>
              <span className="badge badge-ok"><span className="dot" /> scheduler on</span>
            </label>
          </div>
          <div className="col">
            {RUN_HISTORY.map((r) => {
              const on = r.id === selected;
              return (
                <button
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className="run-item"
                  data-on={on}
                >
                  <span className={`run-ico ${r.status}`}>
                    {r.status === "ok" ? <IconCheck style={{ width: 15, height: 15 }} /> : <IconWarn style={{ width: 15, height: 15 }} />}
                  </span>
                  <div className="col grow" style={{ alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600 }}>{r.id}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{r.trigger} · {compactTime(r.at)}</span>
                  </div>
                  <div className="col" style={{ alignItems: "flex-end" }}>
                    <span className="mono" style={{ fontWeight: 650 }}>{r.updated}</span>
                    <span className="muted" style={{ fontSize: 11 }}>updated</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="col" style={{ gap: 14 }}>
          <div className="card card-pad">
            <div className="row between">
              <div className="col">
                <span className="row" style={{ gap: 10 }}>
                  <h2 style={{ fontSize: 20, fontWeight: 750, letterSpacing: "-.02em" }}>{run.id}</h2>
                  <span className={`badge badge-${run.status === "ok" ? "ok" : "warn"}`}>
                    <span className="dot" /> {run.status === "ok" ? "completed" : "completed with warnings"}
                  </span>
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>{run.trigger} run · {relTime(run.at)} · {run.scanned} variants scanned</span>
              </div>
              <div className="segmented">
                <button className="on"><IconPlay style={{ width: 14, height: 14 }} /></button>
                <button><IconPause style={{ width: 14, height: 14 }} /></button>
              </div>
            </div>

            <div className="bars" style={{ height: 120, marginTop: 20, alignItems: "flex-end" }}>
              {bd.map((b) => (
                <div key={b.k} className="col" style={{ flex: 1, alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                  <span className="mono" style={{ fontWeight: 700 }}>{b.v}</span>
                  <span style={{ width: "62%", height: `${(b.v / max) * 80 + 6}px`, background: b.c, borderRadius: "5px 5px 2px 2px", transition: "height .5s var(--ease)" }} />
                  <span className="muted" style={{ fontSize: 11.5 }}>{b.k}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="stat-grid">
            <Mini k="Success rate" v={`${(((run.scanned - run.failed) / run.scanned) * 100).toFixed(1)}%`} />
            <Mini k="Apply yield" v={`${(((run.updated + run.created) / run.scanned) * 100).toFixed(0)}%`} />
            <Mini k="Held ratio" v={`${((run.held / run.scanned) * 100).toFixed(1)}%`} />
            <Mini k="Failures" v={String(run.failed)} bad={run.failed > 0} />
          </div>

          <div className="card">
            <div className="card-head"><h3>Updates per run</h3><span className="sub">trend</span></div>
            <div className="card-pad">
              <Bars data={[...RUN_HISTORY].reverse().map((r) => r.updated)} />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .run-item { display: flex; align-items: center; gap: 12px; padding: 13px 18px; text-align: left;
          border-bottom: 1px solid var(--line); border-left: 3px solid transparent; transition: background .14s var(--ease), border-color .14s; }
        .run-item:hover { background: var(--surface-hover); }
        .run-item[data-on="true"] { background: color-mix(in oklab, var(--accent) 9%, transparent); border-left-color: var(--accent); }
        .run-ico { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; flex: none; }
        .run-ico.ok { background: color-mix(in oklab, var(--down) 16%, transparent); color: var(--down); }
        .run-ico.warn { background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn); }
      `}</style>
    </div>
  );
}

function Mini({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-top">{k}</div>
      <div className="stat-val mono" style={{ color: bad ? "var(--up)" : undefined, fontSize: 24 }}>{v}</div>
    </div>
  );
}
