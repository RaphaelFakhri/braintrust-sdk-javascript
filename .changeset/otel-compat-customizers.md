---
"@braintrust/otel": patch
---

fix: Throw from `setupOtelCompat()` when Braintrust span customizers are registered, since they are not yet supported with OpenTelemetry compat mode
