/**
 * Tracks consecutive errors across poll-loop iterations.
 * Resets to 0 on any successful run. Only signals an alert
 * after {@link threshold} consecutive failures, preventing
 * transient network blips from flooding Slack / Prometheus.
 */
export class ConsecutiveErrorTracker {
  private count = 0;

  constructor(private readonly threshold: number = 3) {}

  recordSuccess(): void {
    this.count = 0;
  }

  recordError(): number {
    return ++this.count;
  }

  shouldAlert(): boolean {
    return this.count >= this.threshold;
  }

  getCount(): number {
    return this.count;
  }
}
