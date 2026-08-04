const API = "/api/v1";
const ANALYSIS = ["none", "analyzing", "analyzed", "delete", "irrelevant", "past", "other"];
const ANALYSIS_LABELS = {
  none: "не обработан",
  analyzing: "анализ…",
  analyzed: "проанализирован",
  delete: "на удаление",
  irrelevant: "нерелевантный",
  past: "прошедший",
  other: "ошибка / прочее",
};
const INGEST_LABELS = {
  queued: "в очереди",
  running: "в работе",
  ok: "готово",
  error: "ошибка",
  skipped: "пропущен",
  unsupported_source: "источник не поддержан",
  failed_analyze: "ошибка анализа",
  cancelled: "отменён",
};
const JOB_LABELS = {
  queued: "в очереди",
  running: "в работе",
  done: "готово",
  error: "ошибка",
  cancelled: "отменён",
};
const WORKER_LABELS = {
  running: "работает",
  paused: "пауза",
  stopped: "стоп",
};
const DOC_STATUS_LABELS = {
  processed: "обработан",
  unprocessed: "не обработан",
};
const REC_LABELS = {
  participate: "Да",
  caution: "С оговорками",
  skip: "Нет",
  unknown: "Неясно",
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let state = {
  categories: [],
  stats: [],
  jobs: [],
  workers: { ingest: "running", auto_ai: false, analyze_active: false, analizator: "disabled", analizator_configured: false },
  activeSlug: null,
  activeJobId: null,
  logAfter: 0,
  currentTenderId: null,
  aiConfigs: [],
  activeAiConfigId: null,
  editingAiConfigId: null,
};

const uploadModal = () => bootstrap.Modal.getOrCreateInstance($("#uploadModal"));
const refreshModal = () => bootstrap.Modal.getOrCreateInstance($("#refreshModal"));
const tenderModal = () => bootstrap.Modal.getOrCreateInstance($("#tenderModal"));
const aiConfigModal = () => bootstrap.Modal.getOrCreateInstance($("#aiConfigModal"));

async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || res.statusText);
  return data;
}

function money(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}
function fmtDate(v) {
  if (!v) return "—";
  return String(v).replace("T", " ").slice(0, 16);
}
function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m} мин ${s} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
function jobProgress(j) {
  const total = j.total_items || 0;
  const done = (j.done_items || 0) + (j.error_items || 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : (j.status === "done" ? 100 : 0);
  const remaining = Math.max(0, total - done);
  let etaSec = null;
  if (done > 0 && remaining > 0 && j.created_at) {
    etaSec = ((Date.now() - new Date(j.created_at).getTime()) / 1000 / done) * remaining;
  } else if (remaining === 0) etaSec = 0;
  return { total, done, remaining, pct, etaSec };
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function label(map, key, fallback) {
  if (key == null || key === "") return fallback || "—";
  return map[key] || fallback || String(key);
}
function markIcon(ok) {
  if (ok === true) return `<span class="mark ok" title="успешно">✓</span>`;
  if (ok === false) return `<span class="mark bad" title="ошибка">✕</span>`;
  return `<span class="mark pending" title="в процессе">…</span>`;
}
function dualBars(t) {
  const collectPct = t.collect_pct ?? 0;
  const aiPct = t.ai_pct ?? 0;
  return `
    <div class="dual-bars">
      <div class="bar-row">
        <span class="bar-label">Сбор</span>
        <div class="progress bar-collect"><div class="progress-bar" style="width:${collectPct}%"></div></div>
        <span class="bar-pct">${collectPct}%</span>
        ${markIcon(t.collect_ok)}
      </div>
      <div class="bar-row">
        <span class="bar-label">AI</span>
        <div class="progress bar-ai"><div class="progress-bar" style="width:${aiPct}%"></div></div>
        <span class="bar-pct">${aiPct}%</span>
        ${markIcon(t.ai_ok)}
      </div>
    </div>`;
}

async function refreshAll() {
  const [cats, stats, jobs, workers] = await Promise.all([
    api("/categories"),
    api("/stats/ingest"),
    api("/ingest/jobs"),
    api("/workers").catch(() => ({ ingest: "running", auto_ai: false, analyze_active: false })),
  ]);
  state.categories = cats || [];
  state.stats = stats || [];
  state.jobs = jobs || [];
  state.workers = workers || state.workers;
  renderCategories();
  renderOverall();
  renderWorkers();
  renderJobs();
  if (state.activeSlug) {
    await renderCatalog();
    await loadAIConfigs(false);
  }
  if (state.activeJobId) await renderJobDetail(false);
}

function workerPillClass(st) {
  if (st === "paused") return "pill warn";
  if (st === "stopped") return "pill stopped";
  return "pill ok";
}

function renderWorkers() {
  const w = state.workers || {};
  const ingestEl = $("#ingest-state");
  ingestEl.textContent = label(WORKER_LABELS, w.ingest, "работает");
  ingestEl.className = workerPillClass(w.ingest);

  const azConfigured = !!(w.analizator_configured || w.analizator === "ok");
  const autoOn = !!w.auto_ai;
  const analyzeEl = $("#analyze-state");
  analyzeEl.textContent = !azConfigured ? "нет AI" : (autoOn ? (w.analyze_active ? "анализ…" : "вкл") : "выкл");
  analyzeEl.className = !azConfigured ? "pill" : (autoOn ? (w.analyze_active ? "pill warn" : "pill ok") : "pill");
  $("#analyze-active").classList.toggle("hidden", !w.analyze_active);

  const toggle = $("#auto-ai-toggle");
  toggle.disabled = !azConfigured;
  if (toggle.checked !== autoOn) toggle.checked = autoOn;

  const sel = $("#ai-config-select");
  sel.disabled = autoOn || !state.activeSlug;
  renderAIConfigSelect();

  const ingestPaused = w.ingest === "paused" || w.ingest === "stopped";
  $("#btn-ingest-pause").disabled = ingestPaused;
  $("#btn-ingest-resume").disabled = !ingestPaused;
  $("#btn-ingest-stop").disabled = w.ingest === "stopped";
}

function renderCategories() {
  const box = $("#category-list");
  const bySlug = Object.fromEntries((state.stats || []).map((s) => [s.category_slug, s]));
  box.innerHTML = "";
  for (const c of state.categories) {
    const st = bySlug[c.slug] || {};
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-item" + (state.activeSlug === c.slug ? " active" : "");
    btn.innerHTML = `<strong>${escapeHtml(c.title)}</strong>
      <span class="count">${st.tenders_in_db || 0} в БД · ок ${st.ok || 0} · очередь ${(st.queued || 0) + (st.running || 0)}</span>`;
    btn.addEventListener("click", () => {
      state.activeSlug = c.slug;
      $("#catalog-panel").classList.remove("hidden");
      renderCategories();
      renderCatalog();
      loadAIConfigs(true);
    });
    box.appendChild(btn);
  }
  if (!state.categories.length) {
    box.innerHTML = `<div class="small text-secondary">Пока нет категорий — загрузите CSV</div>`;
  }
}

function renderOverall() {
  let overallDone = 0, overallTotal = 0, eta = null, db = 0, queued = 0, running = 0;
  for (const j of state.jobs) {
    const p = jobProgress(j);
    overallDone += p.done;
    overallTotal += p.total;
    if (p.etaSec != null && p.remaining > 0) eta = Math.max(eta || 0, p.etaSec);
  }
  for (const s of state.stats) {
    db += s.tenders_in_db || 0;
    queued += s.queued || 0;
    running += s.running || 0;
  }
  const pct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
  $("#overall-pct").textContent = pct + "%";
  $("#overall-bar").style.width = pct + "%";
  $("#overall-meta").textContent = `в БД: ${db} · готово ${overallDone}/${overallTotal} · очередь ${queued} · в работе ${running}`;
  $("#overall-eta").textContent = `осталось ≈ ${fmtDuration(eta)}`;
}

function renderJobs() {
  const list = $("#jobs-list");
  list.innerHTML = "";
  for (const j of state.jobs) {
    const p = jobProgress(j);
    const el = document.createElement("div");
    el.className = "job-card";
    el.innerHTML = `
      <div class="d-flex justify-content-between"><strong>${escapeHtml(j.category_title || j.category_slug || "")}</strong>
        <span class="pill">${escapeHtml(label(JOB_LABELS, j.status))}</span></div>
      <div class="progress mt-2"><div class="progress-bar" style="width:${p.pct}%"></div></div>
      <div class="small text-secondary mt-1">${p.pct}% · ${p.done}/${p.total} · ${escapeHtml(j.source_name || "")} · осталось ≈ ${fmtDuration(p.etaSec)}</div>`;
    el.addEventListener("click", () => openJob(j.id));
    list.appendChild(el);
  }
  if (!state.jobs.length) list.innerHTML = `<div class="small text-secondary">Задач пока нет</div>`;
}

async function openJob(id) {
  state.activeJobId = id;
  state.logAfter = 0;
  $("#jobs-panel").classList.remove("hidden");
  $("#job-detail").classList.remove("hidden");
  $("#job-log").innerHTML = "";
  await renderJobDetail(true);
}

async function renderJobDetail(resetLog) {
  if (!state.activeJobId) return;
  const data = await api(`/ingest/jobs/${state.activeJobId}`);
  const job = data.job;
  const items = data.items || [];
  const p = jobProgress(job);
  $("#job-detail-title").textContent = job.category_title || job.category_slug || "Задача";
  $("#job-detail-meta").textContent = `${label(JOB_LABELS, job.status)} · ${job.source_name || ""} · ${job.id}`;
  $("#job-detail-bar").style.width = p.pct + "%";

  const running = items.find((i) => i.status === "running");
  $("#current-reg").textContent = running ? running.reg_number : "—";

  const box = $("#job-items");
  box.innerHTML = items.map((i) => `
    <div class="item-row ${i.status === "running" ? "running" : ""}">
      <strong>${escapeHtml(i.reg_number)}</strong>
      <span class="pill">${escapeHtml(label(INGEST_LABELS, i.status))}</span>
      <div class="small text-secondary">${escapeHtml(i.source_site || "")}</div>
      ${i.error ? `<div class="small text-danger">${escapeHtml(i.error)}</div>` : ""}
    </div>`).join("") || `<div class="item-row text-secondary">нет позиций</div>`;

  const logs = await api(`/ingest/jobs/${state.activeJobId}/logs?after=${state.logAfter}`);
  const logBox = $("#job-log");
  if (resetLog) logBox.innerHTML = "";
  for (const l of logs || []) {
    state.logAfter = Math.max(state.logAfter, l.id);
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span class="lvl">${escapeHtml(l.level)}</span><strong>${escapeHtml(l.reg_number)}</strong> ${escapeHtml(l.message)}`;
    logBox.appendChild(line);
  }
  logBox.scrollTop = logBox.scrollHeight;
}

async function renderCatalog() {
  if (!state.activeSlug) return;
  const cat = state.categories.find((c) => c.slug === state.activeSlug);
  const st = state.stats.find((s) => s.category_slug === state.activeSlug) || {};
  $("#catalog-title").textContent = cat ? cat.title : state.activeSlug;
  $("#catalog-count").textContent = `${st.tenders_in_db || 0} закупок в СУБД`;

  const q = $("#catalog-q").value.trim();
  const params = new URLSearchParams({ category: state.activeSlug });
  if (q) params.set("q", q);
  const tenders = await api("/tenders?" + params);
  const grid = $("#tenders-grid");
  grid.innerHTML = "";
  for (const t of tenders || []) {
    const tone = t.card_tone === "good" ? "tone-good"
      : (t.card_tone === "bad" ? "tone-bad"
        : (t.card_tone === "pending" ? "tone-pending" : "tone-neutral"));
    const rec = t.recommendation ? `<span class="pill">${escapeHtml(label(REC_LABELS, t.recommendation))}</span>` : "";
    const card = document.createElement("article");
    card.className = `tender-card ${tone}`;
    const canAI = t.ready_for_ai || t.analysis_status === "analyzed" || t.analysis_status === "other" || t.ingest_status === "ok";
    card.innerHTML = `
      <div class="tender-card-top">
        <div>
          <div class="tender-reg">${escapeHtml(t.reg_number)}</div>
          <div class="tender-obj">${escapeHtml(t.object_name || "—")}</div>
        </div>
        <div class="tender-meta">
          <span class="pill">${escapeHtml(label(ANALYSIS_LABELS, t.analysis_status))}</span>
          ${rec}
        </div>
      </div>
      <div class="tender-facts">
        <span>Окончание: ${fmtDate(t.application_end)}</span>
        <span>НМЦК: ${money(t.nmck)}</span>
        <span>Док.: ${t.docs_with_text || 0}/${t.docs_total || 0}</span>
      </div>
      ${dualBars(t)}
      <div class="tender-actions">
        <button type="button" class="btn btn-sm btn-outline-dark btn-open">Открыть</button>
        <button type="button" class="btn btn-sm btn-outline-primary btn-ai" ${canAI ? "" : "disabled"}>AI</button>
      </div>`;
    card.querySelector(".btn-open").addEventListener("click", () => openTender(t.id));
    card.querySelector(".btn-ai").addEventListener("click", () => analyzeFromCard(t.id, card.querySelector(".btn-ai")));
    grid.appendChild(card);
  }
  $("#catalog-empty").classList.toggle("hidden", !!(tenders && tenders.length));
}

async function analyzeFromCard(id, btn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await api(`/tenders/${id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checklist_id: "default",
        config_id: state.activeAiConfigId || $("#ai-config-select")?.value || "",
      }),
    });
    const summary = (res.assessment && res.assessment.summary) || "";
    const details = res.assessment && res.assessment.details;
    const rec = details && details.recommendation;
    alert(
      (rec ? `${label(REC_LABELS, rec)}\n\n` : "") +
      (summary ? summary.slice(0, 1200) : "Анализ сохранён")
    );
    await renderCatalog();
  } catch (err) {
    alert("AI-анализ: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function openTender(id) {
  state.currentTenderId = id;
  const [t, docs, assessment] = await Promise.all([
    api(`/tenders/${id}`),
    api(`/tenders/${id}/documents?text=1`),
    api(`/tenders/${id}/assessment`).catch(() => null),
  ]);
  $("#tender-title").textContent = t.reg_number;
  const sel = $("#tender-analysis");
  sel.innerHTML = ANALYSIS.filter((a) => a !== "analyzing" || t.analysis_status === "analyzing").map((a) =>
    `<option value="${a}" ${a === t.analysis_status ? "selected" : ""}>${ANALYSIS_LABELS[a] || a}</option>`
  ).join("");

  let cust = "";
  if (t.customer) {
    const c = t.customer;
    cust = `<h3>Заказчик</h3>
      <p><strong>${escapeHtml(c.full_name || "—")}</strong><br>
      ИНН ${escapeHtml(c.inn || "—")} · КПП ${escapeHtml(c.kpp || "—")} · ОГРН ${escapeHtml(c.ogrn || "—")}<br>
      ${escapeHtml(c.address || "")}<br>
      ${escapeHtml(c.email || "")} ${escapeHtml(c.phone || "")} ${escapeHtml(c.contact_person || "")}</p>`;
  }

  const docItems = (docs || []).map((d) => {
    const pill = d.process_status === "processed"
      ? `<span class="pill ok">${DOC_STATUS_LABELS.processed}</span>`
      : `<span class="pill bad">${DOC_STATUS_LABELS.unprocessed}</span>`;
    const link = d.source_url ? `<a href="${escapeHtml(d.source_url)}" target="_blank" rel="noopener">скачать</a>` : "";
    const text = d.text_content
      ? `<details><summary>текст</summary><pre>${escapeHtml(d.text_content.slice(0, 6000))}</pre></details>`
      : (d.process_error ? `<div class="small text-danger">${escapeHtml(d.process_error)}</div>` : "");
    return `<li>${pill} ${escapeHtml(d.filename || d.uid || "документ")} ${link} ${text}</li>`;
  }).join("");

  let payloadPreview = "";
  try {
    const pretty = JSON.stringify(typeof t.payload === "string" ? JSON.parse(t.payload) : t.payload, null, 2);
    payloadPreview = `<h3>Полные данные карточки</h3><pre>${escapeHtml(pretty.slice(0, 12000))}</pre>`;
  } catch { /* ignore */ }

  const rec = (assessment && assessment.details && assessment.details.recommendation)
    || t.recommendation || "";

  $("#tender-body").innerHTML = `
    ${dualBars(t)}
    <p class="mt-3"><strong>Объект:</strong> ${escapeHtml(t.object_name || "—")}</p>
    <p><strong>НМЦК:</strong> ${money(t.nmck)} · <strong>Закон:</strong> ${escapeHtml(t.law || "—")}
      · <strong>Статус:</strong> ${escapeHtml(t.status || "—")}</p>
    <p><strong>Источник:</strong> ${escapeHtml(t.source_site || "")}</p>
    <p><strong>Опубликовано:</strong> ${fmtDate(t.published_at)} · <strong>Обновлено на сайте:</strong> ${fmtDate(t.updated_on_site)}
      · <strong>Окончание заявок:</strong> ${fmtDate(t.application_end)}</p>
    ${cust}
    <h3>Документы (${(docs || []).length})</h3>
    <ul class="doc-list">${docItems || "<li>нет</li>"}</ul>
    <h3>Оценка</h3>
    <p>${rec ? `<strong>${escapeHtml(label(REC_LABELS, rec))}</strong> · ` : ""}${escapeHtml((assessment && assessment.summary) || "не задана")}
      · оценка ${assessment && assessment.score != null ? assessment.score : "—"}</p>
    <label class="form-label">Резюме оценки</label>
    <textarea class="form-control mb-2" id="dlg-assess-summary" rows="3">${escapeHtml((assessment && assessment.summary) || "")}</textarea>
    <label class="form-label">Оценка (0–1)</label>
    <input type="number" class="form-control" id="dlg-assess-score" step="0.1" value="${assessment && assessment.score != null ? assessment.score : ""}" />
    ${payloadPreview}
  `;
  tenderModal().show();
}

/* events */
$("#btn-upload").addEventListener("click", async () => {
  const sel = $("#upload-category");
  sel.innerHTML = state.categories.map((c) => `<option value="${c.slug}">${escapeHtml(c.title)}</option>`).join("");
  $("#upload-status").textContent = "";
  uploadModal().show();
});

$("#upload-new-toggle").addEventListener("change", (e) => {
  $("#upload-new-wrap").classList.toggle("hidden", !e.target.checked);
  $("#upload-category").disabled = e.target.checked;
});

$("#upload-submit").addEventListener("click", async () => {
  const status = $("#upload-status");
  status.textContent = "Отправка…";
  try {
    const files = $("#upload-files").files;
    if (!files.length) throw new Error("Выберите CSV");
    const ids = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      if ($("#upload-new-toggle").checked) {
        fd.append("category_title", $("#upload-new-title").value.trim());
      } else {
        fd.append("category_slug", $("#upload-category").value);
      }
      const job = await api("/ingest", { method: "POST", body: fd });
      ids.push(job.id);
    }
    status.textContent = `Создано: ${ids.length} задач`;
    $("#upload-files").value = "";
    uploadModal().hide();
    $("#jobs-panel").classList.remove("hidden");
    await refreshAll();
    if (ids[0]) openJob(ids[0]);
  } catch (err) {
    status.textContent = "Ошибка: " + err.message;
  }
});

$("#overall-bar-wrap").addEventListener("click", () => {
  $("#jobs-panel").classList.toggle("hidden");
});

async function workerAction(path, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    state.workers = await api(path, { method: "POST" });
    renderWorkers();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
}

$("#btn-ingest-pause").addEventListener("click", () => workerAction("/workers/ingest/pause"));
$("#btn-ingest-resume").addEventListener("click", () => workerAction("/workers/ingest/resume"));
$("#btn-ingest-stop").addEventListener("click", () =>
  workerAction("/workers/ingest/stop", "Остановить сбор и отменить всю очередь?")
);

$("#auto-ai-toggle").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const w = state.workers || {};
  if (on && !(w.analizator_configured || w.analizator === "ok")) {
    e.target.checked = false;
    alert("AI-анализатор не настроен");
    return;
  }
  try {
    state.workers = await api("/workers/auto-ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: on }),
    });
    renderWorkers();
    if (on) {
      console.info("Авто AI включён — берёт карточки после завершения сбора (ingest ok) с текстом документов");
    }
  } catch (err) {
    e.target.checked = !on;
    alert(err.message);
  }
});

$("#ai-config-select").addEventListener("change", async (e) => {
  if (!state.activeSlug || state.workers.auto_ai) return;
  const id = e.target.value || null;
  try {
    await api(`/categories/${encodeURIComponent(state.activeSlug)}/active-ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config_id: id }),
    });
    state.activeAiConfigId = id;
    const cat = state.categories.find((c) => c.slug === state.activeSlug);
    if (cat) cat.active_ai_config_id = id;
  } catch (err) {
    alert(err.message);
    await loadAIConfigs(true);
  }
});

$("#btn-ai-config").addEventListener("click", async () => {
  if (!state.activeSlug) {
    alert("Сначала выберите категорию");
    return;
  }
  await loadAIConfigs(true);
  state.editingAiConfigId = null;
  $("#ai-config-cat-label").textContent = "Категория: " + (state.categories.find((c) => c.slug === state.activeSlug)?.title || state.activeSlug);
  $("#ai-cfg-name").value = "";
  $("#ai-cfg-system").value = "";
  $("#ai-cfg-user").value = "";
  $("#ai-cfg-rules").value = "";
  $("#ai-cfg-file").value = "";
  $("#ai-cfg-status").textContent = "";
  $("#ai-cfg-activate").checked = true;
  renderAIConfigList();
  aiConfigModal().show();
});

async function loadAIConfigs(forceSelect) {
  if (!state.activeSlug) return;
  try {
    const data = await api(`/categories/${encodeURIComponent(state.activeSlug)}/ai-configs`);
    state.aiConfigs = data.configs || [];
    state.activeAiConfigId = data.active_ai_config_id || null;
    if (forceSelect) renderAIConfigSelect();
    renderAIConfigList();
  } catch (err) {
    console.warn(err);
  }
}

function renderAIConfigSelect() {
  const sel = $("#ai-config-select");
  if (!sel) return;
  const cur = state.activeAiConfigId || "";
  sel.innerHTML = `<option value="">без конфигурации</option>` +
    (state.aiConfigs || []).map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === cur ? "selected" : ""}>${escapeHtml(c.name)}</option>`
    ).join("");
}

function renderAIConfigList() {
  const box = $("#ai-cfg-list");
  if (!box) return;
  const active = state.activeAiConfigId;
  box.innerHTML = (state.aiConfigs || []).map((c) => `
    <div class="ai-cfg-item ${c.id === active ? "active" : ""}">
      <div><strong>${escapeHtml(c.name)}</strong>${c.id === active ? " · активна" : ""}</div>
      <div class="d-flex gap-1">
        <button type="button" class="btn btn-sm btn-outline-dark" data-edit="${escapeHtml(c.id)}">Открыть</button>
        <button type="button" class="btn btn-sm btn-outline-danger" data-del="${escapeHtml(c.id)}">Удалить</button>
      </div>
    </div>`).join("") || `<div class="small text-secondary">Пока нет конфигураций</div>`;
  box.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.aiConfigs.find((x) => x.id === btn.getAttribute("data-edit"));
      if (!c) return;
      state.editingAiConfigId = c.id;
      $("#ai-cfg-name").value = c.name || "";
      $("#ai-cfg-system").value = c.system_prompt || "";
      $("#ai-cfg-user").value = c.user_prompt || "";
      $("#ai-cfg-rules").value = c.rules || "";
      $("#ai-cfg-status").textContent = "Редактирование: " + c.name;
    });
  });
  box.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Удалить конфигурацию?")) return;
      await api(`/categories/${encodeURIComponent(state.activeSlug)}/ai-configs/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      await loadAIConfigs(true);
    });
  });
}

$("#ai-cfg-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const text = await file.text();
  if (!$("#ai-cfg-system").value.trim()) {
    $("#ai-cfg-system").value = text;
  } else if (!$("#ai-cfg-user").value.trim()) {
    $("#ai-cfg-user").value = text;
  } else {
    $("#ai-cfg-rules").value = ($("#ai-cfg-rules").value + "\n" + text).trim();
  }
  if (!$("#ai-cfg-name").value.trim()) {
    $("#ai-cfg-name").value = file.name.replace(/\.txt$/i, "");
  }
  $("#ai-cfg-status").textContent = "Загружен файл: " + file.name;
});

$("#ai-cfg-save").addEventListener("click", async () => {
  const status = $("#ai-cfg-status");
  try {
    const payload = {
      name: $("#ai-cfg-name").value.trim(),
      system_prompt: $("#ai-cfg-system").value,
      user_prompt: $("#ai-cfg-user").value,
      rules: $("#ai-cfg-rules").value,
      activate: $("#ai-cfg-activate").checked,
    };
    if (!payload.name) throw new Error("Укажите имя конфигурации");
    if (state.editingAiConfigId) {
      await api(`/categories/${encodeURIComponent(state.activeSlug)}/ai-configs/${state.editingAiConfigId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (payload.activate && !state.workers.auto_ai) {
        await api(`/categories/${encodeURIComponent(state.activeSlug)}/active-ai-config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config_id: state.editingAiConfigId }),
        });
      }
    } else {
      await api(`/categories/${encodeURIComponent(state.activeSlug)}/ai-configs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    status.textContent = "Сохранено";
    state.editingAiConfigId = null;
    await loadAIConfigs(true);
    await refreshAll();
  } catch (err) {
    status.textContent = "Ошибка: " + err.message;
  }
});

$("#jobs-collapse").addEventListener("click", () => $("#jobs-panel").classList.add("hidden"));
$("#job-detail-close").addEventListener("click", () => {
  $("#job-detail").classList.add("hidden");
  state.activeJobId = null;
});
$("#job-delete").addEventListener("click", async () => {
  if (!state.activeJobId || !confirm("Удалить прогресс этой задачи?")) return;
  await api(`/ingest/jobs/${state.activeJobId}`, { method: "DELETE" });
  state.activeJobId = null;
  $("#job-detail").classList.add("hidden");
  await refreshAll();
});

$("#catalog-q").addEventListener("input", () => {
  clearTimeout(window.__q);
  window.__q = setTimeout(renderCatalog, 250);
});

$("#btn-clear-cat").addEventListener("click", async () => {
  if (!state.activeSlug || !confirm("Удалить все закупки этой категории из СУБД?")) return;
  await api(`/categories/${encodeURIComponent(state.activeSlug)}/tenders`, { method: "DELETE" });
  await refreshAll();
});
$("#btn-clear-jobs").addEventListener("click", async () => {
  if (!state.activeSlug || !confirm("Удалить весь прогресс загрузок этой категории?")) return;
  await api(`/categories/${encodeURIComponent(state.activeSlug)}/jobs`, { method: "DELETE" });
  await refreshAll();
});

$("#btn-refresh-cat").addEventListener("click", () => {
  const box = $("#refresh-checks");
  const opts = ANALYSIS.filter((a) => a !== "analyzing");
  box.innerHTML = opts.map((a) => `
    <div class="form-check">
      <input class="form-check-input refresh-status" type="checkbox" value="${a}" id="rs-${a}" ${a === "none" ? "checked" : ""} />
      <label class="form-check-label" for="rs-${a}">${ANALYSIS_LABELS[a] || a}</label>
    </div>`).join("");
  refreshModal().show();
});

$("#refresh-submit").addEventListener("click", async () => {
  const statuses = $$(".refresh-status:checked").map((el) => el.value);
  if (!statuses.length) return alert("Выберите хотя бы один тип");
  const job = await api(`/categories/${encodeURIComponent(state.activeSlug)}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ statuses }),
  });
  refreshModal().hide();
  $("#jobs-panel").classList.remove("hidden");
  await refreshAll();
  openJob(job.id);
});

$("#tender-save").addEventListener("click", async () => {
  if (!state.currentTenderId) return;
  await api(`/tenders/${state.currentTenderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis_status: $("#tender-analysis").value }),
  });
  const summary = $("#dlg-assess-summary")?.value ?? "";
  const scoreRaw = $("#dlg-assess-score")?.value;
  const score = scoreRaw === "" ? null : Number(scoreRaw);
  await api(`/tenders/${state.currentTenderId}/assessment`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, score, details: {} }),
  });
  tenderModal().hide();
  renderCatalog();
});

$("#tender-delete").addEventListener("click", async () => {
  if (!state.currentTenderId || !confirm("Удалить закупку?")) return;
  await api(`/tenders/${state.currentTenderId}`, { method: "DELETE" });
  tenderModal().hide();
  await refreshAll();
});

$("#tender-refresh").addEventListener("click", async () => {
  if (!state.currentTenderId) return;
  const job = await api(`/tenders/${state.currentTenderId}/refresh`, { method: "POST" });
  tenderModal().hide();
  $("#jobs-panel").classList.remove("hidden");
  await refreshAll();
  openJob(job.id);
});

$("#tender-analyze").addEventListener("click", async () => {
  if (!state.currentTenderId) return;
  const btn = $("#tender-analyze");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Анализ… (порции в LM Studio)";
  try {
    const res = await api(`/tenders/${state.currentTenderId}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checklist_id: "default",
        config_id: state.activeAiConfigId || $("#ai-config-select")?.value || "",
      }),
    });
    const summary = (res.assessment && res.assessment.summary) || "";
    const details = res.assessment && res.assessment.details;
    const rec = details && details.recommendation;
    alert(
      (rec ? `${label(REC_LABELS, rec)}\n\n` : "") +
      (summary ? summary.slice(0, 1200) : "Анализ сохранён")
    );
    await openTender(state.currentTenderId);
    renderCatalog();
  } catch (err) {
    alert("AI-анализ: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

setInterval(async () => {
  try {
    await refreshAll();
  } catch (e) {
    console.warn(e);
  }
}, 2000);

refreshAll().catch(console.error);
