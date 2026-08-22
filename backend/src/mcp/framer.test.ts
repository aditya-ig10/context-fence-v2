import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { JsonRpcFramer, parseFrames, serializeMessage, synthesizeError } from './framer.js';

const MSG_ONE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } };
const MSG_TWO = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/tmp/x' } } };

function buildFramedPair(): Buffer {
  return Buffer.concat([serializeMessage(MSG_ONE), serializeMessage(MSG_TWO)]);
}

test('parseFrames: two concatenated frames parse in order', () => {
  const { messages, rest } = parseFrames(buildFramedPair());
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], MSG_ONE);
  assert.deepEqual(messages[1], MSG_TWO);
  assert.equal(rest.length, 0);
});

test('parseFrames: partial body is preserved as rest', () => {
  const full = buildFramedPair();
  const frameOneLen = serializeMessage(MSG_ONE).length;
  const cut = full.length - 7; // chop 7 bytes off the end of the second frame
  const { messages, rest } = parseFrames(full.subarray(0, cut));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], MSG_ONE);
  assert.equal(rest.length, cut - frameOneLen); // incomplete remainder of frame 2
});

test('JsonRpcFramer: two frames arriving in three fragmented chunks yield exactly two ordered messages', async () => {
  const data = buildFramedPair();
  // Simulate TCP fragmentation: 3 arbitrary splits across the byte stream.
  const splitA = Math.floor(data.length * 0.37);
  const splitB = Math.floor(data.length * 0.71);
  const chunks = [data.subarray(0, splitA), data.subarray(splitA, splitB), data.subarray(splitB)];

  const framer = new JsonRpcFramer();
  const out: unknown[] = [];
  framer.on('data', (m) => out.push(m));

  for (const chunk of chunks) framer.write(chunk);
  framer.end();
  await once(framer, 'end');

  assert.equal(out.length, 2, `expected exactly 2 messages, got ${out.length}`);
  assert.deepEqual(out[0], MSG_ONE);
  assert.deepEqual(out[1], MSG_TWO);
});

test('JsonRpcFramer: byte-by-byte writes still reconstruct the frame', async () => {
  const data = buildFramedPair();
  const framer = new JsonRpcFramer();
  const out: unknown[] = [];
  framer.on('data', (m) => out.push(m));
  for (const byte of data) framer.write(Buffer.from([byte]));
  framer.end();
  await once(framer, 'end');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], MSG_ONE);
});

test('serializeMessage round-trips through parseFrames', () => {
  const wire = serializeMessage(MSG_ONE);
  assert.ok(wire.toString('utf-8').startsWith('Content-Length: '));
  const { messages, rest } = parseFrames(wire);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], MSG_ONE);
  assert.equal(rest.length, 0);
});

test('synthesizeError builds a JSON-RPC error response', () => {
  const err = synthesizeError(7, 'blocked by policy', -32000);
  assert.deepEqual(err, {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32000, message: 'blocked by policy' },
  });
});

test('JsonRpcFramer: truncated stream rejects on flush', async () => {
  const data = serializeMessage(MSG_ONE);
  const framer = new JsonRpcFramer();
  const errs: Error[] = [];
  framer.on('error', (e: Error) => errs.push(e));
  framer.resume(); // consume readable side so flush error can propagate
  const errorPromise = once(framer, 'error');
  framer.write(data.subarray(0, data.length - 3));
  framer.end();
  await errorPromise;
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /Incomplete JSON-RPC frame/);
});
