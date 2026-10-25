import { useEffect, useState } from "react";
import type { DashboardData, GoalSummary } from "../../src/types/dashboard";
import { api, ApiError, dashboardSchema, goalCreatedSchema } from "./api";
import { AtpPanel, AuthForm, GoalForm } from "./forms";
import { dateLabel, ErrorMessage, Icon, Modal, money } from "./components";
import { type GoalInput } from "./demo";
import { MoneyDecimal as D } from "../../src/domain/money";
import { z } from "zod";
import { GlobalMarkets } from "./GlobalMarkets";
import { WealthTable } from "./WealthTable";

type Page = "overview" | "savings" | "activity" | "markets" | "atp" | "account";
const navigation = [
  { id: "overview", label: "Your wealth", icon: "grid" },
  { id: "savings", label: "My savings", icon: "goal" },
  { id: "activity", label: "Wallet & activity", icon: "wallet" },
  { id: "markets", label: "Explore assets", icon: "chart" },
  { id: "atp", label: "Plan your investments", icon: "chart" },
  { id: "account", label: "My account", icon: "user" },
] as const;

export function App() {
  const [mode, setMode] = useState<"demo" | "live">(() => new URLSearchParams(window.location.search).get("mode") === "demo" ? "demo" : "live");
  const [page, setPage] = useState<Page>("overview");
  const [token, setToken] = useState<string | null>(null);
  const [demoEnabled, setDemoEnabled] = useState<boolean | null>(null);
  const [live, setLive] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [funding, setFunding] = useState(false);
  const data = live;
  const [demoCash, setDemoCash] = useState("0");

  useEffect(() => {
    let active = true;
    api("/demo/config", z.object({ enabled: z.boolean() }), null).then((result) => {
      if (!active) return;
      setDemoEnabled(result.enabled);
      if (result.enabled) setMode("demo");
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Could not check this environment."); });
    return () => { active = false; };
  }, [mode]);
  useEffect(() => {
    if (mode !== "demo" || !demoEnabled || token) return;
    let active = true;
    setLoading(true); setError(null);
    let identity = sessionStorage.getItem("instanta-demo-identity");
    if (!identity) {
      identity = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("instanta-demo-identity", identity);
    }
    api("/demo/session", z.object({ accessToken: z.string() }), null, { identity }).then((result) => {
      if (active) setToken(result.accessToken);
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Could not open the demo."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, demoEnabled, token, refresh]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    if (!live) setLoading(true);
    setError(null);
    api("/dashboard", dashboardSchema, token)
      .then((result) => { if (active) setLive(result); })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof ApiError && failure.status === 401) setToken(null);
        setError(failure instanceof Error ? failure.message : "Could not load your account.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, token, refresh]);
  useEffect(() => {
    if (mode !== "demo" || !token) return;
    let active = true;
    api("/wealth/portfolio", z.object({ balances: z.array(z.object({ asset: z.string(), available: z.string() })) }), token)
      .then((result) => { if (active) setDemoCash(result.balances.find((balance) => balance.asset === "NGN")?.available ?? "0"); })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Could not load demo cash."); });
    return () => { active = false; };
  }, [mode, token, refresh]);

  function switchMode(next: "demo" | "live") {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", next);
    window.history.replaceState(null, "", url);
    setMode(next);
    if (next !== mode) setDemoEnabled(null);
    setToken(null);
    setLive(null);
    setError(null);
    setNotice("");
    setLoading(false);
    setCreating(false);
    setFunding(false);
    setPage("overview");
  }
  function checkUnauthorized(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) {
      setToken(null);
      setLive(null);
      setNotice("Your session expired. Please sign in again.");
    }
  }
  async function saveGoal(input: GoalInput, key: string) {
    setSaving(true);
    try {
        await api("/savings/goals", goalCreatedSchema, token, input, key);
        setRefresh((value) => value + 1);
      setCreating(false);
      setPage("savings");
      setNotice(mode === "demo" ? "Demo goal created. No real money was moved." : "Savings goal created. Your balances are being refreshed.");
    } catch (failure) {
      checkUnauthorized(failure);
      throw failure;
    } finally { setSaving(false); }
  }
  function navigate(next: Page) { setPage(next); setNotice(""); }
  async function signOut() {
    try {
      await api("/auth/logout", z.object({ signedOut: z.literal(true) }), token, {});
      switchMode("live");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) switchMode("live");
      else setNotice(failure instanceof Error ? failure.message : "Sign out failed. Please retry.");
    }
  }
  const title = navigation.find((item) => item.id === page)?.label ?? "Overview";
  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="brand" aria-label="Instanta website"><span className="brand-mark">i</span>instanta<span className="brand-dot">.</span></a>
      <span className="sidebar-label">YOUR MONEY SPACE</span>
      <nav aria-label="Main navigation">
        {navigation.map((item) => <button key={item.id} aria-label={item.label} className={page === item.id ? "nav-item active" : "nav-item"} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{page === item.id && <span className="nav-dot" />}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><Icon name="shield" /><h3>Built for your future.</h3><p>Intentional saving.<br />Thoughtful investing.</p></div><span className="version">INSTANTA / PHASE 01</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb">My workspace <span>/</span> <strong>{title}</strong></div>
        <div className="top-actions">
          <a href="/" className="website-link">Back to website <Icon name="arrow" size={16} /></a>
          <div className="mode-switch" aria-label="Data mode">
            <button disabled={saving} aria-pressed={mode === "demo"} className={mode === "demo" ? "selected" : ""} onClick={() => switchMode("demo")}>Demo</button>
            <button disabled={saving} aria-pressed={mode === "live"} className={mode === "live" ? "selected" : ""} onClick={() => switchMode("live")}>Account</button>
          </div>
          {mode === "live" && token && <button className="text-button" disabled={saving} onClick={() => void signOut()}>Sign out</button>}
          <div className="avatar" aria-label={data ? `${data.user.firstName} ${data.user.lastName}` : "Account"}>{data ? `${data.user.firstName[0]}${data.user.lastName[0]}` : <Icon name="user" />}</div>
        </div>
      </header>
      <main>
        <div className={`mode-banner ${mode}`}><span className="status-dot" /><strong>{mode === "demo" ? "Demo Mode — Simulated Live Environment" : "Your account"}</strong><span>{mode === "demo" ? "Virtual funds only. Progress is saved in a separate database. No bank, exchange or AI provider is contacted." : "All your assets in one place. Practice investments remain clearly labeled and separate from real balances."}</span></div>
        {mode === "live" && data?.partnerMode === "MOCK" && <div className="notice" role="status"><Icon name="shield" /><p>Development/staging mock partners are enabled. KYC results and bank details may be simulated. Do not send real money to mock accounts.</p></div>}
        {notice && <div className="success-box" role="status">{notice}<button aria-label="Dismiss notification" onClick={() => setNotice("")}><Icon name="close" size={16} /></button></div>}
        {mode === "demo" && !demoEnabled ? <section className="panel"><h2>{error ? "The demo could not be opened" : "Opening your isolated demo..."}</h2><p>{error ? "Restart the app with npm start or npm run dev. Startup prepares a separate demo database without changing your account." : "Connecting to your virtual account. Real account funds are never used."}</p><ErrorMessage message={error} /><button className="button primary" onClick={() => switchMode("live")}>Back to sign in</button></section> : mode === "live" && !token ? <>
          <ErrorMessage message={error} />
          <AuthForm onDemo={() => switchMode("demo")} onAuthenticated={(value) => { setToken(value); setNotice(""); }} />
        </> : loading ? <section className="panel loading" role="status"><span className="spinner" />Loading your money space...</section>
          : !data ? <section className="panel"><h2>Your account couldn't be loaded</h2><ErrorMessage message={error} /><button className="button primary" onClick={() => setRefresh((value) => value + 1)}>Try again <Icon name="refresh" /></button></section>
          : <>
            <div className="page-heading">
              <div><span className="eyebrow">{page === "overview" ? "A LITTLE PROGRESS, EVERY DAY" : "YOUR MONEY, WITH INTENTION"}</span><h1>{page === "overview" ? `Keep growing, ${data.user.firstName}.` : title}</h1><p>{page === "overview" ? "Big dreams start with the steps you take today." : page === "savings" ? "Make room for the things that matter to you." : page === "activity" ? "A clear view of every movement." : page === "markets" ? "Nigerian and global assets, side by side." : page === "atp" ? "Test your strategy before you commit." : "Your identity and investment preferences."}</p></div>
              <div className="heading-actions">{mode === "live" && <button className="icon-button" aria-label="Refresh account data" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" /></button>}{(page === "overview" || page === "savings") && <button className="button primary" disabled={!data.wallet || data.wallet.status !== "ACTIVE"} onClick={() => setCreating(true)}><Icon name="plus" />Create a goal</button>}</div>
            </div>
            {page === "overview" && <WealthTable token={token} revision={refresh} onUnauthorized={checkUnauthorized} onChanged={() => setRefresh((value) => value + 1)} />}
            {page === "savings" && <>
              <div className="savings-grid">{data.goals.map((goal, index) => <GoalCard key={goal.id} goal={goal} index={index} />)}</div>
              {!data.goals.length && <EmptyState title="Your first goal starts here" text="Create a savings goal and give your money a purpose." />}
              <YieldEstimator />
            </>}
            {page === "activity" && <><WalletDetails data={data} mode={mode} onFund={() => setFunding(true)} /><Activity data={data} /></>}
            {page === "markets" && <GlobalMarkets key={`${mode}:${data.user.id}`} demo={mode === "demo"} token={token} onChanged={() => setRefresh((value) => value + 1)} onUnauthorized={checkUnauthorized} />}
            {page === "atp" && <AtpPanel key={`${mode}:${data.user.id}`} mode={mode} token={token} onUnauthorized={checkUnauthorized} />}
            {page === "account" && <Account data={data} mode={mode} />}
            {creating && <Modal title="Create a savings goal" onClose={() => { if (!saving) setCreating(false); }}><GoalForm walletBalance={mode === "demo" ? demoCash : data.wallet?.balance ?? "0"} onSave={saveGoal} /></Modal>}
            {funding && <Modal title="Fund your wallet" onClose={() => setFunding(false)}><Funding data={data} mode={mode} /></Modal>}
          </>}
        <footer><span>Your money, managed to your risk, every day.</span><span><Icon name="lock" size={13} /> Partner-first infrastructure</span></footer>
      </main>
    </div>
  </div>;
}

function Overview({ data, mode, onPage, onFund }: { data: DashboardData; mode: "demo" | "live"; onPage: (page: Page) => void; onFund: () => void }) {
  const cashDecimal = new D(data.wallet?.balance ?? "0");
  const savingsDecimal = data.goals.reduce((sum, goal) => sum.plus(goal.balance), new D(0));
  const cash = cashDecimal.toNumber();
  const yieldTotal = data.goals.reduce((sum, goal) => sum.plus(goal.yieldAccrued), new D(0)).toString();
  const total = cashDecimal.plus(savingsDecimal).toNumber();
  return <>
    <div className="stats-grid">
      <section className="balance-card"><div className="card-label">Total balance <span className="tag on-dark">{mode === "demo" ? "Sample" : "NGN"}</span></div><div className="balance-amount">{money(cashDecimal.plus(savingsDecimal).toString())}</div><p>One picture. All your possibilities.</p><div className="balance-bottom"><span><span className="tiny-dot" />Wallet + savings</span><Icon name="chart" size={30} /></div></section>
      <section className="panel stat-card"><div className="card-label">Available wallet <span className="mini-icon"><Icon name="wallet" /></span></div><strong>{money(cashDecimal.toString())}</strong><p>Ready for your next move</p><button className="text-link" onClick={onFund}>Fund wallet <Icon name="arrow" size={16} /></button></section>
      <section className="panel stat-card"><div className="card-label">Accrued savings yield <span className="mini-icon lavender"><Icon name="chart" /></span></div><strong>{money(yieldTotal)}</strong><p>{mode === "demo" ? "Illustrative earnings, not real returns" : "Recorded interest accruals"}</p><span className="tag green"><Icon name="goal" size={13} />{data.goals.length} savings goals</span></section>
    </div>
    <div className="overview-middle">
      <section className="panel allocation-panel">
        <div className="section-heading"><div><span className="eyebrow">EVERY NAIRA HAS A PLACE</span><h2>Your money at a glance</h2></div><span className="tag neutral">NGN</span></div>
        <div className="allocation-content">
          <div className="donut" style={{ background: total > 0 ? `conic-gradient(#1e5949 0% ${cash / total * 100}%, #b7cda5 ${cash / total * 100}% 100%)` : "#e7ebe7" }} role="img" aria-label={`Wallet ${money(cashDecimal.toString())}, savings ${money(savingsDecimal.toString())}`}><div><span>YOUR BALANCE</span><strong>{total > 0 ? "100%" : "0%"}</strong><span>working toward you</span></div></div>
          <div className="allocation-legend"><div><span><i className="legend-dot dark" />Cash wallet</span><strong>{money(cashDecimal.toString())}</strong></div><div><span><i className="legend-dot sage" />Goal savings</span><strong>{money(savingsDecimal.toString())}</strong></div><p className="fine-print">Balances are grouped by ledger account. ATP paper portfolios are not included.</p></div>
        </div>
      </section>
      <section className="future-card"><div className="future-top"><span className="tag on-dark">INVEST WITH INTENTION</span><Icon name="chart" size={32} /></div><h2>A little less guesswork.<br />A lot more perspective.</h2><p>Explore how a T-bill allocation could protect a modeled loss floor.</p><button className="button light" onClick={() => onPage("atp")}>Explore ATP simulator <Icon name="arrow" /></button><span className="fine-print">Paper trading only. No investment orders.</span></section>
    </div>
    <div className="section-heading outside"><div><span className="eyebrow">YOUR NEXT BIG THINGS</span><h2>Goals in motion</h2></div><button className="text-link" onClick={() => onPage("savings")}>View all goals <Icon name="arrow" size={16} /></button></div>
    <div className="savings-grid">{data.goals.slice(0, 2).map((goal, index) => <GoalCard goal={goal} index={index} key={goal.id} />)}</div>
    {!data.goals.length && <EmptyState title="A fresh start" text="Use Create a goal to begin saving for something meaningful." />}
    <Activity data={data} compact onView={() => onPage("activity")} />
  </>;
}

function GoalCard({ goal, index }: { goal: GoalSummary; index: number }) {
  const progress = Math.min(100, Number(goal.balance) / Number(goal.targetAmount) * 100);
  return <article className="panel goal-card">
    <div className="section-heading"><span className={`goal-icon ${index % 2 ? "sand" : "sage-bg"}`}><Icon name={index % 2 ? "shield" : "goal"} size={23} /></span><span className={`tag ${goal.status === "LOCKED" ? "lavender" : "green"}`}>{goal.status === "LOCKED" && <Icon name="lock" size={12} />}{goal.status.toLowerCase()}</span></div>
    <h3>{goal.name}</h3><div className="goal-balance">{money(goal.balance)} <span>of {money(goal.targetAmount)}</span></div>
    <progress aria-label={`${goal.name} progress`} value={progress} max={100} /><div className="progress-label"><span>{progress.toFixed(0)}% of your goal</span><span>{dateLabel(goal.endDate)}</span></div>
    <div className="goal-meta"><span><Icon name="clock" size={14} />{goal.lockUntil ? `Locked until ${dateLabel(goal.lockUntil)}` : "Flexible goal"}</span><span>{goal.autoSweep ? "Sweep preference saved" : "Manual funding"}</span></div>
  </article>;
}

function Activity({ data, compact = false, onView }: { data: DashboardData; compact?: boolean; onView?: () => void }) {
  return <section className="panel activity-panel"><div className="section-heading"><div><span className="eyebrow">THE SMALL STEPS ADD UP</span><h2>{compact ? "Recent activity" : "Ledger activity"}</h2></div>{onView && <button className="text-link" onClick={onView}>View activity <Icon name="arrow" size={16} /></button>}</div>
    <p className="fine-print">Individual liability-account lines; transfers can appear as a debit and a credit. Showing {compact ? "the latest 4" : "up to 50 latest"} lines.</p>
    {data.activity.length ? <div className="table-scroll"><table><thead><tr><th>Transaction / account</th><th>Date</th><th>Ledger side</th><th className="align-right">Amount</th></tr></thead><tbody>{data.activity.slice(0, compact ? 4 : 50).map((item) => <tr key={item.id}>
      <td><div className="transaction-title"><span className={`transaction-icon ${item.side === "CREDIT" ? "in" : "out"}`}><Icon name={item.side === "CREDIT" ? "plus" : "arrow"} size={16} /></span><div><strong>{item.description}</strong><small>{item.accountName}</small>{!compact && <small className="journal-id">Journal: {item.journalEntryId}</small>}</div></div></td>
      <td>{dateLabel(item.createdAt)}</td><td><span className={`tag ${item.side === "CREDIT" ? "green" : "neutral"}`}>{item.side.toLowerCase()}</span></td><td className="align-right amount">{item.side === "CREDIT" ? "+" : "-"}{money(item.amount)}</td>
    </tr>)}</tbody></table></div> : <EmptyState title="Nothing here just yet" text="Partner-confirmed deposits and goal transfers will appear here." />}
  </section>;
}

function WalletDetails({ data, mode, onFund }: { data: DashboardData; mode: "demo" | "live"; onFund: () => void }) {
  return <section className="panel wallet-details"><div><span className="eyebrow">YOUR NGN WALLET</span><h2>{money(data.wallet?.balance ?? 0)}</h2><span className="tag green">{data.wallet?.status ?? "Not provisioned"}</span></div><div><p>{mode === "demo" ? "Sample wallet. No bank account is connected." : data.wallet?.virtualAccountNumber ? `${data.wallet.virtualAccountBank ?? "Partner bank"} / ${data.wallet.virtualAccountNumber}` : "Virtual account provisioning is not yet connected."}</p><button className="button primary" onClick={onFund}>Funding details <Icon name="wallet" /></button></div></section>;
}

function Funding({ data, mode }: { data: DashboardData; mode: "demo" | "live" }) {
  if (mode === "demo") return <><div className="notice"><Icon name="wallet" /><p>Your demo wallet starts empty and cannot receive deposits. You can create unfunded goals. Use Live API mode and partner-provisioned bank details for actual funding.</p></div><p className="muted">Available demo balance: <strong>{money(data.wallet?.balance ?? 0)}</strong></p></>;
  return <>{data.wallet?.virtualAccountNumber ? <div className="detail-list"><div><span>Bank</span><strong>{data.wallet.virtualAccountBank ?? "Contact support"}</strong></div><div><span>Account name</span><strong>{data.wallet.virtualAccountName ?? "Not supplied by partner"}</strong></div><div><span>Account number</span><strong>{data.wallet.virtualAccountNumber}</strong></div></div> : <div className="notice"><Icon name="clock" /><p>No virtual bank account has been assigned yet. A configured BaaS partner must provision it before you can fund this wallet.</p></div>}<p className="fine-print">A balance is credited only after a signed partner deposit notification is recorded in the ledger. This UI cannot submit deposits or withdrawals.</p></>;
}

function YieldEstimator() {
  const [amount, setAmount] = useState("0");
  const [rate, setRate] = useState("0");
  const [days, setDays] = useState("0");
  const valid = amount !== "" && rate !== "" && days !== "" && Number(amount) >= 0 && Number(rate) >= 0 && Number(rate) <= 100 && Number(days) >= 0 && Number(days) <= 3650;
  return <section className="panel yield-panel"><div><span className="eyebrow">A LOOK AHEAD</span><h2>What could your savings earn?</h2><p className="muted">Simple interest estimate only. Nothing is accrued or posted.</p></div><div className="form-grid three"><label>Amount (NGN)<input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Annual yield (%)<input type="number" min="0" max="100" value={rate} onChange={(event) => setRate(event.target.value)} /></label><label>Days<input type="number" min="0" max="3650" value={days} onChange={(event) => setDays(event.target.value)} /></label></div><div className="yield-result" aria-live="polite"><span>Estimated interest</span><strong>{valid ? money(new D(amount).mul(rate).div(100).mul(days).div(365).toFixed(2)) : "Enter valid assumptions"}</strong></div><p className="fine-print">Uses amount x annual rate x days / 365. Assumed rates are not offers; taxes, fees and partner risks are excluded.</p></section>;
}

function Account({ data, mode }: { data: DashboardData; mode: "demo" | "live" }) {
  return <div className="account-grid"><section className="panel"><span className="eyebrow">IDENTITY & VERIFICATION</span><h2>{data.user.firstName} {data.user.lastName}</h2><p className="muted">{data.user.email}</p><div className="detail-list">
    <div><span>KYC status</span><span className={`tag ${data.user.kycStatus === "VERIFIED" ? "green" : "amber"}`}>{data.user.kycStatus}</span></div>
    <div><span>Account tier</span><strong>{data.user.kycLevel.replace("_", " ")}</strong></div>
    <div><span>BVN</span><strong>{data.user.bvnLastFour ? `*******${data.user.bvnLastFour}` : "Not supplied"}</strong></div>
    <div><span>NIN</span><strong>{data.user.ninLastFour ? `*******${data.user.ninLastFour}` : "Not supplied"}</strong></div>
    </div><div className="notice"><Icon name="shield" /><p>{mode === "demo" ? "This is a fictional profile for local practice. No identity provider is contacted." : "Your identity-check status is updated by our verification partner. Refresh to see the latest status. Your full identity numbers are never displayed."}</p></div></section>
    <section className="panel"><span className="eyebrow">YOUR INVESTMENT COMPASS</span><h2>Risk budget</h2><div className="detail-list">
      <div><span>Maximum tolerable loss</span><strong>{data.user.maxTolerableLoss === null ? "Not set" : `${Number(data.user.maxTolerableLoss) * 100}%`}</strong></div>
      <div><span>Annual target return</span><strong>{data.user.targetReturn === null ? "Not set" : `${Number(data.user.targetReturn) * 100}%`}</strong></div>
      <div><span>Time horizon</span><strong>{data.user.timeHorizonMonths ? `${data.user.timeHorizonMonths} months` : "Not set"}</strong></div>
    </div><p className="muted">These preferences are collected at registration, not an investment mandate. Simulator assumptions start at zero so you can choose each scenario explicitly.</p><p className="fine-print">Returns are objectives, not promises. The ATP engine is paper-only and does not route money to fund managers.</p></section></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><Icon name="goal" size={30} /><h3>{title}</h3><p>{text}</p></div>;
}
