const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

// Depth-limited search for an executable inside a directory tree.
function findFile(dir, fileName, depth = 5) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFile(path.join(dir, e.name), fileName, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function wingetPackageDirs(prefix) {
  const root = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    return fs
      .readdirSync(root)
      .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((n) => path.join(root, n));
  } catch {
    return [];
  }
}

function resolveBinary({ envVar, exeName, wingetPrefixes = [] }) {
  if (process.env[envVar]) return process.env[envVar];
  if (IS_WIN) {
    for (const prefix of wingetPrefixes) {
      for (const dir of wingetPackageDirs(prefix)) {
        const hit = findFile(dir, exeName + EXE);
        if (hit) return hit;
      }
    }
  }
  return exeName; // fall back to PATH
}

// Winget's "Gyan.FFmpeg" package tracks a git/master snapshot that dropped
// -filter_complex_script, so prefer the BtbN release builds when present.
const FFMPEG_BIN = resolveBinary({
  envVar: "FFMPEG_PATH",
  exeName: "ffmpeg",
  wingetPrefixes: ["BtbN.FFmpeg.GPL", "BtbN.FFmpeg.LGPL", "Gyan.FFmpeg"],
});

const POPPLER_PREFIXES = ["oschwartz10612.Poppler"];
const PDFTOPPM_BIN = resolveBinary({ envVar: "PDFTOPPM_PATH", exeName: "pdftoppm", wingetPrefixes: POPPLER_PREFIXES });
const PDFTOTEXT_BIN = resolveBinary({ envVar: "PDFTOTEXT_PATH", exeName: "pdftotext", wingetPrefixes: POPPLER_PREFIXES });

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

const FONT_BOLD =
  process.env.FONT_BOLD ||
  firstExisting([
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ]);

// Run `bin args` and return its combined output, or null if it can't start.
function probe(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return null;
  return `${r.stdout || ""}${r.stderr || ""}`;
}

/**
 * Verify external tools once at startup so a missing dependency produces a
 * clear message instead of a cryptic spawn error on the first render.
 */
let cachedCheck = null;
function checkDependencies() {
  if (cachedCheck) return cachedCheck;
  const problems = [];

  const ffmpegHelp = probe(FFMPEG_BIN, ["-hide_banner", "-h", "full"]);
  let supportsFilterScript = false;
  if (ffmpegHelp === null) {
    problems.push(`ffmpeg not found (looked for "${FFMPEG_BIN}"). Install FFmpeg or set FFMPEG_PATH.`);
  } else {
    supportsFilterScript = ffmpegHelp.includes("-filter_complex_script");
    const filters = probe(FFMPEG_BIN, ["-hide_banner", "-filters"]) || "";
    if (!/\bsubtitles\b/.test(filters)) {
      problems.push("this ffmpeg build lacks the 'subtitles' filter (libass) — captions will fail.");
    }
  }

  for (const [name, bin] of [["pdftoppm", PDFTOPPM_BIN], ["pdftotext", PDFTOTEXT_BIN]]) {
    if (probe(bin, ["-v"]) === null) {
      problems.push(`${name} not found (looked for "${bin}"). Install Poppler or set PDFTOPPM_PATH/PDFTOTEXT_PATH.`);
    }
  }

  if (!FONT_BOLD) problems.push("no bold TTF font found for on-video text — set FONT_BOLD to a .ttf path.");
  if (!IS_WIN) problems.push("text-to-speech narration uses Windows SAPI and is unavailable on this platform.");

  cachedCheck = { problems, supportsFilterScript };
  return cachedCheck;
}

module.exports = { FFMPEG_BIN, PDFTOPPM_BIN, PDFTOTEXT_BIN, FONT_BOLD, IS_WIN, checkDependencies };
