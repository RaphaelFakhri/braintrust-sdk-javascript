# Eval environments and named snapshots

`environment` acquires resources once for an entire `Eval()` invocation and returns the value tasks and scorers use.
Tasks create their own per-trial state.
Both scopes provide `onCleanup`, so you can register cleanup immediately after acquiring each resource.

This complete example shares a service across the run, gives every trial a separate session, and scores snapshots captured at meaningful points:

```ts
import { Eval } from "braintrust";
import { z } from "zod/v3";

const inventory = z.object({ items: z.array(z.string()) });

await Eval("Shopping agent", {
  data: [{ input: "apple" }, { input: "pear" }],
  trialCount: 2,
  maxConcurrency: 2,

  environment: ({ onCleanup, signal }) => {
    // Substitute a real service or emulator here.
    const sessions = new Map<symbol, { items: string[] }>();
    onCleanup(() => sessions.clear());
    return {
      sessions,
      addItem(id: symbol, item: string) {
        signal.throwIfAborted();
        sessions.get(id)!.items.push(item);
      },
    };
  },

  snapshots: {
    seeded: inventory,
    afterPurchase: inventory,
  },

  task: (input, { environment, onCleanup, snapshot }) => {
    const id = Symbol(); // A separate session for every case and trial.
    const state = { items: [] as string[] };
    environment.sessions.set(id, state);
    onCleanup(() => {
      environment.sessions.delete(id);
    });

    snapshot("seeded", state);
    environment.addItem(id, input);
    snapshot("afterPurchase", state);
    return "Purchased";
  },

  scores: [
    function purchased({ input, environment, snapshots }) {
      // Shared resources and this trial's session are still alive here.
      // Each snapshot is a detached copy, so seeded.items is still empty.
      return Number(
        environment.sessions.size > 0 &&
          snapshots.seeded?.items.length === 0 &&
          snapshots.afterPurchase?.items.includes(input),
      );
    },
  ],
});
```

With an external emulator, start its shared service in `environment`, register shutdown there, and return its client or connection details.
Create isolated task state in the task, capture the state you want to score, and register its cleanup there.
The eval framework does not require an emulator adapter or know about that service's state representation.

## Names and types come from schemas

The `snapshots` option declares names and Zod schemas; it does not capture anything automatically.
Schemas from both Zod 3 and Zod 4 are supported, including mixed schema maps.
`snapshot(name, value)` validates and copies the parsed value synchronously.
Parsed values must contain only primitives (excluding symbols), arrays, and plain records with enumerable string-keyed data properties.
Class instances, buffers (including shared memory), other built-in objects, functions, and accessor properties are rejected, including when nested.
Convert these values to plain data in a schema transform before capturing them.
Each name can be captured once per trial.
Unknown names, invalid values, duplicate captures, and values that cannot be structured-cloned throw errors identifying the snapshot.
Capture failures omit the original error and its cause because they may contain private snapshot values.

```ts
snapshots: {
  seeded: z.object({ count: z.number() }),
  confirmation: z.string(),
  parsedCount: z.string().transform(Number),
},

task: (input, { snapshot }) => {
  snapshot("seeded", { count: 2 });
  snapshot("confirmation", "order-123");
  snapshot("parsedCount", "42"); // Input type is string.

  // TypeScript rejects these:
  // snapshot("typo", {});
  // snapshot("seeded", "wrong");
  // snapshot("parsedCount", 42);

  return input;
},

scores: [({ snapshots }) => {
  // Output type is number | undefined after the transform.
  return snapshots.parsedCount === 42 ? 1 : 0;
}],
```

Every scorer and classifier receives its own copy of the captured snapshots.
Values are optional because a branch, error, or cancellation may prevent capture.
Without captures, `snapshots` is `{}`.
Shared `environment` values stay live and are not copied.

Neither the live environment nor snapshots are automatically logged, added to scorer span inputs, or returned in `EvalResult`.
The `environment` and `snapshots` properties on scorer and classifier arguments are non-enumerable, so JSON serialization and object spreads omit them, including when passing arguments to remote scorers.
Use the existing span logging APIs to persist selected state explicitly.

## Task resources do not require an environment

Use `onCleanup`, `signal`, and `snapshot` directly in a task even when there is no shared environment factory.
For example, the following task can be used with application-provided `openSession` and `runAgent` functions, and a matching `finalState` schema:

```ts
task: async (input, { onCleanup, snapshot, signal, span }) => {
  const session = await openSession();
  onCleanup(() => session.close());

  try {
    return await runAgent(input, { session, signal });
  } finally {
    const state = await session.readState();
    snapshot("finalState", state);
    span.log({ metadata: { finalState: state } }); // Explicit persistence.
  }
},
```

Use `finally` when you want to capture state even after a task fails.
A failed task still skips ordinary scorers and follows the existing error-score handler behavior.
Capturing a snapshot in `finally` does not change that behavior.

## Lifetime, errors, and cancellation

The environment factory runs once, even when data is empty or filters select no cases.
CLI discovery only registers the evaluator and does not run the factory.
Each task invocation, including each repeated trial, owns a separate cleanup stack.
Task cleanup finishes after scoring and before releasing the concurrency slot.
Shared cleanup runs after all active tasks, scorers, data loading and iteration, and their cleanup have finished.

Cleanup callbacks run in reverse registration order and may be synchronous or asynchronous.
Every callback is awaited, even if another callback fails.
Register callbacks immediately after acquiring resources so partial setup failures still clean up.
A task cleanup failure is recorded on that task's result, preserving existing scores and aggregating any original error.
An environment setup or cleanup failure rejects `Eval`; multiple run and cleanup errors are aggregated.

Timeouts start before environment setup.
Timeouts and external aborts stop pending work and abort the shared cooperative `signal`.
`Eval` waits for active work and cleanup before rejecting, including when there is no environment factory.
Tasks, data sources, or setup functions that ignore cancellation can exceed the timeout.
Cleanup should not depend on an already-aborted signal.

This lifecycle API applies to ordinary `Eval` runs.
Durable `WorkflowEval` does not support environments, snapshots, or these task lifecycle hooks.
