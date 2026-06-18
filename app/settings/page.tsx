"use client";

import { useState } from "react";
import { SAMPLE_CONFIG } from "@/lib/sample";
import { Switch, Segmented } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { IconBolt, IconLock, IconCheck } from "@/components/icons";

const TABS = [
  { value: "source", label: "Source" },
  { value: "apply", label: "Apply" },
  { value: "matching", label: "Matching" },
  { value: "connection", label: "Connection" },
] as const;
type Tab = (typeof TABS)[number]["value"];

export default function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("source");
  const c = SAMPLE_CONFIG;
  const [dryRun, setDryRun] = useState(c.apply.dryRunByDefault);
  const [scheduled, setScheduled] = useState(c.apply.schedule != null);

  return (
    <div className="page">
      <div className="row between wrap" style={{ gap: 12 }}>
        <Segmented value={tab} onChange={setTab} options={TABS as unknown as { value: Tab; label: string }[]} />
        <button className="btn btn-sm btn-primary" onClick={() => toast({ kind: "ok", title: "Settings saved" })}>
          <IconCheck style={{ width: 15, height: 15 }} /> Save changes
        </button>
      </div>

      {tab === "source" && (
        <Panel title="Source & fetch" sub="How prices are pulled from KicksDB.">
          <Field label="Market"><input className="input" defaultValue={c.source.market} /></Field>
          <Field label="Default delivery type">
            <select className="select" defaultValue={c.source.defaultDeliveryType}>
              <option>standard</option><option>express_standard</option><option>express_expedited</option>
            </select>
          </Field>
          <Field label="Batch chunk size" hint="KicksDB hard cap is 50.">
            <input className="input" type="number" defaultValue={c.source.batchChunkSize} />
          </Field>
          <Field label="Cache TTL" hint="How long a fetched price stays fresh.">
            <div className="input-suffix"><input className="input" type="number" defaultValue={c.source.cacheTtlSeconds} style={{ width: "100%" }} /><span className="suffix">sec</span></div>
          </Field>
        </Panel>
      )}

      {tab === "apply" && (
        <Panel title="Apply behaviour" sub="Guardrails for writing back to the store.">
          <ToggleRow label="Dry run by default" hint="Preview only — never writes prices." on={dryRun} onClick={() => setDryRun((v) => !v)} />
          <ToggleRow label="Run on a schedule" hint={c.apply.schedule ? `cron ${c.apply.schedule.cron}` : "manual only"} on={scheduled} onClick={() => setScheduled((v) => !v)} />
          <Field label="Hold changes above Δ" hint="Larger deltas wait for manual approval.">
            <div className="input-suffix"><input className="input" type="number" defaultValue={c.apply.requireApprovalAboveDeltaPercent} style={{ width: "100%" }} /><span className="suffix">%</span></div>
          </Field>
          <Field label="Concurrency" hint="Parallel parent-product batches.">
            <input className="input" type="number" defaultValue={c.apply.concurrency} />
          </Field>
          <Field label="Woo batch size" hint="Variations per batch call (≤ ~100).">
            <input className="input" type="number" defaultValue={c.apply.wooBatchSize} />
          </Field>
          <Field label="Retry attempts">
            <input className="input" type="number" defaultValue={c.apply.retry.attempts} />
          </Field>
        </Panel>
      )}

      {tab === "matching" && (
        <Panel title="Matching" sub="How StockX variants link to store variations.">
          <Field label="Strategy order" hint="Tried top-to-bottom until one resolves.">
            <div className="row wrap" style={{ gap: 8 }}>
              {c.matching.strategyOrder.map((s, i) => (
                <span key={s} className="badge">{i + 1}. {s}</span>
              ))}
            </div>
          </Field>
          <Field label="SKU template" hint="Convention used by the skuPattern strategy.">
            <input className="input mono" defaultValue={c.matching.skuTemplate} />
          </Field>
        </Panel>
      )}

      {tab === "connection" && (
        <Panel title="Connections" sub="Secrets are injected from your store, never hardcoded.">
          <Field label="KicksDB API key">
            <div className="input-suffix"><input className="input mono" defaultValue={c.connection.kicksDbApiKey} style={{ width: "100%" }} readOnly /><span className="suffix"><IconLock style={{ width: 14, height: 14 }} /></span></div>
          </Field>
          <Field label="WooCommerce base URL"><input className="input mono" defaultValue={c.connection.woo.baseUrl} /></Field>
          <Field label="Consumer key"><input className="input mono" defaultValue={c.connection.woo.consumerKey} readOnly /></Field>
          <Field label="Consumer secret"><input className="input mono" defaultValue={c.connection.woo.consumerSecret} readOnly /></Field>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => toast({ kind: "info", title: "Testing connection…", msg: "Pinging KicksDB and WooCommerce." })}>
              <IconBolt style={{ width: 15, height: 15 }} /> Test connection
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3><span className="sub">{sub}</span></div>
      <div className="card-pad settings-grid">{children}</div>
      <style>{`.settings-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        @media (max-width: 640px){ .settings-grid { grid-template-columns: 1fr; } }`}</style>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function ToggleRow({ label, hint, on, onClick }: { label: string; hint: string; on: boolean; onClick: () => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ gap: 11, padding: "8px 0" }}>
        <Switch on={on} onClick={onClick} />
        <span className="hint">{hint}</span>
      </div>
    </div>
  );
}
