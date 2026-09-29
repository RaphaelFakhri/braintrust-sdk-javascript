import type * as z3 from "zod/v3";
import type * as z4 from "zod/v4";

export type SnapshotSchemas = Record<string, z3.ZodTypeAny | z4.ZodType>;
export type Snapshots<Schemas extends SnapshotSchemas> = {
  [Name in keyof Schemas]?: Schemas[Name]["_output"];
};
export type CaptureSnapshot<Schemas extends SnapshotSchemas> = <
  Name extends keyof Schemas & string,
>(
  name: Name,
  value: Schemas[NoInfer<Name>]["_input"],
) => void;

export interface CleanupContext {
  /** Register immediately after acquiring a resource. Callbacks run in reverse order. */
  onCleanup: (callback: () => void | Promise<void>) => void;
  /** Cooperative cancellation. Cleanup should not depend on this signal. */
  signal: AbortSignal;
}

/** A run or trial's resources. Trial scopes also own their captured state. */
export class EvalScope {
  private callbacks: Array<() => void | Promise<void>> = [];
  private closed = false;
  private captured: Record<string, unknown> = Object.create(null);

  constructor(private readonly schemas: SnapshotSchemas = {}) {}

  onCleanup = (callback: () => void | Promise<void>): void => {
    if (this.closed) throw new Error("Eval cleanup scope is already closed");
    this.callbacks.push(callback);
  };

  snapshot = (name: string, value: unknown): void => {
    if (this.closed) {
      throw new Error(`Cannot capture snapshot "${name}": scope is closed`);
    }
    if (!Object.hasOwn(this.schemas, name)) {
      throw new Error(`Unknown snapshot "${name}"`);
    }
    if (Object.hasOwn(this.captured, name)) {
      throw new Error(`Snapshot "${name}" has already been captured`);
    }
    try {
      const parsed = this.schemas[name].parse(value);
      const pending: unknown[] = [parsed];
      const seen = new Set<object>();
      for (const current of pending) {
        if (current === null || typeof current !== "object") continue;
        if (seen.has(current)) continue;
        seen.add(current);
        // Structured cloning can erase class types or retain shared memory.
        // Only accept plain data, including nested values and cyclic records.
        const prototype = Object.getPrototypeOf(current);
        if (
          prototype !== Object.prototype &&
          prototype !== null &&
          !(Array.isArray(current) && prototype === Array.prototype)
        ) {
          throw new Error(
            "Snapshots only support primitives, arrays, and plain records",
          );
        }
        for (const key of Reflect.ownKeys(current)) {
          if (Array.isArray(current) && key === "length") continue;
          const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
          if (
            typeof key === "symbol" ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new Error(
              "Snapshot properties must be enumerable string-keyed data properties",
            );
          }
          pending.push(descriptor.value);
        }
      }
      this.captured[name] = structuredClone(parsed);
    } catch {
      // Validation, transforms, and cloning can include private values in their
      // errors. Causes are automatically logged, so only expose the snapshot name.
      throw new Error(`Failed to capture snapshot "${name}"`);
    }
  };

  copySnapshots(): Record<string, unknown> {
    // Structured cloning replaces the null prototype with Object.prototype.
    return Object.setPrototypeOf(structuredClone(this.captured), null);
  }

  async close(): Promise<unknown[]> {
    this.closed = true;
    const errors: unknown[] = [];
    for (const callback of this.callbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
    this.callbacks = [];
    return errors;
  }
}
