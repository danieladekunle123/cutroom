// The waveform timeline: drag to mark a clip, drag its edges or body to change it, click to seek.
(function (root) {
  const RULER = 22;
  const HANDLE = 7;
  const BAR_STEP = 2;
  const MIN_VIEW = 2;
  const round = (t) => Math.round(t * 100) / 100;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  class Timeline {
    /**
     * callbacks: onSeek(t), onCreate(start, end), onSelect(id|null),
     * onEditStart(), onEditLive(id, start, end), onEditEnd()
     */
    constructor(element, overview, callbacks) {
      this.el = element;
      this.canvas = element.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.playhead = element.querySelector('.tl-playhead');
      this.overview = overview;
      this.thumb = overview.querySelector('.overview-thumb');
      this.cb = callbacks;
      this.duration = 0;
      this.peaks = new Uint8Array(0);
      this.peakMax = 1;
      this.pps = 0;
      this.viewStart = 0;
      this.viewDur = 1;
      this.time = 0;
      this.clips = [];
      this.selectedId = null;
      this.pendingIn = null;
      this.drag = null;
      this.message = '';

      const css = getComputedStyle(document.documentElement);
      this.colors = {
        accent: css.getPropertyValue('--accent').trim(),
        wave: css.getPropertyValue('--wave').trim(),
        faint: css.getPropertyValue('--faint').trim(),
        muted: css.getPropertyValue('--muted').trim(),
        text: css.getPropertyValue('--text').trim(),
        control: css.getPropertyValue('--control').trim(),
        surface: css.getPropertyValue('--surface').trim(),
      };

      new ResizeObserver(() => this.draw()).observe(element);
      element.addEventListener('pointerdown', (e) => this.onDown(e));
      element.addEventListener('pointermove', (e) => this.onMove(e));
      element.addEventListener('pointerup', (e) => this.onUp(e));
      element.addEventListener('pointercancel', () => { this.drag = null; this.draw(); });
      element.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      this.thumb.addEventListener('pointerdown', (e) => this.onThumbDown(e));
      overview.addEventListener('pointerdown', (e) => {
        if (e.target !== overview) return;
        const rect = overview.getBoundingClientRect();
        this.setView(((e.clientX - rect.left) / rect.width) * this.duration - this.viewDur / 2, this.viewDur);
      });
    }

    setData({ duration, peaks, pps, message }) {
      this.duration = duration || 0;
      this.peaks = peaks || new Uint8Array(0);
      this.peakMax = this.peaks.length ? Math.max(1, this.peaks.reduce((m, v) => (v > m ? v : m), 0)) : 1;
      this.pps = pps || 0;
      this.message = message || '';
      this.viewStart = 0;
      this.viewDur = this.duration || 1;
      this.draw();
    }

    setClips(clips, selectedId, pendingIn) {
      this.clips = clips;
      this.selectedId = selectedId;
      this.pendingIn = pendingIn;
      this.draw();
    }

    setTime(t, follow) {
      this.time = t;
      if (follow && this.viewDur < this.duration && (t < this.viewStart || t > this.viewStart + this.viewDur)) {
        this.setView(t - this.viewDur * 0.05, this.viewDur);
      }
      this.placePlayhead();
    }

    width() { return this.el.clientWidth || 1; }
    xOf(t) { return ((t - this.viewStart) / this.viewDur) * this.width(); }
    tOf(x) { return clamp(this.viewStart + (x / this.width()) * this.viewDur, 0, this.duration); }

    setView(start, dur) {
      const viewDur = clamp(dur, Math.min(MIN_VIEW, this.duration || MIN_VIEW), this.duration || 1);
      this.viewDur = viewDur;
      this.viewStart = clamp(start, 0, Math.max(0, this.duration - viewDur));
      this.draw();
    }

    zoom(factor, anchor = this.time) {
      const pinned = anchor >= this.viewStart && anchor <= this.viewStart + this.viewDur
        ? anchor : this.viewStart + this.viewDur / 2;
      const ratio = (pinned - this.viewStart) / this.viewDur;
      const next = this.viewDur * factor;
      this.setView(pinned - ratio * next, next);
    }

    fit() { this.setView(0, this.duration); }

    /** Find what's under the pointer: a clip edge, a clip body, or nothing. */
    hit(x) {
      const ordered = [...this.clips].sort((a, b) => (a.id === this.selectedId ? 1 : 0) - (b.id === this.selectedId ? 1 : 0)).reverse();
      for (const clip of ordered) {
        const left = this.xOf(clip.start);
        const right = this.xOf(clip.end);
        if (Math.abs(x - left) <= HANDLE && x <= (left + right) / 2) return { clip, part: 'start' };
        if (Math.abs(x - right) <= HANDLE && x >= (left + right) / 2) return { clip, part: 'end' };
        if (x > left && x < right) return { clip, part: 'body' };
      }
      return null;
    }

    local(e) {
      const rect = this.el.getBoundingClientRect();
      return { x: clamp(e.clientX - rect.left, 0, rect.width), y: e.clientY - rect.top };
    }

    onDown(e) {
      if (e.button !== 0 || !this.duration) return;
      this.el.setPointerCapture(e.pointerId);
      this.el.focus({ preventScroll: true });
      const { x, y } = this.local(e);
      const t = this.tOf(x);
      if (y < RULER) {
        this.drag = { mode: 'scrub' };
        this.cb.onSeek(t);
        return;
      }
      const hit = this.hit(x);
      if (hit) {
        this.cb.onSelect(hit.clip.id);
        this.drag = {
          mode: hit.part,
          id: hit.clip.id,
          startX: x,
          grabT: t,
          orig: { start: hit.clip.start, end: hit.clip.end },
          moved: false,
        };
      } else {
        this.drag = { mode: 'create', startX: x, anchor: t, current: t, moved: false };
      }
    }

    onMove(e) {
      const { x, y } = this.local(e);
      if (!this.drag) {
        this.updateCursor(x, y);
        return;
      }
      const t = this.tOf(x);
      const d = this.drag;
      if (d.mode === 'scrub') {
        this.cb.onSeek(t);
        return;
      }
      if (d.mode !== 'create' && !d.moved) {
        if (Math.abs(x - d.startX) < 3) return;
        d.moved = true;
        this.cb.onEditStart();
      }
      if (d.mode === 'create') {
        d.current = t;
        if (Math.abs(x - d.startX) >= 3) d.moved = true;
        this.draw();
      } else if (d.mode === 'start') {
        this.cb.onEditLive(d.id, round(Math.min(t, d.orig.end - Logic.MIN_CLIP)), d.orig.end);
      } else if (d.mode === 'end') {
        this.cb.onEditLive(d.id, d.orig.start, round(Math.max(t, d.orig.start + Logic.MIN_CLIP)));
      } else if (d.mode === 'body') {
        const length = d.orig.end - d.orig.start;
        const start = clamp(d.orig.start + (t - d.grabT), 0, Math.max(0, this.duration - length));
        this.cb.onEditLive(d.id, round(start), round(start + length));
      }
    }

    onUp(e) {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const { x } = this.local(e);
      if (d.mode === 'create') {
        const start = Math.min(d.anchor, d.current);
        const end = Math.max(d.anchor, d.current);
        if (d.moved && end - start >= Logic.MIN_CLIP) {
          this.cb.onCreate(round(start), round(end));
        } else {
          this.cb.onSelect(null);
          this.cb.onSeek(this.tOf(x));
        }
        this.draw();
      } else if (d.mode !== 'scrub') {
        if (d.moved) this.cb.onEditEnd();
        else this.cb.onSeek(this.tOf(x));
      }
    }

    onWheel(e) {
      if (!this.duration) return;
      e.preventDefault();
      const { x } = this.local(e);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = (e.deltaX || e.deltaY) / this.width();
        this.setView(this.viewStart + delta * this.viewDur, this.viewDur);
      } else {
        this.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, this.tOf(x));
      }
    }

    onThumbDown(e) {
      e.preventDefault();
      e.stopPropagation();
      this.thumb.setPointerCapture(e.pointerId);
      const grabX = e.clientX;
      const grabStart = this.viewStart;
      const rect = this.overview.getBoundingClientRect();
      const move = (ev) => this.setView(grabStart + ((ev.clientX - grabX) / rect.width) * this.duration, this.viewDur);
      const up = () => {
        this.thumb.removeEventListener('pointermove', move);
        this.thumb.removeEventListener('pointerup', up);
      };
      this.thumb.addEventListener('pointermove', move);
      this.thumb.addEventListener('pointerup', up);
    }

    updateCursor(x, y) {
      if (y < RULER) { this.el.style.cursor = 'pointer'; return; }
      const hit = this.hit(x);
      if (!hit) this.el.style.cursor = 'crosshair';
      else this.el.style.cursor = hit.part === 'body' ? 'grab' : 'ew-resize';
    }

    placePlayhead() {
      const x = this.xOf(this.time);
      const visible = x >= -1 && x <= this.width() + 1;
      this.playhead.style.display = visible && this.duration ? 'block' : 'none';
      this.playhead.style.transform = `translateX(${x}px)`;
    }

    placeOverview() {
      const idle = !this.duration || this.viewDur >= this.duration - 0.001;
      this.overview.classList.toggle('is-idle', idle);
      if (idle) return;
      this.thumb.style.left = `${(this.viewStart / this.duration) * 100}%`;
      this.thumb.style.width = `${(this.viewDur / this.duration) * 100}%`;
    }

    draw() {
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      const c = this.ctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      this.placeOverview();
      this.placePlayhead();
      if (!this.duration) return;
      this.drawRuler(c, w);
      this.drawRegions(c, h, 'fill');
      this.drawWave(c, w, h);
      this.drawRegions(c, h, 'edges');
      this.drawPending(c, h);
      if (this.message) {
        c.font = '500 13px Inter, system-ui, sans-serif';
        c.fillStyle = this.colors.muted;
        c.textAlign = 'center';
        c.fillText(this.message, w / 2, RULER + (h - RULER) / 2 - 10);
        c.textAlign = 'left';
      }
    }

    drawRuler(c, w) {
      const step = Logic.tickStep(this.viewDur / w);
      const digits = step < 1 ? 1 : 0;
      c.font = '11px Inter, system-ui, sans-serif';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      const first = Math.ceil(this.viewStart / step) * step;
      for (let t = first; t <= this.viewStart + this.viewDur; t += step) {
        const x = Math.round(this.xOf(t));
        c.fillStyle = this.colors.control;
        c.fillRect(x, RULER - 6, 1, 6);
        const label = Logic.formatTime(t, digits);
        c.fillStyle = this.colors.faint;
        if (x + 4 + c.measureText(label).width < w) c.fillText(label, x + 4, RULER / 2);
      }
    }

    drawWave(c, w, h) {
      const mid = RULER + (h - RULER) / 2 + 6;
      const amp = (h - RULER) / 2 - 14;
      const onClips = this.clips.filter((clip) => clip.on !== false);
      const offClips = this.clips.filter((clip) => clip.on === false);
      const inside = (list, t) => list.some((clip) => t >= clip.start && t <= clip.end);
      const paths = { wave: new Path2D(), on: new Path2D(), off: new Path2D() };
      if (!this.peaks.length) {
        c.fillStyle = this.colors.wave;
        c.fillRect(0, mid, w, 1);
        return;
      }
      for (let x = 0; x < w; x += BAR_STEP) {
        const t0 = this.viewStart + (x / w) * this.viewDur;
        const t1 = this.viewStart + ((x + BAR_STEP) / w) * this.viewDur;
        const i0 = Math.floor(t0 * this.pps);
        const i1 = Math.min(this.peaks.length, Math.max(i0 + 1, Math.ceil(t1 * this.pps)));
        let level = 0;
        for (let i = i0; i < i1; i++) if (this.peaks[i] > level) level = this.peaks[i];
        const height = Math.max(1, Math.pow(level / this.peakMax, 0.75) * amp);
        const target = inside(onClips, (t0 + t1) / 2) ? paths.on : inside(offClips, (t0 + t1) / 2) ? paths.off : paths.wave;
        target.rect(x, mid - height, 1.25, height * 2);
      }
      c.fillStyle = this.colors.wave;
      c.fill(paths.wave);
      c.fillStyle = this.colors.faint;
      c.fill(paths.off);
      c.fillStyle = this.colors.accent;
      c.fill(paths.on);
    }

    drawRegions(c, h, layer) {
      c.font = '500 12px Inter, system-ui, sans-serif';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      this.clips.forEach((clip, index) => {
        const left = this.xOf(clip.start);
        const right = this.xOf(clip.end);
        if (right < 0 || left > this.width()) return;
        const selected = clip.id === this.selectedId;
        const on = clip.on !== false;
        const hue = on ? this.colors.accent : this.colors.faint;
        if (layer === 'fill') {
          c.globalAlpha = selected ? 0.2 : 0.09;
          c.fillStyle = hue;
          c.fillRect(left, RULER, right - left, h - RULER);
          c.globalAlpha = 1;
          return;
        }
        const edge = selected ? 3 : 1;
        c.fillStyle = hue;
        c.fillRect(left, RULER, edge, h - RULER);
        c.fillRect(right - edge, RULER, edge, h - RULER);
        if (right - left > 26) {
          c.save();
          c.beginPath();
          c.rect(left + 4, RULER, right - left - 8, 18);
          c.clip();
          c.fillStyle = selected ? this.colors.text : this.colors.muted;
          c.fillText(`${index + 1}  ${clip.name}`, left + 7, RULER + 10);
          c.restore();
        }
      });
    }

    drawPending(c, h) {
      const accent = this.colors.accent;
      if (this.drag && this.drag.mode === 'create' && this.drag.moved) {
        const left = this.xOf(Math.min(this.drag.anchor, this.drag.current));
        const right = this.xOf(Math.max(this.drag.anchor, this.drag.current));
        c.globalAlpha = 0.25;
        c.fillStyle = accent;
        c.fillRect(left, RULER, right - left, h - RULER);
        c.globalAlpha = 1;
        c.fillRect(left, RULER, 1, h - RULER);
        c.fillRect(right - 1, RULER, 1, h - RULER);
      }
      if (this.pendingIn !== null && this.pendingIn !== undefined) {
        const x = this.xOf(this.pendingIn);
        c.fillStyle = accent;
        c.fillRect(x, RULER, 2, h - RULER);
        c.fillRect(x, RULER, 8, 2);
        c.fillRect(x, h - 2, 8, 2);
      }
    }
  }

  root.Timeline = Timeline;
})(globalThis);
