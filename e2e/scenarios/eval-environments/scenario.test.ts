import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findAllSpans, findLatestSpan } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

test("shared environment and named snapshots survive through scoring and are cleaned up", async () => {
  await withScenarioHarness(
    async ({ runScenarioDir, events, testRunEvents }) => {
      await runScenarioDir({
        scenarioDir,
        runContext: { variantKey: "default", originalScenarioDir },
      });
      const root = findLatestSpan(testRunEvents(), "environment-root");
      expect(root?.row.output).toEqual({
        trials: 4,
        serviceClosed: true,
        sessionsRemaining: 0,
      });
      const evals = findAllSpans(events(), "eval");
      expect(evals).toHaveLength(5);
      for (const scorerName of ["stateChanged", "independentCopy"]) {
        const scorers = findAllSpans(events(), scorerName);
        expect(scorers).toHaveLength(4);
        for (const scorer of scorers) {
          expect(scorer.row.scores).toEqual({ [scorerName]: 1 });
          expect(scorer.row.input).not.toHaveProperty("environment");
          expect(scorer.row.input).not.toHaveProperty("snapshots");
          expect(scorer.row.error).toBeUndefined();
        }
      }
      const serialized = JSON.stringify(events());
      expect(serialized).not.toContain('"seeded"');
      expect(serialized).not.toContain('"afterRequest"');
      expect(serialized).not.toContain('"baseUrl"');
      for (const event of evals) {
        if (event.row.input === "cleanup failure") {
          expect(event.row.error).toContain("task operation failed");
          expect(event.row.error).toContain("session cleanup failed");
          expect(event.row.error).toContain("service disconnected");
        } else {
          expect(event.row.error).toBeUndefined();
        }
      }
      expect(
        evals.filter((event) => event.row.input === "cleanup failure"),
      ).toHaveLength(1);
    },
  );
});
