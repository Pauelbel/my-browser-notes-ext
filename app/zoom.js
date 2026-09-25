// Interface scale. Loaded as a classic script in <head> so the saved scale applies before first paint;
// the settings slider in app.js reuses it through globalThis.quietZoom.
// The side panel opens index.html?view=panel, so the panel and the tab keep separate scales.
globalThis.quietZoom = {
  key: `quiet-zoom:${new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'tab'}`,
  min: 70, max: 120, step: 5, fallback: 100,
  clamp(percent) {
    const value = Math.round(Number(percent) / this.step) * this.step;
    return Number.isFinite(value) && value ? Math.min(this.max, Math.max(this.min, value)) : this.fallback;
  },
  read() {
    try { return this.clamp(localStorage.getItem(this.key) ?? this.fallback); } catch { return this.fallback; }
  },
  apply(percent) {
    const zoom = this.clamp(percent) / 100, root = document.documentElement;
    root.style.zoom = String(zoom);
    // --zoom corrects viewport units; --text-zoom keeps note text and the settings dialog at 100%.
    root.style.setProperty('--zoom', String(zoom));
    root.style.setProperty('--text-zoom', String(1 / zoom));
  },
  save(percent) {
    try { localStorage.setItem(this.key, String(this.clamp(percent))); } catch {}
  },
};
quietZoom.apply(quietZoom.read());
