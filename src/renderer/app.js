// Editor state and interface. All text from videos goes in through textContent, never as HTML.
(function () {
  const { formatTime, parseTime, parseRanges, splitUrls, MIN_CLIP } = Logic;
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  const state = {
    videos: [],
    activeId: null,
    settings: {},
    selectedClipId: null,
    pendingIn: null,
    runtime: new Map(), // id -> { status, stage, progress, error, previewUrl, peaks, pps, hasAudio, hasVideo }
    history: new Map(), // id -> { undo: [], redo: [] }
    exporting: false,
    lastOutput: null,
    sequence: null, // clips being played back one after another
  };

  const video = $('video');
  let saveTimer = null;
  let toastTimer = null;
  let clipCounter = 0;

  const newId = () => `c${Date.now().toString(36)}${(clipCounter++).toString(36)}`;
  const active = () => state.videos.find((v) => v.id === state.activeId) || null;
  const runtimeOf = (id) => {
    if (!state.runtime.has(id)) state.runtime.set(id, { status: 'idle', progress: 0 });
    return state.runtime.get(id);
  };
  const includedClips = (v) => (v ? v.clips.filter((c) => c.on !== false) : []);

  function element(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  function toast(message, ms = 4000) {
    const box = $('toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms);
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${Math.round(bytes / 1e6)} MB`;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveLibrary({ videos: state.videos, settings: state.settings }).then((result) => {
        if (result.error) toast(`Couldn't save your clips: ${result.error}`);
      });
    }, 250);
  }

  /* ---------- Timeline wiring ---------- */

  const timeline = new Timeline($('timeline'), $('overview'), {
    onSeek: (t) => { stopSequence(); seek(t); },
    onSelect: (id) => selectClip(id),
    onCreate: (start, end) => addClips([{ start, end }]),
    onEditStart: () => pushHistory(),
    onEditLive: (id, start, end) => {
      const clip = active().clips.find((c) => c.id === id);
      clip.start = start;
      clip.end = end;
      refreshClipRow(clip);
      refreshTimelineClips();
      renderCut();
    },
    onEditEnd: () => scheduleSave(),
  });

  function refreshTimelineClips() {
    const v = active();
    timeline.setClips(v ? v.clips : [], state.selectedClipId, state.pendingIn);
  }

  /* ---------- Undo ---------- */

  function historyOf(id) {
    if (!state.history.has(id)) state.history.set(id, { undo: [], redo: [] });
    return state.history.get(id);
  }

  function pushHistory() {
    const v = active();
    if (!v) return;
    const h = historyOf(v.id);
    h.undo.push(JSON.stringify(v.clips));
    if (h.undo.length > 100) h.undo.shift();
    h.redo.length = 0;
  }

  function stepHistory(from, to) {
    const v = active();
    if (!v) return;
    const h = historyOf(v.id);
    if (!h[from].length) return;
    h[to].push(JSON.stringify(v.clips));
    v.clips = JSON.parse(h[from].pop());
    if (!v.clips.some((c) => c.id === state.selectedClipId)) state.selectedClipId = null;
    clipsChanged();
  }

  /* ---------- Clips ---------- */

  function clipsChanged() {
    renderClips();
    refreshTimelineClips();
    renderCut();
    renderExport();
    renderLibrary();
    scheduleSave();
  }

  function nextClipName(v) {
    const used = new Set(v.clips.map((c) => c.name));
    let n = v.clips.length + 1;
    while (used.has(`Clip ${n}`)) n++;
    return `Clip ${n}`;
  }

  function addClips(ranges) {
    const v = active();
    if (!v || !ranges.length) return;
    pushHistory();
    let last = null;
    for (const { start, end } of ranges) {
      last = { id: newId(), name: nextClipName(v), start, end, on: true };
      v.clips.push(last);
    }
    state.selectedClipId = last.id;
    state.lastOutput = null;
    clipsChanged();
    const row = document.querySelector(`[data-clip="${last.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function removeClip(id) {
    const v = active();
    pushHistory();
    v.clips = v.clips.filter((c) => c.id !== id);
    if (state.selectedClipId === id) state.selectedClipId = null;
    clipsChanged();
  }

  function selectClip(id) {
    if (state.selectedClipId === id) return;
    state.selectedClipId = id;
    document.querySelectorAll('.clip-row').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.clip === id);
    });
    document.querySelectorAll('.cut-seg').forEach((seg) => {
      seg.classList.toggle('is-selected', seg.dataset.clip === id);
    });
    refreshTimelineClips();
    if (id) {
      const row = document.querySelector(`[data-clip="${id}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveClip(id, toIndex) {
    const v = active();
    const from = v.clips.findIndex((c) => c.id === id);
    if (from < 0 || toIndex < 0 || toIndex >= v.clips.length || from === toIndex) return;
    pushHistory();
    const [clip] = v.clips.splice(from, 1);
    v.clips.splice(toIndex, 0, clip);
    clipsChanged();
  }

  function commitTime(input, clip, field) {
    const value = parseTime(input.value);
    const duration = active().duration;
    const start = field === 'start' ? value : clip.start;
    const end = field === 'end' ? value : clip.end;
    const valid = value !== null && start >= 0 && end <= duration + 0.001 && end - start >= MIN_CLIP;
    input.classList.toggle('is-invalid', !valid);
    if (!valid) {
      input.title = `Use a time between 0:00 and ${formatTime(duration, 0)}, with the end after the start.`;
      return;
    }
    input.title = '';
    if (value !== clip[field]) {
      pushHistory();
      clip[field] = value;
    }
    input.value = formatTime(clip[field]);
    refreshClipRow(clip);
    refreshTimelineClips();
    renderCut();
    scheduleSave();
  }

  function refreshClipRow(clip) {
    const row = document.querySelector(`[data-clip="${clip.id}"]`);
    if (!row) return;
    const startInput = row.querySelector('[data-field="start"]');
    const endInput = row.querySelector('[data-field="end"]');
    if (document.activeElement !== startInput) startInput.value = formatTime(clip.start);
    if (document.activeElement !== endInput) endInput.value = formatTime(clip.end);
    row.querySelector('.clip-length').textContent = formatTime(clip.end - clip.start, 1);
  }

  function timeField(clip, field, index) {
    const input = element('input', {
      class: 'clip-time',
      type: 'text',
      spellcheck: false,
      value: formatTime(clip[field]),
      'aria-label': `Clip ${index + 1} ${field}`,
      'data-field': field,
      onfocus: () => selectClip(clip.id),
      onchange: () => commitTime(input, clip, field),
      onkeydown: (e) => { if (e.key === 'Enter') input.blur(); },
    });
    return input;
  }

  function renderClips() {
    const v = active();
    const list = $('clip-list');
    list.replaceChildren();
    if (!v) return;
    $('clip-count').textContent = v.clips.length ? String(v.clips.length) : '';
    const sorted = v.clips.every((c, i) => i === 0 || v.clips[i - 1].start <= c.start);
    $('sort-clips').hidden = sorted;
    if (!v.clips.length) {
      list.append(element('li', { class: 'clip-empty' }, 'Drag across the waveform to mark your first clip, or type its times above.'));
      return;
    }
    v.clips.forEach((clip, index) => {
      const grip = element('button', {
        class: 'icon-btn clip-grip',
        type: 'button',
        title: 'Drag to change the order. Up and Down arrow keys also work.',
        'aria-label': `Move clip ${index + 1}`,
        onkeydown: (e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); moveClip(clip.id, index - 1); }
          if (e.key === 'ArrowDown') { e.preventDefault(); moveClip(clip.id, index + 1); }
        },
        onpointerdown: () => { row.draggable = true; },
      }, icon('grip'));
      const row = element('li', {
        class: `clip-row${clip.id === state.selectedClipId ? ' is-selected' : ''}${clip.on === false ? ' is-off' : ''}`,
        'data-clip': clip.id,
        onclick: () => selectClip(clip.id),
        ondragstart: (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-cutroom-clip', clip.id);
        },
        ondragend: () => { row.draggable = false; clearDropMarks(); },
        ondragover: (e) => {
          if (!e.dataTransfer.types.includes('application/x-cutroom-clip')) return;
          e.preventDefault();
          clearDropMarks();
          row.classList.add(dropAfter(e, row) ? 'drop-after' : 'drop-before');
        },
        ondrop: (e) => {
          const id = e.dataTransfer.getData('application/x-cutroom-clip');
          if (!id) return;
          e.preventDefault();
          const after = dropAfter(e, row);
          const from = v.clips.findIndex((c) => c.id === id);
          let to = index + (after ? 1 : 0);
          if (from < to) to -= 1;
          clearDropMarks();
          moveClip(id, to);
        },
      },
      element('input', {
        class: 'clip-check',
        type: 'checkbox',
        checked: clip.on !== false,
        'aria-label': `Include ${clip.name} in the export`,
        title: 'Include in the export',
        onchange: (e) => {
          pushHistory();
          clip.on = e.target.checked;
          clipsChanged();
        },
      }),
      element('input', {
        class: 'clip-name',
        type: 'text',
        spellcheck: false,
        value: clip.name,
        maxLength: 80,
        'aria-label': `Clip ${index + 1} name`,
        onfocus: () => selectClip(clip.id),
        onchange: (e) => {
          const name = e.target.value.trim();
          if (!name) { e.target.value = clip.name; return; }
          pushHistory();
          clip.name = name;
          refreshTimelineClips();
          scheduleSave();
        },
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      }),
      element('div', { class: 'clip-actions' },
        element('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Play this clip',
          'aria-label': `Play ${clip.name}`,
          onclick: (e) => { e.stopPropagation(); playSequence([clip]); },
        }, icon('play')),
        grip,
        element('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Delete this clip (Delete)',
          'aria-label': `Delete ${clip.name}`,
          onclick: (e) => { e.stopPropagation(); removeClip(clip.id); },
        }, icon('trash'))),
      element('div', { class: 'clip-times' },
        timeField(clip, 'start', index),
        element('span', { class: 'clip-arrow' }, 'to'),
        timeField(clip, 'end', index),
        element('span', { class: 'clip-length' }, formatTime(clip.end - clip.start, 1))));
      list.append(row);
    });
  }

  function dropAfter(e, row) {
    const rect = row.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  }

  function clearDropMarks() {
    document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  /* ---------- What the export will produce ---------- */

  function renderCut() {
    const v = active();
    const clips = includedClips(v);
    const merge = state.settings.merge && clips.length > 1;
    const total = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
    $('cut-total').textContent = formatTime(total, 1);
    if (!clips.length) $('cut-label').textContent = 'No clips ticked';
    else if (merge) $('cut-label').textContent = `1 file from ${clips.length} clips`;
    else $('cut-label').textContent = clips.length === 1 ? '1 file' : `${clips.length} files, total length`;
    const strip = $('cut-strip');
    strip.className = `cut-strip ${merge ? 'is-merged' : 'is-separate'}`;
    strip.replaceChildren(...clips.map((clip) => {
      const share = (clip.end - clip.start) / total;
      const seg = element('div', {
        class: `cut-seg${clip.id === state.selectedClipId ? ' is-selected' : ''}`,
        'data-clip': clip.id,
        title: `${clip.name}, ${formatTime(clip.end - clip.start, 1)}`,
        onclick: () => { selectClip(clip.id); seek(clip.start); },
      }, share > 0.05 ? String(v.clips.indexOf(clip) + 1) : '');
      seg.style.flex = `${clip.end - clip.start} 1 0`;
      return seg;
    }));
  }

  function renderExport() {
    const v = active();
    const { kind, merge, quality, bitrate, outDir } = state.settings;
    const rt = v ? runtimeOf(v.id) : {};
    document.querySelectorAll('[data-kind]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    });
    document.querySelectorAll('[data-merge]').forEach((b) => {
      b.setAttribute('aria-checked', String((b.dataset.merge === 'true') === !!merge));
    });

    const select = $('quality');
    let options;
    if (kind === 'mp3') {
      options = [[320, '320 kbps'], [192, '192 kbps'], [128, '128 kbps']];
    } else {
      const heights = v ? v.heights : [];
      const top = heights[0];
      options = [['best', 'Best']];
      for (const h of heights.filter((x) => x !== top && x >= 240).slice(0, 6)) options.push([h, `${h}p`]);
    }
    select.replaceChildren(...options.map(([value, label]) => element('option', { value: String(value) }, label)));
    select.value = String(kind === 'mp3' ? bitrate : quality);
    if (select.selectedIndex < 0) select.selectedIndex = 0;

    $('out-dir').textContent = `‎${outDir || ''}`;
    $('out-dir').title = outDir || '';

    const clips = includedClips(v);
    const button = $('export');
    const type = kind === 'mp3' ? 'MP3' : 'MP4';
    if (!clips.length) button.textContent = `Export ${type}`;
    else if (merge && clips.length > 1) button.textContent = `Export merged ${type}`;
    else button.textContent = clips.length === 1 ? `Export 1 ${type}` : `Export ${clips.length} ${type}s`;
    const noAudio = kind === 'mp3' && rt.status === 'ready' && rt.hasAudio === false;
    button.disabled = !clips.length || state.exporting || noAudio;
    button.title = noAudio ? 'This video has no audio track.' : (clips.length ? '' : 'Mark a clip first.');
    $('export-idle').hidden = state.exporting;
    $('export-busy').hidden = !state.exporting;
    $('export-done').hidden = !state.lastOutput || state.exporting;
  }

  async function startExport() {
    const v = active();
    const clips = includedClips(v);
    if (!v || !clips.length || state.exporting) return;
    const { kind, merge, outDir } = state.settings;
    // What the menu shows, since a saved choice may not exist for this video.
    const chosen = $('quality').value;
    const quality = kind === 'mp3' || chosen === 'best' ? 'best' : Number(chosen);
    const bitrate = kind === 'mp3' ? Number(chosen) : state.settings.bitrate;
    state.exporting = true;
    state.lastOutput = null;
    $('export-error').hidden = true;
    $('export-label').textContent = 'Starting';
    $('export-pct').textContent = '';
    $('export-bar').style.width = '0';
    renderExport();
    const result = await api.startExport({
      video: { id: v.id, url: v.url, title: v.title, duration: v.duration },
      clips: clips.map(({ name, start, end }) => ({ name, start, end })),
      kind, merge, quality, bitrate, outDir,
    });
    state.exporting = false;
    if (result.ok) {
      state.lastOutput = result.ok.outputs;
      const count = result.ok.outputs.length;
      $('export-done-label').textContent = count === 1 ? 'Saved 1 file' : `Saved ${count} files`;
    } else if (!result.cancelled) {
      $('export-error').textContent = result.error;
      $('export-error').hidden = false;
    }
    renderExport();
    refreshCacheSize();
  }

  /* ---------- Playback ---------- */

  function seek(t) {
    const v = active();
    if (!v) return;
    const time = Math.max(0, Math.min(t, v.duration));
    if (runtimeOf(v.id).status === 'ready') video.currentTime = time;
    timeline.setTime(time, true);
    $('time-now').textContent = formatTime(time);
  }

  function stopSequence() {
    state.sequence = null;
    $('play-clips').classList.remove('is-on');
  }

  function playSequence(clips) {
    if (!clips.length || runtimeOf(state.activeId).status !== 'ready') return;
    state.sequence = { clips, index: 0, solo: clips.length === 1 };
    $('play-clips').classList.toggle('is-on', clips.length > 1);
    seek(clips[0].start);
    video.play();
  }

  /** Runs on a timer, because a covered or minimized window stops getting animation frames. */
  function followSequence() {
    const seq = state.sequence;
    if (!seq || video.paused) return;
    if (video.currentTime < seq.clips[seq.index].end) return;
    seq.index += 1;
    if (seq.index >= seq.clips.length) {
      video.pause();
      stopSequence();
    } else {
      video.currentTime = seq.clips[seq.index].start;
    }
  }

  function tick() {
    if (!video.paused) {
      timeline.setTime(video.currentTime, true);
      $('time-now').textContent = formatTime(video.currentTime);
    }
    requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (runtimeOf(state.activeId).status !== 'ready') return;
    if (video.paused) video.play();
    else { video.pause(); stopSequence(); }
  }

  function renderPlayIcon() {
    const button = $('play');
    button.replaceChildren(icon(video.paused ? 'play' : 'pause'));
    button.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  }

  function markIn() {
    if (!active()) return;
    state.pendingIn = video.currentTime;
    $('mark-in').classList.add('is-on');
    refreshTimelineClips();
  }

  function markOut() {
    const v = active();
    if (!v) return;
    const now = video.currentTime;
    const start = state.pendingIn === null ? 0 : state.pendingIn;
    state.pendingIn = null;
    $('mark-in').classList.remove('is-on');
    if (Math.abs(now - start) < MIN_CLIP) {
      toast('A clip needs a start and an end at different times.');
      refreshTimelineClips();
      return;
    }
    addClips([{ start: Math.round(Math.min(start, now) * 100) / 100, end: Math.round(Math.max(start, now) * 100) / 100 }]);
  }

  /* ---------- Library and loading ---------- */

  function renderLibrary() {
    const list = $('library-list');
    list.replaceChildren();
    if (!state.videos.length) {
      list.append(element('li', { class: 'library-empty' }, 'Videos you add stay here with their clips.'));
    }
    for (const v of state.videos) {
      const rt = runtimeOf(v.id);
      let sub = `${formatTime(v.duration, 0)}, ${v.clips.length} ${v.clips.length === 1 ? 'clip' : 'clips'}`;
      if (rt.status === 'loading') sub = `${rt.stage === 'waveform' ? 'Reading audio' : 'Downloading'} ${Math.round((rt.progress || 0) * 100)}%`;
      if (rt.status === 'queued') sub = 'Waiting';
      if (rt.status === 'error') sub = "Couldn't load";
      const site = Logic.siteOf(v.url);
      list.append(element('li', {
        class: `library-row${v.id === state.activeId ? ' is-active' : ''}`,
        onclick: () => openVideo(v.id),
      },
      v.thumbnail
        ? element('img', { class: 'library-thumb', src: v.thumbnail, alt: '', draggable: false })
        : element('span', { class: 'library-thumb' }),
      element('span', { class: 'library-name', title: v.title }, v.title),
      element('span', { class: `library-sub num${rt.status === 'error' ? ' is-error' : ''}` }, ...(site ? [logo(site, 14)] : []), sub),
      element('button', {
        class: 'icon-btn library-remove',
        type: 'button',
        title: 'Remove this video and its clips',
        'aria-label': `Remove ${v.title}`,
        onclick: (e) => { e.stopPropagation(); removeVideo(v.id); },
      }, icon('x'))));
    }
  }

  function renderScreen() {
    const v = active();
    if (!v) return;
    const rt = runtimeOf(v.id);
    const status = $('screen-status');
    const ready = rt.status === 'ready';
    status.hidden = ready;
    video.hidden = !ready;
    ['play', 'mark-in', 'mark-out', 'play-clips'].forEach((id) => { $(id).disabled = !ready; });
    if (ready) return;
    $('screen-thumb').hidden = !v.thumbnail;
    if (v.thumbnail) $('screen-thumb').src = v.thumbnail;
    status.classList.toggle('is-error', rt.status === 'error');
    $('status-retry').hidden = rt.status !== 'error';
    if (rt.status === 'error') {
      $('status-label').textContent = rt.error;
      return;
    }
    const pct = Math.round((rt.progress || 0) * 100);
    if (rt.status === 'queued') $('status-label').textContent = 'Waiting for the other video to finish';
    else if (rt.stage === 'waveform') $('status-label').textContent = `Reading the audio ${pct}%`;
    else $('status-label').textContent = `Downloading a preview ${pct}%`;
    $('status-bar').style.width = `${pct}%`;
  }

  function renderHead() {
    const v = active();
    if (!v) return;
    $('video-title').textContent = v.title;
    $('video-title').title = v.title;
    const top = v.heights[0];
    const parts = [v.uploader, formatTime(v.duration, 0), top ? `exports up to ${top}p` : ''].filter(Boolean);
    const site = Logic.siteOf(v.url);
    $('video-meta').replaceChildren(...(site ? [logo(site, 14)] : []), parts.join(', '));
    $('time-total').textContent = `/ ${formatTime(v.duration, 0)}`;
  }

  function renderShell() {
    const v = active();
    $('empty-stage').hidden = !!v;
    $('editor').hidden = !v;
    $('side').hidden = !v;
    $('workspace').classList.toggle('is-empty', !v);
    $('add-form').hidden = !v;
    if (v) {
      renderHead();
      renderScreen();
      renderClips();
      renderCut();
    }
    renderExport();
    renderLibrary();
  }

  function applyRuntimeToEditor(v) {
    const rt = runtimeOf(v.id);
    if (rt.status === 'ready') {
      if (video.getAttribute('src') !== rt.previewUrl) {
        video.poster = v.thumbnail || '';
        video.src = rt.previewUrl;
        video.load();
      }
      timeline.setData({ duration: v.duration, peaks: rt.peaks, pps: rt.pps, message: rt.hasAudio ? '' : 'This video has no sound' });
    } else {
      video.pause();
      video.removeAttribute('src');
      video.load();
      timeline.setData({ duration: v.duration, peaks: new Uint8Array(0), pps: 0 });
    }
    refreshTimelineClips();
    timeline.setTime(0);
    $('time-now').textContent = formatTime(0);
  }

  function openVideo(id) {
    if (state.activeId === id) return;
    stopSequence();
    video.pause();
    state.activeId = id;
    state.selectedClipId = null;
    state.pendingIn = null;
    state.lastOutput = null;
    $('mark-in').classList.remove('is-on');
    $('export-error').hidden = true;
    state.settings.activeId = id;
    renderShell();
    const v = active();
    if (v) applyRuntimeToEditor(v);
    else { video.pause(); video.removeAttribute('src'); video.load(); }
    scheduleSave();
  }

  function markReady(id, prepared) {
    Object.assign(runtimeOf(id), {
      status: 'ready',
      previewUrl: prepared.previewUrl,
      peaks: prepared.peaks,
      pps: prepared.peaksPerSecond,
      hasAudio: prepared.hasAudio,
      hasVideo: prepared.hasVideo,
      error: null,
    });
  }

  async function prepareVideo(v) {
    const rt = runtimeOf(v.id);
    rt.status = 'queued';
    rt.progress = 0;
    rt.error = null;
    renderLibrary();
    if (v.id === state.activeId) { renderScreen(); applyRuntimeToEditor(v); }
    const result = await api.prepareVideo({ id: v.id, url: v.url, duration: v.duration });
    if (!state.videos.includes(v)) return;
    if (result.ok) {
      markReady(v.id, result.ok);
    } else if (result.cancelled) {
      return;
    } else {
      rt.status = 'error';
      rt.error = result.error;
    }
    renderLibrary();
    if (v.id === state.activeId) {
      renderScreen();
      renderExport();
      applyRuntimeToEditor(v);
    }
    refreshCacheSize();
  }

  async function addLinks(text) {
    const { urls, invalid } = splitUrls(text);
    if (invalid.length && !urls.length) {
      toast(`"${invalid[0].slice(0, 60)}" doesn't look like a link.`);
      return false;
    }
    for (const url of urls) {
      toast('Looking up the video');
      const result = await api.videoInfo(url);
      if (result.error) {
        toast(`Couldn't open that link. ${result.error}`, 9000);
        continue;
      }
      $('toast').hidden = true;
      const info = result.ok;
      const existing = state.videos.find((v) => v.id === info.id);
      if (existing) {
        openVideo(existing.id);
        continue;
      }
      const v = { ...info, clips: [] };
      state.videos.unshift(v);
      openVideo(v.id);
      prepareVideo(v);
    }
    return urls.length > 0;
  }

  async function removeVideo(id) {
    const v = state.videos.find((x) => x.id === id);
    if (!v) return;
    if (v.clips.length) {
      const result = await api.confirm({
        message: `Remove "${v.title}"?`,
        detail: `Its ${v.clips.length} marked ${v.clips.length === 1 ? 'clip' : 'clips'} and downloaded files will be deleted. Files you've already exported are kept.`,
        action: 'Remove',
      });
      if (!result.ok) return;
    }
    const wasActive = state.activeId === id;
    if (wasActive) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    state.videos = state.videos.filter((x) => x !== v);
    state.runtime.delete(id);
    state.history.delete(id);
    if (wasActive) {
      state.activeId = null;
      openVideo(state.videos[0] ? state.videos[0].id : null);
    } else {
      renderLibrary();
    }
    scheduleSave();
    const result = await api.removeVideo(id);
    if (result.error) toast(`Removed, but some files couldn't be deleted: ${result.error}`);
    refreshCacheSize();
  }

  async function refreshCacheSize() {
    const result = await api.cacheUsage();
    if (result.ok !== undefined) $('cache-size').textContent = `Stored videos: ${formatBytes(result.ok)}`;
  }

  /* ---------- Events ---------- */

  function bindForm(formId, inputId) {
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $(inputId);
      const text = input.value;
      if (!text.trim()) { input.focus(); return; }
      input.value = '';
      input.dispatchEvent(new Event('input'));
      const accepted = await addLinks(text);
      if (!accepted) input.value = text;
    });
  }

  function isTyping(target) {
    return target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox'
      || target instanceof HTMLSelectElement;
  }

  function renderLogos() {
    $('add-logos').replaceChildren(...LOGO_SITES.map((site) => {
      const mark = logo(site, 16);
      mark.dataset.site = site;
      return mark;
    }));
    $('empty-logos').replaceChildren(...LOGO_SITES.map((site) => element('span', { class: 'empty-site' }, logo(site, 24), logoName(site))));
    // The logo of the site you're pasting from stands out from the other two.
    $('add-input').addEventListener('input', (e) => {
      const { urls } = splitUrls(e.target.value);
      const sites = new Set(urls.map(Logic.siteOf));
      $('add-logos').classList.toggle('has-match', sites.size > 0 && [...sites].some(Boolean));
      $('add-logos').querySelectorAll('.logo').forEach((mark) => mark.classList.toggle('is-match', sites.has(mark.dataset.site)));
    });
  }

  function bindEvents() {
    renderLogos();
    bindForm('add-form', 'add-input');
    bindForm('empty-form', 'empty-input');

    $('play').replaceChildren(icon('play'));
    $('zoom-in').replaceChildren(icon('plus'));
    $('zoom-out').replaceChildren(icon('minus'));
    $('volume-icon').replaceChildren(icon('volume'));
    $('play').addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    video.addEventListener('loadedmetadata', () => {
      if (runtimeOf(state.activeId).hasVideo && video.videoWidth === 0) {
        toast("This PC can't show this video's preview picture. Sound, the timeline and exports still work.", 9000);
      }
    });
    video.addEventListener('play', renderPlayIcon);
    video.addEventListener('pause', renderPlayIcon);
    video.addEventListener('ended', () => { stopSequence(); renderPlayIcon(); });
    $('mark-in').addEventListener('click', markIn);
    $('mark-out').addEventListener('click', markOut);
    $('play-clips').addEventListener('click', () => {
      if (state.sequence && state.sequence.clips.length > 1) { video.pause(); stopSequence(); return; }
      const clips = includedClips(active());
      if (clips.length) playSequence(clips);
      else toast('Mark a clip first.');
    });
    $('zoom-in').addEventListener('click', () => timeline.zoom(1 / 1.6));
    $('zoom-out').addEventListener('click', () => timeline.zoom(1.6));
    $('zoom-fit').addEventListener('click', () => timeline.fit());
    $('volume').addEventListener('input', (e) => {
      video.volume = Number(e.target.value);
      $('volume-icon').replaceChildren(icon(video.volume === 0 ? 'mute' : 'volume'));
      state.settings.volume = video.volume;
      scheduleSave();
    });

    $('ranges-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('ranges-input');
      const { ranges, errors } = parseRanges(input.value, active().duration);
      addClips(ranges);
      $('ranges-error').hidden = !errors.length;
      $('ranges-error').textContent = errors.join('. ');
      input.value = errors.length ? input.value : '';
    });
    $('sort-clips').addEventListener('click', () => {
      pushHistory();
      active().clips.sort((a, b) => a.start - b.start);
      clipsChanged();
    });

    document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      state.settings.kind = b.dataset.kind;
      state.lastOutput = null;
      renderExport();
      scheduleSave();
    }));
    document.querySelectorAll('[data-merge]').forEach((b) => b.addEventListener('click', () => {
      state.settings.merge = b.dataset.merge === 'true';
      state.lastOutput = null;
      renderCut();
      renderExport();
      scheduleSave();
    }));
    $('quality').addEventListener('change', (e) => {
      if (state.settings.kind === 'mp3') state.settings.bitrate = Number(e.target.value);
      else state.settings.quality = e.target.value === 'best' ? 'best' : Number(e.target.value);
      scheduleSave();
    });
    $('choose-folder').addEventListener('click', async () => {
      const result = await api.chooseFolder(state.settings.outDir);
      if (result.ok) {
        state.settings.outDir = result.ok;
        renderExport();
        scheduleSave();
      }
    });
    $('export').addEventListener('click', startExport);
    $('export-cancel').addEventListener('click', () => api.cancelExport());
    $('export-show').addEventListener('click', () => {
      if (state.lastOutput) api.showFile(state.lastOutput[0]);
    });
    $('status-retry').addEventListener('click', () => { if (active()) prepareVideo(active()); });
    $('clear-cache').addEventListener('click', async () => {
      if (state.exporting) { toast('Wait for the export to finish first.'); return; }
      const result = await api.confirm({
        message: 'Clear downloaded full-quality files?',
        detail: 'Your clips and previews stay. Full-quality files are downloaded again the next time you export.',
        action: 'Clear',
      });
      if (!result.ok) return;
      await api.clearCache();
      refreshCacheSize();
    });

    api.onVideoProgress(({ id, stage, progress }) => {
      const rt = runtimeOf(id);
      rt.status = 'loading';
      rt.stage = stage;
      rt.progress = progress;
      if (id === state.activeId) renderScreen();
      renderLibraryProgressThrottled();
    });
    api.onExportProgress(({ label, progress }) => {
      $('export-label').textContent = label;
      $('export-pct').textContent = `${Math.round(progress * 100)}%`;
      $('export-bar').style.width = `${progress * 100}%`;
    });

    document.addEventListener('click', (e) => {
      // A clicked button keeps focus, and Space would press it again instead of playing.
      if (e.detail > 0 && e.target.closest('button')) document.activeElement.blur();
    });

    document.addEventListener('keydown', (e) => {
      if (isTyping(e.target) || !active()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? 'redo' : 'undo', e.shiftKey ? 'undo' : 'redo'); return; }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory('redo', 'undo'); return; }
      if (ctrl || e.altKey) return;
      const step = e.shiftKey ? 5 : 1;
      switch (e.key) {
        case ' ':
          if (e.target instanceof HTMLButtonElement) return;
          e.preventDefault();
          togglePlay();
          break;
        case 'i': case 'I': markIn(); break;
        case 'o': case 'O': markOut(); break;
        case 'ArrowLeft': e.preventDefault(); stopSequence(); seek(video.currentTime - step); break;
        case 'ArrowRight': e.preventDefault(); stopSequence(); seek(video.currentTime + step); break;
        case 'Home': stopSequence(); seek(0); break;
        case 'End': stopSequence(); seek(active().duration); break;
        case 'Delete': case 'Backspace':
          if (state.selectedClipId) removeClip(state.selectedClipId);
          break;
        case 'Escape':
          state.pendingIn = null;
          $('mark-in').classList.remove('is-on');
          selectClip(null);
          refreshTimelineClips();
          break;
        default:
      }
    });

    document.addEventListener('paste', (e) => {
      if (isTyping(e.target)) return;
      const text = e.clipboardData.getData('text');
      if (splitUrls(text).urls.length) addLinks(text);
    });
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('text/plain')) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (text && !isTyping(e.target)) {
        e.preventDefault();
        addLinks(text);
      }
    });
  }

  let libraryThrottle = 0;
  function renderLibraryProgressThrottled() {
    const now = Date.now();
    if (now - libraryThrottle < 200) return;
    libraryThrottle = now;
    renderLibrary();
  }

  /* ---------- Start ---------- */

  async function start() {
    bindEvents();
    const loaded = await api.loadLibrary();
    if (loaded.ok) {
      state.videos = loaded.ok.videos.map((v) => ({ ...v, clips: Array.isArray(v.clips) ? v.clips : [], heights: v.heights || [] }));
      state.settings = loaded.ok.settings;
    } else {
      toast(`Couldn't read your saved videos: ${loaded.error}`);
    }
    video.volume = Number(state.settings.volume ?? 1);
    $('volume').value = String(video.volume);

    const tools = await api.checkTools();
    if (tools.ok && tools.ok.length) {
      const box = $('tools-missing');
      box.textContent = `Cutroom needs ${tools.ok.map((t) => t.cmd).join(' and ')}. Install with: ${[...new Set(tools.ok.map((t) => t.install))].join(' and ')}`;
      box.hidden = false;
    }

    await Promise.all(state.videos.map(async (v) => {
      const result = await api.loadVideo(v.id);
      if (result.ok) markReady(v.id, result.ok);
    }));

    // Videos added by an older version have their quality list worked out the old way.
    state.videos.filter((v) => !v.infoVersion).forEach(async (v) => {
      const result = await api.videoInfo(v.url);
      if (!result.ok || result.ok.id !== v.id) return;
      v.heights = result.ok.heights;
      v.infoVersion = result.ok.infoVersion;
      if (v.id === state.activeId) { renderHead(); renderExport(); }
      scheduleSave();
    });

    const first = state.videos.find((v) => v.id === state.settings.activeId) || state.videos[0];
    openVideo(first ? first.id : null);
    if (!first) renderShell();
    state.videos.filter((v) => runtimeOf(v.id).status !== 'ready').forEach(prepareVideo);
    refreshCacheSize();
    setInterval(followSequence, 25);
    requestAnimationFrame(tick);
  }

  start();
})();
