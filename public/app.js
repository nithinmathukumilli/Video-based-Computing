(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Small DOM builder. Uses text nodes only, so names can never inject HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ---------- state ----------
  let me = { name: '', admin: false, holdMinutes: 5 };
  let data = null; // latest { now, tables }
  let skew = 0; // server clock minus this device's clock
  let party = 2;
  let watch = false;
  let leaving = null; // { id, n } while the "how many are leaving" panel is open
  let lastKey = '';
  let lastJson = '';
  let selectedId = null; // table tapped on the map
  let editing = false; // admin is dragging tables around
  let dragging = null; // { id, x, y } while a table is being dragged
  let wantTable = new URLSearchParams(location.search).get('table'); // set when opened from a Teams message
  let prevTables = null; // tables from the previous update, to spot what changed
  const pulseIds = new Set(); // tables that just changed (they get a quick ping on the map)
  const walkers = new Map(); // table id -> { n, t0 }: people who just left and are walking away from it
  let partView = null; // the part the person has opened (null = the overview of all parts)
  let zoneMode = false; // true while the map shows the overview of the room, where the parts are tapped
  let setupSig = ''; // what the admin lists were last drawn from, so typing in them isn't interrupted
  let hereId = null; // the table that locks the page for this person (null while still looking, and always for admins)
  let myTableId = null; // the table this person sat at, admin or not: it gets the "You are here" mark
  let greetNormal = ''; // the usual greeting, put back when they are not sitting
  const WALK_MS = 1500;
  const MANY_TABLES = 24; // above this: tables are drawn smaller on the map so they all fit
  let mineUntil = 0; // while now < this, changes were caused by my own tap, so no "seats opened" toast
  let freedTotal = 0; // seats this person has freed, kept on this device only
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  try {
    const saved = parseInt(localStorage.getItem('party'), 10);
    if (saved >= 1 && saved <= 8) party = saved;
    freedTotal = parseInt(localStorage.getItem('freed'), 10) || 0;
  } catch (e) {}

  const nowS = () => Date.now() + skew;
  const avail = (tb) => Math.max(0, tb.free - tb.held);

  // ---------- server calls ----------
  function showError(msg) {
    const el = $('error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // Dev testing: /?as=asha acts as that user. The server ignores it unless DEV_USER is set.
  const AS = new URLSearchParams(location.search).get('as');
  const withAs = (p) => (AS ? p + (p.includes('?') ? '&' : '?') + 'as=' + encodeURIComponent(AS) : p);

  // ---------- little moments of fun ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove('in');
    void el.offsetWidth; // restart the slide-in
    el.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  // Flat citron and gray squares falling from the top. Skipped for people who prefer less motion.
  function confetti(count) {
    if (calm) return;
    const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    const colors = ['var(--citron)', 'var(--g7)', 'var(--citron)', 'var(--g3)'];
    for (let i = 0; i < (count || 30); i++) {
      const bit = h('i');
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = colors[i % colors.length];
      bit.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
      bit.style.animationDelay = `${Math.random() * 0.3}s`;
      bit.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 240)}px`);
      bit.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      box.append(bit);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 3200);
  }

  function addFreed(n) {
    freedTotal += n;
    try { localStorage.setItem('freed', String(freedTotal)); } catch (e) {}
  }

  // Compare with the last update: ping the tables that changed, and announce seats that opened up.
  function noteChanges(tables) {
    if (prevTables) {
      pulseIds.clear();
      const old = new Map(prevTables.map((t) => [t.id, t]));
      let best = null;
      for (const t of tables) {
        const o = old.get(t.id);
        if (!o) continue;
        if (o.free !== t.free || o.held !== t.held) pulseIds.add(t.id);
        if (t.free > o.free && !calm) walkers.set(t.id, { n: t.free - o.free, t0: Date.now() }); // people who just left
        const gain = avail(t) - avail(o);
        if (gain > 0 && (!best || gain > best.gain)) best = { t, gain };
      }
      if (best && Date.now() > mineUntil) {
        toast(`${best.gain} ${best.gain === 1 ? 'seat' : 'seats'} just opened at ${best.t.name}.${avail(best.t) >= party ? ' Fits your group!' : ''}`);
      }
    }
    prevTables = tables;
  }

  async function api(method, path, body) {
    if (method !== 'GET') mineUntil = Date.now() + 2000;
    try {
      const r = await fetch(withAs(path), {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401) { location.reload(); return null; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        showError(j.error || 'Something went wrong. Try again.');
        return null;
      }
      showError('');
      applyState(j);
      return j;
    } catch (e) {
      showError("Can't reach the server. Check your connection, or reload if your sign-in expired.");
      return null;
    }
  }
  const post = (path, body) => api('POST', path, body || {});

  function applyState(j) {
    if (!j || !j.tables) return;
    skew = j.now - Date.now();
    const s = JSON.stringify([j.parts, j.tables, j.areas]);
    data = j;
    if (s !== lastJson) {
      noteChanges(j.tables);
      lastJson = s;
      render();
      checkAlert();
    }
  }

  function connect() {
    const es = new EventSource(withAs('/api/events'));
    es.onopen = () => ($('conn').hidden = true);
    es.onmessage = (e) => {
      $('conn').hidden = true;
      try {
        applyState(JSON.parse(e.data));
      } catch (err) {}
    };
    es.onerror = () => ($('conn').hidden = false);
    // Fallback for proxies/tunnels that hold back the live stream: load once now, then poll.
    const pull = () => fetch(withAs('/api/state'), { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) { location.reload(); return null; } // signed in elsewhere: show the sign-in page
        return r.ok ? r.json() : null;
      })
      .then(applyState)
      .catch(() => {});
    pull();
    setInterval(pull, 3000);
  }

  // ---------- alerts ----------
  // One shared audio context, started on the tap, so phones allow the beep later.
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }

  function beep() {
    try {
      unlockAudio();
      const ctx = audioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }

  function myHoldTable() {
    return data && data.tables.find((t) => t.mine && t.mine.until > nowS());
  }

  function checkAlert() {
    if (!watch || !data || myHoldTable()) return;
    const fitting = data.tables.filter((t) => avail(t) >= party);
    const key = fitting.map((t) => `${t.id}:${avail(t)}`).join(',');
    if (!key) {
      lastKey = '';
      return;
    }
    if (key === lastKey) return;
    lastKey = key;
    beep();
    try {
      if (window.Notification && Notification.permission === 'granted') {
        const t = fitting[0];
        new Notification('Seats open in the cafeteria', { body: `${t.name} has ${avail(t)} seats free` });
      }
    } catch (e) {}
  }

  // ---------- rendering ----------
  function render() {
    if (!data) return;
    $('loading').hidden = true;
    // Opened from a Teams message (?table=t4): show the map with that table selected and pinging.
    if (wantTable) {
      const t = data.tables.find((x) => x.id === wantTable);
      wantTable = null;
      if (t) {
        selectedId = t.id;
        partView = t.part; // open the part the table is in
        pulseIds.add(t.id);
        toast(`${t.name}:${avail(t)} ${avail(t) === 1 ? 'seat' : 'seats'} free right now.`);
        setTimeout(() => $('map').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' }), 100);
      }
    }
    // Once you have sat down, the page is just "enjoy your meal" and where you are. Finding or holding other seats is hidden.
    // Admins are exempt: they keep every option, and just get a mark on their table.
    const seatedAt = data.tables.filter((t) => (t.sat || 0) > 0).sort((a, b) => b.sat - a.sat)[0] || null;
    const here = me.admin ? null : seatedAt; // the table that locks the page for a non-admin
    hereId = here ? here.id : null;
    myTableId = seatedAt ? seatedAt.id : null;
    $('browse').hidden = !!here;
    $('seated').hidden = !here;
    if (here) {
      selectedId = here.id;
      leaving = leaving && leaving.id === here.id ? leaving : null;
      $('seated-text').textContent = `You're at ${here.name}, in ${here.sat === 1 ? '1 seat' : `${here.sat} seats`}. Finished? Tap "I'm done eating" below to free your seats.`;
      $('greeting').textContent = `You're all set, ${me.name.split(' ')[0]}. Your table is marked on the map.`;
      if (watch) { // no need for "seats open" alerts while you are sitting down
        watch = false;
        syncChain = syncChain.then(syncTeamsAlert).catch(() => {});
      }
    } else if (greetNormal) {
      $('greeting').textContent = greetNormal;
    }

    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.k : null;

    renderFinder();
    renderHold();
    renderView();
    pulseIds.clear(); // each change pings once; later redraws (like tapping a table) must not replay it
    renderSetup();

    if (focusKey) {
      const el = document.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
      if (el && !el.disabled) el.focus();
    }
  }

  function renderFinder() {
    $('party-n').textContent = party;
    const tables = data.tables;
    const totalFree = tables.reduce((s, t) => s + avail(t), 0);
    const fitting = tables.filter((t) => avail(t) >= party);
    let text;
    if (totalFree === 0) text = 'No free seats right now.';
    else if (fitting.length > 0)
      text = `${fitting.length} ${fitting.length === 1 ? 'table fits' : 'tables fit'} your group of ${party}.`;
    else text = `${totalFree} free ${totalFree === 1 ? 'seat' : 'seats'}, but none together for ${party}.`;
    $('summary').textContent = text;

    const btn = $('alert-toggle');
    btn.classList.toggle('on', watch);
    btn.setAttribute('aria-pressed', String(watch));
    btn.textContent = watch ? 'Alerts on. Tap to stop' : 'Alert me when seats open';
    $('alert-hint').hidden = !watch;
    $('alert-hint').textContent = me.teamsAlerts
      ? `We'll also message you on Teams the first time a table fits your group, even if you close this page. It lasts ${me.teamsAlertHours} hours and sends just one message.`
      : 'Alerts only work while this page is open. Keep it open in a tab while you wait.';
    $('alert-consent').hidden = watch || !me.teamsAlerts;
    renderMeter();
  }

  function renderMeter() {
    const total = data.tables.reduce((s, t) => s + t.cap, 0);
    const taken = data.tables.reduce((s, t) => s + (t.cap - t.free), 0);
    const pct = total ? Math.round((taken / total) * 100) : 0;
    const mood =
      pct >= 100 ? 'Standing room only' : pct >= 90 ? 'Packed. Good luck out there.' : pct >= 70 ? 'Getting busy' : pct >= 40 ? 'Filling up' : 'Plenty of room';
    $('meter-mood').textContent = mood;
    $('meter-pct').textContent = `${pct}% full`;
    $('meter').setAttribute('aria-label', `${mood}, ${pct}% full`);
    const bar = $('meter-bar');
    const segs = 24;
    if (bar.children.length !== segs) bar.replaceChildren(...[...Array(segs)].map(() => h('i')));
    const on = Math.round((pct / 100) * segs);
    [...bar.children].forEach((el, i) => el.classList.toggle('on', i < on));
  }

  const mmss = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderHold() {
    const bar = $('holdbar');
    const tb = myHoldTable();
    bar.replaceChildren();
    if (!tb) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.append(
      h('span', null,
        `Holding ${tb.mine.n} ${tb.mine.n === 1 ? 'seat' : 'seats'} at `,
        h('b', null, tb.name),
        ' for ',
        h('span', { id: 'holdtime' }, mmss(tb.mine.until - nowS()))
      ),
      h('span', { class: 'holdbtns' },
        h('button', {
          class: 'primary', 'data-k': 'hold-sit',
          onclick: async () => {
            if (await post('/api/sit', { id: tb.id })) {
              confetti(18);
              toast('Enjoy your meal!');
            }
          },
        }, "I've sat down"),
        h('button', { 'data-k': 'hold-release', onclick: () => post('/api/hold/cancel') }, 'Release')
      ),
      h('div', { class: 'holdprog', 'aria-hidden': 'true' }, h('i', { id: 'holdfill' }))
    );
    tickHold(tb);
  }

  // The bar drains over the hold time; in the last minute it blinks.
  function tickHold(tb) {
    const left = tb.mine.until - nowS();
    const el = $('holdtime');
    if (el) el.textContent = mmss(left);
    const fill = $('holdfill');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, (left / (me.holdMinutes * 60000)) * 100))}%`;
    $('holdbar').classList.toggle('hurry', left < 60000);
  }

  setInterval(() => {
    const tb = myHoldTable();
    if (tb) tickHold(tb);
    else if (!$('holdbar').hidden) render(); // my hold just ran out
  }, 1000);

  function seatsView(tb) {
    const taken = tb.cap - tb.free;
    const states = [...Array(tb.cap)].map((_, i) => (i < taken ? 'taken' : i < taken + tb.held ? 'held' : 'free'));
    const row = (list) => h('div', { class: 'chairs' }, list.map((s) => h('span', { class: `chair ${s}` })));
    return h('div', { class: 'seats', 'aria-hidden': 'true' },
      row(states.filter((_, i) => i % 2 === 0)),
      h('div', { class: 'tabletop' }, tb.name),
      row(states.filter((_, i) => i % 2 === 1))
    );
  }

  // opts.seatedOnly: the person has sat down here, so show only what they can still do (free their seats)
  function cardView(tb, opts) {
    const seatedOnly = !!(opts && opts.seatedOnly);
    const a = avail(tb);
    const taken = tb.cap - tb.free;
    const fits = a >= party;
    const mine = !!(tb.mine && tb.mine.until > nowS());
    const sat = tb.sat || 0; // seats here that this person sat in
    const canFree = me.admin ? taken : Math.min(sat, taken); // everyone else can only free their own seats
    const isLeaving = leaving && leaving.id === tb.id;
    if (isLeaving) leaving.n = Math.max(1, Math.min(leaving.n, canFree));

    let actions;
    if (isLeaving) {
      actions = h('div', { class: 'leave' },
        h('span', { class: 'label' }, 'How many are leaving?'),
        h('div', { class: 'stepper small' },
          h('button', { 'aria-label': 'Fewer', 'data-k': `${tb.id}-lm`, onclick: () => { leaving.n = Math.max(1, leaving.n - 1); render(); } }, '−'),
          h('output', null, leaving.n),
          h('button', { 'aria-label': 'More', 'data-k': `${tb.id}-lp`, onclick: () => { leaving.n = Math.min(canFree, leaving.n + 1); render(); } }, '+')
        ),
        h('div', { class: 'row' },
          h('button', {
            class: 'primary', 'data-k': `${tb.id}-lc`,
            onclick: async () => {
              const n = leaving.n;
              leaving = null;
              render();
              if (await post('/api/leave', { id: tb.id, n })) {
                addFreed(n);
                confetti();
                toast(`Thanks! ${n} ${n === 1 ? 'seat' : 'seats'} freed. That's ${freedTotal} you've passed on so far.`);
              }
            },
          }, `Free ${leaving.n} ${leaving.n === 1 ? 'seat' : 'seats'}`),
          h('button', { 'data-k': `${tb.id}-lx`, onclick: () => { leaving = null; render(); } }, 'Cancel')
        )
      );
    } else if (seatedOnly) {
      actions = h('div', { class: 'row' },
        h('button', {
          class: 'primary', disabled: canFree === 0, 'data-k': `${tb.id}-done`,
          // start with everything they sat in selected; they can lower it if only some of the group are leaving
          onclick: () => { leaving = { id: tb.id, n: Math.max(1, Math.min(sat || canFree, canFree)) }; render(); },
        }, "I'm done eating")
      );
    } else {
      actions = h('div', { class: 'row' },
        h('button', { disabled: canFree === 0, 'data-k': `${tb.id}-done`, onclick: () => { leaving = { id: tb.id, n: 1 }; render(); } }, "I'm done eating"),
        fits && !mine && h('button', { class: 'primary', 'data-k': `${tb.id}-hold`, onclick: () => post('/api/hold', { id: tb.id, n: party }) },
          `Hold ${party} for ${me.holdMinutes} min`),
        a > 0 && !mine && h('button', { 'data-k': `${tb.id}-sit`, onclick: () => post('/api/sit', { id: tb.id, n: Math.min(party, a) }) }, 'Sit here now')
      );
    }

    return h('article', { class: `card${fits ? ' fits' : ''}${pulseIds.has(tb.id) ? ' pulse' : ''}` },
      seatsView(tb),
      h('p', { class: 'status' },
        a > 0 ? h('b', { class: 'ok' }, `${a} free`) : h('b', null, 'Full'),
        tb.held > 0 && ` · ${tb.held} held`,
        h('span', { class: 'muted' }, ` of ${tb.cap}`),
        sat > 0 && h('span', { class: 'muted' }, ` · you're sitting ${sat === 1 ? 'in 1 seat' : `in ${sat} seats`}`)
      ),
      // you can only free seats you sat in, so say why the button is off
      !seatedOnly && !me.admin && taken > 0 && sat === 0 && !isLeaving &&
        h('p', { class: 'hint' }, 'You can free seats here after you sit here. Tap "Sit here now", or hold seats and then "I\'ve sat down".'),
      actions
    );
  }

  function renderView() {
    $('map').classList.toggle('editing', editing);
    $('map-hint').hidden = !editing;
    renderMap();
  }

  // Where each chair sits around a table, as percentages of the table's box.
  function chairSpot(shape, i, cap) {
    if (shape === 'single') return [50, 50]; // one chair, in the middle of its little seat
    if (shape === 'round') {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / cap;
      return [50 + 44 * Math.cos(a), 50 + 44 * Math.sin(a)];
    }
    if (shape === 'square') {
      // seats shared round the four sides; if they don't divide evenly, the extras go to the top and bottom first
      const base = Math.floor(cap / 4);
      const extra = cap % 4;
      const count = { top: base + (extra >= 1 ? 1 : 0), right: base + (extra >= 3 ? 1 : 0), bottom: base + (extra >= 2 ? 1 : 0), left: base };
      let left = i;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const c = count[side];
        if (left >= c) { left -= c; continue; }
        const along = 18 + ((left + 0.5) / c) * 64; // spread along the side, away from the corners
        if (side === 'top') return [along, 10];
        if (side === 'bottom') return [along, 90];
        if (side === 'left') return [10, along];
        return [90, along];
      }
    }
    if (shape === 'long') {
      const top = i % 2 === 0;
      const k = top ? Math.ceil(cap / 2) : Math.floor(cap / 2);
      const j = Math.floor(i / 2);
      return [6 + ((j + 0.5) / k) * 88, top ? 13 : 87];
    }
    // booth sofa and high counter: seats on one side only, the other side is the wall
    return [6 + ((i + 0.5) / cap) * 88, shape === 'booth' ? 85 : 83];
  }

  function mapTable(tb) {
    const a = avail(tb);
    const taken = tb.cap - tb.free;
    const shape = tb.shape || 'round';
    const isHere = myTableId === tb.id;
    const cls = ['mt', shape, a > 0 ? 'some' : 'full', a >= party && !hereId && 'fits', selectedId === tb.id && 'sel', editing && 'editing', pulseIds.has(tb.id) && 'pulse', isHere && 'here', tb.cam && 'cam', hereId && !isHere && 'dim', (tb.rot || 0) % 180 === 90 && 'sideways'];
    const el = h('button', {
      class: cls.filter(Boolean).join(' '),
      'data-k': `m-${tb.id}`,
      'aria-label': `${tb.name}, ${a} of ${tb.cap} seats free`,
      'aria-pressed': String(selectedId === tb.id),
      title: tb.name,
      onclick: () => {
        if (editing || hereId) return; // while sitting down, the page just shows where you are
        selectedId = selectedId === tb.id ? null : tb.id;
        leaving = null;
        render();
      },
    });
    el.style.left = `${tb.x == null ? 50 : tb.x}%`; // a table's place on its part's page
    el.style.top = `${tb.y == null ? 50 : tb.y}%`;
    el.style.setProperty('--rot', `${tb.rot || 0}deg`); // how far it is turned; names and people are turned back upright

    for (let i = 0; i < tb.cap; i++) {
      const state = i < taken ? 'taken' : i < taken + tb.held ? 'held' : 'free';
      const [x, y] = chairSpot(shape, i, tb.cap);
      const c = h('span', { class: `chair ${state}` });
      c.style.left = `${x}%`;
      c.style.top = `${y}%`;
      c.style.setProperty('--d', `${-((i * 0.37) % 1.6).toFixed(2)}s`); // each person eats out of step with the others
      el.append(c);
    }
    el.append(h('span', { class: 'top' }, h('span', { class: 'nm' }, tb.name), h('span', { class: 'ct' }, a > 0 ? `${a}/${tb.cap}` : 'Full')));
    if (isHere) el.append(h('span', { class: 'you' }, 'You are here'));
    if (tb.cam) el.append(h('span', { class: 'camtag', title: `Seen by the camera at ${new Date(tb.cam.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }, 'From camera'));
    if (editing) {
      // turn the table a quarter turn at a time (a span, not a button, because the table itself is a button)
      el.append(h('span', {
        class: 'rotbtn', role: 'button', tabindex: '0', title: 'Turn this table', 'aria-label': `Turn ${tb.name}`,
        onpointerdown: (e) => e.stopPropagation(), // so tapping it doesn't start dragging the table
        onclick: (e) => { e.stopPropagation(); post('/api/admin/layout', { tables: [{ id: tb.id, rot: ((tb.rot || 0) + 90) % 360 }] }); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); post('/api/admin/layout', { tables: [{ id: tb.id, rot: ((tb.rot || 0) + 90) % 360 }] }); } },
      }, '↻'));
    }

    // people who just finished: they get up from the freed chairs and walk away from the table
    const w = walkers.get(tb.id);
    const gone = w ? Date.now() - w.t0 : WALK_MS;
    if (w && gone >= WALK_MS) walkers.delete(tb.id);
    else if (w && !editing) {
      for (let k = 0; k < w.n && taken + k < tb.cap; k++) {
        const [x, y] = chairSpot(shape, taken + k, tb.cap);
        const vx = x - 50, vy = y - 50, len = Math.hypot(vx, vy) || 1;
        const p = h('span', { class: 'chair taken walker', 'aria-hidden': 'true' });
        p.style.left = `${x}%`;
        p.style.top = `${y}%`;
        p.style.setProperty('--ox', `${((vx / len) * 10).toFixed(1)}cqw`);
        p.style.setProperty('--oy', `${((vy / len) * 10).toFixed(1)}cqw`);
        p.style.animationDelay = `${-gone}ms`; // a redraw mid-walk carries on instead of restarting
        el.append(p);
        setTimeout(() => p.remove(), WALK_MS - gone);
      }
    }

    el.addEventListener('pointerdown', (e) => {
      if (!editing) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      dragging = { id: tb.id, x: tb.x, y: tb.y };
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.id !== tb.id) return;
      const r = $('map').getBoundingClientRect();
      dragging.x = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100));
      dragging.y = Math.max(2, Math.min(98, ((e.clientY - r.top) / r.height) * 100));
      el.style.left = `${dragging.x}%`;
      el.style.top = `${dragging.y}%`;
    });
    const drop = () => {
      if (!dragging || dragging.id !== tb.id) return;
      const d = dragging;
      dragging = null;
      post('/api/admin/layout', { tables: [{ id: d.id, x: d.x, y: d.y }] });
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    return el;
  }

  // ---------- parts of the cafeteria ----------
  // Each part is its own page: its tables sit at x and y (% of that page), and the page is part.h times as long as it is wide.
  const partsOf = () => (data && data.parts) || [];

  function partStats(p) {
    const tables = data.tables.filter((t) => t.part === p.id);
    return {
      tables,
      free: tables.reduce((s, t) => s + avail(t), 0),
      cap: tables.reduce((s, t) => s + t.cap, 0),
      fits: tables.filter((t) => avail(t) >= party).length,
    };
  }

  // On the room map each part is a band across the room. All the bands are the same size, however many tables a part has.
  function overviewBands(parts) {
    const top = 6.5, bottom = 89, gap = 1.2; // between the windows at the top and the counter and entrance at the bottom
    const weights = parts.map(() => 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const room = bottom - top - gap * (parts.length - 1);
    let y = top;
    return parts.map((p, i) => {
      const band = { y0: y, y1: y + (room * weights[i]) / total };
      y = band.y1 + gap;
      return band;
    });
  }

  function openPart(id) {
    partView = id;
    const sel = data.tables.find((t) => t.id === selectedId);
    if (sel && sel.part !== id) selectedId = null;
    leaving = null;
    render();
    $('mapwrap').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  }

  // A labelled area on a part's page (entrance, lounge, walkway). Drawn behind the tables; an admin can drag and resize it in "Move tables".
  function areaView(a) {
    const el = h('div', { class: `area ${a.kind}${editing ? ' editing' : ''}`, 'data-k': `area-${a.id}`, title: a.label }, h('span', { class: 'albl' }, a.label));
    el.style.left = `${a.x}%`;
    el.style.top = `${a.y}%`;
    el.style.width = `${a.w}%`;
    el.style.height = `${a.h}%`;
    if (!editing) return el;
    const grip = h('span', { class: 'areagrip', 'aria-label': `Resize ${a.label}`, title: 'Drag to resize' });
    el.append(grip);
    const pageBox = () => $('map').getBoundingClientRect();
    let start = null; // what the drag started from: the pointer and the label's box
    const begin = (mode) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      start = { mode, x: e.clientX, y: e.clientY, a: { x: a.x, y: a.y, w: a.w, h: a.h } };
      dragging = { id: a.id, area: true }; // stops the page being redrawn under the finger
    };
    el.addEventListener('pointerdown', (e) => { if (e.target !== grip) begin('move')(e); });
    grip.addEventListener('pointerdown', begin('size'));
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = pageBox();
      const dx = ((e.clientX - start.x) / r.width) * 100;
      const dy = ((e.clientY - start.y) / r.height) * 100;
      const b = { ...start.a };
      if (start.mode === 'move') {
        b.x = Math.max(0, Math.min(100 - b.w, b.x + dx));
        b.y = Math.max(0, Math.min(100 - b.h, b.y + dy));
      } else {
        b.w = Math.max(3, Math.min(100 - b.x, b.w + dx));
        b.h = Math.max(3, Math.min(100 - b.y, b.h + dy));
      }
      Object.assign(start.now = start.now || {}, b);
      el.style.left = `${b.x}%`; el.style.top = `${b.y}%`; el.style.width = `${b.w}%`; el.style.height = `${b.h}%`;
    });
    const finish = () => {
      if (!start) return;
      const box = start.now;
      start = null;
      dragging = null;
      if (box) post('/api/admin/areas/update', { id: a.id, x: box.x, y: box.y, w: box.w, h: box.h });
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    return el;
  }

  // A cute, random-looking scene as the background of a part on the home page: a few little tables with people
  // eating round them, and a few people on their own. It is decoration only and does not follow the real tables.
  // The scene is the same every time for a part.
  function crowd(seedText) {
    let seed = 2166136261;
    for (const ch of String(seedText)) { seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619); }
    const rand = () => { // a small seeded random-number generator, so a part always gets the same picture
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // distances are worked out in pixels on a band about 633 wide and 217 tall: 1% across is 6.3 px, 1% down is 2.2 px
    const dist = (a, b) => Math.hypot((a[0] - b[0]) * 6.3, (a[1] - b[1]) * 2.2);
    const colours = ['var(--g6)', 'var(--mint)', 'var(--almond)', 'var(--sky)', 'var(--g5)'];
    const place = (el, x, y) => { el.style.left = `${x.toFixed(1)}%`; el.style.top = `${y.toFixed(1)}%`; return el; };
    const person = (x, y) => {
      const p = place(h('span', { class: 'chair taken eater' }), x, y);
      p.style.setProperty('--s', (0.85 + rand() * 0.45).toFixed(2));
      p.style.setProperty('--pc', colours[Math.floor(rand() * colours.length)]);
      p.style.setProperty('--d', `${-(rand() * 1.6).toFixed(2)}s`); // each one eats out of step with the others
      return p;
    };

    // 1) a few tables, kept apart, and away from the corner where the part's name and free seats are
    const tables = [];
    for (let tries = 0; tries < 600 && tables.length < 4; tries++) {
      const pos = [14 + rand() * 78, 32 + rand() * 38];
      if (pos[0] < 34 && pos[1] < 62) continue;
      if (tables.some((t) => dist(t.pos, pos) < 120)) continue;
      tables.push({ pos, long: rand() < 0.4 });
    }
    const out = [];
    const seats = []; // where people sit, so loose people can keep clear
    for (const t of tables) {
      const [x, y] = t.pos;
      const el = place(h('span', { class: `dtable ${t.long ? 'long' : 'round'}` }), x, y);
      el.style.setProperty('--s', (0.9 + rand() * 0.25).toFixed(2));
      out.push(el);
      // 2) people sit round it: 3 of the 4 places, picked at random
      const places = t.long
        ? [[x - 3.4, y - 16], [x + 3.4, y - 16], [x - 3.4, y + 16], [x + 3.4, y + 16]]
        : [[x - 5.8, y], [x + 5.8, y], [x, y - 17], [x, y + 17]];
      places.sort(() => rand() - 0.5);
      for (const [px, py] of places.slice(0, rand() < 0.5 ? 3 : 2)) {
        seats.push([px, py]);
        out.push(person(px, py));
      }
    }
    // 3) a few people on their own, doing different things, not on top of a table or each other:
    //    one waves and says hi, two stand with a tray, one sips a hot drink, and a few just eat
    const taken = [];
    const free = () => { // a spot clear of the tables and of everyone already placed
      for (let tries = 0; tries < 500; tries++) {
        const pos = [8 + rand() * 80, 16 + rand() * 70];
        if (pos[0] < 26 && pos[1] < 54) continue;
        if (tables.some((t) => dist(t.pos, pos) < 80)) continue;
        if ([...seats, ...taken].some((s) => dist(s, pos) < 50)) continue;
        taken.push(pos);
        return pos;
      }
      return null;
    };
    const greetings = ['Hi!', 'Hello!', 'Hey!'];
    const waver = (x, y) => {
      const p = person(x, y);
      p.classList.add('waver');
      p.append(h('span', { class: 'hand' }), h('span', { class: 'bubble' }, greetings[Math.floor(rand() * greetings.length)]));
      return p;
    };
    const stander = (x, y) => {
      const p = place(h('span', { class: 'stander' }, h('span', { class: 'tray' })), x, y);
      p.style.setProperty('--s', (0.9 + rand() * 0.25).toFixed(2));
      p.style.setProperty('--pc', colours[Math.floor(rand() * colours.length)]);
      p.style.setProperty('--d', `${-(rand() * 2.4).toFixed(2)}s`);
      return p;
    };
    const sipper = (x, y) => {
      const p = person(x, y);
      p.classList.add('sipper');
      p.append(h('span', { class: 'cup' }));
      return p;
    };
    for (const make of [waver, stander, stander, sipper, person, person]) {
      const pos = free();
      if (pos) out.push(make(pos[0], pos[1]));
    }
    return out;
  }
  function renderPartBar() {
    const bar = $('partbar');
    const parts = partsOf();
    if (parts.length < 2 || editing || hereId) {
      bar.replaceChildren();
      return;
    }
    const chips = parts.map((p) => {
      const s = partStats(p);
      return h('button', {
        class: s.fits > 0 ? 'fits' : '',
        'aria-pressed': String(partView === p.id),
        'data-k': `part-${p.id}`,
        onclick: () => openPart(p.id),
      }, `${p.name} · ${s.free} free`);
    });
    bar.replaceChildren(
      ...(partView ? [h('button', { class: 'back', 'data-k': 'part-back', onclick: () => { partView = null; selectedId = null; leaving = null; render(); } }, '← All parts')] : []),
      ...(partView ? [] : [h('span', { class: 'hint' }, 'Pick a part to see its tables.')]),
      ...chips
    );
  }

  // The "Move tables on map" button in the admin panel shows whether moving is on.
  function syncEditButton() {
    $('edit-layout').textContent = editing ? 'Done moving tables' : 'Move tables on map';
    $('edit-layout').setAttribute('aria-pressed', String(editing));
  }

  function renderMap() {
    if (dragging) return; // don't rebuild the map under someone's finger
    const map = $('map');
    const parts = partsOf();
    const byId = (id) => parts.find((p) => p.id === id);
    // which part's page is open: sitting down shows your own part; one part has no overview; editing needs a part
    if (hereId) {
      const ht = data.tables.find((t) => t.id === hereId);
      partView = ht ? ht.part : null;
    } else if (parts.length < 2) {
      partView = parts[0] ? parts[0].id : null;
    } else if (editing && !byId(partView)) {
      partView = parts[0].id;
    } else if (!byId(partView)) {
      partView = null;
    }
    const part = partView ? byId(partView) : null;
    zoneMode = !part; // the overview of the room: no tables, just the parts
    map.classList.toggle('partpage', !!part);
    // width 680 x w and length 680 x h, so widening a page adds room across without making it taller
    map.style.aspectRatio = part ? `${part.w || 1} / ${part.h || 1.2}` : '';
    if (part) map.style.setProperty('--w', String(part.w || 1)); // how much wider than the old map; tables keep their size
    else map.style.removeProperty('--w');
    const tables = part ? data.tables.filter((t) => t.part === part.id) : [];

    // Demo only: the camera picture with its seats marked, above a part whose tables are read by the camera.
    // A real camera picture would never be shown to staff; this is here so the demo shows where the numbers come from.
    const camAt = Math.max(0, ...tables.map((t) => (t.cam ? t.cam.at : 0)));
    let fig = $('camfig');
    if (camAt && !hereId && !editing) {
      if (!fig) {
        fig = h('figure', { class: 'camfig', id: 'camfig' }, h('img', { alt: 'Camera picture with each seat marked red (taken) or blue (free)' }), h('figcaption'));
        $('partbar').after(fig);
      }
      const img = fig.querySelector('img');
      const src = `/camera/latest.jpg?v=${camAt}`; // a new address each time the camera reports, so the picture refreshes
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      fig.querySelector('figcaption').textContent = `From camera · demo picture · seen ${new Date(camAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · red = taken, blue = free`;
      fig.hidden = false;
    } else if (fig) fig.hidden = true;

    map.querySelectorAll('.mt, .zone').forEach((n) => n.remove());
    map.querySelectorAll('.area').forEach((n) => n.remove());
    if (part) map.append(...(data.areas || []).filter((a) => a.part === part.id).map(areaView)); // behind the tables
    map.append(...tables.map((tb) => mapTable(tb)));
    map.classList.toggle('dense', tables.length > MANY_TABLES); // a part with many tables: draw them smaller

    if (zoneMode) {
      const bands = overviewBands(parts);
      parts.forEach((p, i) => {
        const s = partStats(p);
        const z = h('button', {
          // the colour belongs to the part (not to its place in the order), so moving a part keeps its colour
          class: `zone z${((parseInt(String(p.id).slice(1), 10) || i + 1) - 1) % 8}${s.fits > 0 ? ' fits' : ''}`,
          'data-k': `zone-${p.id}`,
          'aria-label': `${p.name}: ${s.free} of ${s.cap} seats free. Open to see its tables.`,
          onclick: () => openPart(p.id),
        },
          h('span', { class: 'zprev crowd', 'aria-hidden': 'true' }, crowd(p.id)),
          h('span', { class: 'zn' }, p.name),
          h('span', { class: 'zf' }, `${s.free} free`),
          h('span', { class: 'zs' }, !s.tables.length ? 'No tables yet' : s.fits > 0 ? `${s.fits} ${s.fits === 1 ? 'table fits' : 'tables fit'} your group` : `of ${s.cap} seats`)
        );
        z.style.left = '5.5%';
        z.style.width = '93%';
        z.style.top = `${bands[i].y0}%`;
        z.style.height = `${bands[i].y1 - bands[i].y0}%`;
        map.append(z);
      });
    }
    renderPartBar();
    syncEditButton();

    const sel = data.tables.find((t) => t.id === selectedId);
    if (!sel || zoneMode || (partView && sel.part !== partView)) selectedId = null; // nothing is picked in the overview
    const shown = data.tables.find((t) => t.id === selectedId);
    $('picked').replaceChildren(shown
      ? cardView(shown, hereId === shown.id ? { seatedOnly: true } : undefined)
      : h('p', { class: 'tip' }, zoneMode ? 'Tap a part on the map to see its tables.' : 'Tap a table to see its seats and hold or sit.'));
  }
  function renderSetup() {
    $('setup').hidden = !me.admin;
    if (!me.admin) return;
    // only redraw these lists when they changed, so typing in a part name isn't wiped by a seat update
    const sig = JSON.stringify([data.parts, data.tables.map((t) => [t.id, t.name, t.cap, t.part]), (data.areas || []).map((a) => [a.id, a.part, a.label, a.kind])]);
    if (sig === setupSig) return;
    setupSig = sig;
    const parts = partsOf();
    const partSelect = (current, onchange, k) =>
      h('select', { 'aria-label': 'Part', 'data-k': k, onchange: (e) => onchange(e.target.value) },
        parts.map((p) => h('option', { value: p.id, selected: p.id === current }, p.name)));

    const prev = $('new-part').value;
    $('new-part').replaceChildren(...parts.map((p) => h('option', { value: p.id, selected: p.id === prev }, p.name)));

    const prevAreaPart = $('new-area-part').value || partView;
    $('new-area-part').replaceChildren(...parts.map((p) => h('option', { value: p.id, selected: p.id === prevAreaPart }, p.name)));
    $('area-list').replaceChildren(
      ...(data.areas || []).map((a) => {
        const pn = (parts.find((p) => p.id === a.part) || { name: '?' }).name;
        return h('li', null,
          `${pn} · ${a.label} (${a.kind})`,
          h('button', {
            'data-k': `ra-${a.id}`,
            onclick: () => { if (confirm(`Remove the label "${a.label}"?`)) api('DELETE', `/api/admin/areas/${encodeURIComponent(a.id)}`, {}); },
          }, 'Remove')
        );
      })
    );

    $('part-list').replaceChildren(
      ...parts.map((p, idx) =>
        h('li', null,
          h('input', {
            value: p.name, maxlength: '30', 'aria-label': `Name of ${p.name}`, 'data-k': `pn-${p.id}`,
            onchange: (e) => { const name = e.target.value.trim(); if (name && name !== p.name) post('/api/admin/parts/rename', { id: p.id, name }); else e.target.value = p.name; },
          }),
          // the home page lists the parts from top to bottom in this order
          h('button', { 'data-k': `up-${p.id}`, disabled: idx === 0, title: 'Move up', 'aria-label': `Move ${p.name} up`, onclick: () => post('/api/admin/parts/move', { id: p.id, dir: -1 }) }, '↑'),
          h('button', { 'data-k': `dn-${p.id}`, disabled: idx === parts.length - 1, title: 'Move down', 'aria-label': `Move ${p.name} down`, onclick: () => post('/api/admin/parts/move', { id: p.id, dir: 1 }) }, '↓'),
          h('button', {
            'data-k': `rp-${p.id}`, disabled: parts.length <= 1,
            onclick: () => { if (confirm(`Remove ${p.name}? Its tables move to another part.`)) api('DELETE', `/api/admin/parts/${encodeURIComponent(p.id)}`, {}); },
          }, 'Remove')
        )
      )
    );

    $('setup-list').replaceChildren(
      ...data.tables.map((tb) =>
        h('li', null,
          `${tb.name}, ${tb.cap} seats`,
          partSelect(tb.part, (part) => post('/api/admin/table-part', { id: tb.id, part }), `tp-${tb.id}`),
          h('button', {
            'data-k': `rm-${tb.id}`,
            onclick: () => { if (confirm(`Remove ${tb.name}?`)) api('DELETE', `/api/admin/tables/${encodeURIComponent(tb.id)}`, {}); },
          }, 'Remove')
        )
      )
    );
  }

  // ---------- controls ----------
  function setParty(n) {
    party = Math.max(1, Math.min(8, n));
    try { localStorage.setItem('party', String(party)); } catch (e) {}
    lastKey = '';
    render();
    checkAlert();
    if (watch) syncTeamsAlert(); // a new group size means a new thing to wait for
  }

  // Keep the server's "message me on Teams" request in step with the button.
  async function syncTeamsAlert() {
    if (!me.teamsAlerts) return;
    if (watch) await post('/api/alert', { n: party });
    else await post('/api/alert/cancel');
  }

  // Server updates run one after another in the background, so the button never waits on the network.
  let syncChain = Promise.resolve();

  function toggleWatch() {
    unlockAudio();
    if (!watch) {
      try {
        // Not awaited: the prompt must not hold up the button.
        if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
      } catch (e) {}
    }
    lastKey = '';
    watch = !watch;
    render();
    checkAlert();
    syncChain = syncChain.then(syncTeamsAlert).catch(() => {});
    if (watch) {
      const fitsNow = data && data.tables.some((t) => avail(t) >= party);
      // Sound works while this page is open; a Teams message is added only for people signed in with a real email.
      const how = me.teamsAlerts
        ? 'You\'ll hear a beep while this page is open, and we\'ll also message you on Teams'
        : 'You\'ll hear a beep while this page is open';
      toast(fitsNow
        ? `Seats already fit your group of ${party}. Tap "Find me a seat". ${how} when another table opens.`
        : `Alerts on. ${how} when seats open for ${party}.`);
    } else {
      toast('Alerts off.');
    }
  }

  // One tap: hold the snuggest table that fits the group.
  async function findSeat() {
    if (!data) return;
    const mineT = myHoldTable();
    if (mineT) {
      selectedId = mineT.id;
      partView = mineT.part;
      render();
      toast(`You're already holding seats at ${mineT.name}.`);
      return;
    }
    const fits = data.tables
      .filter((t) => avail(t) >= party)
      .sort((a, b) => avail(a) - party - (avail(b) - party) || a.cap - b.cap);
    if (!fits.length) {
      const totalFree = data.tables.reduce((s, t) => s + avail(t), 0);
      toast(totalFree ? `No table has ${party} seats together right now. Turn on alerts and we'll tell you.` : 'No free seats right now. Turn on alerts and we\'ll tell you.');
      return;
    }
    const t = fits[0];
    if (await post('/api/hold', { id: t.id, n: party })) {
      selectedId = t.id;
      partView = t.part; // take them straight to the part their table is in
      leaving = null;
      pulseIds.add(t.id);
      render();
      confetti(14);
      toast(`Held ${party} at ${t.name} for ${me.holdMinutes} min. Go, go, go!`);
    }
  }

  function bind() {
    $('party-minus').addEventListener('click', () => setParty(party - 1));
    $('party-plus').addEventListener('click', () => setParty(party + 1));
    $('alert-toggle').addEventListener('click', toggleWatch);
    $('new-cap').replaceChildren(...[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => h('option', { value: n, selected: n === 4 }, n)));
    // a single chair always has one seat, so the seats menu is set to 1 and locked while it is chosen
    let capBefore = '4';
    $('new-shape').addEventListener('change', () => {
      const single = $('new-shape').value === 'single';
      if (single) capBefore = $('new-cap').value !== '1' ? $('new-cap').value : capBefore;
      $('new-cap').value = single ? '1' : capBefore;
      $('new-cap').disabled = single;
    });
    $('add-table').addEventListener('click', async () => {
      const ok = await post('/api/admin/tables', {
        name: $('new-name').value,
        cap: parseInt($('new-cap').value, 10),
        shape: $('new-shape').value,
        part: $('new-part').value,
      });
      if (ok) {
        $('new-name').value = '';
        $('setup').open = true;
      }
    });
    $('add-part').addEventListener('click', async () => {
      const name = $('new-part-name').value.trim();
      if (!name) return;
      if (await post('/api/admin/parts', { name })) $('new-part-name').value = '';
    });
    $('find-seat').addEventListener('click', findSeat);
    // moving tables works on the part that is open (the first part, if none is)
    const toggleEdit = () => { editing = !editing; render(); };
    $('edit-layout').addEventListener('click', toggleEdit);
    $('add-area').addEventListener('click', async () => {
      const label = $('new-area-label').value.trim();
      if (!label) return;
      if (await post('/api/admin/areas', { label, kind: $('new-area-kind').value, part: $('new-area-part').value })) $('new-area-label').value = '';
    });
    $('reset-all').addEventListener('click', () => {
      if (confirm('Mark every seat as taken and clear all holds?')) post('/api/admin/reset');
    });
    $('free-all').addEventListener('click', () => {
      if (confirm('Mark every seat as free and clear all holds?')) post('/api/admin/free-all');
    });
  }

  async function init() {
    bind();
    try {
      const r = await fetch(withAs('/api/me'), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('auth');
      me = await r.json();
    } catch (e) {
      showError('Sign-in required, or the server is unreachable. Reload the page to sign in.');
      return;
    }
    $('signout').hidden = !me.signOut;
    const hr = new Date().getHours();
    const hello = hr < 11 ? 'Good morning' : hr < 15 ? 'Lunchtime' : 'Good afternoon';
    greetNormal = `${hello}, ${me.name.split(' ')[0]}. Hungry? Tap "Find me a seat". Finished eating? Free up your seat for someone else.`;
    $('greeting').textContent = greetNormal;
    connect();
  }

  init();
})();
