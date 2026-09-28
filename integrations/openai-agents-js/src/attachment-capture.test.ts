import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "braintrust";
import { OpenAIAgentsTraceProcessor } from "./index";
import type { AgentsSpan, AgentsTrace } from "./types";

let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(() => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  background = _exportsForTestingOnly.useTestBackgroundLogger();
});
afterEach(() => {
  _exportsForTestingOnly.clearTestBackgroundLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "uses the owning audio policy (%s) for child and root spans",
  async (captureAttachments) => {
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-audio-capture",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const decode = vi.spyOn(globalThis, "atob");
    for (const type of ["transcription", "speech"] as const) {
      const trace: AgentsTrace = {
        type: "trace",
        traceId: type,
        name: type,
        groupId: null,
      };
      const readData = vi.fn(() => "AQID");
      const audio = {
        get data() {
          return readData();
        },
        format: "pcm",
      };
      const span: AgentsSpan = {
        type: "trace.span",
        traceId: type,
        spanId: `${type}-span`,
        parentId: null,
        startedAt: null,
        endedAt: null,
        error: null,
        spanData:
          type === "speech"
            ? { type, input: "Hello", output: audio }
            : { type, input: audio, output: "Hello" },
      };
      await processor.onTraceStart(trace);
      await processor.onSpanStart(span);
      initLogger({ ...options, captureAttachments: !captureAttachments });
      await processor.onSpanEnd(span);
      const metadata = processor._traceSpans.get(type)?.metadata;
      const expected = {
        format: "pcm",
        ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
      };
      expect(
        type === "speech" ? metadata?.lastOutput : metadata?.firstInput,
      ).toEqual(expected);
      await processor.onTraceEnd(trace);
      const rows = await background.drain();
      const field = type === "speech" ? "output" : "input";
      const audioRows = rows.filter((row) => {
        const value = row[field as keyof typeof row];
        return value && typeof value === "object" && "format" in value;
      });
      expect(audioRows).toHaveLength(2);
      for (const row of audioRows) expect(row).toHaveProperty(field, expected);
      expect(
        rows.some((row) =>
          type === "speech"
            ? "input" in row && row.input === "Hello"
            : "output" in row && row.output === "Hello",
        ),
      ).toBe(true);
      if (!captureAttachments) {
        expect(readData).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        expect(JSON.stringify(rows)).not.toContain("AQID");
      }
    }
  },
);

it.each([true, false])(
  "uses its local logger policy (%s) when trace events arrive outside the original context",
  async (captureAttachments) => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", String(!captureAttachments));
    const options = {
      projectId: "test-project-id",
      projectName: "tmp-luca-agents-capture",
    };
    const logger = initLogger({
      ...options,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace: AgentsTrace = {
      type: "trace",
      traceId: "trace",
      name: "test trace",
      groupId: null,
    };
    const span: AgentsSpan = {
      type: "trace.span",
      traceId: "trace",
      spanId: "response",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: "response",
        _input: [{ type: "input_image", image: "data:image/png;base64,AQID" }],
        _response: {
          output: [{ type: "image_generation_call", result: "AQID" }],
        },
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...options, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    await processor.onTraceEnd(trace);
    const payload = JSON.stringify(await background.drain());
    if (captureAttachments) expect(payload).toContain("braintrust_attachment");
    else {
      expect(payload).not.toContain("input_image");
      expect(payload).not.toContain("image_generation_call");
      expect(payload).not.toContain("AQID");
      expect(payload).not.toContain("braintrust_attachment");
    }
  },
);
