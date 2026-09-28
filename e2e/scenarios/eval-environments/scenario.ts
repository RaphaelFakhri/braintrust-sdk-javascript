import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Eval, initLogger } from "braintrust";
import { z } from "zod/v3";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const scenario = "eval-environments";
  const logger = initLogger({
    projectName: scopedName("tmp-luca-eval-environments", testRunId),
  });
  const sessions = new Map<string, { count: number }>();
  let serviceClosed = false;
  let setupCount = 0;
  let scored = 0;
  await logger.traced(
    async (root) => {
      const result = await Eval(
        "environment resources",
        {
          state: logger.loggingState,
          data: [1, 2].map((input) => ({
            input,
            metadata: { scenario, testRunId },
          })),
          trialCount: 2,
          maxConcurrency: 2,
          environment: async ({ onCleanup }) => {
            setupCount++;
            // Stateless shared API; each trial supplies its own session identifier.
            const server = createServer((req, res) => {
              const session = sessions.get(req.url!.slice(1));
              if (!session) {
                res.writeHead(404).end();
                return;
              }
              session.count++;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify(session));
            });
            onCleanup(async () => {
              assert.equal(sessions.size, 0);
              await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
              serviceClosed = true;
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            assert(address && typeof address !== "string");
            return {
              baseUrl: `http://127.0.0.1:${address.port}`,
              isOpen: () => server.listening,
              // If environment ever gets serialized, the scenario must fail.
              toJSON() {
                throw new Error("Live environment must not be logged");
              },
            };
          },
          snapshots: {
            seeded: z.object({ count: z.number() }),
            afterRequest: z.object({ count: z.number() }),
            unused: z.string(),
          },
          task: async (
            input,
            { environment, trialIndex, onCleanup, snapshot },
          ) => {
            const id = `${input}-${trialIndex}`;
            const state = { count: input };
            sessions.set(id, state);
            onCleanup(() => {
              assert(environment.isOpen());
              sessions.delete(id);
            });
            snapshot("seeded", state);
            const response = await fetch(`${environment.baseUrl}/${id}`);
            assert(response.ok);
            snapshot("afterRequest", state);
            return (await response.json()).count as number;
          },
          scores: [
            function stateChanged({ input, output, snapshots, environment }) {
              assert(environment.isOpen());
              assert.equal(snapshots.seeded?.count, input);
              assert.equal(snapshots.afterRequest?.count, input + 1);
              assert.equal(snapshots.unused, undefined);
              assert.equal(output, input + 1);
              snapshots.seeded!.count = -1;
              scored++;
              return 1;
            },
            async function independentCopy(args) {
              const { input, snapshots } = args;
              await Promise.resolve();
              assert.equal(snapshots.seeded?.count, input);
              const serialized = JSON.parse(JSON.stringify(args));
              assert.equal("environment" in serialized, false);
              assert.equal("snapshots" in serialized, false);
              assert.equal(serialized.input, input);
              return 1;
            },
          ],
          classifiers: [
            function completed(args) {
              const { snapshots, input } = args;
              assert.equal(snapshots.seeded?.count, input);
              const serialized = JSON.parse(JSON.stringify(args));
              assert.equal("environment" in serialized, false);
              assert.equal("snapshots" in serialized, false);
              return { name: "completion", id: "done", label: "Done" };
            },
          ],
        },
        { parent: await root.export() },
      );
      assert.equal(setupCount, 1);
      assert.equal(scored, 4);
      assert.equal(serviceClosed, true);
      assert.equal(result.results.length, 4);
      for (const item of result.results) {
        assert.equal(item.error, undefined);
        assert.deepEqual(item.scores, { stateChanged: 1, independentCopy: 1 });
        assert.deepEqual(item.classifications?.completion, [
          { id: "done", label: "Done" },
        ]);
        assert.equal("environment" in item, false);
        assert.equal("snapshots" in item, false);
      }
      root.log({
        output: { trials: 4, serviceClosed, sessionsRemaining: sessions.size },
      });
    },
    { name: "environment-root", event: { metadata: { scenario, testRunId } } },
  );
  await logger.traced(
    async (root) => {
      const result = await Eval(
        "cleanup failures",
        {
          state: logger.loggingState,
          data: [{ input: "cleanup failure" }],
          task: (_, { onCleanup }) => {
            onCleanup(() => {
              throw new Error("session cleanup failed", {
                cause: new Error("service disconnected"),
              });
            });
            throw new Error("task operation failed");
          },
          scores: [],
        },
        { parent: await root.export() },
      );
      assert(result.results[0].error instanceof AggregateError);
    },
    {
      name: "cleanup-failure-root",
      event: { metadata: { scenario, testRunId } },
    },
  );
  await logger.flush();
}

runMain(main);
