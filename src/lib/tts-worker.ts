// ---- Message type interfaces (importable by main thread) ----

export interface InitMessage {
  type: "init";
  model?: string;
  dtype?: string;
  device?: string;
}

export interface GenerateMessage {
  type: "generate";
  id: number;
  text: string;
  voice?: string;
  speed?: number;
}

export interface StreamMessage {
  type: "stream";
  text: string;
  voice?: string;
  speed?: number;
}

export interface CancelMessage {
  type: "cancel";
}

export interface ListVoicesMessage {
  type: "list-voices";
}

export type WorkerIncoming =
  | InitMessage
  | GenerateMessage
  | StreamMessage
  | CancelMessage
  | ListVoicesMessage;

export interface ReadyMessage {
  type: "ready";
  voices: string[];
  device: string;
}

export interface ProgressMessage {
  type: "progress";
  progress: number;
}

export interface DeviceMessage {
  type: "device";
  device: string;
}

export interface AudioMessage {
  type: "audio";
  id: number;
  audio: Float32Array;
  sampleRate: number;
}

/** Streaming chunk — one sentence worth of audio */
export interface StreamChunkMessage {
  type: "stream-chunk";
  index: number;
  text: string;
  audio: Float32Array;
  sampleRate: number;
}

export interface StreamDoneMessage {
  type: "stream-done";
  totalChunks: number;
}

export interface VoicesMessage {
  type: "voices";
  voices: string[];
}

export interface ErrorMessage {
  type: "error";
  id?: number;
  error: string;
}

export type WorkerOutgoing =
  | ReadyMessage
  | ProgressMessage
  | DeviceMessage
  | AudioMessage
  | StreamChunkMessage
  | StreamDoneMessage
  | VoicesMessage
  | ErrorMessage;

// ---- Worker implementation ----
// Matches the architecture from https://github.com/xenova/kokoro-web

import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const DEFAULT_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

let tts: KokoroTTS | null = null;
let cancelStream = false;

/** Detect WebGPU availability */
async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

// FIFO queue for generate requests
interface QueueEntry {
  id: number;
  text: string;
  voice: string;
  speed: number;
}

const queue: QueueEntry[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing || queue.length === 0 || !tts) return;
  processing = true;

  while (queue.length > 0) {
    const { id, text, voice, speed } = queue.shift()!;
    try {
      const t0 = performance.now();
      const result = await tts.generate(text, { voice: voice as any, speed });
      console.log(
        `[TTS Worker] id=${id} ${(performance.now() - t0).toFixed(0)}ms, ${result.audio?.length} samples`
      );
      const msg: AudioMessage = {
        type: "audio",
        id,
        audio: result.audio,
        sampleRate: result.sampling_rate,
      };
      self.postMessage(msg, [result.audio.buffer] as any);
    } catch (err: any) {
      const msg: ErrorMessage = {
        type: "error",
        id,
        error: err?.message ?? String(err),
      };
      self.postMessage(msg);
    }
  }

  processing = false;
}

/** Stream-generate long text, sending chunks as they're produced */
async function streamGenerate(
  text: string,
  voice: string,
  speed: number
): Promise<void> {
  if (!tts) throw new Error("TTS not initialized");
  cancelStream = false;

  const streamer = new TextSplitterStream();
  streamer.push(text);
  streamer.close();

  const stream = tts.stream(streamer, { voice: voice as any, speed });
  let index = 0;

  for await (const { text: chunkText, audio } of stream) {
    if (cancelStream) break;

    const pcm = audio.audio; // Float32Array
    const sr = audio.sampling_rate;

    const msg: StreamChunkMessage = {
      type: "stream-chunk",
      index,
      text: chunkText,
      audio: pcm,
      sampleRate: sr,
    };
    self.postMessage(msg, [pcm.buffer] as any);
    index++;
  }

  if (!cancelStream) {
    const msg: StreamDoneMessage = { type: "stream-done", totalChunks: index };
    self.postMessage(msg);
  }
}

self.onmessage = async (e: MessageEvent<WorkerIncoming>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      try {
        // Auto-detect device like kokoro-web
        const hasWebGPU = await detectWebGPU();
        const device = msg.device ?? (hasWebGPU ? "webgpu" : "wasm");
        const dtype = msg.dtype ?? (device === "wasm" ? "q8" : "fp32");
        const model = msg.model ?? DEFAULT_MODEL;

        const deviceMsg: DeviceMessage = { type: "device", device };
        self.postMessage(deviceMsg);

        tts = await KokoroTTS.from_pretrained(model, {
          dtype,
          device,
          progress_callback: (progress: any) => {
            if (typeof progress?.progress === "number") {
              const out: ProgressMessage = {
                type: "progress",
                progress: progress.progress,
              };
              self.postMessage(out);
            }
          },
        } as any);

        const voices = Object.keys(tts.voices);
        const out: ReadyMessage = { type: "ready", voices, device };
        self.postMessage(out);
      } catch (err: any) {
        const out: ErrorMessage = {
          type: "error",
          error: err?.message ?? String(err),
        };
        self.postMessage(out);
      }
      break;
    }

    case "generate": {
      queue.push({
        id: msg.id,
        text: msg.text,
        voice: msg.voice ?? DEFAULT_VOICE,
        speed: msg.speed ?? 1.0,
      });
      processQueue();
      break;
    }

    case "stream": {
      try {
        await streamGenerate(
          msg.text,
          msg.voice ?? DEFAULT_VOICE,
          msg.speed ?? 1.0
        );
      } catch (err: any) {
        const out: ErrorMessage = {
          type: "error",
          error: err?.message ?? String(err),
        };
        self.postMessage(out);
      }
      break;
    }

    case "cancel": {
      cancelStream = true;
      break;
    }

    case "list-voices": {
      if (!tts) {
        const out: ErrorMessage = {
          type: "error",
          error: "TTS not initialized",
        };
        self.postMessage(out);
        return;
      }
      try {
        const voices = Object.keys(tts.voices);
        const out: VoicesMessage = { type: "voices", voices };
        self.postMessage(out);
      } catch (err: any) {
        const out: ErrorMessage = {
          type: "error",
          error: err?.message ?? String(err),
        };
        self.postMessage(out);
      }
      break;
    }
  }
};
