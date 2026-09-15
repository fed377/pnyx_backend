import { Resend } from "resend";
import { config } from "./config";

let client: Resend | null = null;

function resend() {
  if (!config.resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured — see .env.example");
  }
  client ??= new Resend(config.resendApiKey);
  return client;
}

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
};

/** Thin wrapper so callers don't need the Resend SDK or its error shape directly. */
export async function sendEmail({ to, subject, html, from }: SendEmailInput) {
  const { data, error } = await resend().emails.send({
    from: from ?? config.emailFrom,
    to,
    subject,
    html,
  });
  if (error) throw new Error(`resend: ${error.message}`);
  return data;
}
