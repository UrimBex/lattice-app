const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCaptionChunks, chunksToAss } = require("../lib/captions");

test("buildCaptionChunks splits on sentence ends and word limit", () => {
  const chunks = buildCaptionChunks("Hi Ada. This agreement covers the terms of your new contract.", 8);
  assert.equal(chunks[0].text, "Hi Ada.");
  assert.ok(chunks.every((c) => c.text.split(" ").length <= 7));
});

test("buildCaptionChunks paces chunks contiguously across the full duration", () => {
  const chunks = buildCaptionChunks("one two three four five six seven eight nine ten", 10);
  assert.equal(chunks[0].start, 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, chunks[i - 1].end);
  assert.ok(Math.abs(chunks.at(-1).end - 10) < 1e-9);
});

test("buildCaptionChunks returns nothing for empty text or zero duration", () => {
  assert.deepEqual(buildCaptionChunks("", 5), []);
  assert.deepEqual(buildCaptionChunks("hello", 0), []);
});

test("chunksToAss emits explicit resolution and one dialogue line per chunk", () => {
  const ass = chunksToAss([{ text: "Hello", start: 1.5, end: 3.25 }], 1280, 720);
  assert.match(ass, /PlayResX: 1280/);
  assert.match(ass, /PlayResY: 720/);
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:03\.25,Default,,0,0,0,,Hello/);
});
