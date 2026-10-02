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
    `PNYX comes out on ${LAUNCH_DAY}. We'll send you one more email that day with the download link.`,
    "",
    "In the app you watch short videos and photos and like or dislike them. From what you react to, it works out your personality and shows you who thinks like you.",
    "",
    "--",
    "You got this email because this address was added to the PNYX waitlist. If that wasn't you, you can ignore it and we won't email you again.",
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
<div style="display:none;max-height:0;overflow:hidden;">PNYX comes out on ${LAUNCH_DAY}. We'll email you when it does.</div>
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
            <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#4b4945;">PNYX comes out on <strong style="color:#161513;">${LAUNCH_DAY}</strong>. We'll send you one more email that day with the download link.</p>
            <p style="margin:0;font-size:16px;line-height:1.55;color:#4b4945;">In the app you watch short videos and photos and like or dislike them. From what you react to, it works out your personality and shows you who thinks like you.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#67645e;">You got this email because this address was added to the PNYX waitlist. If that wasn't you, you can ignore it and we won't email you again.</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { to, subject: "You're on the PNYX waitlist", html, text };
}
