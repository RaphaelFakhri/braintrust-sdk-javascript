import { beforeAll, describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod/v3";
import * as z4 from "zod/v4";
import {
  Eval,
  callEvaluatorData,
  defaultErrorScoreHandler,
  runEvaluator,
  type EvalScorer,
  type EvalClassifier,
} from "./framework";
import { EvalScope } from "./eval-environment";
import { configureNode } from "./node/config";
import { NOOP_SPAN } from "./logger";

beforeAll(configureNode);
const options = {
  noSendLogs: true,
  progress: { start() {}, stop() {}, increment() {} },
};

describe("eval environments and snapshots", () => {
  test("mixed Zod versions infer capture inputs and transformed scorer outputs", async () => {
    const result = await Eval(
      "mixed snapshot schemas",
      {
        data: [{ input: 1 }],
        snapshots: {
          legacy: z.string().transform(Number),
          current: z4.string().transform(Number),
        },
        task: (input, { snapshot }) => {
          snapshot("legacy", "1");
          snapshot("current", "2");
          if (false) {
            // @ts-expect-error Zod 4 transforms accept the input type.
            snapshot("current", 2);
            // @ts-expect-error Zod 3 transforms accept the input type.
            snapshot("legacy", 1);
            // @ts-expect-error Unknown names must not widen the schema map.
            snapshot("missing", "3");
          }
          return input;
        },
        scores: [
          ({ snapshots }) => {
            expectTypeOf(snapshots.current).toEqualTypeOf<number | undefined>();
            expectTypeOf(snapshots.legacy).toEqualTypeOf<number | undefined>();
            expect(snapshots).toEqual({ legacy: 1, current: 2 });
            return 1;
          },
        ],
        classifiers: [
          ({ snapshots }) => {
            expectTypeOf(snapshots.current).toEqualTypeOf<number | undefined>();
            return { name: "count", id: String(snapshots.current) };
          },
        ],
      },
      options,
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].scores).toEqual({ scorer_0: 1 });
    expect(result.results[0].classifications?.count).toEqual([
      { id: "2", label: "2" },
    ]);
  });

  test.each([
    ["Buffer", Buffer.from("snapshot")],
    [
      "class instance",
      new (class State {
        count = 1;
      })(),
    ],
    ["shared buffer", new SharedArrayBuffer(8)],
    ["shared view", new Uint8Array(new SharedArrayBuffer(8))],
    [
      "accessor",
      {
        get count() {
          return 1;
        },
      },
    ],
    ["symbol key", { [Symbol("count")]: 1 }],
    ["hidden property", Object.defineProperty({}, "count", { value: 1 })],
  ])("rejects nested %s without consuming the snapshot name", (_, value) => {
    const scope = new EvalScope({ state: z.unknown() });
    expect(() => scope.snapshot("state", { nested: [value] })).toThrow(
      'Failed to capture snapshot "state"',
    );
    scope.snapshot("state", { count: 1 });
    expect(scope.copySnapshots()).toEqual({ state: { count: 1 } });
  });

  test("rejects schema outputs that cloning would change and accepts explicit plain-data transforms", () => {
    const scope = new EvalScope({
      raw: z.instanceof(Buffer),
      converted: z4.instanceof(Buffer).transform((value) => Array.from(value)),
    });
    const buffer = Buffer.from([1, 2]);
    expect(() => scope.snapshot("raw", buffer)).toThrow(
      'Failed to capture snapshot "raw"',
    );
    scope.snapshot("converted", buffer);
    buffer[0] = 99;
    expect(scope.copySnapshots()).toEqual({ converted: [1, 2] });
  });

  test("plain-data snapshots preserve cycles, aliases, and primitive values while isolating copies", () => {
    const scope = new EvalScope({ state: z.unknown() });
    const state: Record<string, unknown> = {
      values: [undefined, null, true, "value", 1n, NaN, Infinity],
      child: { count: 1 },
    };
    state.self = state;
    state.alias = state.child;
    scope.snapshot("state", state);
    const first = scope.copySnapshots().state as typeof state;
    const second = scope.copySnapshots().state as typeof state;
    expect(first).toEqual(state);
    expect(first.self).toBe(first);
    expect(first.alias).toBe(first.child);
    expect(first.child).not.toBe(state.child);
    expect(first.child).not.toBe(second.child);
  });

  test("standalone scorers and classifiers can declare an environment without snapshots", async () => {
    type Environment = { count: number };
    const score: EvalScorer<number, number, void, {}, Environment> = ({
      environment,
      output,
    }) => {
      expectTypeOf(environment).toEqualTypeOf<Environment>();
      return Number(environment.count === output);
    };
    const classifier: EvalClassifier<number, number, void, {}, Environment> = ({
      environment,
    }) => {
      expectTypeOf(environment).toEqualTypeOf<Environment>();
      return { name: "count", id: String(environment.count) };
    };
    const plainScorer: EvalScorer<number, number, void, {}> = ({ output }) =>
      Number(output === 1);
    const result = await Eval(
      "environment-only scorers",
      {
        data: [{ input: 1, metadata: {} }],
        environment: () => ({ count: 1 }),
        task: (input) => input,
        scores: [score, plainScorer],
        classifiers: [classifier],
      },
      options,
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].scores).toEqual({ score: 1, plainScorer: 1 });
    expect(result.results[0].classifications).toEqual({
      count: [{ id: "1", label: "1" }],
    });
  });

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

  test.each([
    ["Zod 3 literal", z.unknown().pipe(z.literal("public"))],
    ["Zod 3 enum", z.unknown().pipe(z.enum(["public"]))],
    ["Zod 4 enum", z4.unknown().pipe(z4.enum(["public"]))],
    [
      "custom validation message",
      z.string().superRefine((value, context) => {
        context.addIssue({ code: "custom", message: value });
      }),
    ],
    [
      "transform error",
      z4.string().transform((value) => {
        throw new Error(value, { cause: new Error(value) });
      }),
    ],
  ])(
    "does not log private snapshot values from %s failures",
    async (_, schema) => {
      const secret = "private-snapshot-value";
      const log = vi.spyOn(NOOP_SPAN, "log");
      try {
        const result = await Eval(
          "private snapshot failure",
          {
            data: [{ input: 1 }],
            snapshots: { state: schema },
            task: (_, { snapshot }) => {
              snapshot("state", secret);
            },
            scores: [],
          },
          options,
        );
        expect(result.results[0].error).toMatchObject({
          message: 'Failed to capture snapshot "state"',
        });
        expect(result.results[0].error).not.toHaveProperty("cause");
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).toContain("Failed to capture snapshot");
        expect(logged).not.toContain(secret);
      } finally {
        log.mockRestore();
      }
    },
  );

  test.each(["constructor", "toString", "__proto__"])(
    "uncaptured snapshot %s is undefined for scorers and classifiers",
    async (name) => {
      const result = await Eval(
        "uncaptured reserved snapshot",
        {
          data: [{ input: 1 }],
          snapshots: { [name]: z.number() },
          task: (input) => input,
          scores: [({ snapshots }) => Number(snapshots[name] === undefined)],
          classifiers: [
            ({ snapshots }) => ({
              name: "missing",
              id: String(snapshots[name] === undefined),
            }),
          ],
        },
        options,
      );
      expect(result.results[0].scores).toEqual({ scorer_0: 1 });
      expect(result.results[0].classifications?.missing).toEqual([
        { id: "true", label: "true" },
      ]);
    },
  );

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

  test("observes data factory rejections before evaluator initialization", async () => {
    const dataError = new Error("data failed");
    const { data } = callEvaluatorData(async () => {
      throw dataError;
    });
    // Leave a full event-loop turn before consuming the data, as asynchronous
    // experiment initialization does. Vitest reports unhandled rejections.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(data).rejects.toBe(dataError);
  });

  test.each([false, true])(
    "preserves data errors during pending environment setup (setup fails: %s)",
    async (setupFails) => {
      const dataError = new Error("data failed");
      const setupError = new Error("setup failed");
      const cleanup = vi.fn();
      const task = vi.fn();
      const failure = await Eval(
        "data failure during setup",
        {
          data: async () => {
            throw dataError;
          },
          environment: async ({ onCleanup }) => {
            onCleanup(cleanup);
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (setupFails) throw setupError;
          },
          task,
          scores: [],
        },
        options,
      ).catch((error: unknown) => error);
      if (setupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          dataError,
          setupError,
        ]);
      } else {
        expect(failure).toBe(dataError);
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(task).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "data failure aborts pending setup and awaits cleanup (setup fails: %s)",
    async (setupFails) => {
      const dataError = new Error("data failed during setup");
      const setupError = new Error("setup failed after cancellation");
      const events: string[] = [];
      let started!: () => void;
      const setupStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const task = vi.fn();
      const failure = await Eval(
        "data failure cancels setup",
        {
          // Bound the regression case where data failure never aborts setup.
          timeout: 1000,
          data: async () => {
            await setupStarted;
            throw dataError;
          },
          environment: async ({ signal, onCleanup }) => {
            onCleanup(async () => {
              await Promise.resolve();
              events.push("shared cleanup");
            });
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              started();
            });
            expect(signal.reason).toBe(dataError);
            events.push("setup aborted");
            await Promise.resolve();
            events.push("setup finished");
            if (setupFails) throw setupError;
          },
          task,
          scores: [],
        },
        options,
      ).catch((error: unknown) => error);
      if (setupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          dataError,
          setupError,
        ]);
      } else {
        expect(failure).toBe(dataError);
      }
      expect(task).not.toHaveBeenCalled();
      expect(events).toEqual([
        "setup aborted",
        "setup finished",
        "shared cleanup",
      ]);
    },
  );

  test("cancellation during setup waits for pending data and preserves its failure", async () => {
    const controller = new AbortController();
    const dataError = new Error("data failed after cancellation");
    const events: string[] = [];
    const failure = await Eval(
      "pending data cancellation",
      {
        signal: controller.signal,
        data: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          events.push("data finished");
          throw dataError;
        },
        environment: ({ onCleanup }) => {
          onCleanup(() => {
            events.push("shared cleanup");
          });
          controller.abort();
        },
        task: () => 1,
        scores: [],
      },
      options,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Evaluator aborted" }),
      dataError,
    ]);
    expect(events).toEqual(["data finished", "shared cleanup"]);
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

  test.each([
    { cancellation: "abort", returnResults: true },
    { cancellation: "abort", returnResults: false },
    { cancellation: "timeout", returnResults: true },
    { cancellation: "timeout", returnResults: false },
  ])(
    "$cancellation preserves task cleanup errors (returnResults: $returnResults)",
    async ({ cancellation, returnResults }) => {
      const controller = new AbortController();
      const firstError = new Error("first cleanup failed");
      const secondError = new Error("second cleanup failed");
      const sharedCleanup = vi.fn();
      const failure = await Eval(
        "cancel failing cleanup",
        {
          data: [{ input: 1 }],
          signal: controller.signal,
          timeout: cancellation === "timeout" ? 10 : undefined,
          environment: ({ onCleanup }) => {
            onCleanup(sharedCleanup);
          },
          task: async (_, { signal, onCleanup }) => {
            onCleanup(() => {
              throw firstError;
            });
            onCleanup(async () => {
              await Promise.resolve();
              throw secondError;
            });
            const aborted = new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            if (cancellation === "abort") controller.abort();
            await aborted;
          },
          scores: [],
        },
        { ...options, returnResults },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({
          message:
            cancellation === "timeout"
              ? "Evaluator timed out"
              : "Evaluator aborted",
        }),
        secondError,
        firstError,
      ]);
      expect(sharedCleanup).toHaveBeenCalledOnce();
    },
  );

  test.each([true, false])(
    "bounds retained cleanup failures across trials (returnResults: %s)",
    async (returnResults) => {
      const controller = new AbortController();
      const cleanupErrors = Array.from(
        { length: 12 },
        (_, index) => new Error(`cleanup ${index} failed`),
      );
      const attempted: Error[] = [];
      const failure = await Eval(
        "bounded cleanup failures",
        {
          data: [0, 1, 2, 3].map((input) => ({ input })),
          maxConcurrency: 1,
          signal: controller.signal,
          task: (input, { onCleanup }) => {
            if (input === 3) onCleanup(() => controller.abort());
            for (let index = 2; index >= 0; index--) {
              const error = cleanupErrors[input * 3 + index];
              onCleanup(() => {
                attempted.push(error);
                throw error;
              });
            }
            return input;
          },
          scores: [],
        },
        { ...options, returnResults },
      ).catch((error: unknown) => error);
      expect(attempted).toEqual(cleanupErrors);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ message: "Evaluator aborted" }),
        ...cleanupErrors.slice(0, 5),
      ]);
      expect((failure as AggregateError).message).toContain(
        "7 additional task cleanup errors omitted",
      );
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

  test.each([false, true])(
    "cancellation waits for pending iteration and iterator cleanup (cleanup fails: %s)",
    async (cleanupFails) => {
      const controller = new AbortController();
      const iteratorError = new Error("iterator cleanup failed");
      const events: string[] = [];
      let finishRead!: () => void;
      const pendingRead = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      let reading!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let started!: () => void;
      const taskStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cleanup = vi.fn(() => {
        events.push("shared cleanup");
      });
      const task = vi.fn((input: number) => {
        started();
        return input;
      });
      const run = Eval(
        "cancel pending iteration",
        {
          signal: controller.signal,
          data: (async function* () {
            try {
              yield { input: 1 };
              reading();
              await pendingRead;
              events.push("read finished");
              yield { input: 2 };
            } finally {
              await new Promise((resolve) => setTimeout(resolve, 0));
              events.push("iterator cleanup");
              if (cleanupFails) throw iteratorError;
            }
          })(),
          environment: ({ onCleanup }) => {
            onCleanup(cleanup);
          },
          task,
          scores: [],
        },
        options,
      ).catch((error: unknown) => error);
      await Promise.all([readStarted, taskStarted]);
      controller.abort();
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cleanup).not.toHaveBeenCalled();
      } finally {
        finishRead();
      }
      const failure = await run;
      if (cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({ message: "Evaluator aborted" }),
          iteratorError,
        ]);
      } else {
        expect(failure).toMatchObject({ message: "Evaluator aborted" });
      }
      expect(task).toHaveBeenCalledOnce();
      expect(events).toEqual([
        "read finished",
        "iterator cleanup",
        "shared cleanup",
      ]);
    },
  );
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
