import { useRef, useState, type FormEvent } from "react";
import { calculateFloorProtection, evaluateDrift } from "../../src/domain/atp";
import { api, authSchema, challengeSchema, registeredSchema, evaluationSchema, type Evaluation } from "./api";
import { MoneyDecimal as D } from "../../src/domain/money";
import { ErrorMessage, Icon, money } from "./components";
import type { GoalInput } from "./demo";
import { RecoveryForm } from "./RecoveryForm";

function text(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== "string") throw new Error(`Missing ${key}`);
  return value;
}

export function AuthForm({ onAuthenticated, onDemo }: {
  onAuthenticated: (token: string) => void;
  onDemo: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        const result = await api("/auth/verify-otp", authSchema, null, { challengeId: challenge, code: text(form, "code") });
        onAuthenticated(result.accessToken);
        return;
      }
      const body = {
        email: text(form, "email"), password: text(form, "password"),
        ...(register ? {
          firstName: text(form, "firstName"), lastName: text(form, "lastName"),
          phoneNumber: text(form, "phoneNumber"),
          [text(form, "identityType")]: text(form, "identity"),
          riskProfile: {
            maxTolerableLoss: Number(text(form, "maxLoss")) / 100,
            targetReturn: Number(text(form, "targetReturn")) / 100,
            timeHorizonMonths: Number(text(form, "months")),
          },
        } : {}),
      };
      if (register) {
        const result = await api("/auth/register", registeredSchema, null, body, requestKey.current);
        setRegister(false);
        requestKey.current = crypto.randomUUID();
        setMessage(result.message);
      } else {
        const result = await api("/auth/login", challengeSchema, null, body);
        setChallenge(result.challengeId);
        setMessage("Enter the code sent to your registered phone. In development mock mode, check the worker's local console.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }
  if (recovering) return <RecoveryForm onBack={() => { setRecovering(false); setChallenge(null); setMessage(""); setError(null); }} />;
  return <section className="auth-layout">
    <div className="auth-story">
      <span className="eyebrow">THE NEXT CHAPTER OF YOUR MONEY</span>
      <h1>Small steps.<br />Lasting wealth.</h1>
      <p>A little intention goes a long way. Give every naira a purpose with savings that fit your life.</p>
      <div className="story-feature"><Icon name="shield" /> Partner-first. Built with care.</div>
      <button className="button light" onClick={onDemo} disabled={busy}>Explore the demo <Icon name="arrow" /></button>
    </div>
    <div className="panel auth-panel">
      <span className="eyebrow">YOUR INSTANTA ACCOUNT</span>
      <h2>{challenge ? "Verify your device" : register ? "Start your journey" : "Welcome back"}</h2>
      <p className="muted">{register ? "Create your account and request identity verification." : "Sign in to see your real wallet and savings."}</p>
      {!challenge && <div className="segmented" aria-label="Authentication options">
        <button disabled={busy} className={!register ? "selected" : ""} onClick={() => { setRegister(false); setError(null); }}>Sign in</button>
        <button disabled={busy} className={register ? "selected" : ""} onClick={() => { setRegister(true); setError(null); }}>Create account</button>
      </div>}
      {message && <p role="status" className="notice">{message}</p>}
      <form onSubmit={submit} key={`${register}:${challenge}`} onChange={() => { requestKey.current = crypto.randomUUID(); }}>
        <fieldset disabled={busy}>
          {challenge ? <label>Verification code<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required /></label> : <>
          {register && <div className="form-grid">
            <label>First name<input name="firstName" autoComplete="given-name" required maxLength={100} /></label>
            <label>Last name<input name="lastName" autoComplete="family-name" required maxLength={100} /></label>
          </div>}
          <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} minLength={register ? 12 : 1} maxLength={72} required placeholder={register ? "At least 12 characters (max 72 UTF-8 bytes)" : "Your password"} /></label>
          {register && <>
            <label>Mobile number<input name="phoneNumber" type="tel" pattern="\+234[789][0-9]{9}" placeholder="+2348012345678" autoComplete="tel" required /></label>
            <div className="form-grid">
              <label>Identity document<select name="identityType"><option value="bvn">BVN</option><option value="nin">NIN</option></select></label>
              <label>11-digit identity number<input name="identity" inputMode="numeric" pattern="[0-9]{11}" maxLength={11} required autoComplete="off" /></label>
            </div>
            <h3>Your risk budget</h3>
            <div className="form-grid three">
              <label>Max loss (%)<input name="maxLoss" type="number" min="0" max="100" step="0.01" defaultValue="0" required /></label>
              <label>Target return (%)<input name="targetReturn" type="number" min="0" max="1000" step="0.01" defaultValue="0" required /></label>
              <label>Horizon (months)<input name="months" type="number" min="1" max="1200" defaultValue="0" required /></label>
            </div>
            <p className="fine-print">Preferences start at zero. Choose a horizon of at least one month before registering.</p>
            <p className="fine-print">Identity and mobile numbers are encrypted by the API. Development mock verification accepts only BVN/NIN 00000000000; production requires a live identity gateway.</p>
          </>}
          </>}
          <ErrorMessage message={error} />
          <button className="button primary full" type="submit">{busy ? "Please wait..." : challenge ? "Verify code" : register ? "Create account" : "Sign in"}<Icon name="arrow" /></button>
          {!register && !challenge && <button className="text-button" type="button" onClick={() => setRecovering(true)}>Forgot password?</button>}
          {challenge && <button className="text-button" type="button" onClick={() => { setChallenge(null); setMessage(""); setError(null); }}>Start a new sign-in</button>}
        </fieldset>
      </form>
      <p className="fine-print"><Icon name="lock" size={14} /> Access tokens stay in memory. Refreshing signs you out.</p>
    </div>
  </section>;
}

export function GoalForm({ onSave, walletBalance }: {
  onSave: (input: GoalInput, key: string) => Promise<void>;
  walletBalance: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const lockDate = text(form, "lockUntil");
      const endDate = text(form, "endDate");
      if (lockDate && endDate && lockDate > endDate) throw new Error("The end date cannot be before the lock date.");
      await onSave({
        name: text(form, "name").trim(), targetAmount: text(form, "targetAmount"),
        initialAmount: text(form, "initialAmount"), autoSweep: form.get("autoSweep") === "on",
        ...(lockDate ? { lockUntil: new Date(`${lockDate}T23:59:59+01:00`).toISOString() } : {}),
        ...(endDate ? { endDate: new Date(`${endDate}T23:59:59+01:00`).toISOString() } : {}),
      }, requestKey.current);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create your savings goal.");
      setBusy(false);
    }
  }
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return <form onSubmit={submit} onChange={() => { requestKey.current = crypto.randomUUID(); }}>
    <p className="muted">Give your next big thing a little momentum.</p>
    <fieldset disabled={busy}>
      <label>Goal name<input name="name" placeholder="My next big thing" required maxLength={100} /></label>
      <div className="form-grid">
        <label>Target amount (NGN)<input name="targetAmount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></label>
        <label>Initial contribution (NGN)<input name="initialAmount" type="number" min="0" max={walletBalance} step="0.01" defaultValue="0" required /></label>
      </div>
      <p className="fine-print">Available in your wallet: {money(walletBalance)}. Initial funding moves money from your wallet into this goal.</p>
      <div className="form-grid">
        <label>Lock until (optional)<input name="lockUntil" type="date" min={tomorrow} /></label>
        <label>Target date (optional)<input name="endDate" type="date" min={tomorrow} /></label>
      </div>
      <label className="checkbox"><input type="checkbox" name="autoSweep" /> I'd like automatic savings transfers</label>
      <p className="fine-print">We'll save this preference, but automatic transfers are not yet enabled. This version does not support withdrawing from locked goals.</p>
      <ErrorMessage message={error} />
      <button type="submit" className="button primary full">{busy ? "Creating goal..." : "Create savings goal"}<Icon name="plus" /></button>
    </fieldset>
  </form>;
}

export function AtpPanel({ mode, token, onUnauthorized }: {
  mode: "demo" | "live"; token: string | null;
  onUnauthorized: (error: unknown) => void;
}) {
  const [result, setResult] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetTbills, setTargetTbills] = useState(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const principal = Number(text(form, "principal"));
      const tbillActual = Number(text(form, "actual"));
      const tbillTarget = Number(text(form, "target"));
      if (principal <= 0 || Number(text(form, "months")) <= 0) {
        throw new Error("Enter a positive principal and horizon before running a simulation.");
      }
      setTargetTbills(new D(principal).mul(tbillTarget).div(100).toNumber());
      const input = {
        principal, maxLossPercent: Number(text(form, "loss")),
        riskFreeRate: Number(text(form, "rate")) / 100,
        timeHorizonYears: Number(text(form, "months")) / 12,
        portfolio: {
          totalValue: principal,
          holdings: [
            { assetClass: "T-Bills", marketValue: new D(principal).mul(tbillActual).div(100).toNumber() },
            { assetClass: "Equity ETF", marketValue: new D(principal).mul(new D(100).minus(tbillActual)).div(100).toNumber() },
          ],
        },
        targetAllocation: { "T-Bills": tbillTarget / 100, "Equity ETF": (100 - tbillTarget) / 100 },
      };
      if (mode === "demo" && !token) {
        setResult({
          evaluationId: "demo-paper",
          ...calculateFloorProtection(principal, input.maxLossPercent, input.riskFreeRate, input.timeHorizonYears),
          signal: evaluateDrift(input.portfolio, input.targetAllocation),
        });
      } else setResult(await api("/atp/shadow-evaluate", evaluationSchema, token, input));
    } catch (failure) {
      onUnauthorized(failure);
      setError(failure instanceof Error ? failure.message : "Evaluation failed.");
    } finally { setBusy(false); }
  }
  return <div className="atp-layout">
    <section className="panel">
      <div className="section-heading"><div><span className="eyebrow">ATP SHADOW ENGINE</span><h2>Explore the possibilities</h2></div><span className="tag lavender">Paper trading</span></div>
      <p className="muted">Estimate the minimum value you want at the end of your plan (your loss floor), then compare your planned and current investment mix. No orders are placed.</p>
      <form onSubmit={submit} onChange={() => setResult(null)}>
        <fieldset disabled={busy}>
          <label>Principal (NGN)<input name="principal" type="number" min="0" max="1000000000000" step="0.01" defaultValue="0" required /></label>
          <div className="form-grid">
            <label>Maximum loss (%)<input name="loss" type="number" min="0" max="100" step="0.01" defaultValue="0" required /></label>
            <label>Horizon (months)<input name="months" type="number" min="0" max="1200" defaultValue="0" required /></label>
            <label>Annual T-bill yield (%)<input name="rate" type="number" min="0" max="100" step="0.01" defaultValue="0" required /></label>
            <label>Target T-bills (%)<input name="target" type="number" min="0" max="100" step="0.01" defaultValue="0" required /></label>
            <label>Current T-bills (%)<input name="actual" type="number" min="0" max="100" step="0.01" defaultValue="0" required /></label>
            <div className="input-note">The remaining allocation is assigned to Equity ETF.</div>
          </div>
          <ErrorMessage message={error} />
          <button type="submit" className="button primary full">{busy ? "Calculating..." : "Calculate my plan"}<Icon name="chart" /></button>
        </fieldset>
      </form>
    </section>
    <section className="panel result-panel" aria-live="polite">
      <span className="eyebrow">YOUR RISK, IN PERSPECTIVE</span><h2>A plan with a floor</h2>
      {result ? <>
        <div className="result-number"><span>Maturity floor estimate</span><strong>{money(result.floorValue)}</strong></div>
        <div className="result-number small"><span>Minimum T-bill allocation today</span><strong>{money(result.requiredTbills)}</strong></div>
        <div className="notice"><Icon name="shield" /><p>{new D(targetTbills).plus("0.001").gte(result.requiredTbills)
          ? `Your target T-bill amount of ${money(targetTbills)} meets this modeled minimum.`
          : `Your target T-bill amount of ${money(targetTbills)} is ${money(new D(result.requiredTbills).minus(targetTbills).toString())} below the modeled minimum. This allocation does not meet the floor.`}</p></div>
        <div className="divider" />
        <h3>{result.signal.shouldRebalance ? "A rebalance is suggested" : "Your allocation is within range"}</h3>
        <p className="muted">An adjustment is suggested when an asset's share differs from your target by more than 5 percentage points.</p>
        <div className="table-scroll"><table><thead><tr><th>Asset</th><th>Target</th><th>Actual</th><th>Drift</th></tr></thead><tbody>
          {Object.entries(result.signal.targetVsActual).map(([asset, row]) => <tr key={asset}><td>{asset}</td><td>{row.target.toFixed(1)}%</td><td>{row.actual.toFixed(1)}%</td><td>{row.drift.toFixed(1)} pp</td></tr>)}
        </tbody></table></div>
        {result.signal.suggestedTrades.map((trade) => <div className="trade" key={trade.assetClass}><span className={`tag ${trade.side === "BUY" ? "green" : "amber"}`}>{trade.side}</span><span>{trade.assetClass}</span><strong>{money(trade.amount)}</strong></div>)}
        <p className="fine-print">{token ? "Your plan is saved to your account. It is a calculation, not an investment." : "Preview calculation only. Not saved."}</p>
      </> : <div className="result-placeholder"><div className="round-icon"><Icon name="shield" size={36} /></div><strong className="zero-result">{money(0)}</strong><h3>No simulation yet.</h3><p>All assumptions start at zero. Enter a positive principal and horizon to calculate a modeled floor. No trades or transactions have been created.</p></div>}
      <div className="notice"><Icon name="shield" /><p>This is a simulation, not a capital guarantee or investment recommendation. Simple T-bill yield assumes holding to maturity; fees, taxes, reinvestment and partner/default risk are not modeled.</p></div>
    </section>
  </div>;
}
