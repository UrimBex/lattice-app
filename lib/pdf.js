const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { PDFTOPPM_BIN, PDFTOTEXT_BIN } = require("./config");

/**
 * Rasterize the first `maxPages` pages of a PDF into PNGs.
 * Returns an ordered array of absolute file paths, one per page.
 */
function pdfToPageImages(pdfPath, outDir, maxPages) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const prefix = path.join(outDir, "page");
    const proc = spawn(
      PDFTOPPM_BIN,
      ["-png", "-r", "110", "-f", "1", "-l", String(maxPages), pdfPath, prefix],
      { windowsHide: true }
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        return reject(new Error(`pdftoppm exited ${code}: ${stderr.slice(-500)}`));
      }
      const files = fs
        .readdirSync(outDir)
        .filter((f) => f.startsWith("page") && f.endsWith(".png"))
        .sort((a, b) => {
          const na = parseInt(a.match(/-(\d+)\.png$/)?.[1] || "0", 10);
          const nb = parseInt(b.match(/-(\d+)\.png$/)?.[1] || "0", 10);
          return na - nb;
        })
        .map((f) => path.join(outDir, f));
      if (files.length === 0) return reject(new Error("PDF produced no renderable pages"));
      resolve(files);
    });
  });
}

/**
 * Extract the plain text of a single PDF page — used for "auto-narrate"
 * mode, reading the slide's own text aloud when no manual script is given.
 */
function extractPageText(pdfPath, pageNum) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PDFTOTEXT_BIN, ["-f", String(pageNum), "-l", String(pageNum), pdfPath, "-"], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        return reject(new Error(`pdftotext exited ${code}: ${stderr.slice(-300)}`));
      }
      resolve(stdout.replace(/\s+/g, " ").trim());
    });
  });
}

module.exports = { pdfToPageImages, extractPageText };
