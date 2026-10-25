import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { api, apiBase, ApiError, browserDeviceId } from "./api";
import { ErrorMessage, Icon } from "./components";
import {
  globalAsset, globalEventSchema, globalSnapshotSchema,
  riskScoreSchema, sizeLossBoundedPosition, type GlobalInstrument, type GlobalRiskScore,
} from "../../src/domain/perpetuals";
import { wealthProductsSchema } from "../../src/domain/wealth";
import { marketHistorySchema } from "../../src/domain/market-data";

type Snapshot = z.infer<typeof globalSnapshotSchema>;
const empty: Snapshot = {
  executionMode: "PAPER_ONLY",
  balances: ["USD", "USDT", "USDC"].map((asset) => ({ asset: globalAsset.parse(asset), available: "0.00000000" })),
  positions: [], orders: [],
};
const fillSchema = z.object({ orderId: z.string(), executionMode: z.literal("PAPER_ONLY"), simulated: z.literal(true) });
const creditSchema = z.object({ journalId: z.string(), simulated: z.literal(true) });
const previewSchema = z.object({ price: z.string(), risk: riskScoreSchema });
const quoteSchema = z.object({ lastPrice: z.string().regex(/^\d+(\.\d+)?$/) });

export function GlobalMarkets({ token, onUnauthorized, demo, onChanged }: { token: string | null; onUnauthorized: (failure: unknown) => void; demo: boolean; onChanged: () => void }) {
  const [products, setProducts] = useState<z.infer<typeof wealthProductsSchema>["products"]>([]);
  const [unavailable, setUnavailable] = useState<z.infer<typeof wealthProductsSchema>["unavailable"]>([]);
  const [productId, setProductId] = useState("");
  const [portfolio, setPortfolio] = useState<Snapshot>(empty);
  const [simulated, setSimulated] = useState(true);
  const [points, setPoints] = useState<{ at: string; price: string }[]>([]);
  const [feedStatus, setFeedStatus] = useState("Not connected");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [risk, setRisk] = useState<GlobalRiskScore | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [limitPrice, setLimitPrice] = useState("0");
  const [qty, setQty] = useState("0");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [acknowledged, setAcknowledged] = useState(false);
  const [scenario, setScenario] = useState<ReturnType<typeof sizeLossBoundedPosition> | null>(null);
  const orderKey = useRef(crypto.randomUUID());
  const fundKey = useRef(crypto.randomUUID());
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const product = products.find((item) => item.id === productId);
  const symbol = product?.symbol ?? "";
  const source = product?.source;
  const selected = product?.instrument;
  const tradable = selected && ["SPOT", "SECURITY"].includes(selected.kind) && selected.mode === "ORDER_BOOK";
  const latest = points[points.length - 1];

  useEffect(() => {
    if (!token) return;
    let active = true;
    setError(null);
    Promise.all([
      api("/wealth/products", wealthProductsSchema, token),
      api("/wealth/portfolio", globalSnapshotSchema, token),
    ]).then(([catalog, snapshot]) => {
      if (!active) return;
      setProducts(catalog.products);
      setUnavailable(catalog.unavailable);
      setProductId((current) => catalog.products.some((item) => item.id === current) ? current : catalog.products[0]?.id ?? "");
      setPortfolio(snapshot);
    }).catch((failure: unknown) => {
      if (!active) return;
      unauthorized.current(failure);
      setError(failure instanceof Error ? failure.message : "Global workspace could not load");
    });
    return () => { active = false; };
  }, [token, revision]);

  useEffect(() => {
    setPoints([]);
    setRisk(null);
    setLimitPrice("0");
    setQty("0");
    setAcknowledged(false);
    orderKey.current = crypto.randomUUID();
    if (!token || !symbol) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    const connect = () => {
      if (stopped) return;
      setFeedStatus("Connecting");
      let lastQuote = Date.now();
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${apiBase()}/markets/stream`);
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ op: "auth", token, deviceId: browserDeviceId() }));
      ws.onmessage = (message) => {
        let payload: unknown;
        try { payload = JSON.parse(String(message.data)); }
        catch { setError("Invalid market stream response"); ws.close(); return; }
        const frame = z.object({ type: z.string(), event: z.unknown().optional(), message: z.string().optional(), code: z.string().optional() }).safeParse(payload);
        if (!frame.success) return;
        if (frame.data.type === "authenticated") {
          ws.send(JSON.stringify(source === "NGX" || source === "FMDQ"
            ? { op: "subscribe", region: "LOCAL", provider: source, symbol, range: "1M" }
            : { op: "subscribe", region: "GLOBAL", symbol }));
        } else if (frame.data.type === "error") {
          if (["UNAUTHORIZED", "MFA_REQUIRED"].includes(frame.data.code ?? "")) {
            unauthorized.current(new ApiError(401, frame.data.message ?? "Stream authentication expired"));
          }
          setError(frame.data.message ?? "Global stream unavailable");
          setPoints([]);
          setFeedStatus("Unavailable");
        } else if (frame.data.type === "market") {
          const event = globalEventSchema.safeParse(frame.data.event);
          if (!event.success || event.data.symbol !== symbol) return;
          if (event.data.region === "LOCAL" && event.data.channel === "history") {
            const history = marketHistorySchema.safeParse(event.data.data);
            if (!history.success) { setError("The market history could not be read."); return; }
            lastQuote = Date.now(); attempts = 0; setSimulated(event.data.simulated);
            setFeedStatus(`${source} daily observations`);
            setPoints(history.data.points.map((point) => ({ at: point.at, price: point.value })));
          }
          if (event.data.channel === "status") {
            setPoints([]);
            setFeedStatus("Reconnecting / snapshot reset");
          }
          if (event.data.channel === "quotes") {
            const quote = quoteSchema.safeParse(event.data.data);
            if (!quote.success || !Number.isFinite(Number(quote.data.lastPrice))) { setPoints([]); setFeedStatus("Invalid quote"); return; }
            lastQuote = Date.now();
            attempts = 0;
            setSimulated(event.data.simulated);
            setFeedStatus(event.data.simulated ? "SIMULATED feed" : "Venue public feed");
            setPoints((current) => [...current, { at: event.data.receivedAt, price: quote.data.lastPrice }].slice(-120));
          }
        }
      };
      ws.onerror = () => { setFeedStatus("Connection failed"); setPoints([]); };
      ws.onclose = (event) => {
        setPoints([]);
        if (watchdog) clearInterval(watchdog);
        if (stopped) return;
        if (event.code === 1008) { setError("Stream authentication expired. Sign in again."); setFeedStatus("Authentication required"); return; }
        setFeedStatus("Reconnecting");
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
      };
      watchdog = setInterval(() => {
        if (Date.now() - lastQuote > (source === "NGX" || source === "FMDQ" ? 90_000 : 30_000)) { setPoints([]); setFeedStatus("Waiting for fresh prices"); }
      }, 5000);
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (watchdog) clearInterval(watchdog);
      socket?.close();
    };
  }, [token, symbol, source]);

  function fail(failure: unknown) {
    unauthorized.current(failure);
    setError(failure instanceof Error ? failure.message : "Global action failed");
  }
  async function fund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(null); setNotice("");
    try {
      await api("/wealth/paper/fund", creditSchema, token,
        { asset: form.get("asset"), amount: form.get("amount") }, fundKey.current);
      fundKey.current = crypto.randomUUID();
      setRevision((current) => current + 1);
      onChanged();
      setNotice("Paper credit recorded. No real money, stablecoin transfer or NGN conversion occurred.");
    } catch (failure) { fail(failure); }
    finally { setBusy(false); }
  }
  async function trade(preview: boolean) {
    setBusy(true); setError(null); setNotice("");
    const input = { symbol, side, qty, limitPrice, acknowledgeHighRisk: acknowledged };
    try {
      if (preview) setRisk((await api("/wealth/risk-preview", previewSchema, token, input)).risk);
      else {
        await api("/wealth/paper/orders", fillSchema, token, input, orderKey.current);
        orderKey.current = crypto.randomUUID();
        setRevision((current) => current + 1);
        onChanged();
        setRisk(null);
        setAcknowledged(false);
        setNotice("Paper fill recorded. This is not an exchange execution.");
      }
    } catch (failure) { fail(failure); }
    finally { setBusy(false); }
  }

  const prices = points.map((point) => Number(point.price));
  const minimum = prices.length ? Math.min(...prices) : 0;
  const maximum = prices.length ? Math.max(...prices) : 0;
  const span = maximum - minimum || 1;
  return <div className="global-workspace">
    <div className="notice"><Icon name="shield" /><p><strong>{demo ? "Practice with virtual funds." : "Explore assets worldwide."}</strong> Nigerian shares, Treasury bills, funds and global assets share one list. Each keeps its own currency. Trading here is simulated, not an exchange order. Listed Nigerian live feeds are view-only until a certified execution partner is connected.</p></div>
    <ErrorMessage message={error} />
    {notice && <div className="success-box" role="status">{notice}</div>}
    {unavailable.map((item) => <div className="notice" role="status" key={item.source}><p>{item.source} is unavailable: {item.message} Other available assets are shown below.</p></div>)}
    <section className="panel market-panel">
      <div className="section-heading"><h2>Explore assets</h2><span className={`tag ${simulated ? "amber" : "green"}`}>{simulated ? "Simulated prices" : "Market data"}</span></div>
      <label>Choose an asset<select value={productId} disabled={!products.length || busy} onChange={(event) => setProductId(event.target.value)}>
        {!products.length && <option value="">No assets available</option>}
        {products.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.currency} / {item.category}</option>)}
      </select></label>
      <div className="market-quote"><span>{feedStatus}</span><strong>{latest ? `${latest.price} ${product?.currency ?? ""}` : "--"}</strong><small>{latest ? new Date(latest.at).toLocaleString("en-NG") : "Waiting for a price."}</small></div>
      <div className="market-chart">{points.length ? <svg viewBox="0 0 900 260" role="img" aria-label={`${symbol} ${simulated ? "simulated" : "venue"} price stream`}>
        <text x="15" y="20">{maximum.toFixed(4)}</text><text x="15" y="245">{minimum.toFixed(4)}</text>
        <polyline fill="none" stroke="#23614c" strokeWidth="2.5" points={prices.map((price, index) =>
          `${100 + index / Math.max(1, prices.length - 1) * 780},${225 - (price - minimum) / span * 190}`).join(" ")} />
        {prices.length === 1 && <circle cx="100" cy="225" r="4" fill="#23614c" />}
      </svg> : <div className="market-empty"><Icon name="chart" size={36} /><h3>No market observations yet</h3><p>Global prices are streamed separately from your balances. Simulated prices are always labeled.</p></div>}</div>
      <p className="fine-print">Treasury bills are short-term government loans. A money market fund pools savings into short-term investments. ETFs are baskets of investments. A tokenized share is a digital product linked to a company, not necessarily direct ownership of its shares. Prices shown do not promise a sale at that price.</p>
      {points.length > 0 && <details><summary>Show price observations</summary><div className="table-scroll"><table><thead><tr><th>Time</th><th>Price or rate</th></tr></thead><tbody>{points.map((point, index) => <tr key={`${point.at}:${index}`}><td>{new Date(point.at).toLocaleString("en-NG")}</td><td>{point.price} {product?.currency}</td></tr>)}</tbody></table></div></details>}
    </section>
    <div className="global-action-grid">
      {!demo && <section className="panel"><h2>Add practice funds</h2><p className="muted">Virtual credit only. It cannot be withdrawn or converted to real money.</p>
        <form onSubmit={fund} onChange={() => { fundKey.current = crypto.randomUUID(); }}>
          <fieldset disabled={!token || busy}>
            <label>Paper settlement asset<select name="asset"><option>USDT</option><option>USD</option><option>USDC</option></select></label>
            <label>Paper credit amount<input name="amount" type="number" min="0.00000001" max="1000000" step="0.00000001" defaultValue="0" required /></label>
            <button className="button secondary" type="submit">Add simulated credit</button>
          </fieldset>
        </form>
      </section>}
      <section className="panel"><h2>Try a practice trade</h2><p className="muted">Buy with available virtual cash or sell units you already hold. No borrowing, real orders or simulated fees.</p>
        {!tradable && <div className="notice"><p>{!selected ? "Prices for this asset are available to view. Trading is not connected." : selected.kind === "BARRIER" ? "This contract needs verified fees, expiry and loss limits. Trading is not enabled." : "This product can require extra collateral or forced sales. It is view-only; no loss limit is promised."}</p></div>}
        <form onSubmit={(event) => { event.preventDefault(); void trade(false); }} onChange={() => { orderKey.current = crypto.randomUUID(); setRisk(null); }}>
          <fieldset disabled={!token || busy || !tradable}>
            <label>Action<select value={side} onChange={(event) => setSide(event.target.value === "SELL" ? "SELL" : "BUY")}><option value="BUY">Buy</option><option value="SELL">Sell</option></select></label>
            <div className="form-grid"><label>Quantity<input type="number" min={selected?.minQty ?? "0"} step={selected?.qtyStep ?? "any"} value={qty} onChange={(event) => setQty(event.target.value)} required /></label>
              <label>Price limit<input type="number" min="0" step={selected?.tickSize ?? "any"} value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} required /></label></div>
            <p className="fine-print">Your price limit is the most you'll pay when buying or the least you'll accept when selling. No trade is recorded if the sample price falls outside it.</p>
            <button className="text-button" type="button" disabled={!latest} onClick={() => { setLimitPrice(latest!.price); orderKey.current = crypto.randomUUID(); setRisk(null); }}>Use displayed price</button>
            <label className="checkbox"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand the risk may be unknown and this trade uses virtual funds only.</label>
            <div className="global-order-actions"><button className="button secondary" type="button" onClick={() => void trade(true)}>Check risk</button><button className="button primary" type="submit">Try trade</button></div>
          </fieldset>
        </form>
        {risk && <div className="notice" role="status"><p>{risk.warning}<br />Loss probability: {risk.lossProbability === null ? "Unavailable (not estimated)" : `${(risk.lossProbability * 100).toFixed(2)}%`}. Win probability: {risk.winProbability === null ? "Unavailable" : `${(risk.winProbability * 100).toFixed(2)}%`}. Model output is not a loss guarantee.</p></div>}
      </section>
    </div>
    <details className="panel"><summary>Advanced: estimate a contract's maximum cost</summary><p className="muted">A premium is the upfront cost of a contract. Use this only for a contract whose verified terms limit losses to that cost plus fees. A stop-loss order does not guarantee a maximum loss. This estimate places no order and does not verify a product's terms.</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setError(null);
        const form = new FormData(event.currentTarget);
        try { setScenario(sizeLossBoundedPosition({
          principal: String(form.get("principal")), maxLossFraction: String(form.get("fraction")),
          unitPremium: String(form.get("premium")), fees: String(form.get("fees")), qtyStep: String(form.get("step")),
        })); } catch (failure) { setScenario(null); fail(failure); }
      }} onChange={() => setScenario(null)}>
        <div className="form-grid three">{[
          ["principal", "Paper principal", "0.00000001"], ["fraction", "Max-loss fraction (0..1)", "0.00000001"],
          ["premium", "Premium per contract unit", "0.00000001"], ["fees", "Total worst-case fees", "0.00000001"],
          ["step", "Contract quantity step", "0.00000001"],
        ].map(([name, label, step]) => <label key={name}>{label}<input name={name} type="number" min="0" step={step} defaultValue="0" required /></label>)}</div>
        <button className="button secondary" type="submit">Calculate scenario</button>
      </form>
      <p className="yield-result" aria-live="polite">Quantity: {scenario?.qty ?? "0"} / Maximum premium + fees loss: {scenario?.maximumLoss ?? "0"}</p>
    </details>
    <p className="fine-print">All holdings, savings and activity details appear together in Your wealth. Available practice balances: {portfolio.balances.map((balance) => `${balance.available} ${balance.asset}`).join(" · ")}.</p>
  </div>;
}
