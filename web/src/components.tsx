import { useEffect, useRef, type ReactNode } from "react";
import { MoneyDecimal as D } from "../../src/domain/money";

const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  wallet: "M3 6h16v14H3z M3 6V3h13v3 M15 11h6v5h-6z",
  goal: "M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l9-9 M16 3h5v5",
  chart: "M3 3v18h18 M7 16l4-6 4 3 6-8",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  plus: "M12 5v14 M5 12h14",
  lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4",
  shield: "M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  close: "M6 6l12 12 M18 6 6 18",
  refresh: "M20 7a9 9 0 1 0 1 7 M20 2v6h-6",
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  }} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

export function ErrorMessage({ message }: { message: string | null }) {
  return message ? <div className="error-box" role="alert">{message}</div> : null;
}

export function money(value: number | string): string {
  const amount = new D(value);
  const [whole = "0", fraction = "00"] = amount.abs().toFixed(2).split(".");
  const formatted = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" })
    .formatToParts(BigInt(whole)).map((part) => part.type === "fraction" ? fraction : part.value).join("");
  return amount.isNegative() ? `-${formatted}` : formatted;
}

export function dateLabel(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(new Date(value)) : "Flexible";
}
