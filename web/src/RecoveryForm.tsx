import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api } from "./api";
import { ErrorMessage } from "./components";

export function RecoveryForm({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<"contact" | "code" | "password" | "done">("contact");
  const [challengeId, setChallengeId] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      if (step === "contact") {
        const result = await api("/auth/forgot-password", z.object({ challengeId: z.string(), message: z.string() }), null, { contact: form.get("contact") });
        setChallengeId(result.challengeId); setMessage(result.message); setStep("code");
      } else if (step === "code") {
        const result = await api("/auth/verify-recovery-otp", z.object({ resetToken: z.string(), message: z.string() }), null, { challengeId, code: form.get("code") });
        setResetToken(result.resetToken); setMessage(result.message); setStep("password");
      } else {
        if (form.get("password") !== form.get("confirmPassword")) throw new Error("Your passwords do not match. Please enter them again.");
        const result = await api("/auth/reset-password", z.object({ reset: z.literal(true), message: z.string() }), null, { resetToken, password: form.get("password") });
        setResetToken(""); setChallengeId(""); setMessage(result.message); setStep("done");
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "We could not reset your password. Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="panel auth-panel recovery-panel">
    <h1>{step === "done" ? "Password changed" : "Reset your password"}</h1>
    <p className="muted">{step === "contact" ? "Enter the email or phone number you registered with. We'll send a code to your registered phone." : message}</p>
    {step !== "done" && <form onSubmit={submit} key={step}><fieldset disabled={busy}>
      {step === "contact" && <label>Email or phone number<input name="contact" autoComplete="username" required maxLength={254} placeholder="you@example.com or +2348012345678" /></label>}
      {step === "code" && <><label>Six-digit code<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required /></label><p className="fine-print">After three wrong codes, your account is locked for one hour. Asking for a new code does not restart your attempts.</p></>}
      {step === "password" && <><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label><p className="fine-print">Use at least 12 characters. Changing your password signs you out on every device.</p></>}
      <ErrorMessage message={error} /><button type="submit" className="button primary">{busy ? "Please wait..." : step === "contact" ? "Send reset code" : step === "code" ? "Confirm code" : "Change password"}</button>
    </fieldset></form>}
    <button className="text-button" disabled={busy} onClick={onBack}>Back to sign in</button>
    {step === "code" && <button className="text-button" disabled={busy} onClick={() => { setStep("contact"); setError(null); }}>Request another code</button>}
  </section>;
}
