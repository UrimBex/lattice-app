const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "tts.ps1");

/**
 * Synthesize `text` to a WAV file using Windows' built-in offline SAPI
 * voices (System.Speech) — no external API/key required. This is the
 * "AI narration" input path: instead of uploading a voice clip, the
 * caller types a script and it becomes the voice layer.
 */
function synthesizeSpeech(text, outWavPath) {
  return new Promise((resolve, reject) => {
    const textFile = outWavPath.replace(/\.wav$/i, ".txt");
    fs.writeFileSync(textFile, text, "utf8");

    const proc = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", SCRIPT_PATH,
        "-TextPath", textFile,
        "-OutPath", outWavPath,
      ],
      { windowsHide: true }
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      fs.unlink(textFile, () => {});
      if (code !== 0) return reject(new Error(`tts synthesis exited ${code}: ${stderr.slice(-500)}`));
      if (!fs.existsSync(outWavPath)) return reject(new Error("tts produced no audio file"));
      resolve(outWavPath);
    });
  });
}

module.exports = { synthesizeSpeech };
