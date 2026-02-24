import * as http from "http";
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics
} from "prom-client";

const registry = new Registry();

collectDefaultMetrics({ register: registry });

const runsTotal = new Counter({
  name: "group_tms_runs_total",
  help: "Total number of runOnce invocations",
  labelNames: ["app", "status"] as const,
  registers: [registry]
});

const runDuration = new Histogram({
  name: "group_tms_run_duration_seconds",
  help: "Duration of runOnce in seconds",
  labelNames: ["app"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry]
});

const lastSuccessTimestamp = new Gauge({
  name: "group_tms_last_successful_run_timestamp",
  help: "Unix timestamp of the last successful run",
  labelNames: ["app"] as const,
  registers: [registry]
});

const errorsTotal = new Counter({
  name: "group_tms_errors_total",
  help: "Cumulative error count",
  labelNames: ["app"] as const,
  registers: [registry]
});

const rpcHealthy = new Gauge({
  name: "group_tms_rpc_healthy",
  help: "1 if the RPC endpoint is reachable, 0 otherwise",
  labelNames: ["app"] as const,
  registers: [registry]
});

export function startMetricsServer(
  appName: string,
  port: number = Number.parseInt(process.env.METRICS_PORT || "9091", 10)
): http.Server {
  // Initialise the last-success gauge so Prometheus sees a 0 value
  // (rather than absent) until the first successful run completes.
  lastSuccessTimestamp.labels(appName).set(0);

  const server = http.createServer(async (_req, res) => {
    try {
      const metrics = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType });
      res.end(metrics);
    } catch (err) {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`[metrics] ${appName} metrics server listening on :${port}`);
  });

  return server;
}

export function recordRunSuccess(appName: string, durationMs: number): void {
  runsTotal.labels(appName, "success").inc();
  runDuration.labels(appName).observe(durationMs / 1000);
  lastSuccessTimestamp.labels(appName).set(Date.now() / 1000);
}

export function recordRunError(appName: string): void {
  runsTotal.labels(appName, "error").inc();
  errorsTotal.labels(appName).inc();
}

export function recordRpcHealth(appName: string, healthy: boolean): void {
  rpcHealthy.labels(appName).set(healthy ? 1 : 0);
}

export function getRegistry(): Registry {
  return registry;
}
