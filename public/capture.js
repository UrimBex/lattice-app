// Camera and microphone capture for file inputs marked data-capture="photo"
// or data-capture="audio". A captured photo/recording is placed into the
// file input itself, so the form submits it exactly like an uploaded file and
// the server needs no changes.
(function () {
  const MAX_RECORD_SECONDS = 60;
  const hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) node.append(c);
    return node;
  }

  function setInputFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function describeError(err) {
    if (!window.isSecureContext) return "Camera and microphone need https:// or localhost.";
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      return "Permission was denied. Allow access in the browser's address bar and try again.";
    }
    if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      return "No camera or microphone was found on this device.";
    }
    return "Could not start: " + ((err && err.message) || "unknown error");
  }

  function stopStream(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  function attachPreview(input, preview) {
    let url = null;
    function render() {
      if (url) URL.revokeObjectURL(url);
      url = null;
      preview.replaceChildren();
      const file = input.files && input.files[0];
      if (!file) return;
      url = URL.createObjectURL(file);
      const media = file.type.startsWith("image/")
        ? el("img", { src: url, alt: "Selected photo preview" })
        : el("audio", { src: url, controls: true });
      const remove = el("button", { type: "button", className: "btn-secondary", textContent: "Remove" });
      remove.addEventListener("click", () => {
        input.value = "";
        render();
      });
      preview.append(media, el("span", { className: "muted", textContent: file.name }), remove);
    }
    input.addEventListener("change", render);
  }

  function initPhoto(input, row, panelHost, msg) {
    const openBtn = el("button", { type: "button", className: "btn-secondary", textContent: "Take photo" });
    row.append(openBtn);
    let stream = null;
    let panel = null;

    function close() {
      stopStream(stream);
      stream = null;
      if (panel) panel.remove();
      panel = null;
      openBtn.disabled = false;
    }

    openBtn.addEventListener("click", async () => {
      msg.textContent = "";
      openBtn.disabled = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 } },
          audio: false,
        });
      } catch (err) {
        msg.textContent = describeError(err);
        openBtn.disabled = false;
        return;
      }
      const video = el("video", { autoplay: true, muted: true, playsInline: true });
      video.srcObject = stream;
      const capture = el("button", { type: "button", textContent: "Capture", className: "btn-secondary" });
      const cancel = el("button", { type: "button", textContent: "Cancel", className: "btn-secondary" });
      panel = el("div", { className: "capture-panel" }, [video, el("div", { className: "capture-row" }, [capture, cancel])]);
      panelHost.append(panel);

      cancel.addEventListener("click", close);
      capture.addEventListener("click", () => {
        if (!video.videoWidth) return;
        const canvas = el("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              msg.textContent = "Could not capture the photo. Try again.";
              return;
            }
            setInputFile(input, new File([blob], "camera-photo.jpg", { type: "image/jpeg" }));
            close();
          },
          "image/jpeg",
          0.92
        );
      });
    });
  }

  function pickRecorderMime() {
    const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function extensionFor(mime) {
    if (mime.includes("webm")) return "webm";
    if (mime.includes("mp4")) return "m4a";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
  }

  function initAudio(input, row, msg, form) {
    const recBtn = el("button", { type: "button", className: "btn-secondary", textContent: "Record voice" });
    const timer = el("span", { className: "capture-timer" });
    row.append(recBtn, timer);

    let recorder = null;
    let stream = null;
    let chunks = [];
    let tick = null;
    let startedAt = 0;

    function idle() {
      clearInterval(tick);
      stopStream(stream);
      stream = null;
      recorder = null;
      recBtn.classList.remove("recording");
      recBtn.textContent = "Record voice";
      timer.textContent = "";
      delete form.dataset.recording;
    }

    function stop() {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    }

    recBtn.addEventListener("click", async () => {
      if (recorder) return stop();
      msg.textContent = "";
      if (!window.MediaRecorder) {
        msg.textContent = "Recording is not supported in this browser. Upload an audio file instead.";
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        msg.textContent = describeError(err);
        return;
      }
      const mime = pickRecorderMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
      recorder.addEventListener("stop", () => {
        const type = (recorder && recorder.mimeType) || mime || "audio/webm";
        const baseType = type.split(";")[0];
        const blob = new Blob(chunks, { type: baseType });
        idle();
        if (blob.size === 0) {
          msg.textContent = "Nothing was recorded. Try again.";
          return;
        }
        setInputFile(input, new File([blob], `voice-recording.${extensionFor(baseType)}`, { type: baseType }));
      });

      recorder.start();
      startedAt = Date.now();
      form.dataset.recording = "1";
      recBtn.classList.add("recording");
      recBtn.replaceChildren(el("span", { className: "rec-dot" }), document.createTextNode("Stop recording"));
      tick = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} / 1:00`;
        if (s >= MAX_RECORD_SECONDS) stop();
      }, 250);
    });
  }

  document.querySelectorAll("input[type=file][data-capture]").forEach((input) => {
    const kind = input.dataset.capture;
    const form = input.closest("form");
    const row = el("div", { className: "capture-row" });
    const panelHost = el("div");
    const preview = el("div", { className: "capture-preview" });
    const msg = el("div", { className: "capture-msg", role: "status" });
    input.after(row, panelHost, preview, msg);
    attachPreview(input, preview);

    if (!hasMedia) {
      row.append(
        el("span", {
          className: "muted",
          textContent: "Camera and microphone are unavailable here (they need https:// or localhost).",
        })
      );
      return;
    }
    if (kind === "photo") initPhoto(input, row, panelHost, msg);
    if (kind === "audio") initAudio(input, row, msg, form);
  });

  // Don't submit while a recording is still running: the file isn't in the
  // input until the recorder stops.
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener(
      "submit",
      (e) => {
        if (form.dataset.recording) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const msg = form.querySelector(".capture-msg:not(:empty)") || form.querySelector(".capture-msg");
          if (msg) msg.textContent = "Stop the recording first, then render.";
        }
      },
      true
    );
  });
})();
