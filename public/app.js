function pillFor(status) {
  if (status === "failed") return `<span class="pill warn">failed</span>`;
  if (status === "complete") return `<span class="pill">complete</span>`;
  return `<span class="pill">${status}</span>`;
}

function wireForm(form) {
  const statusFrame = document.querySelector(`[data-status-for="${form.id}"]`);
  const submitBtn = form.querySelector(".submitBtn");

  function setStatus(html) {
    statusFrame.innerHTML = html;
  }

  async function pollJob(jobId) {
    const res = await fetch(`/api/jobs/${jobId}`);
    const job = await res.json();

    if (job.status === "queued") {
      setStatus(`${pillFor(job.status)}<div class="muted">Position in queue: ${job.queue_position}</div>`);
      setTimeout(() => pollJob(jobId), 600);
      return;
    }
    if (job.status === "rendering") {
      setStatus(`${pillFor(job.status)}<div class="muted">Compositing layers onto the cached base plate…</div>`);
      setTimeout(() => pollJob(jobId), 600);
      return;
    }
    if (job.status === "complete") {
      setStatus(`
        ${pillFor(job.status)}
        <video controls autoplay loop src="${job.output_url}"></video>
        <div class="muted">${job.output_url}</div>
      `);
      submitBtn.disabled = false;
      return;
    }
    if (job.status === "failed") {
      setStatus(`${pillFor(job.status)}<div class="log">${(job.error || "unknown error").replace(/</g, "&lt;")}</div>`);
      submitBtn.disabled = false;
      return;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    setStatus(`<span class="pill">submitting</span>`);

    const fd = new FormData(form);
    try {
      const res = await fetch(form.dataset.endpoint, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      pollJob(data.job_id);
    } catch (err) {
      submitBtn.disabled = false;
      setStatus(`<span class="pill warn">error</span><div class="log">${String(err.message).replace(/</g, "&lt;")}</div>`);
    }
  });
}

document.querySelectorAll("form[data-endpoint]").forEach(wireForm);
