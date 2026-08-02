'use strict';

// ── Navigation ─────────────────────────────────────────────────────────────
const views = document.querySelectorAll('.view');
const navBtns = document.querySelectorAll('nav button[data-view]');

navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.view;
    views.forEach(v => v.classList.toggle('active', v.id === target));
    navBtns.forEach(b => b.classList.toggle('active', b === btn));
    if (target === 'view-people') loadPeople();
  });
});

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    document.getElementById('stat-photos').textContent = s.total_media ?? 0;
    document.getElementById('stat-processed').textContent = s.processed ?? 0;
    document.getElementById('stat-people').textContent = s.people ?? 0;
    document.getElementById('stat-events').textContent = s.events ?? 0;
  } catch (e) { /* ignore */ }
}

// ── Ingest View ────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const folderInput = document.getElementById('folder-input');
const processBtn = document.getElementById('process-btn');
const progressSection = document.getElementById('progress-section');

const IMAGE_EXT_RE = /\.(jpe?g|png|heic|heif|tiff?|bmp|gif)$/i;

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  await handleSelectedFiles([...e.dataTransfer.files]);
});

dropZone.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,.jpg,.jpeg,.png,.heic,.heif,.tiff,.tif,.bmp,.gif';
  input.multiple = true;
  input.onchange = async () => {
    await handleSelectedFiles([...input.files]);
  };
  input.click();
});

async function handleSelectedFiles(files) {
  const zips = files.filter(f => f.name.toLowerCase().endsWith('.zip'));
  const images = files.filter(f => IMAGE_EXT_RE.test(f.name));

  if (!zips.length && !images.length) {
    showToast('Please drop photos (.jpg, .png, .heic) or a .zip file.');
    return;
  }

  for (const zip of zips) await uploadZip(zip);
  if (images.length) await uploadFiles(images);
}

async function uploadZip(file) {
  showToast(`Uploading ${file.name}…`);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/ingest/zip', { method: 'POST', body: fd });
    const data = await r.json();
    showToast(`Ingested ${data.ingested} photos, skipped ${data.skipped}. Click "Process All" to run the pipeline.`);
    refreshStats();
  } catch (e) {
    showToast('Upload failed: ' + e.message);
  }
}

async function uploadFiles(files) {
  showToast(`Uploading ${files.length} photo${files.length !== 1 ? 's' : ''}…`);
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  try {
    const r = await fetch('/api/ingest/files', { method: 'POST', body: fd });
    const data = await r.json();
    showToast(`Ingested ${data.ingested} photos, skipped ${data.skipped}. Click "Process All" to run the pipeline.`);
    refreshStats();
  } catch (e) {
    showToast('Upload failed: ' + e.message);
  }
}

processBtn.addEventListener('click', async () => {
  const folder = folderInput.value.trim();
  const totalPhotos = parseInt(document.getElementById('stat-photos').textContent, 10) || 0;
  if (!folder && totalPhotos === 0) {
    showToast('Enter a folder path first.');
    return;
  }

  processBtn.disabled = true;
  progressSection.classList.add('visible');

  const steps = ['step-ingest', 'step-faces', 'step-scenes', 'step-graph'];

  const setStep = (id, state) => {
    document.getElementById(id)?.classList.remove('active', 'done');
    if (state) document.getElementById(id)?.classList.add(state);
  };

  const setBar = pct => {
    document.getElementById('progress-bar').style.width = pct + '%';
  };

  try {
    // Step 1: Ingest
    if (folder) {
      setStep('step-ingest', 'active');
      const r1 = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: folder }),
      });
      const d1 = await r1.json();
      if (!r1.ok) throw new Error(d1.detail || 'Ingest failed');
      showToast(`Ingested ${d1.ingested} photos`);
    }
    setStep('step-ingest', 'done');
    setBar(25);

    // Step 2: Faces
    setStep('step-faces', 'active');
    const r2 = await fetch('/api/process/faces', { method: 'POST' });
    const d2 = await r2.json();
    if (!r2.ok) throw new Error(d2.detail || 'Face processing failed');
    setStep('step-faces', 'done');
    setBar(50);

    // Step 3: Scenes
    setStep('step-scenes', 'active');
    const r3 = await fetch('/api/process/scenes', { method: 'POST' });
    const d3 = await r3.json();
    if (!r3.ok) throw new Error(d3.detail || 'Scene tagging failed');
    setStep('step-scenes', 'done');
    setBar(75);

    // Step 4: Graph
    setStep('step-graph', 'active');
    await fetch('/api/graph');
    setStep('step-graph', 'done');
    setBar(100);

    await refreshStats();
    showToast('Processing complete!');

  } catch (e) {
    showToast('Error: ' + e.message, 5000);
    console.error(e);
  } finally {
    processBtn.disabled = false;
  }
});

// ── People View ────────────────────────────────────────────────────────────
let showSingletons = false;
let lastPeople = [];

async function loadPeople() {
  const grid = document.getElementById('people-grid');
  grid.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const r = await fetch('/api/people');
    lastPeople = await r.json();
    if (!lastPeople.length) {
      grid.innerHTML = '<div class="empty-state"><div class="icon">👥</div><p>No people found yet.<br>Run the pipeline from the Ingest tab first.</p></div>';
      document.getElementById('merge-suggestions').style.display = 'none';
      document.getElementById('toggle-singletons').style.display = 'none';
      return;
    }
    renderPeople();
    loadMergeSuggestions();
  } catch (e) {
    grid.innerHTML = '<p style="color:var(--danger)">Failed to load people.</p>';
  }
}

// Named/multi-photo people are the ones worth a demo audience seeing first;
// one-off "Person N" clusters (DBSCAN noise) are hidden by default and can be
// revealed with the toggle instead of overwhelming the grid.
function renderPeople() {
  const grid = document.getElementById('people-grid');
  const toggle = document.getElementById('toggle-singletons');
  const singletons = lastPeople.filter(p => !p.confirmed_name && p.photo_count <= 1);
  const visible = showSingletons ? lastPeople : lastPeople.filter(p => p.confirmed_name || p.photo_count > 1);

  if (singletons.length) {
    toggle.style.display = 'inline-block';
    toggle.textContent = showSingletons
      ? `Hide ${singletons.length} unmatched single-photo ${singletons.length === 1 ? 'person' : 'people'}`
      : `Show ${singletons.length} unmatched single-photo ${singletons.length === 1 ? 'person' : 'people'}`;
  } else {
    toggle.style.display = 'none';
  }

  if (!visible.length) {
    grid.innerHTML = '<div class="empty-state"><div class="icon">👥</div><p>No people to show.</p></div>';
    return;
  }
  grid.innerHTML = '';
  visible.forEach(person => grid.appendChild(buildPersonCard(person)));
}

document.getElementById('toggle-singletons').addEventListener('click', () => {
  showSingletons = !showSingletons;
  renderPeople();
});

async function loadMergeSuggestions() {
  const box = document.getElementById('merge-suggestions');
  const list = document.getElementById('merge-suggestion-list');
  try {
    const r = await fetch('/api/people/merge-suggestions');
    const suggestions = await r.json();
    if (!suggestions.length) {
      box.style.display = 'none';
      return;
    }
    list.innerHTML = '';
    suggestions.forEach(s => list.appendChild(buildSuggestionCard(s)));
    box.style.display = 'block';
  } catch (e) {
    box.style.display = 'none';
  }
}

function buildSuggestionCard(s) {
  const card = document.createElement('div');
  card.className = 'merge-suggestion-card';
  const thumb = p => p.thumbnail_path
    ? `<img class="msc-face" src="/${p.thumbnail_path.replace(/^\//, '')}" onerror="this.style.display='none'">`
    : `<div class="msc-face"></div>`;
  card.innerHTML = `
    <div>${thumb(s.person_a)}<div class="msc-name">${escHtml(s.person_a.name)}</div></div>
    <span class="msc-link">≈</span>
    <div>${thumb(s.person_b)}<div class="msc-name">${escHtml(s.person_b.name)}</div></div>
    <div class="msc-actions">
      <button class="btn small success msc-merge">Merge</button>
      <button class="btn small secondary msc-dismiss">Not the same</button>
    </div>
  `;
  card.querySelector('.msc-merge').addEventListener('click', async () => {
    // Prefer keeping whichever side already has a photo lead / confirmed name as
    // the target so the merge reads as "add to" rather than losing the bigger cluster.
    const [sourceId, targetId] = s.person_a.photo_count >= s.person_b.photo_count
      ? [s.person_b.id, s.person_a.id]
      : [s.person_a.id, s.person_b.id];
    await doMerge(sourceId, targetId);
  });
  card.querySelector('.msc-dismiss').addEventListener('click', () => {
    card.remove();
    if (!document.getElementById('merge-suggestion-list').children.length) {
      document.getElementById('merge-suggestions').style.display = 'none';
    }
  });
  return card;
}

async function doMerge(sourceId, targetId) {
  try {
    const r = await fetch(`/api/people/${sourceId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: targetId }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || 'Merge failed');
    showToast('Merged.');
    loadPeople();
    refreshStats();
  } catch (e) {
    showToast('Merge failed: ' + e.message);
  }
}

// Drag a person card onto another to merge the dragged person into the drop target.
let dragSourceId = null;

function wireCardDragAndDrop(card, person) {
  card.draggable = true;

  card.addEventListener('dragstart', e => {
    dragSourceId = person.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set for the drag to start at all.
    e.dataTransfer.setData('text/plain', person.id);
  });

  card.addEventListener('dragend', () => {
    dragSourceId = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.person-card.drop-target')
      .forEach(c => c.classList.remove('drop-target'));
  });

  card.addEventListener('dragover', e => {
    if (!dragSourceId || dragSourceId === person.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drop-target');
  });

  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));

  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drop-target');
    if (!dragSourceId || dragSourceId === person.id) return;
    doMerge(dragSourceId, person.id);
  });
}

function buildPersonCard(person) {
  const card = document.createElement('div');
  card.className = 'person-card';
  card.dataset.id = person.id;

  // Representative face
  const repFace = person.faces?.[0];
  let faceHtml = '';
  if (repFace?.thumbnail_path) {
    faceHtml = `<img class="face-thumb" src="/${repFace.thumbnail_path.replace(/^\//, '')}" onerror="this.style.display='none'">`;
  } else {
    faceHtml = `<div class="face-thumb" style="background:var(--surface2);border-radius:50%;"></div>`;
  }

  const isConfirmed = !!person.confirmed_name;

  card.innerHTML = `
    ${faceHtml}
    ${isConfirmed ? `<div class="confirmed-badge">✓ Confirmed</div>` : ''}
    <div class="person-name">${escHtml(person.name)}</div>
    <div class="person-count">${person.photo_count} photo${person.photo_count !== 1 ? 's' : ''}</div>
    <div class="name-input-row">
      <input type="text" placeholder="Enter real name…" value="${escHtml(person.confirmed_name || '')}">
      <button class="btn small success confirm-btn">Save</button>
    </div>
    <div class="face-gallery">
      ${(person.faces || []).map(f =>
        f.thumbnail_path
          ? `<img src="/${f.thumbnail_path.replace(/^\//, '')}" title="face" onerror="this.style.display='none'">`
          : ''
      ).join('')}
    </div>
    <button class="btn secondary small" style="width:100%;margin-top:8px;" data-toggle-gallery>
      Show faces
    </button>
  `;

  wireCardDragAndDrop(card, person);

  card.querySelector('.confirm-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const input = card.querySelector('input');
    const name = input.value.trim();
    if (!name) { showToast('Enter a name first'); return; }
    try {
      const r = await fetch(`/api/people/${person.id}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error('Failed');
      showToast(`Saved: ${name}`);
      loadPeople();
    } catch (e) {
      showToast('Save failed: ' + e.message);
    }
  });

  card.querySelector('[data-toggle-gallery]').addEventListener('click', e => {
    e.stopPropagation();
    const gallery = card.querySelector('.face-gallery');
    const open = gallery.classList.toggle('open');
    e.target.textContent = open ? 'Hide faces' : 'Show faces';
  });

  return card;
}

// ── Search View ────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsGrid = document.getElementById('results-grid');
let searchDebounce;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doSearch, 600);
});

searchBtn.addEventListener('click', doSearch);

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) {
    resultsGrid.innerHTML = '';
    return;
  }
  resultsGrid.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const results = await r.json();
    renderResults(results);
  } catch (e) {
    resultsGrid.innerHTML = `<p style="color:var(--danger)">Search failed: ${e.message}</p>`;
  }
}

function renderResults(results) {
  if (!results.length) {
    resultsGrid.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><p>No results found.</p></div>';
    return;
  }
  resultsGrid.innerHTML = '';
  results.forEach(item => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const thumbSrc = item.thumbnail_path
      ? '/' + item.thumbnail_path.replace(/^\//, '')
      : '';
    const tagsHtml = (item.tags || []).map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('');
    const peopleStr = (item.people || []).join(', ');

    card.innerHTML = `
      <img class="thumb" src="${thumbSrc}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="result-meta">
        ${item.date_taken ? `<div class="result-date">${item.date_taken.slice(0, 10)}</div>` : ''}
        ${peopleStr ? `<div class="result-people">${escHtml(peopleStr)}</div>` : ''}
        <div class="result-tags">${tagsHtml}</div>
      </div>
    `;

    card.addEventListener('click', () => openLightbox(item));
    resultsGrid.appendChild(card);
  });
}

// ── Lightbox ───────────────────────────────────────────────────────────────
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxMeta = document.getElementById('lightbox-meta');

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

function openLightbox(item) {
  lightboxImg.src = item.thumbnail_path ? '/' + item.thumbnail_path.replace(/^\//, '') : '';
  lightboxMeta.innerHTML = `
    <h3 style="margin-bottom:10px">${escHtml(item.people?.join(', ') || 'Unknown')}</h3>
    ${item.date_taken ? `<p class="hint">${item.date_taken.slice(0, 10)}</p>` : ''}
    <div class="result-tags" style="margin-top:10px">
      ${(item.tags || []).map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}
    </div>
  `;
  lightbox.classList.add('open');
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lightboxImg.src = '';
}

// ── Utils ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────
refreshStats();
setInterval(refreshStats, 10000);
