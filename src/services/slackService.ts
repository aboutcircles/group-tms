import {ISlackService} from "../interfaces/ISlackService";
import {CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";

export class SlackService implements ISlackService {
  private readonly tag: string;

  constructor(private webhookUrl: string) {
    const env = process.env.ENVIRONMENT || "unknown";
    const instance = process.env.INSTANCE_ID || "";
    const app = process.env.APP_NAME || "group-tms";
    this.tag = instance
      ? `[${env}:${instance} | ${app}]`
      : `[${env} | ${app}]`;
  }

  async notifyBackingNotCompleted(e: CrcV2_CirclesBackingInitiated, reason: string): Promise<void> {
    const text =
      `${this.tag} ⚠️ Backing stuck. Reason: ${reason}.
- backer: ${e.backer}
- instance: ${e.circlesBackingInstance}
- tx: ${e.transactionHash}
- block: ${e.blockNumber}
- initiatedAt: ${e.timestamp}`;

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        text: text
      })
    });
    if (!res.ok) {
      throw new Error(`Slack notify failed: ${res.status} ${await res.text()}`);
    }
  }

  async notifySlackStartOrCrash(message: string): Promise<void> {
    const tagged = `${this.tag} ${message}`;
    if (!this.webhookUrl) {
      const ts = new Date().toISOString();
      console.warn(`[${ts}]`, `Slack notification (no webhook configured): ${tagged}`);
      return;
    }

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        text: tagged
      })
    });
    if (!res.ok) {
      throw new Error(`Slack notify failed: ${res.status} ${await res.text()}`);
    }
  }
}
