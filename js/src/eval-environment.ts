import type { z } from "zod/v3";

export type SnapshotSchemas = Record<string, z.ZodTypeAny>;
export type Snapshots<Schemas extends SnapshotSchemas> = {
  [Name in keyof Schemas]?: z.output<Schemas[Name]>;
};
export type CaptureSnapshot<Schemas extends SnapshotSchemas> = <
  Name extends keyof Schemas & string,
>(
  name: Name,
  value: z.input<Schemas[NoInfer<Name>]>,
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
      this.captured[name] = structuredClone(this.schemas[name].parse(value));
    } catch (cause) {
      throw new Error(`Failed to capture snapshot "${name}"`, { cause });
    }
  };

  copySnapshots(): Record<string, unknown> {
    return structuredClone(this.captured);
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
