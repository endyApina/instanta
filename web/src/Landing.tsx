import { useState } from "react";
import "./landing.css";

const ArrowIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
    <path d="M4 10h11M10 5l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
    <path d="m4.5 10.5 3.2 3.2 7.8-7.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Brand() {
  return (
    <a className="landing-brand" href="/" aria-label="Instanta home">
      <span className="landing-brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>instanta</span>
    </a>
  );
}

const faqItems = [
  {
    question: "What is Instanta?",
    answer:
      "Instanta is a financial tools platform designed to help you build saving habits, organize money goals and practice investing ideas in a simulator.",
  },
  {
    question: "Can I save in naira?",
    answer:
      "The wallet experience is designed for Nigerian naira (NGN). Availability of wallet and partner services may depend on the feature rollout and your eligibility.",
  },
  {
    question: "What is a locked vault?",
    answer:
      "A locked vault lets you set aside money for a goal and choose a period when you intend not to withdraw it. Review the terms shown in the app before you commit.",
  },
  {
    question: "Does the ATP simulator invest real money?",
    answer:
      "No. The ATP paper simulator is for practice only and uses simulated activity. It does not place live trades or guarantee any outcome.",
  },
  {
    question: "Are partner integrations available now?",
    answer:
      "We are taking a partner-first approach. Some integrations are still in progress, so availability can change and will be clearly shown in the app.",
  },
];

export function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-shell landing-header-inner">
          <Brand />
          <button
            className="landing-menu-toggle"
            type="button"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={menuOpen}
            aria-controls="landing-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
          </button>
          <nav
            className={`landing-nav${menuOpen ? " landing-nav-open" : ""}`}
            id="landing-navigation"
            aria-label="Main navigation"
          >
            <a href="#features" onClick={closeMenu}>What you can do</a>
            <a href="#how-it-works" onClick={closeMenu}>How it works</a>
            <a href="#faq" onClick={closeMenu}>FAQs</a>
            <a className="landing-nav-cta" href="/app" onClick={closeMenu}>
              Open app <ArrowIcon />
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero landing-shell" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <div className="landing-eyebrow">
              <span className="landing-eyebrow-dot" />
              Make room for what matters
            </div>
            <h1 id="landing-title">
              Your money, with <span>a little more</span> intention.
            </h1>
            <p className="landing-hero-description">
              Set goals, build a saving rhythm and explore investing ideas at
              your own pace. A calmer way to make progress, one decision at a
              time.
            </p>
            <div className="landing-hero-actions">
              <a className="landing-button landing-button-primary" href="/app">
                Open app <ArrowIcon />
              </a>
              <a className="landing-button landing-button-secondary" href="/app?mode=live">
                Get started
              </a>
            </div>
            <div className="landing-hero-note">
              <span className="landing-note-icon"><CheckIcon /></span>
              Thoughtful tools. Your choices stay yours.
            </div>
          </div>

          <div className="landing-hero-art" aria-label="Illustration of a savings goal dashboard">
            <div className="landing-art-orbit landing-art-orbit-one" />
            <div className="landing-art-orbit landing-art-orbit-two" />
            <div className="landing-art-spark landing-art-spark-one">✳</div>
            <div className="landing-art-spark landing-art-spark-two">✳</div>
            <div className="landing-savings-card">
              <div className="landing-card-topline">
                <div>
                  <span className="landing-card-kicker">YOUR GOAL</span>
                  <h2>Rainy day fund</h2>
                </div>
                <span className="landing-card-menu" aria-hidden="true">•••</span>
              </div>
              <div className="landing-goal-amount">₦185,000 <span>of ₦250,000</span></div>
              <div className="landing-progress-track" role="img" aria-label="74 percent of goal illustration">
                <span />
              </div>
              <div className="landing-progress-meta">
                <span>74% of your goal</span>
                <span>Illustrative</span>
              </div>
              <div className="landing-card-divider" />
              <div className="landing-card-bottom">
                <span className="landing-calendar-icon" aria-hidden="true">◷</span>
                <span>Small steps add up</span>
                <span className="landing-card-arrow"><ArrowIcon /></span>
              </div>
            </div>
            <div className="landing-floating-note">
              <span className="landing-floating-icon"><CheckIcon /></span>
              <span><strong>One goal at a time</strong><small>Your pace, your plan</small></span>
            </div>
            <div className="landing-art-caption">A clearer view of your next step</div>
          </div>
        </section>

        <section className="landing-proof-strip" aria-label="Instanta principles">
          <div className="landing-shell landing-proof-inner">
            <span>Built for real-life money goals</span>
            <i aria-hidden="true" />
            <span>Practice before you participate</span>
            <i aria-hidden="true" />
            <span>Partner-first, transparent by design</span>
          </div>
        </section>

        <section className="landing-section landing-features landing-shell" id="features">
          <div className="landing-section-heading">
            <p className="landing-section-label">A toolkit for your next move</p>
            <h2>Make your money goals<br />feel more manageable.</h2>
            <p>Useful building blocks to help you plan, save and learn—with no pressure to do it all at once.</p>
          </div>
          <div className="landing-feature-grid">
            <article className="landing-feature-card landing-feature-sage">
              <div className="landing-feature-icon landing-icon-target" aria-hidden="true">
                <svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="16" stroke="currentColor" strokeWidth="1.8"/><circle cx="24" cy="24" r="9" stroke="currentColor" strokeWidth="1.8"/><circle cx="24" cy="24" r="2.5" fill="currentColor"/><path d="m26 22 9-9m0 0v6m0-6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <span className="landing-feature-number">01 / SAVE</span>
              <h3>Goals that feel within reach</h3>
              <p>Give a purpose to your savings with goal-based vaults. Set a target, choose a rhythm and see your progress take shape.</p>
              <a href="/app" className="landing-text-link">Explore saving tools <ArrowIcon /></a>
            </article>
            <article className="landing-feature-card landing-feature-cream">
              <div className="landing-feature-icon landing-icon-wallet" aria-hidden="true">
                <svg viewBox="0 0 48 48" fill="none"><rect x="8" y="13" width="32" height="25" rx="5" stroke="currentColor" strokeWidth="1.8"/><path d="M8 19h32M31 28h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M12 13v-2a3 3 0 0 1 3-3h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </div>
              <span className="landing-feature-number">02 / ORGANIZE</span>
              <h3>Your NGN wallet, at a glance</h3>
              <p>Keep an eye on your naira balance and activity in one simple view, with partner services introduced thoughtfully as they become available.</p>
              <a href="/app" className="landing-text-link">See the wallet <ArrowIcon /></a>
            </article>
            <article className="landing-feature-card landing-feature-lilac">
              <div className="landing-feature-icon landing-icon-chart" aria-hidden="true">
                <svg viewBox="0 0 48 48" fill="none"><path d="M9 38V10m0 28h31" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="m14 30 8-8 6 4 10-12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="38" cy="14" r="2.5" fill="currentColor"/></svg>
              </div>
              <span className="landing-feature-number">03 / LEARN</span>
              <h3>Practice with the ATP simulator</h3>
              <p>Explore ideas in a paper-trading environment. It’s a place to learn and experiment with simulated activity—not live investing.</p>
              <a href="/app" className="landing-text-link">Try the simulator <ArrowIcon /></a>
            </article>
          </div>
          <p className="landing-integration-note">
            <span aria-hidden="true">i</span>
            Instanta is building with partners. Some wallet and saving features may depend on integrations that are still in progress.
          </p>
        </section>

        <section className="landing-how" id="how-it-works">
          <div className="landing-shell landing-how-layout">
            <div className="landing-how-intro">
              <p className="landing-section-label">Start where you are</p>
              <h2>A simple way to<br />get moving.</h2>
              <p>No perfect plan required. Begin with one small step and adjust as life changes.</p>
              <a className="landing-button landing-button-primary" href="/app?mode=live">
                Get started <ArrowIcon />
              </a>
            </div>
            <div className="landing-steps">
              <article className="landing-step">
                <span className="landing-step-index">01</span>
                <div><h3>Choose what matters</h3><p>Name a goal or decide what you want to learn. Start with the thing that feels useful now.</p></div>
              </article>
              <article className="landing-step">
                <span className="landing-step-index">02</span>
                <div><h3>Pick your next small step</h3><p>Set a saving target or explore the simulator with practice activity. You’re always in control of your choices.</p></div>
              </article>
              <article className="landing-step">
                <span className="landing-step-index">03</span>
                <div><h3>Check in and adjust</h3><p>See how you’re getting on, then change your plan when your priorities or circumstances shift.</p></div>
              </article>
            </div>
          </div>
        </section>

        <section className="landing-disclosure landing-shell" aria-labelledby="landing-disclosure-title">
          <div className="landing-disclosure-icon" aria-hidden="true">!</div>
          <div>
            <p className="landing-section-label">A note on risk</p>
            <h2 id="landing-disclosure-title">Stay informed. Make your own call.</h2>
            <p>
              Saving and investing involve different risks. A locked vault may limit access to funds for a period, and investment values can go down as well as up. The ATP simulator is for educational practice only; simulated results do not predict future performance. Review the terms and risks of any partner service before using it.
            </p>
          </div>
        </section>

        <section className="landing-faq landing-section" id="faq">
          <div className="landing-shell landing-faq-layout">
            <div className="landing-faq-intro">
              <p className="landing-section-label">Good to know</p>
              <h2>Questions, answered.</h2>
              <p>Still wondering about something? Start here, then explore the app at your own pace.</p>
              <a className="landing-text-link" href="/app">Open the app <ArrowIcon /></a>
            </div>
            <div className="landing-faq-list">
              {faqItems.map((item) => (
                <details className="landing-faq-item" key={item.question}>
                  <summary>{item.question}<span aria-hidden="true" /></summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-final-cta landing-shell">
          <div className="landing-final-cta-content">
            <span className="landing-final-ornament" aria-hidden="true">✳</span>
            <p className="landing-section-label">Your next step starts here</p>
            <h2>Make progress feel like yours.</h2>
            <p>Explore a more intentional way to save, plan and learn.</p>
            <a className="landing-button landing-button-light" href="/app">
              Open app <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer-inner">
          <Brand />
          <p>Thoughtful tools for your money journey.</p>
          <span>© {new Date().getFullYear()} Instanta</span>
        </div>
        <div className="landing-shell landing-footer-disclaimer">
          Instanta provides tools for saving and learning. Feature and partner availability may vary. Nothing on this page is financial advice or a promise of returns.
        </div>
      </footer>
    </div>
  );
}
