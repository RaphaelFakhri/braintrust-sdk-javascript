import { beforeAll, describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod/v3";
import { Eval, defaultErrorScoreHandler, runEvaluator } from "./framework";
import { EvalScope } from "./eval-environment";
import { configureNode } from "./node/config";

beforeAll(configureNode);
const options = {
  noSendLogs: true,
  progress: { start() {}, stop() {}, increment() {} },
};

describe("eval environments and snapshots", () => {
  test("infers environment, capture inputs, and optional transformed outputs", async () => {
    const result = await Eval(
      "typed snapshots",
      {
        data: [{ input: 1 }],
        environment: async () => ({ baseUrl: "http://localhost" }),
        snapshots: {
          seeded: z.object({ count: z.number() }),
          parsed: z.string().transform(Number),
          optional: z.string(),
        },
        task: (input, { environment, snapshot, signal, onCleanup }) => {
          expectTypeOf(environment).toEqualTypeOf<{ baseUrl: string }>();
          expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
          snapshot("seeded", { count: input });
          snapshot("parsed", "42");
          onCleanup(() => {});
          if (false) {
            // @ts-expect-error Unknown names cannot widen the schema map.
            snapshot("typo", {});
            // @ts-expect-error The schema input, not its output, is accepted.
            snapshot("parsed", 42);
            // @ts-expect-error A value must match its particular name.
            snapshot("seeded", "wrong");
          }
          return input;
        },
        scores: [
          ({ environment, snapshots }) => {
            expectTypeOf(environment).toEqualTypeOf<{ baseUrl: string }>();
            expectTypeOf(snapshots.parsed).toEqualTypeOf<number | undefined>();
            expectTypeOf(snapshots.seeded).toEqualTypeOf<
              { count: number } | undefined
            >();
            if (false) {
              // @ts-expect-error Missing captures must be handled.
              snapshots.seeded.count;
              // @ts-expect-error Only declared names exist.
              snapshots.typo;
            }
            expect(snapshots).toEqual({ seeded: { count: 1 }, parsed: 42 });
            return 1;
          },
        ],
        classifiers: [
          ({ snapshots, environment }) => {
            expectTypeOf(snapshots.parsed).toEqualTypeOf<number | undefined>();
            expectTypeOf(environment.baseUrl).toEqualTypeOf<string>();
            return { name: "status", id: "ok", label: "OK" };
          },
        ],
      },
      options,
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].scores).toEqual({ scorer_0: 1 });
  });

  test("isolates concurrent trials, capture values, and each scorer's copies", async () => {
    const events: string[] = [];
    let open = true;
    let active = 0;
    const result = await Eval(
      "isolated trials",
      {
        data: [{ input: 1 }, { input: 2 }],
        trialCount: 2,
        maxConcurrency: 2,
        environment: ({ onCleanup }) => {
          events.push("setup");
          onCleanup(() => {
            expect(active).toBe(0);
            open = false;
            events.push("shared cleanup");
          });
          return { isOpen: () => open };
        },
        snapshots: {
          seeded: z.object({ count: z.number() }),
          final: z.number(),
        },
        task: async (input, { snapshot, onCleanup, environment }) => {
          active++;
          expect(environment.isOpen()).toBe(true);
          onCleanup(async () => {
            expect(open).toBe(true);
            active--;
            events.push("trial cleanup");
          });
          const state = { count: input };
          snapshot("seeded", state);
          state.count = 99;
          await Promise.resolve();
          snapshot("final", state.count);
          return input;
        },
        scores: [
          ({ snapshots, input, environment }) => {
            expect(environment.isOpen()).toBe(true);
            expect(snapshots.seeded?.count).toBe(input);
            snapshots.seeded!.count = -1;
            return 1;
          },
          async ({ snapshots, input }) => {
            await Promise.resolve();
            expect(snapshots.seeded?.count).toBe(input);
            expect(snapshots.final).toBe(99);
            return 1;
          },
        ],
        classifiers: [
          ({ snapshots, input }) => {
            expect(snapshots.seeded?.count).toBe(input);
            return { name: "status", id: "ok" };
          },
        ],
      },
      options,
    );
    expect(result.results).toHaveLength(4);
    for (const resultItem of result.results) {
      expect(resultItem.error).toBeUndefined();
      expect(Object.values(resultItem.scores)).toEqual([1, 1]);
      expect(resultItem).not.toHaveProperty("environment");
      expect(resultItem).not.toHaveProperty("snapshots");
    }
    expect(events).toEqual([
      "setup",
      ...Array(4).fill("trial cleanup"),
      "shared cleanup",
    ]);
  });

  test("task-only hooks work and cleanup runs in reverse order after scoring", async () => {
    const events: string[] = [];
    await Eval(
      "task-only",
      {
        data: [{ input: 1 }],
        snapshots: { ready: z.boolean() },
        task: (_, { environment, snapshot, onCleanup }) => {
          expectTypeOf(environment).toEqualTypeOf<undefined>();
          onCleanup(() => {
            events.push("first");
          });
          onCleanup(async () => {
            await Promise.resolve();
            events.push("second");
          });
          snapshot("ready", true);
          return "ok";
        },
        scores: [
          ({ snapshots }) => {
            expect(snapshots.ready).toBe(true);
            events.push("score");
            return 1;
          },
        ],
      },
      options,
    );
    expect(events).toEqual(["score", "second", "first"]);
  });

  test("empty snapshots are available without schemas and captures cannot be inferred", async () => {
    await Eval(
      "no schemas",
      {
        data: [{ input: 1 }],
        task: (_, { snapshot }) => {
          if (false) {
            // @ts-expect-error Capturing requires a declared schema.
            snapshot("unknown", 1);
          }
        },
        scores: [
          ({ snapshots }) => {
            expect(snapshots).toEqual({});
            return 1;
          },
        ],
      },
      options,
    );
  });

  test.each([
    [
      "unknown",
      "Unknown snapshot",
      (scope: EvalScope) => scope.snapshot("unknown", 1),
    ],
    [
      "invalid",
      'snapshot "count"',
      (scope: EvalScope) => scope.snapshot("count", "invalid"),
    ],
    [
      "duplicate",
      "already been captured",
      (scope: EvalScope) => {
        scope.snapshot("count", 1);
        scope.snapshot("count", 2);
      },
    ],
    [
      "uncloneable",
      'snapshot "anything"',
      (scope: EvalScope) => scope.snapshot("anything", () => {}),
    ],
  ])("rejects %s captures", (_, message, capture) => {
    const scope = new EvalScope({ count: z.number(), anything: z.unknown() });
    expect(() => capture(scope)).toThrow(message);
  });

  test("reserved property names work and failed validation does not consume a name", () => {
    const scope = new EvalScope({
      ["__proto__"]: z.number(),
      count: z.number(),
    });
    scope.snapshot("__proto__", 1);
    expect(() => scope.snapshot("count", "bad")).toThrow();
    scope.snapshot("count", 2);
    expect(Object.keys(scope.copySnapshots())).toEqual(["__proto__", "count"]);
  });

  test("preserves task errors, skips scorers, and attempts every cleanup", async () => {
    const taskError = new Error("task failed");
    const cleanupError = new Error("cleanup failed");
    const events: string[] = [];
    const scorer = vi.fn(() => 1);
    const result = await Eval(
      "task failure",
      {
        data: [{ input: 1 }],
        snapshots: { failed: z.boolean() },
        task: (_, { onCleanup, snapshot }) => {
          onCleanup(() => {
            events.push("first");
          });
          onCleanup(() => {
            events.push("second");
            throw cleanupError;
          });
          try {
            throw taskError;
          } finally {
            snapshot("failed", true);
          }
        },
        scores: [scorer],
        errorScoreHandler: defaultErrorScoreHandler,
      },
      options,
    );
    expect(scorer).not.toHaveBeenCalled();
    expect(events).toEqual(["second", "first"]);
    expect(result.results[0].error).toBeInstanceOf(AggregateError);
    expect((result.results[0].error as AggregateError).errors).toEqual([
      taskError,
      cleanupError,
    ]);
    expect(Object.values(result.results[0].scores)).toEqual([0]);
  });

  test("retains successful scores when cleanup fails", async () => {
    const result = await Eval(
      "cleanup failure",
      {
        data: [{ input: 1 }],
        task: (_, { onCleanup }) => {
          onCleanup(() => {
            throw new Error("close");
          });
          return 1;
        },
        scores: [() => 1],
      },
      options,
    );
    expect(Object.values(result.results[0].scores)).toEqual([1]);
    expect(result.results[0].error).toBeInstanceOf(AggregateError);
  });

  test("cleanup runs after scorer and classifier failures", async () => {
    const close = vi.fn();
    await Eval(
      "scoring failures",
      {
        data: [{ input: 1 }],
        task: (_, { onCleanup }) => {
          onCleanup(close);
          return 1;
        },
        scores: [
          () => {
            throw new Error("score");
          },
        ],
        classifiers: [
          () => {
            throw new Error("classifier");
          },
        ],
      },
      options,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test.each([false, true])(
    "runs factory and cleanup for empty or filtered data (%s)",
    async (filtered) => {
      const cleanup = vi.fn();
      const setup = vi.fn(({ onCleanup }) => {
        onCleanup(cleanup);
        return {};
      });
      await runEvaluator(
        null,
        {
          projectName: "empty",
          evalName: "empty",
          data: filtered ? [{ input: 1 }] : [],
          environment: setup,
          task: vi.fn(),
          scores: [],
        },
        options.progress,
        filtered ? [{ path: ["input"], pattern: /never/ }] : [],
        undefined,
      );
      expect(setup).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  test("cleans partially initialized environments and aggregates failures", async () => {
    const events: number[] = [];
    const initError = new Error("init");
    const cleanupError = new Error("close");
    const run = Eval(
      "partial setup",
      {
        data: [],
        environment: ({ onCleanup }) => {
          onCleanup(() => {
            events.push(1);
          });
          onCleanup(() => {
            events.push(2);
            throw cleanupError;
          });
          throw initError;
        },
        task: () => 1,
        scores: [],
      },
      options,
    );
    await expect(run).rejects.toMatchObject({
      errors: [initError, cleanupError],
    });
    expect(events).toEqual([2, 1]);
  });

  test("shared cleanup errors reject an otherwise successful run", async () => {
    await expect(
      Eval(
        "shared failure",
        {
          data: [],
          environment: ({ onCleanup }) => {
            onCleanup(() => {
              throw new Error("shared close");
            });
          },
          task: () => 1,
          scores: [],
        },
        options,
      ),
    ).rejects.toThrow("shared close");
  });

  test("CLI discovery does not acquire resources", async () => {
    const environment = vi.fn();
    const previous = globalThis._lazy_load;
    const evaluators = { ...globalThis._evals.evaluators };
    try {
      globalThis._lazy_load = true;
      await Eval(
        "lazy environment",
        { data: [], environment, task: () => 1, scores: [] },
        options,
      );
      expect(environment).not.toHaveBeenCalled();
    } finally {
      globalThis._lazy_load = previous;
      globalThis._evals.evaluators = evaluators;
    }
  });

  test("aborts before setup when the supplied signal is already aborted", async () => {
    const setup = vi.fn();
    await expect(
      Eval(
        "already aborted",
        {
          data: [],
          environment: setup,
          task: () => 1,
          scores: [],
          signal: AbortSignal.abort(),
        },
        options,
      ),
    ).rejects.toThrow("Evaluator aborted");
    expect(setup).not.toHaveBeenCalled();
  });

  test("timeout includes setup and waits for its cleanup", async () => {
    const events: string[] = [];
    await expect(
      Eval(
        "setup timeout",
        {
          data: [{ input: 1 }],
          timeout: 10,
          environment: async ({ onCleanup, signal }) => {
            onCleanup(async () => {
              await Promise.resolve();
              events.push("cleanup");
            });
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            events.push("setup finished");
          },
          task: () => {
            events.push("task");
          },
          scores: [],
        },
        options,
      ),
    ).rejects.toThrow("Evaluator timed out");
    expect(events).toEqual(["setup finished", "cleanup"]);
  });

  test.each([false, true])(
    "cancellation drains task cleanup before shared cleanup (environment: %s)",
    async (withEnvironment) => {
      const events: string[] = [];
      const controller = new AbortController();
      await expect(
        Eval(
          "drain cancelled tasks",
          {
            data: [{ input: 1 }, { input: 2 }],
            maxConcurrency: 1,
            signal: controller.signal,
            environment: withEnvironment
              ? ({ onCleanup }) => {
                  onCleanup(() => {
                    events.push("shared cleanup");
                  });
                }
              : undefined,
            task: async (input, { signal, onCleanup }) => {
              events.push(`task ${input}`);
              onCleanup(async () => {
                await Promise.resolve();
                events.push("task cleanup");
              });
              const aborted = new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              controller.abort();
              await aborted;
              events.push("task finished");
            },
            scores: [
              () => {
                events.push("score");
                return 1;
              },
            ],
          },
          options,
        ),
      ).rejects.toThrow("Evaluator aborted");
      expect(events).toEqual([
        "task 1",
        "task finished",
        "task cleanup",
        ...(withEnvironment ? ["shared cleanup"] : []),
      ]);
    },
  );

  test("data iteration failure aborts active tasks before shared cleanup", async () => {
    const events: string[] = [];
    let started!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    await expect(
      Eval(
        "broken iterator",
        {
          data: (async function* () {
            yield { input: 1 };
            await taskStarted;
            throw new Error("iterator failed");
          })(),
          environment: ({ onCleanup }) => {
            onCleanup(() => {
              events.push("shared cleanup");
            });
          },
          task: async (_, { signal, onCleanup }) => {
            onCleanup(() => {
              events.push("task cleanup");
            });
            started();
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
          scores: [],
        },
        options,
      ),
    ).rejects.toThrow("iterator failed");
    expect(events).toEqual(["task cleanup", "shared cleanup"]);
  });
});

test("cancellation waits for active scoring before cleanup", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  await expect(
    Eval(
      "cancel scoring",
      {
        data: [{ input: 1 }],
        signal: controller.signal,
        environment: ({ onCleanup }) => {
          onCleanup(() => {
            events.push("shared cleanup");
          });
        },
        task: (_, { onCleanup }) => {
          onCleanup(() => {
            events.push("task cleanup");
          });
          return 1;
        },
        scores: [
          async () => {
            controller.abort();
            await Promise.resolve();
            events.push("scored");
            return 1;
          },
        ],
      },
      options,
    ),
  ).rejects.toThrow("Evaluator aborted");
  expect(events).toEqual(["scored", "task cleanup", "shared cleanup"]);
});

test("closed scopes reject late capture and cleanup registration", async () => {
  const scope = new EvalScope({ count: z.number() });
  await scope.close();
  expect(() => scope.snapshot("count", 1)).toThrow(
    'snapshot "count": scope is closed',
  );
  expect(() => scope.onCleanup(() => {})).toThrow("scope is already closed");
});
