import { Fragment, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { wealthSummarySchema } from "../../src/domain/wealth";
import { api } from "./api";
import { ErrorMessage } from "./components";

function amountLabel(value: string) {
  const [whole = "0", fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimals ? `.${decimals}` : ""}`;
}

export function WealthTable({ token, revision, onUnauthorized, onChanged }: {
  token: string | null; revision: number; onUnauthorized: (failure: unknown) => void; onChanged: () => void;
}) {
  const [data, setData] = useState<z.infer<typeof wealthSummarySchema> | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const rebalanceKey = useRef(crypto.randomUUID());
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  useEffect(() => {
    if (!token) return;
    let active = true;
    setError(null);
    api("/wealth/summary", wealthSummarySchema, token).then((result) => { if (active) setData(result); }).catch((failure: unknown) => {
      if (!active) return;
      unauthorized.current(failure);
      setError(failure instanceof Error ? failure.message : "Your holdings could not be loaded.");
    });
    return () => { active = false; };
  }, [token, revision]);
  async function rebalance() {
    setBusy(true); setError(null);
    try {
      const result = await api("/demo/rebalance", z.object({ trades: z.number(), message: z.string() }), token, {}, rebalanceKey.current);
      rebalanceKey.current = crypto.randomUUID();
      setNotice(result.message); onChanged();
    } catch (failure) { unauthorized.current(failure); setError(failure instanceof Error ? failure.message : "The adjustment did not complete."); }
    finally { setBusy(false); }
  }
  return <section className="panel wealth-table">
    <div className="section-heading"><div><span className="eyebrow">ONE VIEW, EVERY ASSET</span><h2>Your wealth</h2></div>
      {data?.demo && <button className="button secondary" disabled={busy} onClick={() => void rebalance()}>{busy ? "Adjusting..." : "Rebalance demo holdings"}</button>}
    </div>
    <p className="muted">Your money, managed to your risk, every day.</p>
    <p className="fine-print">Currencies and real or practice balances stay separate. Holdings show purchase cost, not current sale value. Plans are estimates and are not added to your balances.</p>
    <ErrorMessage message={error} />
    {notice && <p role="status">{notice}</p>}
    <div className="wealth-totals">{data?.totals.map((total) => <div key={`${total.currency}:${total.mode}`}><span>{total.currency} · {total.mode}</span><strong>{amountLabel(total.amount)}</strong></div>)}</div>
    <div className="table-scroll"><table><caption className="sr-only">Cash, savings, investments and portfolio plans. Expand a row for details.</caption>
      <thead><tr><th scope="col">Asset or goal</th><th scope="col">Type</th><th scope="col">Currency</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead>
      <tbody>{data?.rows.map((row) => <Fragment key={row.id}><tr>
        <th scope="row">{row.name}<small className="wealth-mode">{row.mode}</small></th><td>{row.kind}</td><td>{row.currency}</td><td>{amountLabel(row.amount)}</td><td>{row.status.replaceAll("_", " ").toLowerCase()}</td>
        <td><button className="text-button" aria-expanded={open.has(row.id)} aria-controls={`wealth-${row.id}`} onClick={() => setOpen((current) => {
          const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;
        })}>{open.has(row.id) ? "Hide" : "Show"} <span aria-hidden="true">{open.has(row.id) ? "−" : "+"}</span></button></td>
      </tr>{open.has(row.id) && <tr id={`wealth-${row.id}`}><td colSpan={6} className="wealth-detail">
        <p>{row.detail}</p><p><strong>Loss protection:</strong> {row.protection}</p>
        {row.yieldEarned !== null && <p><strong>Interest earned:</strong> {amountLabel(row.yieldEarned)} {row.currency}</p>}
        {row.drift.length > 0 && <><strong>Difference from your target mix</strong><ul>{row.drift.map((item) => <li key={item.asset}>{item.asset}: {item.percentagePoints} percentage points (the gap between planned and actual share).</li>)}</ul></>}
        <h3>Recent activity</h3>{row.history.length ? <ul>{row.history.map((item, index) => <li key={`${item.at}:${index}`}><time dateTime={item.at}>{new Date(item.at).toLocaleString("en-NG")}</time> · {item.description} · {amountLabel(item.amount)} {row.currency}</li>)}</ul> : <p>No recent activity for this item.</p>}
      </td></tr>}</Fragment>)}</tbody>
    </table></div>{!data && !error && <p role="status">Loading your wealth...</p>}
    {data && !data.rows.length && <p>No holdings yet. Create a goal or explore an asset to get started.</p>}
  </section>;
}
