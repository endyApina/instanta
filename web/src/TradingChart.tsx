import { useEffect, useState } from "react";
import {
  marketCatalogSchema, marketHistorySchema, type MarketProvider, type MarketRange,
  type MarketInstrument, type MarketHistory,
} from "../../src/domain/market-data";
import { api } from "./api";
import { ErrorMessage, Icon, money } from "./components";

const groups = [
  { category: "EQUITY", label: "NGX equities", provider: "NGX" },
  { category: "ETF", label: "NGX ETFs", provider: "NGX" },
  { category: "TREASURY_BILL", label: "Treasury bills / NITTY", provider: "FMDQ" },
  { category: "FGN_BOND", label: "FGN bonds", provider: "FMDQ" },
  { category: "RATE", label: "Macro rates", provider: "FMDQ" },
] as const;

export function TradingChart({ token, onUnauthorized }: {
  token: string | null; onUnauthorized: (error: unknown) => void;
}) {
  const [category, setCategory] = useState<string>("EQUITY");
  const [instruments, setInstruments] = useState<MarketInstrument[]>([]);
  const [symbol, setSymbol] = useState("");
  const [range, setRange] = useState<MarketRange>("1M");
  const [history, setHistory] = useState<MarketHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const provider: MarketProvider = groups.find((group) => group.category === category)!.provider;

  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    setError(null);
    setInstruments([]);
    setSymbol("");
    setHistory(null);
    api(`/markets/instruments?provider=${provider}`, marketCatalogSchema, token)
      .then((catalog) => {
        if (!active) return;
        const matches = catalog.instruments.filter((item) => item.category === category);
        setInstruments(matches);
        setSymbol(matches[0]?.symbol ?? "");
      })
      .catch((failure: unknown) => {
        if (!active) return;
        onUnauthorized(failure);
        setError(failure instanceof Error ? failure.message : "Market catalog could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, provider, category, refresh]);

  useEffect(() => {
    if (!token || !symbol) return;
    let active = true;
    setLoading(true);
    setError(null);
    setHistory(null);
    setSelected(null);
    const query = new URLSearchParams({ provider, symbol, range });
    api(`/markets/history?${query}`, marketHistorySchema, token)
      .then((result) => { if (active) setHistory(result); })
      .catch((failure: unknown) => {
        if (!active) return;
        onUnauthorized(failure);
        setError(failure instanceof Error ? failure.message : "Market history could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, provider, symbol, range, refresh]);

  const points = history?.points ?? [];
  const current = points[selected ?? points.length - 1];
  const unit = history?.unit ?? instruments.find((item) => item.symbol === symbol)?.unit ?? "NGN";
  const format = (value: string | number) => unit === "NGN" ? money(value)
    : `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 4 }).format(Number(value))}${unit === "PERCENT" ? "%" : " / 100 face value"}`;
  const values = points.map((point) => Number(point.value));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = high === low ? Math.max(Math.abs(high) * 0.01, 0.01) : (high - low) * 0.1;
  const minimum = low - padding;
  const maximum = high + padding;
  const times = points.map((point) => Date.parse(point.at));
  const firstTime = times[0] ?? 0;
  const timeSpan = (times[times.length - 1] ?? 0) - firstTime;
  const x = (index: number) => points.length === 1 ? 475 : 85 + (times[index]! - firstTime) / timeSpan * 780;
  const y = (value: number) => 245 - (value - minimum) / (maximum - minimum) * 210;
  const line = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const date = (at: string) => new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(new Date(at));

  return <section className="panel market-panel">
    <div className="section-heading"><div><span className="eyebrow">NIGERIAN MARKETS</span><h2>Market chart</h2></div><span className="tag neutral">{provider} / Read only</span></div>
    <p className="muted">Explore exchange prices and fixed-income fixings. Market data is separate from your wallet; viewing a chart never places an order.</p>
    <div className="market-controls">
      <label>Product<select value={category} onChange={(event) => { setCategory(event.target.value); setSymbol(""); setHistory(null); setInstruments([]); }}>
        {groups.map((group) => <option key={group.category} value={group.category}>{group.label}</option>)}
      </select></label>
      <label>Instrument<select disabled={!instruments.length || loading} value={symbol} onChange={(event) => { setSymbol(event.target.value); setHistory(null); }}>
        {!instruments.length && <option value="">No instruments loaded</option>}
        {instruments.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
      </select></label>
      <div className="market-range" aria-label="Chart date range">
        {(["1M", "3M", "1Y"] as const).map((value) => <button key={value} aria-pressed={range === value} onClick={() => { if (value !== range) { setRange(value); setHistory(null); } }} className={range === value ? "selected" : ""}>{value}</button>)}
      </div>
      <button className="icon-button" disabled={!token || loading} aria-label="Refresh market data" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" /></button>
    </div>
    <ErrorMessage message={error} />
    <div className="market-quote" aria-live="polite">
      <span>{symbol || "No instrument selected"}</span><strong>{current ? format(current.value) : "--"}</strong>
      <small>{current ? `${date(current.at)} / ${history?.frequency === "FIXING" ? "Official fixing" : "Daily close"}` : "No quote available. Missing prices are not zero."}</small>
    </div>
    <div className="market-chart">
      {points.length ? <svg viewBox="0 0 900 300" role="img" aria-label={`${symbol} ${unit === "PERCENT" ? "rate" : "price"} history, ${points.length} observations`}>
        {[0, 1, 2, 3, 4].map((index) => {
          const value = minimum + (maximum - minimum) * index / 4;
          return <g key={index}><line x1="85" x2="865" y1={y(value)} y2={y(value)} className="chart-grid" /><text x="75" y={y(value) + 4} textAnchor="end">{new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2, notation: "compact" }).format(value)}</text></g>;
        })}
        <polyline points={line} fill="none" stroke="#23614c" strokeWidth="2.5" />
        {values.map((value, index) => <circle key={points[index]!.at} cx={x(index)} cy={y(value)} r={selected === index ? 5 : 3} fill="#23614c" />)}
        {current && selected !== null && <line x1={x(selected)} x2={x(selected)} y1="25" y2="250" className="chart-crosshair" />}
        <text x="85" y="285">{date(points[0]!.at)}</text><text x="865" y="285" textAnchor="end">{date(points[points.length - 1]!.at)}</text>
        <rect x="85" y="25" width="780" height="230" fill="transparent" onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const time = firstTime + (event.clientX - bounds.left) / bounds.width * timeSpan;
          setSelected(times.reduce((best, value, index) => Math.abs(value - time) < Math.abs(times[best]! - time) ? index : best, 0));
        }} onPointerLeave={() => setSelected(null)} />
      </svg> : <div className="market-empty" role="status"><Icon name="chart" size={42} /><h3>{loading ? "Loading licensed market data..." : "Your chart is ready for data"}</h3><p>{!token
        ? "Sign in using Live API mode to load your licensed NGX or FMDQ feed. No sample prices or trades are preloaded."
        : error ? "Check the provider configuration or subscription, then refresh. No invented prices are displayed."
          : "No observations are available for this product and period."}</p></div>}
    </div>
    {points.length > 0 && <details className="market-observations"><summary>View recent observations (accessible table)</summary><div className="table-scroll"><table><thead><tr><th>Date (Lagos)</th><th>{unit === "PERCENT" ? "Rate (%)" : unit === "NGN" ? "Close (NGN)" : "Price per 100 face value"}</th></tr></thead><tbody>
      {points.slice(-10).reverse().map((point) => <tr key={point.at}><td>{date(point.at)}</td><td>{format(point.value)}</td></tr>)}
    </tbody></table></div></details>}
    <p className="fine-print">{history ? `Fetched ${new Date(history.fetchedAt).toLocaleString("en-NG")}. ` : ""}NGX charts show historical daily closing prices, not a real-time executable quote. FMDQ yields/fixings are not security prices. Data access and redistribution require the relevant subscription and permissions.</p>
  </section>;
}
