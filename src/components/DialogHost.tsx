import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Promise-based modal dialogs (replaces window.prompt/confirm in the
// GitKraken/TortoiseGit surfaces). Any module can `await askText(...)`.

type Field = { name: string; label: string; initial?: string; placeholder?: string; multiline?: boolean };
type Choice = { value: string; label: string; description?: string; danger?: boolean };

type Request =
  | { kind: "text"; title: string; message?: string; fields: Field[]; confirm: string; resolve: (value: Record<string, string> | null) => void }
  | { kind: "confirm"; title: string; message: ReactNode; confirm: string; danger: boolean; resolve: (value: boolean) => void }
  | { kind: "choice"; title: string; message?: string; choices: Choice[]; resolve: (value: string | null) => void };

let enqueue: ((request: Request) => void) | null = null;

export function askText(title: string, label: string, initial = "", options: { message?: string; confirm?: string; placeholder?: string; multiline?: boolean } = {}): Promise<string | null> {
  return askFields(title, [{ name: "value", label, initial, placeholder: options.placeholder, multiline: options.multiline }], options)
    .then((values) => (values ? values.value : null));
}

export function askFields(title: string, fields: Field[], options: { message?: string; confirm?: string } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    if (!enqueue) {
      const values: Record<string, string> = {};
      for (const field of fields) {
        const value = window.prompt(`${title}\n${field.label}`, field.initial ?? "");
        if (value === null) { resolve(null); return; }
        values[field.name] = value;
      }
      resolve(values);
      return;
    }
    enqueue({ kind: "text", title, message: options.message, fields, confirm: options.confirm ?? "OK", resolve });
  });
}

export function askConfirm(title: string, message: ReactNode, options: { confirm?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(window.confirm(`${title}\n${typeof message === "string" ? message : ""}`)); return; }
    enqueue({ kind: "confirm", title, message, confirm: options.confirm ?? "OK", danger: options.danger ?? false, resolve });
  });
}

export function askChoice(title: string, choices: Choice[], message?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(choices[0]?.value ?? null); return; }
    enqueue({ kind: "choice", title, message, choices, resolve });
  });
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInput = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    enqueue = (request) => setQueue((current) => [...current, request]);
    return () => { enqueue = null; };
  }, []);

  const current = queue[0];
  useEffect(() => {
    if (current?.kind === "text") {
      setValues(Object.fromEntries(current.fields.map((field) => [field.name, field.initial ?? ""])));
      requestAnimationFrame(() => { firstInput.current?.focus(); if (firstInput.current instanceof HTMLInputElement) firstInput.current.select(); });
    }
  }, [current]);

  if (!current) return null;
  const finish = () => setQueue((items) => items.slice(1));
  const cancel = () => {
    if (current.kind === "text") current.resolve(null);
    else if (current.kind === "confirm") current.resolve(false);
    else current.resolve(null);
    finish();
  };

  return (
    <div className="ux-modal-backdrop gk-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}>
      <form
        className="ux-dialog gk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        onSubmit={(event) => {
          event.preventDefault();
          if (current.kind === "text") current.resolve(values);
          else if (current.kind === "confirm") current.resolve(true);
          finish();
        }}
      >
        <header><h2>{current.title}</h2></header>
        <div className="ux-dialog-body gk-dialog-body">
          {current.kind !== "text" && current.message && <div className="gk-dialog-message">{current.message}</div>}
          {current.kind === "text" && current.message && <p className="gk-dialog-message">{current.message}</p>}
          {current.kind === "text" && current.fields.map((field, index) => (
            <label key={field.name} className="gk-dialog-field">
              <span>{field.label}</span>
              {field.multiline
                ? <textarea ref={index === 0 ? (el) => { firstInput.current = el; } : undefined} rows={5} value={values[field.name] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))} />
                : <input ref={index === 0 ? (el) => { firstInput.current = el; } : undefined} value={values[field.name] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))} />}
            </label>
          ))}
          {current.kind === "choice" && (
            <div className="gk-choice-list">
              {current.choices.map((choice) => (
                <button key={choice.value} type="button" className={`gk-choice${choice.danger ? " is-danger" : ""}`} onClick={() => { current.resolve(choice.value); finish(); }}>
                  <strong>{choice.label}</strong>
                  {choice.description && <small>{choice.description}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="ux-button" onClick={cancel}>Cancel</button>
          {current.kind !== "choice" && (
            <button type="submit" className={current.kind === "confirm" && current.danger ? "ux-danger-button" : "ux-primary-button"} autoFocus={current.kind === "confirm"}>
              {current.confirm}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
