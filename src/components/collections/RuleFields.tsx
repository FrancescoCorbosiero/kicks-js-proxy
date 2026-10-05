"use client";

import * as React from "react";
import {
  CONDITION_FIELDS,
  FIELD_OPS,
  FIELD_VALUE,
  type ConditionField,
  type ConditionOp,
} from "@core/collections";
import { useI18n } from "@/i18n/provider";
import type { CollectionOptions, DraftProblem } from "@/lib/collections/types";
import { blankCondition, conditionProblem, withField, type EditorCondition, type EditorState } from "./editor-model";

/**
 * The rule editor's fields — the category, "all or any", the conditions —
 * drawn by the Hub's page and the Vetrina's sheet alike. Plain HTML controls
 * (native selects, inputs with a datalist for pick-or-type) so the same
 * component feels native on a phone and works with a mouse; `look` gives it
 * each host's skin.
 */

export interface Look {
  label: string;
  hint: string;
  select: string;
  input: string;
  problem: string;
  /** The "all / any" switch: its frame and its two states. */
  segment: string;
  segmentOn: string;
  segmentOff: string;
  /** One condition's frame. */
  row: string;
  /** The small secondary button ("add condition"). */
  add: string;
  /** The remove button on a condition. */
  remove: string;
}

type Words = ReturnType<typeof useI18n>["t"]["collections"]["editor"];

function problemText(p: DraftProblem, e: Words): string {
  switch (p.kind) {
    case "noCategory":
      return e.problems.noCategory;
    case "noConditions":
      return e.problems.noConditions;
    case "badValue":
      return e.problems.badValue;
    case "badOperator":
      return e.problems.badOperator;
    case "readsItself":
      return e.problems.readsItself;
    case "loop":
      return e.problems.loop(p.with.map((n) => `«${n}»`).join(", "));
    case "categoryTaken":
      return e.problems.categoryTaken(p.by);
  }
}

/** The problems that belong to the rule as a whole, not to one condition. */
export function RuleProblems({ problems, look }: { problems: DraftProblem[]; look: Look }) {
  const { t } = useI18n();
  const general = problems.filter((p) => !("index" in p));
  if (general.length === 0) return null;
  return (
    <ul className="space-y-1">
      {general.map((p, i) => (
        <li key={i} className={look.problem}>
          {problemText(p, t.collections.editor)}
        </li>
      ))}
    </ul>
  );
}

/** Which category the rule fills: an existing one, or a new one created on save. */
export function CategoryField({
  state,
  onChange,
  options,
  look,
  /** The category is fixed (the Vetrina's sheet, opened on a rail). */
  fixed,
}: {
  state: EditorState;
  onChange: (next: Partial<EditorState>) => void;
  options: CollectionOptions;
  look: Look;
  fixed?: { name: string };
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  if (fixed) {
    return (
      <div>
        <span className={look.label}>{e.category}</span>
        <div className="text-[15px] font-semibold">{fixed.name}</div>
      </div>
    );
  }
  return (
    <div className="@container space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className={look.label}>{e.category}</span>
        {!state.id && (
          <div className={look.segment}>
            {(["existing", "new"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ categoryMode: mode })}
                className={state.categoryMode === mode ? look.segmentOn : look.segmentOff}
              >
                {mode === "existing" ? e.existing : e.create}
              </button>
            ))}
          </div>
        )}
      </div>
      {state.categoryMode === "existing" ? (
        <select
          aria-label={e.category}
          className={look.select}
          value={state.termId ?? ""}
          onChange={(ev) => onChange({ termId: ev.target.value ? Number(ev.target.value) : null })}
        >
          <option value="">{e.pick}</option>
          {options.categories.map((c) => {
            const taken = c.collectionId != null && c.collectionId !== state.id;
            return (
              <option key={c.id} value={c.id} disabled={taken}>
                {taken ? `${c.path} — ${e.taken}` : c.path}
              </option>
            );
          })}
        </select>
      ) : (
        <div className="grid gap-2 @md:grid-cols-2">
          <label className="block">
            <span className={look.hint}>{e.newName}</span>
            <input
              className={look.input}
              value={state.newName}
              placeholder={e.newNamePlaceholder}
              maxLength={120}
              enterKeyHint="done"
              onChange={(ev) => onChange({ newName: ev.target.value })}
            />
          </label>
          <label className="block">
            <span className={look.hint}>{e.parent}</span>
            <select
              className={look.select}
              value={state.newParent}
              onChange={(ev) => onChange({ newParent: Number(ev.target.value) })}
            >
              <option value={0}>{e.topLevel}</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className={look.hint}>{e.categoryHint}</p>
    </div>
  );
}

/** "Tutte le condizioni / almeno una". */
export function MatchField({
  value,
  onChange,
  look,
}: {
  value: "all" | "any";
  onChange: (value: "all" | "any") => void;
  look: Look;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={look.label}>{e.match}</span>
      <div className={look.segment}>
        {(["all", "any"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={value === m ? look.segmentOn : look.segmentOff}
          >
            {m === "all" ? e.all : e.any}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Every condition, each with its own problem under it, and "add condition". */
export function ConditionsField({
  conditions,
  onChange,
  options,
  problems,
  look,
}: {
  conditions: EditorCondition[];
  onChange: (next: EditorCondition[]) => void;
  options: CollectionOptions;
  problems: DraftProblem[];
  look: Look;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  const set = (key: string, next: EditorCondition) => onChange(conditions.map((c) => (c.key === key ? next : c)));
  return (
    // Laid out by the room it gets, not the screen's: the Vetrina is a phone-wide column on a desktop too.
    <div className="@container space-y-2">
      {conditions.map((c, i) => {
        const problem = conditionProblem(problems, i);
        return (
          <div key={c.key} className={look.row}>
            <ConditionRow condition={c} options={options} look={look} onChange={(next) => set(c.key, next)} />
            <div className="flex items-center justify-between gap-2">
              {problem ? <p className={look.problem}>{problemText(problem, e)}</p> : <span />}
              {conditions.length > 1 && (
                <button
                  type="button"
                  aria-label={e.remove}
                  title={e.remove}
                  className={look.remove}
                  onClick={() => onChange(conditions.filter((x) => x.key !== c.key))}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className={look.add}
        disabled={conditions.length >= 20}
        onClick={() => onChange([...conditions, blankCondition()])}
      >
        + {e.addCondition}
      </button>
    </div>
  );
}

function opLabel(field: ConditionField, op: ConditionOp, e: Words): string {
  return e.yesNo[field]?.[op] ?? e.ops[op] ?? op;
}

function ConditionRow({
  condition: c,
  options,
  look,
  onChange,
}: {
  condition: EditorCondition;
  options: CollectionOptions;
  look: Look;
  onChange: (next: EditorCondition) => void;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  const kind = FIELD_VALUE[c.field];
  return (
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-[minmax(0,11rem)_minmax(0,9rem)_minmax(0,1fr)]">
      <select
        aria-label={e.fields[c.field]}
        className={look.select}
        value={c.field}
        onChange={(ev) => onChange(withField(c, ev.target.value as ConditionField))}
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f} value={f}>
            {e.fields[f] ?? f}
          </option>
        ))}
      </select>
      <select
        aria-label={e.fields[c.field]}
        className={look.select}
        value={c.op}
        onChange={(ev) => onChange({ ...c, op: ev.target.value as ConditionOp })}
      >
        {FIELD_OPS[c.field].map((op) => (
          <option key={op} value={op}>
            {opLabel(c.field, op, e)}
          </option>
        ))}
      </select>
      {kind !== "none" && (
        <div className="col-span-2 @xl:col-span-1">
          <ValueInput condition={c} options={options} look={look} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function ValueInput({
  condition: c,
  options,
  look,
  onChange,
}: {
  condition: EditorCondition;
  options: CollectionOptions;
  look: Look;
  onChange: (next: EditorCondition) => void;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  const listId = React.useId();

  if (c.field === "tag") {
    // Pick or type: a name that is not a tag yet is created when the rule is saved.
    const current = c.value ? (options.tags.find((x) => String(x.id) === c.value)?.name ?? c.label ?? "") : (c.label ?? "");
    const unborn = !c.value && !!c.label?.trim();
    return (
      <div>
        <input
          className={look.input}
          list={listId}
          value={current}
          placeholder={e.placeholders.tag}
          autoCapitalize="none"
          enterKeyHint="done"
          onChange={(ev) => {
            const typed = ev.target.value;
            const found = options.tags.find((x) => sameText(x.name, typed));
            onChange(found ? { ...c, value: String(found.id), label: found.name } : { ...c, value: "", label: typed });
          }}
        />
        <datalist id={listId}>
          {options.tags.map((x) => (
            <option key={x.id} value={x.name} />
          ))}
        </datalist>
        {unborn && <p className={look.hint}>{e.newTag(c.label!.trim())}</p>}
      </div>
    );
  }

  if (c.field === "brand" || c.field === "category") {
    const list = c.field === "brand" ? options.brands : options.categories;
    return (
      <div>
        <select
          aria-label={e.fields[c.field]}
          className={look.select}
          value={c.value}
          onChange={(ev) => {
            const picked = list.find((x) => String(x.id) === ev.target.value);
            onChange({ ...c, value: ev.target.value, label: picked?.path });
          }}
        >
          <option value="">{e.pickTerm}</option>
          {/* A term gone from the store still shows by the name it was saved with. */}
          {c.value && !list.some((x) => String(x.id) === c.value) && (
            <option value={c.value}>{c.label ?? c.value}</option>
          )}
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.path}
            </option>
          ))}
        </select>
        <p className={look.hint}>{c.field === "brand" ? e.withSubBrands : e.withChildren}</p>
      </div>
    );
  }

  if (c.field === "attribute") {
    const attribute = options.attributes.find((a) => a.key === c.attribute);
    return (
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={e.fields.attribute}
          className={look.select}
          value={c.attribute ?? ""}
          onChange={(ev) => {
            const picked = options.attributes.find((a) => a.key === ev.target.value);
            onChange({ ...c, attribute: ev.target.value || undefined, label: picked?.name, value: "" });
          }}
        >
          <option value="">{e.pickAttribute}</option>
          {c.attribute && !attribute && <option value={c.attribute}>{c.label ?? c.attribute}</option>}
          {options.attributes.map((a) => (
            <option key={a.key} value={a.key}>
              {a.name}
            </option>
          ))}
        </select>
        <div>
          <input
            className={look.input}
            list={listId}
            value={c.value}
            placeholder={e.pickOption}
            disabled={!c.attribute}
            enterKeyHint="done"
            onChange={(ev) => onChange({ ...c, value: ev.target.value })}
          />
          <datalist id={listId}>
            {(attribute?.options ?? []).map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          {c.attribute && attribute && attribute.options.length === 0 && <p className={look.hint}>{e.noOptions}</p>}
        </div>
      </div>
    );
  }

  const numeric = c.field === "price" || c.field === "created";
  const suffix = c.field === "price" ? e.currency : c.field === "created" ? e.days : null;
  return (
    <div className="flex items-center gap-2">
      <input
        className={look.input}
        value={c.value}
        inputMode={numeric ? "decimal" : "text"}
        enterKeyHint="done"
        placeholder={e.placeholders[c.field] ?? ""}
        onChange={(ev) => onChange({ ...c, value: ev.target.value })}
      />
      {suffix && <span className={`shrink-0 ${look.hint}`}>{suffix}</span>}
    </div>
  );
}
