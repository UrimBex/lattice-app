/**
 * Split narration text into caption chunks and place them proportionally
 * across the synthesized clip's real duration (by word-count fraction).
 * This is a pacing approximation, not phoneme-level alignment — good
 * enough to read along with SAPI's fairly even cadence, not frame-exact.
 */
function buildCaptionChunks(text, durationSec, maxWordsPerChunk = 7) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSec <= 0) return [];

  const groups = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWordsPerChunk || /[.!?]$/.test(w)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  const totalWords = words.length;
  let seen = 0;
  return groups.map((g) => {
    const start = (seen / totalWords) * durationSec;
    seen += g.length;
    const end = (seen / totalWords) * durationSec;
    return { text: g.join(" "), start, end };
  });
}

function pad(n, len) {
  return String(n).padStart(len, "0");
}

function assTimestamp(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/**
 * Render caption chunks as a self-contained .ass file with an explicit
 * PlayResX/Y and style — burning one `subtitles` filter pass is far
 * cheaper than chaining a separate drawtext filter per chunk (dozens of
 * chunks in a multi-slide presentation measurably slowed renders down).
 * Writing real ASS instead of SRT+force_style is deliberate: libass's
 * SRT-to-ASS conversion picks its own default script resolution, which
 * makes force_style's MarginV/Fontsize scale unpredictably against the
 * actual video size. An explicit PlayResX/Y removes that guesswork.
 */
function chunksToAss(chunks, width, height) {
  const header =
    `[Script Info]\n` +
    `ScriptType: v4.00+\n` +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n` +
    `\n[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    // BorderStyle=3 draws an opaque box instead of a text outline; its
    // width comes from the Outline field (not a separate "box" setting) —
    // Outline=0 collapses that box to nothing, so it's set to 4 here.
    `Style: Default,Segoe UI,28,&H00FFFFFF,&H000000FF,&H00000000,&H33221C18,0,0,0,0,100,100,0,0,3,4,0,2,20,20,20,1\n` +
    `\n[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const lines = chunks.map(
    (c) => `Dialogue: 0,${assTimestamp(c.start)},${assTimestamp(c.end)},Default,,0,0,0,,${c.text}`
  );
  return header + lines.join("\n") + "\n";
}

module.exports = { buildCaptionChunks, chunksToAss };
