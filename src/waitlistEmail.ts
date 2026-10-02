import type { EmailMessage } from "./email";

/** Keep in step with pnyx-waitlist/launch.js — the site's countdown target. */
const LAUNCH_DAY = "Monday, 2 November 2026";

/**
 * Sent once, when an address is first added to the waitlist. Table layout and
 * inline styles only: mail clients ignore <style> blocks and most modern CSS.
 * Colours are the app's own tokens (warm neutral, monochrome).
 */
export function waitlistConfirmation(to: string): EmailMessage {
  const text = [
    "PNYX",
    "",
    "You're on the list.",
    "",
    `PNYX opens on ${LAUNCH_DAY}. We'll send you one more email that day, with the download link. Nothing in between.`,
    "",
    "There's no quiz to prepare for. Your type comes from what you react to.",
    "",
    "Everyone should know what everyone really thinks.",
    "",
    "—",
    "You're getting this because this address was added to the PNYX waitlist. If that wasn't you, ignore this email and you won't hear from us again.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>You're on the PNYX waitlist</title>
</head>
<body style="margin:0;padding:0;background:#f2f0ec;">
<div style="display:none;max-height:0;overflow:hidden;">PNYX opens on ${LAUNCH_DAY}. We'll email you once, that day.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f0ec;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr>
          <td style="padding:0 4px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:5px;color:#161513;">PNYX</td>
        </tr>
        <tr>
          <td style="background:#faf9f6;border:1px solid #dcd9d2;border-radius:16px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#161513;">
            <h1 style="margin:0 0 16px;font-size:28px;line-height:1.1;font-weight:600;letter-spacing:-0.5px;color:#161513;">You're on the list.</h1>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#4b4945;">PNYX opens on <strong style="color:#161513;">${LAUNCH_DAY}</strong>. We'll send you one more email that day, with the download link. Nothing in between.</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#4b4945;">There's no quiz to prepare for. Your type comes from what you react to.</p>
            <p style="margin:0;padding-top:20px;border-top:1px solid #e8e5df;font-size:14px;line-height:1.5;color:#67645e;">Everyone should know what everyone really thinks.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#67645e;">You're getting this because this address was added to the PNYX waitlist. If that wasn't you, ignore this email and you won't hear from us again.</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { to, subject: "You're on the PNYX waitlist", html, text };
}
