export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailSender {
  /** Best-effort, like PushSender — a failed send must never fail the action
   * that triggered it, so callers swallow (and log) rejections. */
  send(message: EmailMessage): Promise<void>;
}

/**
 * Outbound email via Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 * Plain fetch rather than the SDK: one endpoint doesn't justify a dependency.
 *
 * `from` must be on a domain verified in Resend. Resend's shared test sender
 * (onboarding@resend.dev) only delivers to the Resend account owner's own
 * address — real recipients silently never get it.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, ...message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend: HTTP ${res.status} ${await res.text()}`);
  }
}

/** No-op — local dev and tests never send real email. */
export class NullEmailSender implements EmailSender {
  async send(): Promise<void> {}
}
