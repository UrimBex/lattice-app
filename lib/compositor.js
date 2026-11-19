const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chunksToAss } = require("./captions");
const { FFMPEG_BIN, FONT_BOLD, checkDependencies } = require("./config");

const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

// -filter_complex_script lets big filter graphs bypass Windows' ~32K command
// line limit (spawn ENAMETOOLONG). Some ffmpeg builds dropped it; those fall
// back to passing the graph inline, which only suits small renders.
const { supportsFilterScript: SUPPORTS_FILTER_SCRIPT } = checkDependencies();
const FONT_BOLD_FF = (FONT_BOLD || "").replace(/\\/g, "/").replace(/:/g, "\\:");

const DATA_DIR = path.join(__dirname, "..", "data");
const W = 1280, H = 720, FPS = 30, DURATION = 10;
const BASE_PLATE = path.join(DATA_DIR, "base_plate.mp4");
const MUSIC_BED = path.join(DATA_DIR, "music_bed.mp3");

// FFmpeg filtergraph string values need ':' escaped (option separator) and
// forward slashes avoid the backslash-escaping mess entirely on Windows paths.
function ffPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// Keep drawtext content to a safe ASCII subset so we don't have to solve
// ffmpeg's quote-within-quote escaping for arbitrary user input.
function sanitizeText(s, maxLen) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[:'%\\,]/g, "")
    .trim()
    .slice(0, maxLen) || "";
}

// Same ASCII-safe stance as sanitizeText, but keeps spaces/punctuation that
// captions actually need; commas are escaped rather than stripped below.
function sanitizeCaption(s, maxLen) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[:'%\\]/g, "")
    .trim()
    .slice(0, maxLen);
}

function probeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ["-i", filePath], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error("could not probe duration of " + filePath));
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
    });
  });
}

/**
 * Burn caption chunks in as ONE `subtitles` filter pass over an SRT file,
 * rather than a separate drawtext filter per chunk. At the scale of a
 * multi-slide presentation (dozens of chunks) chaining that many drawtext
 * nodes measurably slows the whole render down — a single libass pass
 * doesn't have that cost. Returns a tempFile the caller must clean up
 * after the render completes (the file has to exist while ffmpeg runs).
 */
function captionFilters(chunks, videoLabel, clipEndSec) {
  const clipped = chunks
    .map((c) => ({ text: sanitizeCaption(c.text, 90), start: c.start, end: clipEndSec != null ? Math.min(c.end, clipEndSec) : c.end }))
    .filter((c) => c.text && c.start < c.end);
  if (clipped.length === 0) return { filters: [], label: videoLabel, tempFile: null };

  // MarginV=90 in the style clears the page-counter row the contract/
  // presentation templates draw at DOC_Y+DOC_H+16 (~74px above the frame
  // bottom); BackColour alpha 0x33 (~80% opaque) so the box actually reads
  // against a busy gradient background. PlayResX/Y in the file itself
  // (not force_style) is what makes those values land at their literal
  // pixel position instead of being auto-scaled against a guessed res.
  const assPath = path.join(DATA_DIR, `_cap_${Date.now()}_${Math.random().toString(36).slice(2)}.ass`);
  fs.writeFileSync(assPath, chunksToAss(clipped, W, H), "utf8");

  const label = "vcaptioned";
  const filters = [`[${videoLabel}]subtitles='${ffPath(assPath)}'[${label}]`];
  return { filters, label, tempFile: assPath };
}

// Windows caps a process's whole command line at ~32K chars (and Node's
// spawn can throw ENAMETOOLONG well before that on some builds); a
// filter_complex string with many pages/captions can blow past it. Writing
// it to a file and pointing ffmpeg at that sidesteps the limit entirely.
async function runFiltered(preArgs, filters, postArgs) {
  if (!SUPPORTS_FILTER_SCRIPT) {
    await run([...preArgs, "-filter_complex", filters.join(";"), ...postArgs]);
    return;
  }
  const scriptPath = path.join(DATA_DIR, `_fc_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(scriptPath, filters.join(";"), "utf8");
  try {
    await run([...preArgs, "-filter_complex_script", scriptPath, ...postArgs]);
  } finally {
    fs.unlink(scriptPath, () => {});
  }
}

// A render that's still running after this long is almost certainly not
// going to finish in a reasonable time (an oversized filter graph, a
// pathological input) — kill it rather than let it block a 1-worker queue
// indefinitely, and surface a clear error instead of a silent hang.
function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ["-y", ...args], { windowsHide: true });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);

    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`render exceeded ${RENDER_TIMEOUT_MS / 1000}s and was killed — try fewer pages/slides or shorter narration`));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Pre-warm step (architecture doc §3): composite every "static" layer of the
 * template exactly once and cache the result. Every render below starts from
 * this plate instead of re-decoding/re-drawing brand assets per user.
 */
async function prewarmBasePlate() {
  if (fs.existsSync(BASE_PLATE) && fs.existsSync(MUSIC_BED)) return;

  console.log("[prewarm] compositing base plate + music bed (once, cached)...");
  const fontfile = FONT_BOLD_FF;

  // Moving brand gradient + a static wordmark baked in — this is the
  // "static": true portion of the blueprint (§4), rendered exactly once.
  await run([
    "-f", "lavfi",
    "-i", `gradients=size=${W}x${H}:duration=${DURATION}:speed=0.02:x0=250:y0=120:x1=1050:y1=600:c0=0x0d3b2e:c1=0x157f5a:c2=0x0a2620`,
    "-vf", `drawtext=fontfile='${fontfile}':text='LATTICE':fontcolor=0xE7EAED@0.85:fontsize=34:x=48:y=h-80,format=yuv420p`,
    "-t", String(DURATION),
    "-r", String(FPS),
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    BASE_PLATE,
  ]);

  // Ambient pad (three sine tones + slow fades) standing in for a licensed
  // music bed — cached once, ducked per-render when a voice track is present.
  await run([
    "-f", "lavfi", "-i", "sine=frequency=220:duration=" + DURATION,
    "-f", "lavfi", "-i", "sine=frequency=277:duration=" + DURATION,
    "-f", "lavfi", "-i", "sine=frequency=330:duration=" + DURATION,
    "-filter_complex",
    `[0:a][1:a][2:a]amix=inputs=3:duration=first:weights=1 1 1,volume=0.12,afade=t=in:d=1.5,afade=t=out:st=${DURATION - 1.5}:d=1.5[a]`,
    "-map", "[a]",
    "-c:a", "libmp3lame", "-q:a", "4",
    MUSIC_BED,
  ]);
  console.log("[prewarm] done.");
}

/**
 * Composite the dynamic layers for one job on top of the cached plate.
 * variables: { first_name, cta_label, avatarPath?, voicePath? }
 */
async function renderJob(variables, outputPath) {
  const name = sanitizeText(variables.first_name, 24) || "there";
  const cta = sanitizeText(variables.cta_label, 20) || "Get started";
  const fontfileBold = FONT_BOLD_FF;

  const hasAvatar = !!variables.avatarPath;
  const hasVoice = !!variables.voicePath;

  const inputs = ["-i", BASE_PLATE, "-i", MUSIC_BED];
  let nextIdx = 2;
  let avatarIdx = -1, voiceIdx = -1;

  if (hasAvatar) {
    inputs.push("-loop", "1", "-i", variables.avatarPath);
    avatarIdx = nextIdx++;
  }
  if (hasVoice) {
    inputs.push("-i", variables.voicePath);
    voiceIdx = nextIdx++;
  }

  const filters = [];

  // text.name — fades in 0.5s-1.5s, matches the sample blueprint in §4
  filters.push(
    `[0:v]drawtext=fontfile='${fontfileBold}':text='Hi ${name}\\, welcome aboard':` +
    `fontcolor=white:fontsize=52:x=90:y=h-260:` +
    `alpha='if(lt(t\\,0.5)\\,0\\,if(lt(t\\,1.5)\\,(t-0.5)/1.0\\,if(lt(t\\,9.5)\\,1\\,0)))'[vtext]`
  );

  let videoLabel = "vtext";

  // Captions must be composited BEFORE anything that runs a `scale` filter
  // upstream of them (the avatar overlay below does) — see the DOC_H
  // comment above for why.
  let captionTempFile = null;
  if (variables.captionChunks?.length) {
    const { filters: capFilters, label, tempFile } = captionFilters(variables.captionChunks, videoLabel, 8.4);
    filters.push(...capFilters);
    videoLabel = label;
    captionTempFile = tempFile;
  }

  if (hasAvatar) {
    filters.push(`[${avatarIdx}:v]scale=220:220:force_original_aspect_ratio=increase,crop=220:220[avimg]`);
    filters.push(
      `[${videoLabel}][avimg]overlay=x=W-268:y=48:enable='between(t\\,2\\,10)'[vavatar]`
    );
    filters.push(`[vavatar]drawbox=x=iw-270:y=46:w=224:h=224:color=0x3DDC97:t=3:enable='between(t\\,2\\,10)'[vboxed]`);
    videoLabel = "vboxed";
  }

  // end_card — 8.5s-10s
  filters.push(
    `[${videoLabel}]drawtext=fontfile='${fontfileBold}':text='${cta} ->':` +
    `fontcolor=0x3DDC97:fontsize=44:x=(w-text_w)/2:y=h-120:` +
    `enable='between(t\\,8.5\\,10)',format=yuv420p[vout]`
  );

  // audio: duck the music bed under the voice track's window, then mix
  if (hasVoice) {
    filters.push(
      `[1:a]volume=0.3:enable='between(t\\,2\\,5.5)',aformat=sample_rates=44100:channel_layouts=stereo[music]`
    );
    filters.push(
      `[${voiceIdx}:a]adelay=2000:all=1,aformat=sample_rates=44100:channel_layouts=stereo[voice]`
    );
    filters.push(`[music][voice]amix=inputs=2:duration=first:weights=1 1.4[aout]`);
  } else {
    filters.push(`[1:a]aformat=sample_rates=44100:channel_layouts=stereo[aout]`);
  }

  try {
    await runFiltered(inputs, filters, [
      "-map", "[vout]",
      "-map", "[aout]",
      "-t", String(DURATION),
      "-r", String(FPS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } finally {
    if (captionTempFile) fs.unlink(captionTempFile, () => {});
  }
}

const SEC_PER_PAGE = 2.2;
const INTRO = 2.0;
const OUTRO = 2.0;
// DOC_H is deliberately short of the old 560 — it leaves genuine clear
// space below the panel for captions+counter without colliding, now that
// captions must be composited BEFORE the panel overlay (see captionFilters
// callers below: applying `subtitles` downstream of a `scale` filter,
// even indirectly through `overlay`, makes libass silently render nothing
// in this ffmpeg build — confirmed by bisection, and naively "fixing" it
// with an extra `format=` filter made renders hang instead of erroring).
const DOC_W = 420, DOC_H = 460;
const DOC_X = Math.round((W - DOC_W) / 2);
const DOC_Y = 70;

/**
 * Composite a name intro + a page-by-page flythrough of an uploaded PDF +
 * an end card. Unlike renderJob, duration is derived from page count, so
 * the base plate and music bed are looped rather than played once.
 *
 * variables: { first_name, cta_label, pagePaths: string[], voicePath? }
 */
async function renderContractJob(variables, outputPath) {
  const name = sanitizeText(variables.first_name, 24) || "there";
  const cta = sanitizeText(variables.cta_label, 24) || "Review & sign";
  const fontfileBold = FONT_BOLD_FF;

  const pages = variables.pagePaths || [];
  if (pages.length === 0) throw new Error("no pages to render");

  const pageCount = pages.length;
  const docEnd = INTRO + pageCount * SEC_PER_PAGE;
  const totalDuration = docEnd + OUTRO;
  const hasVoice = !!variables.voicePath;

  const inputs = [
    "-stream_loop", "-1", "-i", BASE_PLATE,
    "-stream_loop", "-1", "-i", MUSIC_BED,
  ];
  let nextIdx = 2;
  const pageIdx = [];
  for (const p of pages) {
    inputs.push("-loop", "1", "-i", p);
    pageIdx.push(nextIdx++);
  }
  let voiceIdx = -1;
  if (hasVoice) {
    inputs.push("-i", variables.voicePath);
    voiceIdx = nextIdx++;
  }

  const filters = [];

  // text.name — 0.3s-2.0s, matches the blueprint's text_name layer
  filters.push(
    `[0:v]drawtext=fontfile='${fontfileBold}':text='Hi ${name}\\, here is your contract':` +
    `fontcolor=white:fontsize=40:x=(w-text_w)/2:y=30:` +
    `alpha='if(lt(t\\,0.3)\\,0\\,if(lt(t\\,1)\\,(t-0.3)/0.7\\,if(lt(t\\,2)\\,1\\,0)))'[vtext]`
  );

  let videoLabel = "vtext";

  // Captions must be composited BEFORE the page loop below, which runs a
  // `scale` filter per page — applying `subtitles` downstream of that
  // (even indirectly through `overlay`) makes it silently render nothing
  // in this ffmpeg build. DOC_H leaves genuine clear space below the panel
  // (see its definition) so the page overlay drawn afterward doesn't cover
  // the caption region despite now being layered on top of it.
  let captionTempFile = null;
  if (variables.captionChunks?.length) {
    // clipped to docEnd so captions never overlap the end-card CTA
    const { filters: capFilters, label, tempFile } = captionFilters(variables.captionChunks, videoLabel, docEnd);
    filters.push(...capFilters);
    videoLabel = label;
    captionTempFile = tempFile;
  }

  pages.forEach((_, i) => {
    const start = (INTRO + i * SEC_PER_PAGE).toFixed(2);
    const end = (INTRO + (i + 1) * SEC_PER_PAGE).toFixed(2);
    const scaled = `pg${i}`;
    const overlaid = `vpage${i}`;
    const counted = `vcount${i}`;
    filters.push(
      `[${pageIdx[i]}:v]scale=${DOC_W}:${DOC_H}:force_original_aspect_ratio=decrease,` +
      `pad=${DOC_W}:${DOC_H}:(ow-iw)/2:(oh-ih)/2:color=white[${scaled}]`
    );
    filters.push(
      `[${videoLabel}][${scaled}]overlay=x=${DOC_X}:y=${DOC_Y}:enable='between(t\\,${start}\\,${end})'[${overlaid}]`
    );
    filters.push(
      `[${overlaid}]drawtext=fontfile='${fontfileBold}':text='Page ${i + 1} of ${pageCount}':` +
      `fontcolor=0x9AA4B0:fontsize=20:x=(w-text_w)/2:y=${DOC_Y + DOC_H + 16}:` +
      `enable='between(t\\,${start}\\,${end})'[${counted}]`
    );
    videoLabel = counted;
  });

  // a persistent frame around the document panel for the whole flythrough
  filters.push(
    `[${videoLabel}]drawbox=x=${DOC_X - 4}:y=${DOC_Y - 4}:w=${DOC_W + 8}:h=${DOC_H + 8}:` +
    `color=0x3DDC97:t=3:enable='between(t\\,${INTRO}\\,${docEnd.toFixed(2)})'[vframed]`
  );
  videoLabel = "vframed";

  // end_card — final OUTRO seconds
  filters.push(
    `[${videoLabel}]drawtext=fontfile='${fontfileBold}':text='${cta} ->':` +
    `fontcolor=0x3DDC97:fontsize=44:x=(w-text_w)/2:y=h-100:` +
    `enable='between(t\\,${docEnd.toFixed(2)}\\,${totalDuration.toFixed(2)})',format=yuv420p[vout]`
  );

  // audio: duck the music bed for the whole walkthrough when narration is present
  if (hasVoice) {
    filters.push(
      `[1:a]volume=0.3:enable='between(t\\,0.5\\,${(totalDuration - 0.5).toFixed(2)})',` +
      `aformat=sample_rates=44100:channel_layouts=stereo[music]`
    );
    filters.push(
      `[${voiceIdx}:a]adelay=500:all=1,aformat=sample_rates=44100:channel_layouts=stereo[voice]`
    );
    filters.push(`[music][voice]amix=inputs=2:duration=first:weights=1 1.4[aout]`);
  } else {
    filters.push(`[1:a]aformat=sample_rates=44100:channel_layouts=stereo[aout]`);
  }

  try {
    await runFiltered(inputs, filters, [
      "-map", "[vout]",
      "-map", "[aout]",
      "-t", totalDuration.toFixed(2),
      "-r", String(FPS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } finally {
    if (captionTempFile) fs.unlink(captionTempFile, () => {});
  }
  return { totalDuration, pageCount };
}

const PRES_OUTRO = 2.0;

/**
 * PDF-deck presentation: each slide gets its own on-screen duration sized
 * to its own narration clip (not a fixed per-page slot like the contract
 * template). Per-slide audio clips are concatenated back to back via the
 * `concat` filter so the video and audio timelines derive from the same
 * per-slide durations by construction — they can't drift out of sync.
 *
 * variables: {
 *   title?, ctaLabel,
 *   pages: [{ imagePath, wavPath: string|null, durationSec, captionChunks?: [{text,start,end}] }]
 * }
 * start/end in each page's captionChunks are relative to that page's own start.
 */
async function renderPresentationJob(variables, outputPath) {
  const title = sanitizeText(variables.title, 60);
  const cta = sanitizeText(variables.ctaLabel, 30) || "Thanks for watching!";
  const fontfileBold = FONT_BOLD_FF;

  const pages = variables.pages || [];
  if (pages.length === 0) throw new Error("no slides to render");

  const INTRO_LOCAL = title ? 1.5 : 0;
  let cursor = INTRO_LOCAL;
  const pageWindows = pages.map((p) => {
    const start = cursor;
    cursor += p.durationSec;
    return { start, end: cursor };
  });
  const docEnd = cursor;
  const totalDuration = docEnd + PRES_OUTRO;
  const hasAnyVoice = pages.some((p) => !!p.wavPath);

  const inputs = [
    "-stream_loop", "-1", "-i", BASE_PLATE,
    "-stream_loop", "-1", "-i", MUSIC_BED,
  ];
  let nextIdx = 2;
  const pageImgIdx = [];
  const pageAudioIdx = [];
  for (const p of pages) {
    inputs.push("-loop", "1", "-i", p.imagePath);
    pageImgIdx.push(nextIdx++);
    if (p.wavPath) {
      inputs.push("-i", p.wavPath);
      pageAudioIdx.push(nextIdx++);
    } else {
      pageAudioIdx.push(-1);
    }
  }

  const filters = [];
  let videoLabel = "0:v";

  if (title) {
    filters.push(
      `[0:v]drawtext=fontfile='${fontfileBold}':text='${title}':` +
      `fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2:` +
      `alpha='if(lt(t\\,0.9)\\,1\\,if(lt(t\\,${INTRO_LOCAL})\\,1-(t-0.9)/${(INTRO_LOCAL - 0.9).toFixed(2)}\\,0))'[vtitle]`
    );
    videoLabel = "vtitle";
  }

  // flatten each page's own caption chunks (already page-relative) into one
  // absolute-time list, clipped so a caption never bleeds into the next slide
  const allCaptionChunks = [];
  pages.forEach((p, i) => {
    for (const c of p.captionChunks || []) {
      const start = pageWindows[i].start + c.start;
      const end = Math.min(pageWindows[i].start + c.end, pageWindows[i].end);
      if (start < end) allCaptionChunks.push({ text: c.text, start, end });
    }
  });

  // Captions must be composited BEFORE the page loop below, which runs a
  // `scale` filter per slide — applying `subtitles` downstream of that
  // (even indirectly through `overlay`) makes it silently render nothing
  // in this ffmpeg build. DOC_H leaves genuine clear space below the panel
  // so the page overlay drawn afterward doesn't cover the caption region
  // despite now being layered on top of it.
  let captionTempFile = null;
  if (allCaptionChunks.length) {
    const { filters: capFilters, label, tempFile } = captionFilters(allCaptionChunks, videoLabel, docEnd);
    filters.push(...capFilters);
    videoLabel = label;
    captionTempFile = tempFile;
  }

  pages.forEach((_, i) => {
    const { start, end } = pageWindows[i];
    const scaled = `pg${i}`, overlaid = `vpage${i}`, counted = `vcount${i}`;
    filters.push(
      `[${pageImgIdx[i]}:v]scale=${DOC_W}:${DOC_H}:force_original_aspect_ratio=decrease,` +
      `pad=${DOC_W}:${DOC_H}:(ow-iw)/2:(oh-ih)/2:color=white[${scaled}]`
    );
    filters.push(
      `[${videoLabel}][${scaled}]overlay=x=${DOC_X}:y=${DOC_Y}:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'[${overlaid}]`
    );
    filters.push(
      `[${overlaid}]drawtext=fontfile='${fontfileBold}':text='Slide ${i + 1} of ${pages.length}':` +
      `fontcolor=0x9AA4B0:fontsize=20:x=(w-text_w)/2:y=${DOC_Y + DOC_H + 16}:` +
      `enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'[${counted}]`
    );
    videoLabel = counted;
  });

  filters.push(
    `[${videoLabel}]drawbox=x=${DOC_X - 4}:y=${DOC_Y - 4}:w=${DOC_W + 8}:h=${DOC_H + 8}:` +
    `color=0x3DDC97:t=3:enable='between(t\\,${INTRO_LOCAL}\\,${docEnd.toFixed(2)})'[vframed]`
  );
  videoLabel = "vframed";

  filters.push(
    `[${videoLabel}]drawtext=fontfile='${fontfileBold}':text='${cta}':` +
    `fontcolor=0x3DDC97:fontsize=40:x=(w-text_w)/2:y=h-100:` +
    `enable='between(t\\,${docEnd.toFixed(2)}\\,${totalDuration.toFixed(2)})',format=yuv420p[vout]`
  );

  // audio: build one per-slide segment each trimmed/padded to exactly that
  // slide's duration (silence for un-narrated slides), then concat them —
  // the resulting track is time-aligned to the video by construction.
  // Skipped entirely when no slide has narration (nothing to concat, and
  // an unused concat output is itself an ffmpeg error).
  if (hasAnyVoice) {
    pages.forEach((p, i) => {
      const dur = p.durationSec.toFixed(2);
      if (pageAudioIdx[i] >= 0) {
        filters.push(
          `[${pageAudioIdx[i]}:a]atrim=0:${dur},apad=whole_dur=${dur},` +
          `aformat=sample_rates=44100:channel_layouts=mono[aseg${i}]`
        );
      } else {
        filters.push(`anullsrc=channel_layout=mono:sample_rate=44100,atrim=0:${dur}[aseg${i}]`);
      }
    });
    filters.push(`${pages.map((_, i) => `[aseg${i}]`).join("")}concat=n=${pages.length}:v=0:a=1[narr]`);

    filters.push(
      `[1:a]volume=0.3:enable='between(t\\,${INTRO_LOCAL}\\,${(totalDuration - 0.5).toFixed(2)})',` +
      `aformat=sample_rates=44100:channel_layouts=stereo[music]`
    );
    filters.push(`[narr]adelay=${Math.round(INTRO_LOCAL * 1000)}:all=1,aformat=sample_rates=44100:channel_layouts=stereo[voice]`);
    filters.push(`[music][voice]amix=inputs=2:duration=first:weights=1 1.4[aout]`);
  } else {
    filters.push(`[1:a]aformat=sample_rates=44100:channel_layouts=stereo[aout]`);
  }

  try {
    await runFiltered(inputs, filters, [
      "-map", "[vout]",
      "-map", "[aout]",
      "-t", totalDuration.toFixed(2),
      "-r", String(FPS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } finally {
    if (captionTempFile) fs.unlink(captionTempFile, () => {});
  }
  return { totalDuration, pageCount: pages.length };
}

module.exports = {
  prewarmBasePlate,
  renderJob,
  renderContractJob,
  renderPresentationJob,
  sanitizeText,
  probeDurationSeconds,
  DURATION,
  W,
  H,
  FPS,
};
