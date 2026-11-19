const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { prewarmBasePlate, renderJob, renderContractJob, renderPresentationJob, probeDurationSeconds } = require("./lib/compositor");
const { pdfToPageImages, extractPageText } = require("./lib/pdf");
const { synthesizeSpeech } = require("./lib/tts");
const { buildCaptionChunks } = require("./lib/captions");
const { checkDependencies } = require("./lib/config");

// how far into the timeline each template's voice/narration layer starts —
// must match the adelay used in lib/compositor.js so captions line up
const VOICE_OFFSET_SEC = { welcome: 2.0, contract: 0.5 };
const NARRATION_MAX_LEN = 600;
const PRES_NARRATION_MAX_LEN = 6000;
const PRES_PAGE_PAD_SEC = 0.6;

const PORT = process.env.PORT || 4173;
const OUTPUT_DIR = path.join(__dirname, "output");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const TEMPLATE = require("./templates/welcome-video.json");
const CONTRACT_TEMPLATE = require("./templates/contract-walkthrough.json");
const PRESENTATION_TEMPLATE = require("./templates/pdf-presentation.json");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(OUTPUT_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok =
      (file.fieldname === "avatar_image" && file.mimetype.startsWith("image/")) ||
      (file.fieldname === "voice_audio" && file.mimetype.startsWith("audio/"));
    cb(ok ? null : new Error("Unsupported file type for " + file.fieldname), ok);
  },
});

const uploadContract = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok =
      (file.fieldname === "contract_pdf" && file.mimetype === "application/pdf") ||
      (file.fieldname === "voice_audio" && file.mimetype.startsWith("audio/"));
    cb(ok ? null : new Error("Unsupported file type for " + file.fieldname), ok);
  },
});

const uploadPresentation = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.fieldname === "deck_pdf" && file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Unsupported file type for " + file.fieldname), ok);
  },
});

// ---- in-process job queue (concurrency 1 — stands in for the GPU worker
// pool from the architecture doc; same states: queued -> rendering -> complete)
const jobs = new Map();
const queue = [];
let workerBusy = false;

// Finished jobs are only kept in memory long enough for clients to poll the
// result; the rendered files themselves stay on disk in output/.
const JOB_RETENTION_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.completedAt && job.completedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// Uploaded files are only needed by the render worker. If a request is
// rejected (validation error, bad file type) nothing will ever clean them
// up, so delete them when the response goes out with an error status.
function discardUploads(req) {
  for (const f of Object.values(req.files || {}).flat()) fs.unlink(f.path, () => {});
}
function cleanupOnReject(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode >= 400) discardUploads(req);
  });
  next();
}

function enqueue(job) {
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
}

async function pump() {
  if (workerBusy) return;
  const id = queue.shift();
  if (!id) return;
  workerBusy = true;
  const job = jobs.get(id);
  job.status = "rendering";
  job.startedAt = Date.now();
  const tempPaths = [];
  try {
    const outFile = path.join(OUTPUT_DIR, `${job.id}.mp4`);
    let vars = job.variables;

    // AI narration (single continuous track): a typed script takes priority
    // over an uploaded voice file. The presentation kind handles narration
    // per-slide instead, further down, so it's excluded here.
    if (job.kind !== "presentation" && vars.narrationScript) {
      const wavPath = path.join(UPLOAD_DIR, `${job.id}-narration.wav`);
      tempPaths.push(wavPath);
      await synthesizeSpeech(vars.narrationScript, wavPath);
      const wavDuration = await probeDurationSeconds(wavPath);
      vars = { ...vars, voicePath: wavPath };

      if (vars.burnCaptions) {
        const offset = VOICE_OFFSET_SEC[job.kind] ?? 2.0;
        const chunks = buildCaptionChunks(vars.narrationScript, wavDuration).map((c) => ({
          text: c.text,
          start: c.start + offset,
          end: c.end + offset,
        }));
        vars = { ...vars, captionChunks: chunks };
      }
    }

    if (job.kind === "contract") {
      const pageDir = path.join(UPLOAD_DIR, `${job.id}-pages`);
      tempPaths.push(pageDir);
      const pages = await pdfToPageImages(vars.pdfPath, pageDir, CONTRACT_TEMPLATE.max_pages);
      await renderContractJob({ ...vars, pagePaths: pages }, outFile);
    } else if (job.kind === "presentation") {
      const pageDir = path.join(UPLOAD_DIR, `${job.id}-pages`);
      tempPaths.push(pageDir);
      const pageImages = await pdfToPageImages(vars.deckPath, pageDir, PRESENTATION_TEMPLATE.max_pages);

      // per-slide narration text: a manual script (blank-line separated,
      // one paragraph per slide) takes priority; otherwise, when requested,
      // read each slide's own extracted PDF text aloud
      const paragraphs = vars.narrationScript
        ? vars.narrationScript.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
        : [];
      const slideTexts = [];
      for (let i = 0; i < pageImages.length; i++) {
        if (paragraphs[i]) {
          slideTexts.push(paragraphs[i]);
        } else if (vars.autoNarrate) {
          const text = await extractPageText(vars.deckPath, i + 1);
          slideTexts.push(text ? text.slice(0, 500) : null);
        } else {
          slideTexts.push(null);
        }
      }

      const pages = [];
      for (let i = 0; i < pageImages.length; i++) {
        const text = slideTexts[i];
        if (text) {
          const wavPath = path.join(UPLOAD_DIR, `${job.id}-slide${i}.wav`);
          tempPaths.push(wavPath);
          await synthesizeSpeech(text, wavPath);
          const wavDuration = await probeDurationSeconds(wavPath);
          const durationSec = Math.min(Math.max(wavDuration + PRES_PAGE_PAD_SEC, PRESENTATION_TEMPLATE.min_page_seconds), PRESENTATION_TEMPLATE.max_page_seconds);
          const captionChunks = vars.burnCaptions ? buildCaptionChunks(text, wavDuration) : [];
          pages.push({ imagePath: pageImages[i], wavPath, durationSec, captionChunks });
        } else {
          pages.push({ imagePath: pageImages[i], wavPath: null, durationSec: PRESENTATION_TEMPLATE.silent_page_seconds, captionChunks: [] });
        }
      }

      await renderPresentationJob({ title: vars.title, ctaLabel: vars.cta_label, pages }, outFile);
    } else {
      await renderJob(vars, outFile);
    }

    job.status = "complete";
    job.completedAt = Date.now();
    job.outputUrl = `/output/${job.id}.mp4`;
  } catch (err) {
    job.status = "failed";
    job.error = String(err.message || err).split("\n")[0];
    job.completedAt = Date.now();
  } finally {
    cleanupUploads(job.variables);
    for (const d of tempPaths) fs.rm(d, { recursive: true, force: true }, () => {});
    workerBusy = false;
    pump();
  }
}

function cleanupUploads(vars) {
  for (const p of [vars.avatarPath, vars.voicePath, vars.pdfPath, vars.deckPath]) {
    if (p) fs.unlink(p, () => {});
  }
}

app.get("/api/templates/welcome-video", (req, res) => res.json(TEMPLATE));

app.post(
  "/api/render",
  upload.fields([{ name: "avatar_image", maxCount: 1 }, { name: "voice_audio", maxCount: 1 }]),
  cleanupOnReject,
  (req, res) => {
    const first_name = (req.body.first_name || "").trim();
    const cta_label = (req.body.cta_label || "Get started").trim();

    if (!first_name) {
      return res.status(400).json({ error: "first_name is required" });
    }
    if (first_name.length > 24) {
      return res.status(400).json({ error: "first_name must be 24 characters or fewer" });
    }

    const external_ref = (req.body.external_ref || "").trim();
    if (external_ref) {
      const existing = [...jobs.values()].find((j) => j.externalRef === external_ref);
      if (existing) { discardUploads(req); return res.status(200).json({ job_id: existing.id, status: existing.status, deduped: true }); }
    }

    const narration_script = (req.body.narration_script || "").trim();
    if (narration_script.length > NARRATION_MAX_LEN) {
      return res.status(400).json({ error: `narration_script must be ${NARRATION_MAX_LEN} characters or fewer` });
    }

    const id = crypto.randomUUID();
    const avatarFile = req.files?.avatar_image?.[0];
    const voiceFile = req.files?.voice_audio?.[0];

    const job = {
      id,
      kind: "welcome",
      externalRef: external_ref || null,
      status: "queued",
      queuePosition: queue.length + 1,
      createdAt: Date.now(),
      variables: {
        first_name,
        cta_label,
        avatarPath: avatarFile ? avatarFile.path : null,
        voicePath: voiceFile ? voiceFile.path : null,
        narrationScript: narration_script || null,
        burnCaptions: !!narration_script && req.body.burn_captions === "on",
      },
    };
    enqueue(job);
    res.status(202).json({ job_id: id, status: job.status, status_url: `/api/jobs/${id}` });
  }
);

app.get("/api/templates/contract-walkthrough", (req, res) => res.json(CONTRACT_TEMPLATE));

app.post(
  "/api/render/contract",
  uploadContract.fields([{ name: "contract_pdf", maxCount: 1 }, { name: "voice_audio", maxCount: 1 }]),
  cleanupOnReject,
  (req, res) => {
    const first_name = (req.body.first_name || "").trim();
    const cta_label = (req.body.cta_label || "Review & sign").trim();
    const pdfFile = req.files?.contract_pdf?.[0];
    const voiceFile = req.files?.voice_audio?.[0];

    if (!first_name) return res.status(400).json({ error: "first_name is required" });
    if (first_name.length > 24) return res.status(400).json({ error: "first_name must be 24 characters or fewer" });
    if (!pdfFile) return res.status(400).json({ error: "contract_pdf is required" });

    const narration_script = (req.body.narration_script || "").trim();
    if (narration_script.length > NARRATION_MAX_LEN) {
      return res.status(400).json({ error: `narration_script must be ${NARRATION_MAX_LEN} characters or fewer` });
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      kind: "contract",
      status: "queued",
      queuePosition: queue.length + 1,
      createdAt: Date.now(),
      variables: {
        first_name,
        cta_label,
        pdfPath: pdfFile.path,
        voicePath: voiceFile ? voiceFile.path : null,
        narrationScript: narration_script || null,
        burnCaptions: !!narration_script && req.body.burn_captions === "on",
      },
    };
    enqueue(job);
    res.status(202).json({ job_id: id, status: job.status, status_url: `/api/jobs/${id}` });
  }
);

app.get("/api/templates/pdf-presentation", (req, res) => res.json(PRESENTATION_TEMPLATE));

app.post(
  "/api/render/presentation",
  uploadPresentation.fields([{ name: "deck_pdf", maxCount: 1 }]),
  cleanupOnReject,
  (req, res) => {
    const title = (req.body.title || "").trim();
    const cta_label = (req.body.cta_label || "Thanks for watching!").trim();
    const deckFile = req.files?.deck_pdf?.[0];
    const narration_script = (req.body.narration_script || "").trim();

    if (!deckFile) return res.status(400).json({ error: "deck_pdf is required" });
    if (title.length > 60) return res.status(400).json({ error: "title must be 60 characters or fewer" });
    if (narration_script.length > PRES_NARRATION_MAX_LEN) {
      return res.status(400).json({ error: `narration_script must be ${PRES_NARRATION_MAX_LEN} characters or fewer` });
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      kind: "presentation",
      status: "queued",
      queuePosition: queue.length + 1,
      createdAt: Date.now(),
      variables: {
        title: title || null,
        cta_label,
        deckPath: deckFile.path,
        narrationScript: narration_script || null,
        autoNarrate: req.body.auto_narrate === "on",
        burnCaptions: req.body.burn_captions === "on",
      },
    };
    enqueue(job);
    res.status(202).json({ job_id: id, status: job.status, status_url: `/api/jobs/${id}` });
  }
);

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({
    job_id: job.id,
    status: job.status,
    queue_position: job.status === "queued" ? Math.max(1, queue.indexOf(job.id) + 1) : 0,
    output_url: job.outputUrl || null,
    error: job.error || null,
  });
});

app.use((err, req, res, next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  res.status(status).json({ error: err.message || "bad request" });
});

for (const d of [OUTPUT_DIR, UPLOAD_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });

const { problems } = checkDependencies();
for (const p of problems) console.warn(`[startup] warning: ${p}`);

// There is no authentication on this API, so listen on loopback only unless
// the operator explicitly opts in to exposing it (HOST=0.0.0.0).
const HOST = process.env.HOST || "127.0.0.1";

prewarmBasePlate()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Lattice test app running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to pre-warm base plate:", err.message);
    console.error("Check that ffmpeg is installed (see README) or set FFMPEG_PATH.");
    process.exit(1);
  });
