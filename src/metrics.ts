/** Low-cardinality OpenTelemetry metrics for mailsift. */
import { metrics as otelMetrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

function enabled(): boolean {
  const configured = process.env.OTEL_METRICS_EXPORTER?.trim().toLowerCase();
  if (configured === 'none') return false;
  return Boolean(configured || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class Metrics {
  private readonly provider?: MeterProvider;
  private readonly meter: Meter;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor() {
    if (!enabled()) {
      this.meter = otelMetrics.getMeter('mailsift');
      return;
    }
    const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/metrics`
        : undefined);
    const exporter = new OTLPMetricExporter(endpoint ? { url: endpoint } : undefined);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: positiveEnv('OTEL_METRIC_EXPORT_INTERVAL_MS', 60_000),
    });
    const provider = new MeterProvider({ readers: [reader] });
    this.provider = provider;
    otelMetrics.setGlobalMeterProvider(provider);
    this.meter = provider.getMeter('mailsift');
  }

  addCounter(name: string, value = 1, attributes: Record<string, string> = {}): void {
    if (!this.provider) return;
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, attributes);
  }

  recordHistogram(name: string, value: number, attributes: Record<string, string> = {}): void {
    if (!this.provider) return;
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    histogram.record(value, attributes);
  }

  async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }
}

export const metrics = new Metrics();
