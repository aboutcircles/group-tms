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
  help: "Whether the worker can reach the RPC endpoint (1=healthy, 0=unhealthy)",
  labelNames: ["app"] as const,
  registers: [registry]
});

const leaderGauge = new Gauge({
  name: "group_tms_leader",
  help: "Whether this instance is the active leader (1=leader, 0=standby)",
  labelNames: ["app"] as const,
  registers: [registry]
});

/** Track per-app RPC readiness for the /health/ready endpoint. */
const rpcHealthState = new Map<string, boolean>();
const leaderState = new Map<string, boolean>();

export function setRpcHealthy(appName: string, healthy: boolean): void {
  rpcHealthState.set(appName, healthy);
  rpcHealthy.labels(appName).set(healthy ? 1 : 0);
}

export function setLeaderStatus(appName: string, isLeader: boolean): void {
  leaderState.set(appName, isLeader);
  leaderGauge.labels(appName).set(isLeader ? 1 : 0);
}

export function startMetricsServer(
  appName: string,
  port: number = Number.parseInt(process.env.METRICS_PORT || "9091", 10)
): http.Server {
  // Initialise gauges so Prometheus sees a 0 value (rather than absent)
  // until the first run completes.
  lastSuccessTimestamp.labels(appName).set(0);
  rpcHealthy.labels(appName).set(0);
  rpcHealthState.set(appName, false);
  leaderGauge.labels(appName).set(0);

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";

    // GET /health/live — process liveness (always 200)
    if (url === "/health/live") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // GET /health/ready — RPC readiness (200 if healthy, 503 if not)
    if (url === "/health/ready") {
      const healthy = rpcHealthState.get(appName) === true;
      const leader = leaderState.get(appName);
      const code = healthy ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: healthy ? "ready" : "unavailable",
        ...(leader !== undefined && { leader })
      }));
      return;
    }

    // GET /metrics (default) — Prometheus scrape
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
  setRpcHealthy(appName, true);
}

export function recordRunError(appName: string): void {
  runsTotal.labels(appName, "error").inc();
  errorsTotal.labels(appName).inc();
}

/**
 * Mark RPC as unhealthy for a specific app.
 * Call this when the run loop catches an error that indicates
 * the RPC endpoint is unreachable (network/timeout/provider errors).
 */
export function recordRpcUnhealthy(appName: string): void {
  setRpcHealthy(appName, false);
}

export function getRegistry(): Registry {
  return registry;
}
