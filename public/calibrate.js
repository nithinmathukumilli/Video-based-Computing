'use strict';
// Camera seat calibration: click seats on the camera's reference picture and save them.
// Each seat is a dot (x and y between 0 and 1 across the picture) that belongs to one app table.
(() => {
  const $ = (id) => document.getElementById(id);
  let seats = []; // { id, x, y, table }
  let tables = []; // { id, name, cap, part }, in the order of the parts on the home page
  let dirty = false;

  const showError = (msg) => { $('cal-error').textContent = msg || ''; $('cal-error').hidden = !msg; };
  const status = (msg) => { $('cal-status').textContent = msg || ''; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const nextId = () => { let n = 1; const used = new Set(seats.map((s) => s.id)); while (used.has(n)) n++; return n; };
  const touched = () => { dirty = true; status('Not saved yet'); draw(); };

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    return data;
  }

  // A dropdown of every table, grouped by part. A seat saved for a table that no longer exists shows as a missing option.
  function tableSelect(value) {
    const sel = document.createElement('select');
    const groups = new Map();
    for (const t of tables) {
      if (!groups.has(t.part)) { const g = document.createElement('optgroup'); g.label = t.part; groups.set(t.part, g); sel.append(g); }
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${t.name} · ${plural(t.cap, 'seat', 'seats')}`;
      groups.get(t.part).append(o);
    }
    if (value && !tables.some((t) => t.id === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = 'This table was removed: pick another';
      sel.prepend(o);
    }
    if (value) sel.value = value;
    return sel;
  }

  function draw() {
    const pic = $('cal-pic');
    pic.querySelectorAll('.cal-dot').forEach((n) => n.remove());
    for (const s of seats) {
      const d = document.createElement('span');
      d.className = 'cal-dot';
      d.style.left = `${s.x * 100}%`;
      d.style.top = `${s.y * 100}%`;
      d.textContent = String(s.id);
      d.title = `Seat ${s.id}`;
      pic.append(d);
    }
    $('cal-list').replaceChildren(...seats.map((s) => {
      const li = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `Seat ${s.id}`;
      const sel = tableSelect(s.table);
      sel.setAttribute('aria-label', `Table for seat ${s.id}`);
      sel.addEventListener('change', () => { s.table = sel.value; touched(); });
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => { seats = seats.filter((q) => q !== s); touched(); });
      li.append(label, sel, rm);
      return li;
    }));
    $('cal-empty').hidden = seats.length > 0;

    // how many of each table's chairs the camera watches: fewer than its seats is fine, more is a mistake
    const counts = new Map();
    for (const s of seats) counts.set(s.table, (counts.get(s.table) || 0) + 1);
    $('cal-cover').replaceChildren(...[...counts].map(([id, n]) => {
      const t = tables.find((q) => q.id === id);
      const li = document.createElement('li');
      if (!t) { li.textContent = `${plural(n, 'seat is', 'seats are')} marked for a table that was removed.`; li.className = 'bad'; return li; }
      li.textContent = n > t.cap
        ? `${t.name} (${t.part}) has ${plural(t.cap, 'seat', 'seats')} but ${n} are marked. Remove ${n - t.cap}.`
        : `${t.name} (${t.part}): the camera watches ${n} of ${plural(t.cap, 'seat', 'seats')}.${n < t.cap ? ' The others keep their own state.' : ''}`;
      if (n > t.cap) li.className = 'bad';
      return li;
    }));
  }

  $('cal-pic').addEventListener('click', (e) => {
    if (e.target.closest('.cal-dot')) return;
    const r = $('cal-img').getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (seats.length >= 100) return showError('That is the most seats one camera can have (100).');
    showError('');
    seats.push({ id: nextId(), x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, table: $('cal-table').value });
    touched();
  });

  $('cal-clear').addEventListener('click', () => {
    if (seats.length && !confirm('Remove every marked seat?')) return;
    seats = [];
    touched();
  });

  $('cal-save').addEventListener('click', async () => {
    showError('');
    try {
      const res = await api('POST', '/api/admin/camera', { seats });
      seats = res.seats;
      dirty = false;
      status(`Saved ${plural(seats.length, 'seat', 'seats')}`);
      draw();
    } catch (e) { showError(e.message); }
  });

  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  (async () => {
    try {
      const res = await api('GET', '/api/admin/camera');
      seats = res.seats;
      tables = res.tables;
      // within a part, number the tables in order ("Table 2" before "Table 10")
      const order = [...new Set(tables.map((t) => t.part))];
      tables.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      $('cal-table').replaceWith(Object.assign(tableSelect(''), { id: 'cal-table' }));
      draw();
    } catch (e) { showError(e.message); }
  })();
})();
