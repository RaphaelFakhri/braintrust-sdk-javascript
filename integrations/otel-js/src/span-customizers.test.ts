import { afterEach, describe, expect, test } from "vitest";
import { setupOtelCompat, resetOtelCompat } from ".";

// Braintrust stores configured span customizers under this shared symbol.
const SPAN_CUSTOMIZERS_KEY = Symbol.for("braintrust.spanCustomizers");
const shared = globalThis as Record<string | symbol, unknown>;

describe("setupOtelCompat with span customizers", () => {
  afterEach(() => {
    delete shared[SPAN_CUSTOMIZERS_KEY];
    resetOtelCompat();
  });

  test("throws when span customizers are already registered", () => {
    shared[SPAN_CUSTOMIZERS_KEY] = [{ onSpanExport: (data: unknown) => data }];

    expect(() => setupOtelCompat()).toThrow(
      "Braintrust span customizers are not supported with OpenTelemetry compat mode yet.",
    );
    expect(shared.BRAINTRUST_CONTEXT_MANAGER).toBeUndefined();
    expect(shared.BRAINTRUST_ID_GENERATOR).toBeUndefined();
  });

  test.each([undefined, []])(
    "allows setup when customizers are cleared (%j)",
    (customizers) => {
      shared[SPAN_CUSTOMIZERS_KEY] = customizers;
      expect(() => setupOtelCompat()).not.toThrow();
      expect(shared.BRAINTRUST_CONTEXT_MANAGER).toBeDefined();
    },
  );
});
