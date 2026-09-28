import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import { initFunction } from "./invoke";
import { _internalGetGlobalState, _exportsForTestingOnly } from "../logger";
import { configureNode } from "../node/config";
import { Eval } from "../framework";

describe("initFunction", () => {
  beforeEach(() => {
    configureNode();
    _exportsForTestingOnly.setInitialTestState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("remote eval scorers omit live resources and snapshots from HTTP requests", async () => {
    const state = _internalGetGlobalState();
    vi.spyOn(state, "login").mockResolvedValue(undefined);
    state.apiUrl = "https://api.example.com";
    const fetch = vi
      .spyOn(state.proxyConn(), "fetch")
      .mockResolvedValue(new Response("1", { status: 200 }));
    const scorer = initFunction({ projectName: "test", slug: "remote-score" });
    const result = await Eval(
      "private scorer state",
      {
        data: [{ input: { environment: "ordinary input" } }],
        environment: () => ({
          toJSON() {
            throw new Error("Live resource was serialized");
          },
        }),
        snapshots: { secret: z.string() },
        task: (input, { snapshot }) => {
          snapshot("secret", "private snapshot");
          return input;
        },
        scores: [scorer],
      },
      { noSendLogs: true },
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].scores).toEqual({ [scorer.name]: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request.input).not.toHaveProperty("environment");
    expect(request.input).not.toHaveProperty("snapshots");
    expect(request.input.input).toEqual({ environment: "ordinary input" });
    expect(request.input.output).toEqual({ environment: "ordinary input" });
  });

  test("should disable span cache when called", async () => {
    const state = _internalGetGlobalState();

    // Cache should be disabled by default (it's only enabled during evals)
    expect(state.spanCache.disabled).toBe(true);

    // Call initFunction
    initFunction({
      projectName: "test-project",
      slug: "test-function",
    });

    // Cache should still be disabled (initFunction also explicitly disables it)
    expect(state.spanCache.disabled).toBe(true);
  });

  test("should return a function with correct name", () => {
    const fn = initFunction({
      projectName: "my-project",
      slug: "my-scorer",
      version: "v1",
    });

    expect(fn.name).toBe("initFunction-my-project-my-scorer-v1");
  });

  test("should use 'latest' in name when version not specified", () => {
    const fn = initFunction({
      projectName: "my-project",
      slug: "my-scorer",
    });

    expect(fn.name).toBe("initFunction-my-project-my-scorer-latest");
  });
});

describe("registerOtelFlush", () => {
  beforeEach(() => {
    _exportsForTestingOnly.setInitialTestState();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("should register OTEL flush callback", async () => {
    const { registerOtelFlush } = await import("../logger");
    const state = _internalGetGlobalState();

    let flushed = false;
    const mockFlush = async () => {
      flushed = true;
    };

    registerOtelFlush(mockFlush);

    // Calling flushOtel should invoke the registered callback
    await state.flushOtel();

    expect(flushed).toBe(true);
  });

  test("flushOtel should be no-op when no callback registered", async () => {
    const state = _internalGetGlobalState();

    // Should not throw
    await state.flushOtel();
  });
});
