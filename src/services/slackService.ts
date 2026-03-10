import {ISlackService, SlackSeverity} from "../interfaces/ISlackService";
import {BackingInitiatedEvent} from "../interfaces/ICirclesRpc";

export class SlackService implements ISlackService {
  private readonly tag: string;
  private readonly alertWebhookUrl: string;
  private readonly infoWebhookUrl: string | undefined;

  constructor(alertWebhookUrl: string, infoWebhookUrl?: string) {
    this.alertWebhookUrl = alertWebhookUrl;
    this.infoWebhookUrl = infoWebhookUrl?.trim() || undefined;
    const env = process.env.ENVIRONMENT || "unknown";
    const instance = process.env.INSTANCE_ID || "";
    const app = process.env.APP_NAME || "group-tms";
    this.tag = instance
      ? `[${env}:${instance} | ${app}]`
      : `[${env} | ${app}]`;
  }

  private selectWebhook(severity: SlackSeverity): string {
    if (severity === SlackSeverity.INFO && this.infoWebhookUrl) {
      return this.infoWebhookUrl;
    }
    return this.alertWebhookUrl;
  }

  async notifyBackingNotCompleted(e: BackingInitiatedEvent, reason: string): Promise<void> {
    const text =
      `${this.tag} ⚠️ Backing stuck. Reason: ${reason}.
- backer: ${e.backer}
- instance: ${e.circlesBackingInstance}
- tx: ${e.transactionHash}
- block: ${e.blockNumber}
- initiatedAt: ${e.timestamp}`;

    const res = await fetch(this.alertWebhookUrl, {
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

  async notifySlackStartOrCrash(message: string, severity: SlackSeverity = SlackSeverity.CRITICAL): Promise<void> {
    const tagged = `${this.tag} ${message}`;
    const webhookUrl = this.selectWebhook(severity);
    if (!webhookUrl) {
      const ts = new Date().toISOString();
      console.warn(`[${ts}]`, `Slack notification (no webhook configured): ${tagged}`);
      return;
    }

    const res = await fetch(webhookUrl, {
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
