// Kleiner Canvas-Liniendiagramm-Renderer ohne Abhängigkeiten
(function () {
  const tip = () => document.getElementById('chartTip');

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  class LineChart {
    constructor(canvas, { format = (v) => v.toFixed(1), fixedMax = null } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.format = format;
      this.fixedMax = fixedMax;
      this.series = [];
      this.times = [];
      this.hover = -1;
      canvas.addEventListener('mousemove', (e) => this.onMove(e));
      canvas.addEventListener('mouseleave', () => { this.hover = -1; tip().classList.add('hidden'); this.draw(); });
      new ResizeObserver(() => this.draw()).observe(canvas);
    }

    // series: [{ label, color, values: number[] }]
    setData(times, series) {
      this.times = times;
      this.series = series;
      this.draw();
    }

    geometry() {
      const r = this.canvas.getBoundingClientRect();
      return { w: r.width, h: r.height, padL: 54, padR: 12, padT: 10, padB: 24 };
    }

    draw() {
      const dpr = window.devicePixelRatio || 1;
      const { w, h, padL, padR, padT, padB } = this.geometry();
      if (!w || !h) return;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      const c = this.ctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      const n = this.times.length;
      const all = this.series.flatMap((s) => s.values).filter(Number.isFinite);
      const max = this.fixedMax ?? niceMax(Math.max(0, ...all) * 1.1);
      const pw = w - padL - padR;
      const ph = h - padT - padB;
      const x = (i) => padL + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
      const y = (v) => padT + ph - (v / max) * ph;

      // Raster + Achsen
      c.font = '11px "Segoe UI", sans-serif';
      c.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i;
        const yy = Math.round(y(v)) + 0.5;
        c.strokeStyle = '#222836';
        c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
        c.fillStyle = '#5f677b';
        c.textAlign = 'right';
        c.fillText(this.format(v), padL - 8, yy);
      }

      if (!n) {
        c.fillStyle = '#5f677b';
        c.textAlign = 'center';
        c.fillText('Keine Daten', padL + pw / 2, padT + ph / 2);
        return;
      }

      c.textAlign = 'center';
      c.textBaseline = 'top';
      const ticks = Math.min(5, n);
      for (let i = 0; i < ticks; i++) {
        const idx = Math.round((i / Math.max(1, ticks - 1)) * (n - 1));
        c.fillStyle = '#5f677b';
        c.fillText(fmtTime(this.times[idx], this.times), x(idx), h - padB + 7);
      }

      for (const s of this.series) {
        // Fläche
        const grad = c.createLinearGradient(0, padT, 0, padT + ph);
        grad.addColorStop(0, s.color + '55');
        grad.addColorStop(1, s.color + '00');
        c.beginPath();
        s.values.forEach((v, i) => (i ? c.lineTo(x(i), y(v || 0)) : c.moveTo(x(i), y(v || 0))));
        c.lineTo(x(n - 1), padT + ph); c.lineTo(x(0), padT + ph); c.closePath();
        c.fillStyle = grad; c.fill();
        // Linie
        c.beginPath();
        s.values.forEach((v, i) => (i ? c.lineTo(x(i), y(v || 0)) : c.moveTo(x(i), y(v || 0))));
        c.strokeStyle = s.color; c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
      }

      if (this.hover >= 0 && this.hover < n) {
        const hx = Math.round(x(this.hover)) + 0.5;
        c.strokeStyle = '#3a4357';
        c.beginPath(); c.moveTo(hx, padT); c.lineTo(hx, padT + ph); c.stroke();
        for (const s of this.series) {
          c.beginPath();
          c.arc(hx, y(s.values[this.hover] || 0), 4, 0, Math.PI * 2);
          c.fillStyle = s.color; c.fill();
          c.strokeStyle = '#151922'; c.lineWidth = 2; c.stroke();
        }
      }
    }

    onMove(e) {
      const n = this.times.length;
      if (!n) return;
      const r = this.canvas.getBoundingClientRect();
      const { padL, padR } = this.geometry();
      const rel = (e.clientX - r.left - padL) / (r.width - padL - padR);
      this.hover = Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1))));
      this.draw();

      const t = tip();
      const d = new Date(this.times[this.hover] * 1000);
      t.innerHTML = `<div class="t">${d.toLocaleString('de-DE')}</div>` +
        this.series.map((s) =>
          `<div><span class="sw" style="background:${s.color}"></span>${s.label}: <b>${this.format(s.values[this.hover] || 0)}</b></div>`
        ).join('');
      t.classList.remove('hidden');
      const tw = t.offsetWidth;
      t.style.left = Math.min(window.innerWidth - tw - 10, e.clientX + 14) + 'px';
      t.style.top = e.clientY + 14 + 'px';
    }
  }

  function fmtTime(sec, all) {
    const d = new Date(sec * 1000);
    const span = all.length > 1 ? all[all.length - 1] - all[0] : 0;
    if (span <= 2 * 86400) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (span <= 60 * 86400) return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
  }

  window.LineChart = LineChart;
})();
