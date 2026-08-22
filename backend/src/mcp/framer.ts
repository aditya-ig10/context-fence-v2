import { Transform, type TransformCallback } from 'stream';

// MCP stdio transports. Official MCP SDK servers
// (@modelcontextprotocol/server-*, @playwright/mcp) use NEWLINE-delimited
// JSON on stdio, and some print non-JSON banner lines to stdout before the
// first message. This framer therefore auto-detects per stream: if the data
// starts with a Content-Length header it parses LSP-style framing (legacy
// clients/harness), otherwise it splits on newlines and skips non-JSON lines.
//
//   Content-Length: <bytes>\r\n
//   \r\n
//   <json body>
//
// or simply:
//
//   <json body>\n
//
// No external dependencies beyond node built-ins.

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface FrameResult {
  messages: JsonRpcMessage[];
  rest: Buffer;
}

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const CL_HEADER = /^content-length\s*:\s*\d+/i;

/**
 * Parse every complete message in `data` (newline-delimited or
 * Content-Length framed — auto-detected per call), returning the parsed
 * messages in order plus the unconsumed tail bytes (a partial frame).
 */
export function parseFrames(data: Buffer): FrameResult {
  const head = data.subarray(0, 256).toString('utf-8');

  if (!CL_HEADER.test(head.trimStart())) {
    // Newline-delimited JSON (official MCP stdio servers)
    const text = data.toString('utf-8');
    const messages: JsonRpcMessage[] = [];
    let idx = 0;
    let consumed = 0;
    for (;;) {
      const nl = text.indexOf('\n', idx);
      if (nl === -1) break;
      const line = text.slice(idx, nl).trim();
      idx = nl + 1;
      consumed = idx;
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') messages.push(parsed as JsonRpcMessage);
      } catch {
        // Non-JSON line (server banner / progress noise): skip it.
      }
    }
    return { messages, rest: data.subarray(consumed) };
  }

  // Content-Length framed (legacy/harness)
  const messages: JsonRpcMessage[] = [];
  let rest = data;

  for (;;) {
    const headerEnd = rest.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) break; // incomplete header

    const header = rest.subarray(0, headerEnd).toString('utf-8');
    const match = /content-length\s*:\s*(\d+)/i.exec(header);
    if (!match) break; // no Content-Length header: cannot frame, stop

    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    if (rest.length < bodyStart + length) break; // incomplete body

    const body = rest.subarray(bodyStart, bodyStart + length).toString('utf-8');
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch (err) {
      throw new Error(`Failed to parse JSON-RPC frame: ${(err as Error).message}`);
    }
    messages.push(message);
    rest = rest.subarray(bodyStart + length);
  }

  return { messages, rest };
}

/** Serialize a JSON-RPC message into a Content-Length framed buffer. */
export function serializeMessage(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const length = Buffer.byteLength(body, 'utf-8');
  return Buffer.from(`Content-Length: ${length}\r\n\r\n${body}`, 'utf-8');
}

/** Serialize a JSON-RPC message as newline-delimited JSON (official MCP
 *  stdio servers read raw JSON lines from stdin). */
export function serializeMessageLine(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf-8');
}

/** Build a standard JSON-RPC error response (used when a request is denied). */
export function synthesizeError(
  id: number | string | null | undefined,
  message: string,
  code = -32000,
): JsonRpcMessage {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// Deny messages are the ONLY thing an agent's UI relays to the end user when
// the firewall blocks a call. The raw policy reason alone ("Destructive
// command blocked") reads like a server failure; prefixing it makes it
// unambiguous WHO blocked it and that it was deliberate. Deliberately no
// instructions to disable/bypass the firewall — agents may relay the message
// verbatim to an LLM or a non-technical user, and coaching around the block
// would be an autonomous-bypass instruction. Kept short: some agents truncate
// or single-line error messages. All deny paths build through here so the
// wording cannot drift between transports (TCP :3001 / HTTP :3002 / test-mcp).
export function denyMessage(reason: string): string {
  return `Request blocked by Context Fence: ${reason}`;
}

/** JSON-RPC deny error: standard shape (code stays -32000), readable message. */
export function buildDenyError(
  id: number | string | null | undefined,
  reason: string,
): JsonRpcMessage {
  return synthesizeError(id, denyMessage(reason));
}

/**
 * Transform stream: consume raw bytes (child process stdout / stdin side) and
 * yield complete parsed JSON-RPC messages. Object-mode readable; write
 * Buffers, read JsonRpcMessage objects.
 */
export class JsonRpcFramer extends Transform {
  private buf: Buffer = Buffer.alloc(0);

  constructor() {
    super({ objectMode: true, readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback): void {
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const { messages, rest } = parseFrames(Buffer.concat([this.buf, data]));
      this.buf = rest;
      for (const message of messages) this.push(message);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.buf.length > 0) {
      callback(new Error('Incomplete JSON-RPC frame at end of stream'));
      return;
    }
    callback();
  }
}
