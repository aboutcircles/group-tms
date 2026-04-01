/**
 * Tracks consecutive errors across poll-loop iterations.
 * Resets to 0 on any successful run. Only signals an alert
 * after {@link threshold} consecutive failures, preventing
 * transient network blips from flooding Slack / Prometheus.
 */
export class ConsecutiveErrorTracker {
  private count = 0;
  private wasAlerting: boolean = false;

  constructor(private readonly threshold: number = 3) {}

  recordSuccess(): void {
    this.count = 0;
  }

  recordError(): number {
    return ++this.count;
  }

  shouldAlert(): boolean {
    const alert = this.count >= this.threshold;
    if (alert) {
      this.wasAlerting = true;
    }
    return alert;
  }

  /**
   * Returns true exactly once after the tracker transitions from
   * an alerting state back to zero errors (i.e. recovery).
   * Resets the flag so subsequent calls return false until the
   * next alert→recovery cycle.
   */
  wasAlertingAndRecovered(): boolean {
    if (this.wasAlerting && this.count === 0) {
      this.wasAlerting = false;
      return true;
    }
    return false;
  }

  getCount(): number {
    return this.count;
  }
}
