import { Expo } from "expo-server-sdk";

export interface PushSender {
  /** Best-effort — a send failure should never fail the action that triggered
   * the notification (a vote, a follow, ...), so callers swallow rejections. */
  send(tokens: string[], input: { title: string; body: string; data?: Record<string, unknown> }): Promise<void>;
}

/**
 * Real delivery via Expo's push service. Doesn't yet clean up tokens Expo
 * reports as dead (`DeviceNotRegistered`) — that comes back on a *receipt*
 * fetched after the fact, not the send call itself, and is deliberately out
 * of scope for now; a token that goes stale just fails silently on every
 * future send instead of being pruned.
 */
export class ExpoPushSender implements PushSender {
  private readonly expo = new Expo();

  async send(tokens: string[], input: { title: string; body: string; data?: Record<string, unknown> }): Promise<void> {
    const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
    if (valid.length === 0) return;
    const messages = valid.map((to) => ({ to, title: input.title, body: input.body, data: input.data }));
    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      await this.expo.sendPushNotificationsAsync(chunk);
    }
  }
}

/** No-op — local dev and tests never send a real push. */
export class NullPushSender implements PushSender {
  async send(): Promise<void> {}
}
