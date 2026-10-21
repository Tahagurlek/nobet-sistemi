/* Acil Servis Nöbet Sistemi — arayüz.
 * Tek veri kaynağı, üç görünüm: Çizelge, Nöbet İsimleri, Puantaj.
 * Kurallar sunucudaki model.py ile birebir aynıdır.
 * Harici kütüphane kullanılmaz (CDN bağımlılığı yok). */
(function () {
  'use strict';

  var MODE = document.body.getAttribute('data-mode'); // 'admin' | 'view'
  var EDIT = MODE === 'admin';

  var MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  var DAYS_SHORT = ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'];
  var DAYS_FULL = ['PAZARTESİ', 'SALI', 'ÇARŞAMBA', 'PERŞEMBE', 'CUMA', 'CUMARTESİ', 'PAZAR'];
  var SHIFT_HOURS = { '24': 24, '16': 16, '8': 8 };
  var CYCLE = ['', '24', '16', '8'];
  var PALETTE = ['#C5D3FF', '#FFD966', '#C00000', '#D81CBD', '#D490C2', '#F4B084', '#B889DB', '#FFD46B',
    '#C65911', '#33CCFF', '#FFE699', '#BDD7EE', '#A9D18E', '#9DC3E6'];
  var TR_ALPHABET = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ';
  var TABS = [['cizelge', 'Çizelge'], ['isimler', 'Nöbet İsimleri'], ['puantaj', 'Puantaj']];

  var S = {
    doc: null, rev: 0, published: {}, available: [], user: null,
    ym: null, tab: 'cizelge', tool: 'cycle', excuse: 'YI',
    sel: null, painting: null, undo: [],
    dirty: false, saving: false, saveTimer: null, saveError: null, loadError: null,
    menu: false, modal: null
  };

  /* ================= Yardımcılar ================= */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function trUpper(s) { return String(s || '').replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase(); }
  function trKey(s) {
    var u = trUpper(s), out = [];
    for (var i = 0; i < u.length; i++) {
      var idx = TR_ALPHABET.indexOf(u[i]);
      out.push(idx >= 0 ? idx : 100 + u.charCodeAt(i));
    }
    return out;
  }
  function cmpKeys(a, b) {
    for (var i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* yoksay */ } }
  function newId() { return 'p' + Math.random().toString(16).slice(2, 10); }
  function textColor(hex) {
    var h = (hex || '#ffffff').replace('#', '');
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140 ? '#FFFFFF' : '#111827';
  }

  function ymParts(ym) { var p = ym.split('-'); return [parseInt(p[0], 10), parseInt(p[1], 10)]; }
  function ymOf(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function ymShift(ym, n) { var p = ymParts(ym); return ymOf(new Date(p[0], p[1] - 1 + n, 1)); }
  function dim(ym) { var p = ymParts(ym); return new Date(p[0], p[1], 0).getDate(); }
  function weekday(ym, day) { var p = ymParts(ym); return (new Date(p[0], p[1] - 1, day).getDay() + 6) % 7; }
  function weekends(ym) {
    var out = [];
    for (var d = 1; d <= dim(ym); d++) if (weekday(ym, d) >= 5) out.push(d);
    return out;
  }
  function ymLabel(ym) { var p = ymParts(ym); return MONTHS[p[1] - 1] + ' ' + p[0]; }
  function ymTitle(ym) { var p = ymParts(ym); return p[0] + ' ' + trUpper(MONTHS[p[1] - 1]) + ' AYI'; }
  function fmtDate(ym, day) { var p = ymParts(ym); return ('0' + day).slice(-2) + '.' + ('0' + p[1]).slice(-2) + '.' + p[0]; }

  /* ================= Veri kuralları (model.py ile aynı) ================= */
  function getMonth(ym) {
    var m = S.doc.months[ym];
    return m ? { schedule: m.schedule || {}, holidays: m.holidays || [] } : { schedule: {}, holidays: weekends(ym) };
  }
  function ensureMonth(ym) {
    if (!S.doc.months[ym]) S.doc.months[ym] = { schedule: {}, holidays: weekends(ym) };
    return S.doc.months[ym];
  }
  function monthPhysicians(ym) {
    var sched = getMonth(ym).schedule, used = {};
    Object.keys(sched).forEach(function (k) { if (sched[k]) used[k.slice(0, k.lastIndexOf('-'))] = true; });
    return S.doc.physicians.filter(function (p) { return p.active !== false || used[p.id]; });
  }
  function isSpecialist(p) {
    var kw = (S.doc.settings.specialistKeyword || 'uzm').toLowerCase();
    return (p.title || '').toLowerCase().indexOf(kw) >= 0;
  }
  function puantajOrder(list) {
    return list.slice().sort(function (a, b) {
      var sa = isSpecialist(a) ? 0 : 1, sb = isSpecialist(b) ? 0 : 1;
      return sa !== sb ? sa - sb : cmpKeys(trKey(a.name), trKey(b.name));
    });
  }
  function excuses() { return S.doc.settings.excuses || []; }
  function excuseOf(code) {
    var list = excuses();
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }
  function cellVal(ym, pid, day) { return getMonth(ym).schedule[pid + '-' + day] || ''; }

  function computeStats(ym) {
    var phys = monthPhysicians(ym), month = getMonth(ym), n = dim(ym);
    var per = {}, daily = {}, total = 0;
    for (var d = 1; d <= n; d++) daily[d] = 0;
    phys.forEach(function (p) {
      var c = 0, h = 0;
      for (var d = 1; d <= n; d++) {
        var v = month.schedule[p.id + '-' + d];
        if (SHIFT_HOURS[v]) { c++; h += SHIFT_HOURS[v]; daily[d]++; }
      }
      per[p.id] = { count: c, hours: h };
      total += c;
    });
    var hi = null, lo = null, sum = 0;
    phys.forEach(function (p) {
      var h = per[p.id].hours; sum += h;
      if (!hi || h > per[hi.id].hours) hi = p;
      if (!lo || h < per[lo.id].hours) lo = p;
    });
    return { per: per, daily: daily, total: total, avg: phys.length ? sum / phys.length : 0, hi: hi, lo: lo, perDay: total / n };
  }

  function isimlerRows(ym) {
    var phys = monthPhysicians(ym), month = getMonth(ym), rows = [];
    for (var d = 1; d <= dim(ym); d++) {
      var mesai = [], nobet = [];
      phys.forEach(function (p) {
        var v = month.schedule[p.id + '-' + d] || '';
        var label = (isSpecialist(p) ? 'UZM.DR.' : 'DR.') + p.name;
        if (v === '8') mesai.push(label);
        else if (v === '24') nobet.push(label);
        else if (v === '16') nobet.push(label + '(16)');
      });
      var cols = nobet.slice(0, 3);
      while (cols.length < 3) cols.push('');
      if (nobet.length > 3) cols[2] = nobet.slice(2).join('+');
      rows.push({ day: d, weekday: DAYS_FULL[weekday(ym, d)], holiday: month.holidays.indexOf(d) >= 0, mesai: mesai.join('+'), nobet: cols });
    }
    var doctors = phys.map(function (p, i) { return (i + 1) + '.' + (isSpecialist(p) ? 'ACİL UZM.DR.' : 'DR.') + p.name; });
    return { rows: rows, doctors: doctors };
  }

  function canonical(physicians, month) {
    var keys = Object.keys(month.schedule || {}).filter(function (k) { return month.schedule[k]; }).sort();
    return JSON.stringify({
      p: physicians.map(function (p) { return [p.id, p.name, p.displayName, p.color, p.title, p.tc || '']; }),
      s: keys.map(function (k) { return [k, month.schedule[k]]; }),
      h: (month.holidays || []).slice().sort(function (a, b) { return a - b; })
    });
  }
  function publishState() {
    var snap = S.published[S.ym];
    if (!snap) return 'none';
    return canonical(snap.physicians, snap.month) === canonical(monthPhysicians(S.ym), getMonth(S.ym)) ? 'same' : 'changed';
  }

  /* ================= Sunucu ================= */
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { location.href = 'nobet_login.html'; throw new Error('Oturum kapalı'); }
        j.__status = r.status;
        return j;
      });
    });
  }

  function markDirty() {
    S.dirty = true;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, 700);
    renderStatus();
  }

  function save() {
    clearTimeout(S.saveTimer);
    if (S.saving) return S.saving;
    if (!S.dirty) return Promise.resolve();
    S.dirty = false;
    var payload = { baseRev: S.rev, data: S.doc };
    S.saving = api('POST', '/api/working-data', payload).then(function (j) {
      if (j.success) { S.rev = j.rev; S.saveError = null; return; }
      if (j.__status === 409 && j.conflict) {
        S.doc = j.data; S.rev = j.rev; S.undo = []; S.saveError = null;
        toast('Veri başka bir cihazda değiştirilmiş. Güncel hali yüklendi; son değişikliğinizi kontrol edin.', true);
        render();
        return;
      }
      S.dirty = true;
      S.saveError = j.message || 'Kaydedilemedi';
      if (j.__status !== 400) S.saveTimer = setTimeout(save, 5000);
    }, function () {
      S.dirty = true;
      S.saveError = 'Sunucuya ulaşılamıyor';
      S.saveTimer = setTimeout(save, 5000);
    }).then(function () {
      S.saving = false;
      renderStatus();
      if (S.dirty && !S.saveError) return save();
    });
    renderStatus();
    return S.saving;
  }

  function flush() {
    return Promise.resolve(save()).then(function () {
      if (S.saving) return flush();
      if (S.dirty) throw new Error(S.saveError || 'Kaydedilemedi');
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (EDIT && (S.dirty || S.saving)) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================= Düzenleme ================= */
  function pushUndo() {
    S.undo.push({ ym: S.ym, month: S.doc.months[S.ym] ? clone(S.doc.months[S.ym]) : null });
    if (S.undo.length > 60) S.undo.shift();
  }
  function undo() {
    var u = S.undo.pop();
    if (!u) { toast('Geri alınacak işlem yok'); return; }
    if (u.month) S.doc.months[u.ym] = u.month; else delete S.doc.months[u.ym];
    S.ym = u.ym;
    markDirty(); render();
  }
  function setCell(pid, day, value) {
    var m = ensureMonth(S.ym), key = pid + '-' + day;
    if ((m.schedule[key] || '') === value) return false;
    if (value) m.schedule[key] = value; else delete m.schedule[key];
    return true;
  }
  function toolValue(current) {
    if (S.tool === 'cycle') return CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length] || '';
    if (S.tool === 'clear') return '';
    var target = S.tool === 'excuse' ? S.excuse : S.tool;
    return current === target ? '' : target;
  }
  function toggleHoliday(day) {
    pushUndo();
    var m = ensureMonth(S.ym), i = m.holidays.indexOf(day);
    if (i >= 0) m.holidays.splice(i, 1); else m.holidays.push(day);
    m.holidays.sort(function (a, b) { return a - b; });
    markDirty(); render();
  }

  /* ================= Çizim ================= */
  function renderTop() {
    var k = S.doc ? S.doc.settings.kurum : {};
    var canPrev = EDIT || S.available.indexOf(S.ym) > 0;
    var canNext = EDIT || (S.available.indexOf(S.ym) >= 0 && S.available.indexOf(S.ym) < S.available.length - 1);
    $('top').innerHTML =
      '<div class="brand"><b>' + esc(k.hastane || 'Nöbet Sistemi') + '</b><span>' + esc(k.birim || '') + '</span></div>' +
      '<div class="monthnav">' +
      '<button class="btn ghost icon" data-act="prev" ' + (canPrev ? '' : 'disabled') + ' aria-label="Önceki ay">‹</button>' +
      '<strong>' + (S.ym ? esc(ymLabel(S.ym)) : '—') + '</strong>' +
      '<button class="btn ghost icon" data-act="next" ' + (canNext ? '' : 'disabled') + ' aria-label="Sonraki ay">›</button></div>' +
      '<div class="tabs" role="tablist">' + TABS.map(function (t) {
        return '<button role="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="spacer"></div>' +
      '<span class="who">' + esc(S.user ? S.user.username : '') + ' · ' + (EDIT ? 'Yönetici' : 'Görüntüleme') + '</span>' +
      (EDIT ? '' : '<button class="btn" data-act="reload">Yenile</button>') +
      '<button class="btn icon" data-act="fullscreen" title="Tam ekran">⛶</button>' +
      '<button class="btn" data-act="logout">Çıkış</button>';
  }

  function renderToolbar() {
    var bar = $('toolbar');
    var excusePicker = '<select data-act="excuse" aria-label="Mazeret türü">' + excuses().map(function (e) {
      return '<option value="' + esc(e.code) + '"' + (S.excuse === e.code ? ' selected' : '') + '>' + esc(e.code + ' — ' + e.label) + '</option>';
    }).join('') + '</select>';
    var tools = [['cycle', 'Döngü'], ['24', '24'], ['16', '16'], ['8', '8'], ['clear', 'Sil'], ['excuse', 'Mazeret']];
    var exportMenu =
      '<span class="menu"><button class="btn" data-act="menu">Excel çıktısı ▾</button>' +
      (S.menu ? '<div class="menu-pop">' +
        '<button data-export="puantaj">Puantaj<small>Resmi aylık bildirim çizelgesi</small></button>' +
        '<button data-export="renkli">Nöbet Listesi (renkli)<small>Hekim sütunlu, renkli liste</small></button>' +
        '<button data-export="isimler">Nöbet İsimleri<small>Yazdırılabilir günlük isim listesi</small></button>' +
        '</div>' : '') + '</span>';
    if (!EDIT) {
      bar.innerHTML = exportMenu + '<button class="btn" data-act="copy">Kopyalanabilir tablo</button>' +
        '<div class="spacer"></div>' + statusChip();
      return;
    }
    bar.innerHTML = '<span class="label">Araç:</span>' + tools.map(function (t) {
      return '<button class="btn' + (S.tool === t[0] ? ' on' : '') + '" data-tool="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + excusePicker +
      '<button class="btn ghost" data-act="undo" title="Ctrl+Z">↶ Geri al</button>' +
      '<span class="sep"></span>' +
      '<button class="btn" data-act="physicians">Hekimler</button>' +
      '<button class="btn" data-act="settings">Ayarlar</button>' +
      '<span class="sep"></span>' + exportMenu +
      '<button class="btn" data-act="copy">Kopyalanabilir tablo</button>' +
      '<button class="btn danger" data-act="clearmonth">Temizle</button>' +
      '<div class="spacer"></div><span id="status"></span>' +
      '<button class="btn primary" data-act="publish">Yayınla</button>';
    renderStatus();
  }

  function statusChip() {
    if (EDIT) {
      if (S.saveError) return '<span class="chip err" title="' + esc(S.saveError) + '">Kaydedilemedi · tekrar deneniyor</span>';
      if (S.dirty || S.saving) return '<span class="chip">Kaydediliyor…</span>';
    }
    var snap = S.published[S.ym];
    if (!snap) return '<span class="chip">Yayınlanmadı</span>';
    var when = snap.publishedAt ? new Date(snap.publishedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    if (EDIT && publishState() === 'changed') return '<span class="chip warn">Yayınlanmamış değişiklik var</span>';
    return '<span class="chip ok">Yayında' + (when ? ' · ' + esc(when) : '') + '</span>';
  }
  function renderStatus() { var el = $('status'); if (el) el.innerHTML = statusChip(); }

  function renderStats() {
    var el = $('stats');
    if (!S.doc || !S.ym || (!EDIT && !S.published[S.ym])) { el.innerHTML = ''; return; }
    var st = computeStats(S.ym);
    el.innerHTML =
      '<span>Toplam nöbet: <b>' + st.total + '</b></span>' +
      '<span>Ortalama yük: <b>' + st.avg.toFixed(1) + ' s</b></span>' +
      (st.hi ? '<span>En yüksek: <b>' + esc(st.hi.displayName) + ' ' + st.per[st.hi.id].hours + ' s</b></span>' : '') +
      (st.lo ? '<span>En düşük: <b>' + esc(st.lo.displayName) + ' ' + st.per[st.lo.id].hours + ' s</b></span>' : '') +
      '<span>Günlük ort. hekim: <b>' + st.perDay.toFixed(1) + '</b></span>' +
      (EDIT && S.tab !== 'isimler' ? '<span class="hint">İpucu: gün numarasına tıklayınca tatil işaretlenir · seçili hücrede 2/1/8/Del tuşları · sürükleyerek boyayın</span>' : '');
  }

  function cellHtml(p, day, v, holiday, extraClass) {
    var cls = 'c' + (holiday ? ' hol' : '') + (extraClass || ''), style = '', text = '', title = '';
    if (SHIFT_HOURS[v]) {
      style = ' style="background:' + p.color + ';color:' + textColor(p.color) + '"';
      text = v;
    } else if (v) {
      var ex = excuseOf(v);
      cls += ' ex';
      text = v === 'B' ? '' : esc(v);
      title = ' title="' + esc(ex ? ex.label : v) + '"';
    }
    if (S.sel && S.sel.p === p.id && S.sel.d === day) cls += ' sel';
    return '<td class="' + cls + '" data-p="' + p.id + '" data-d="' + day + '"' + style + title + '>' + text + '</td>';
  }

  function renderCizelge() {
    var phys = monthPhysicians(S.ym), month = getMonth(S.ym), st = computeStats(S.ym), n = dim(S.ym);
    if (!phys.length) {
      return '<div class="empty"><b>Henüz hekim yok</b>' + (EDIT ? '"Hekimler" düğmesinden hekim ekleyin.' : '') + '</div>';
    }
    var h = '<table class="grid"><thead><tr><th class="corner">Gün</th>';
    phys.forEach(function (p) {
      var s = st.per[p.id];
      h += '<th class="' + (p.active === false ? 'inactive' : '') + '" title="' + esc(p.name + (p.active === false ? ' (pasif)' : '')) + '">' +
        '<span class="ph-name">' + esc(p.displayName || p.name) + '</span>' +
        '<span class="ph-stat">' + s.count + '× · ' + s.hours + 's</span>' +
        '<span class="ph-bar" style="background:' + p.color + '"></span></th>';
    });
    h += '</tr></thead><tbody>';
    for (var d = 1; d <= n; d++) {
      var hol = month.holidays.indexOf(d) >= 0, c = st.daily[d];
      h += '<tr' + (hol ? ' class="hol"' : '') + '><th' + (EDIT ? ' class="can" data-hday="' + d + '" title="Tatil olarak işaretle / kaldır"' : '') + '>' +
        '<span class="dn">' + d + '</span><span class="dw">' + DAYS_SHORT[weekday(S.ym, d)] + '</span>' +
        '<span class="badge b' + Math.min(c, 2) + '">' + c + '</span></th>';
      phys.forEach(function (p) { h += cellHtml(p, d, month.schedule[p.id + '-' + d] || '', false, ''); });
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  function renderIsimler() {
    var r = isimlerRows(S.ym), k = S.doc.settings.kurum;
    var h = '<div class="pad"><h1 class="doc-title">' + esc(trUpper(k.hastane)) + ' — ' + esc(ymTitle(S.ym)) + ' NÖBET LİSTESİ</h1>' +
      '<p class="doc-sub">Çizelgeden otomatik oluşur; "Nöbet İsimleri" Excel çıktısı bu tabloyla aynıdır.' + (EDIT ? ' Düzenleme için Çizelge sekmesini kullanın.' : '') + '</p>' +
      '<table class="sheet"><thead><tr><th>Tarih</th><th>Gün</th><th>MESAİ (08:00-16:00) 8</th>' +
      '<th>NÖBET (08:00-08:00) 24</th><th>NÖBET (08:00-08:00) 24</th><th>NÖBET (08:00-08:00) 24</th><th>DOKTOR</th></tr></thead><tbody>';
    r.rows.forEach(function (row, i) {
      h += '<tr><td>' + fmtDate(S.ym, row.day) + '</td><td class="' + (row.holiday ? 'hol' : '') + '">' + row.weekday + '</td>' +
        '<td>' + esc(row.mesai) + '</td><td>' + esc(row.nobet[0]) + '</td><td>' + esc(row.nobet[1]) + '</td><td>' + esc(row.nobet[2]) + '</td>' +
        '<td>' + esc(r.doctors[i] || '') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function renderPuantaj() {
    var phys = puantajOrder(monthPhysicians(S.ym)), month = getMonth(S.ym), n = dim(S.ym), st = computeStats(S.ym);
    var h = '<div class="pad"><h1 class="doc-title">' + esc(ymTitle(S.ym)) + ' BİLDİRİMİ PUANTAJ ÇİZELGESİ</h1>' +
      '<p class="doc-sub">Sıralama: önce uzmanlar, sonra tabipler (alfabetik).' + (EDIT ? ' Hücreler seçili araçla düzenlenebilir.' : '') + ' Son sütun ekranda bilgi amaçlı toplam saattir.</p>' +
      '<table class="sheet puantaj"><thead><tr><th>Sıra</th><th>TC Kimlik No</th><th>Adı Soyadı</th><th>Branş</th>';
    for (var d = 1; d <= n; d++) h += '<th class="d' + (month.holidays.indexOf(d) >= 0 ? ' hol' : '') + '">' + d + '</th>';
    h += '<th>Saat</th></tr></thead><tbody>';
    phys.forEach(function (p, i) {
      h += '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(p.tc || '') + '</td><td>' + esc(trUpper(p.name)) + '</td>' +
        '<td>' + (isSpecialist(p) ? 'UZM.DR.' : 'TABİP') + '</td>';
      for (var d = 1; d <= n; d++) {
        var v = month.schedule[p.id + '-' + d] || '', text = '', cls = 'd' + (month.holidays.indexOf(d) >= 0 ? ' hol' : '');
        if (SHIFT_HOURS[v]) text = v;
        else if (v) { var ex = excuseOf(v); text = ex ? (ex.puantaj || '') : v; cls += ' ex'; }
        if (S.sel && S.sel.p === p.id && S.sel.d === d) cls += ' sel';
        h += '<td class="' + cls + '" data-p="' + p.id + '" data-d="' + d + '">' + esc(text) + '</td>';
      }
      h += '<td class="tot">' + st.per[p.id].hours + '</td></tr>';
    });
    if (!phys.length) h += '<tr><td colspan="' + (n + 5) + '" class="num">Hekim yok</td></tr>';
    return h + '</tbody></table></div>';
  }

  function renderMain() {
    var main = $('main');
    var top = main.scrollTop, left = main.scrollLeft;
    var banner = S.loadError ? '<div class="banner">' + esc(S.loadError) + '</div>' : '';
    if (!S.doc) { main.innerHTML = banner || '<div class="empty">Yükleniyor…</div>'; return; }
    if (!EDIT && !S.published[S.ym]) {
      main.innerHTML = banner + '<div class="empty"><b>Henüz yayınlanmış çizelge yok</b>Yönetici çizelgeyi yayınladığında burada görünecek.</div>';
      return;
    }
    var body = S.tab === 'isimler' ? renderIsimler() : S.tab === 'puantaj' ? renderPuantaj() : renderCizelge();
    main.className = EDIT ? 'edit' : '';
    main.innerHTML = banner + body;
    main.scrollTop = top; main.scrollLeft = left;
  }

  function render() {
    renderTop(); renderToolbar(); renderStats(); renderMain(); renderModal();
  }

  /* ================= Pencereler ================= */
  function openModal(m) { S.modal = m; S.menu = false; render(); }
  function closeModal() { S.modal = null; renderModal(); }

  function renderModal() {
    var root = $('modal');
    if (!S.modal) { root.innerHTML = ''; return; }
    var m = S.modal, html = '';
    if (m.type === 'confirm') {
      html = '<div class="modal sm"><header><h2>' + esc(m.title) + '</h2></header><div class="body"><p class="note">' + esc(m.text) + '</p></div>' +
        '<footer><button class="btn" data-m="cancel">Vazgeç</button><button class="btn primary" data-m="ok">' + esc(m.ok || 'Tamam') + '</button></footer></div>';
    } else if (m.type === 'physicians') {
      html = physiciansModal();
    } else if (m.type === 'settings') {
      html = settingsModal();
    }
    root.innerHTML = '<div class="overlay" data-m="backdrop">' + html + '</div>';
  }

  function confirmBox(title, text, ok, onOk) { openModal({ type: 'confirm', title: title, text: text, ok: ok, onOk: onOk }); }

  function physiciansModal() {
    var rows = S.doc.physicians.map(function (p, i) {
      return '<tr class="' + (p.active === false ? 'off' : '') + '">' +
        '<td style="white-space:nowrap"><button class="btn ghost icon" data-pm="up" data-i="' + i + '" ' + (i ? '' : 'disabled') + ' aria-label="Yukarı">↑</button>' +
        '<button class="btn ghost icon" data-pm="down" data-i="' + i + '" ' + (i < S.doc.physicians.length - 1 ? '' : 'disabled') + ' aria-label="Aşağı">↓</button></td>' +
        '<td><input type="color" value="' + esc(p.color) + '" data-pf="color" data-i="' + i + '"></td>' +
        '<td><input type="text" value="' + esc(p.name) + '" data-pf="name" data-i="' + i + '"></td>' +
        '<td><input type="text" value="' + esc(p.displayName) + '" data-pf="displayName" data-i="' + i + '"></td>' +
        '<td><select class="in" data-pf="title" data-i="' + i + '">' + titleOptions(p.title) + '</select></td>' +
        '<td><input type="text" inputmode="numeric" maxlength="11" value="' + esc(p.tc || '') + '" data-pf="tc" data-i="' + i + '"></td>' +
        '<td style="white-space:nowrap"><label><input type="checkbox" data-pf="active" data-i="' + i + '"' + (p.active !== false ? ' checked' : '') + '> Aktif</label></td>' +
        '<td><button class="btn ghost danger" data-pm="del" data-i="' + i + '">Sil</button></td></tr>';
    }).join('');
    var nc = S.modal.newColor || PALETTE[S.doc.physicians.length % PALETTE.length];
    return '<div class="modal"><header><h2>Hekim Ayarları</h2><button class="btn ghost icon" data-m="cancel" aria-label="Kapat">✕</button></header><div class="body">' +
      '<p class="note">Değişiklikler alan değiştirildiği anda kaydedilir. Hekimler sabit bir kimlikle tutulur; ad değiştirmek nöbetleri etkilemez. ' +
      'Nöbet kaydı olan bir hekim silinirse geçmiş aylar bozulmasın diye <b>pasif</b> yapılır. Çizelgedeki sütun sırası buradaki sıradır; puantajda ise uzmanlar önce, sonra tabipler alfabetik sıralanır.</p>' +
      '<table class="ptable"><thead><tr><th>Sıra</th><th>Renk</th><th>Ad Soyad</th><th>Kısa ad</th><th>Unvan</th><th>TC</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="newrow"><input type="color" id="np-color" value="' + esc(nc) + '"><input type="text" id="np-name" placeholder="Ad Soyad">' +
      '<input type="text" id="np-short" placeholder="Kısa ad"><select class="in" id="np-title">' + titleOptions('Dr') + '</select>' +
      '<input type="text" id="np-tc" placeholder="TC Kimlik No" inputmode="numeric" maxlength="11"><button class="btn primary" data-pm="add">Ekle</button></div>' +
      '<div class="swatches">' + PALETTE.map(function (c) { return '<button style="background:' + c + '" data-swatch="' + c + '" aria-label="' + c + '"></button>'; }).join('') + '</div>' +
      '</div><footer><button class="btn" data-m="cancel">Kapat</button></footer></div>';
  }
  function titleOptions(cur) {
    var opts = ['Dr', 'Uzm.Dr'];
    if (cur && opts.indexOf(cur) < 0) opts.push(cur);
    return opts.map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('');
  }

  var SETTING_TABS = [['kurum', 'Kurum'], ['imza', 'İmza alanları'], ['excuses', 'Mazeret kodları'], ['rules', 'Kurallar ve renkler'], ['users', 'Kullanıcılar'], ['backup', 'Yedek ve dosyalar']];

  function settingsModal() {
    var m = S.modal, d = m.draft, body = '';
    function f(path, label, val) {
      return '<div class="field"><label>' + esc(label) + '</label><input type="text" data-sf="' + path + '" value="' + esc(val) + '"></div>';
    }
    if (m.sub === 'kurum') {
      body = '<p class="note">Bu bilgiler Excel başlıklarında kullanılır. Başka bir hastanede kullanmak için burayı değiştirmeniz yeterli.</p><div class="fields">' +
        f('kurum.il', 'İl adı', d.kurum.il) + f('kurum.mudurluk', 'Müdürlük', d.kurum.mudurluk) +
        f('kurum.hastane', 'Hastane adı', d.kurum.hastane) + f('kurum.birim', 'Birim adı', d.kurum.birim) + '</div>';
    } else if (m.sub === 'imza') {
      body = '<p class="note">Puantajın altındaki imza blokları. Ad alanları boş bırakılırsa yalnızca başlık ve unvan yazılır.</p><div class="fields">' +
        f('imza.hazirlayanBaslik', 'Sol blok başlığı', d.imza.hazirlayanBaslik) + f('imza.hazirlayanAd', 'Sol blok ad soyad', d.imza.hazirlayanAd) +
        f('imza.hazirlayanUnvan', 'Sol blok unvan', d.imza.hazirlayanUnvan) + f('imza.onayBaslik', 'Sağ blok başlığı', d.imza.onayBaslik) +
        f('imza.onayAd', 'Sağ blok ad soyad', d.imza.onayAd) + f('imza.onayUnvan', 'Sağ blok unvan', d.imza.onayUnvan) + '</div>';
    } else if (m.sub === 'excuses') {
      body = '<p class="note">Kod: çizelgede görünen kısaltma (1-4 büyük harf). Puantaj: Excel puantajına yazılacak kısaltma; boş bırakılırsa puantaja işlenmez.</p>' +
        '<table class="ptable"><thead><tr><th>Kod</th><th>Açıklama</th><th>Puantaj</th><th></th></tr></thead><tbody>' +
        d.excuses.map(function (e, i) {
          return '<tr><td style="width:90px"><input type="text" maxlength="4" data-ef="code" data-i="' + i + '" value="' + esc(e.code) + '"></td>' +
            '<td><input type="text" data-ef="label" data-i="' + i + '" value="' + esc(e.label) + '"></td>' +
            '<td style="width:110px"><input type="text" maxlength="4" data-ef="puantaj" data-i="' + i + '" value="' + esc(e.puantaj) + '"></td>' +
            '<td><button class="btn ghost danger" data-sm="exdel" data-i="' + i + '">Sil</button></td></tr>';
        }).join('') + '</tbody></table><p><button class="btn" data-sm="exadd">+ Mazeret kodu ekle</button></p>';
    } else if (m.sub === 'rules') {
      body = '<div class="fields">' +
        '<div class="field"><label>Renkli listede mazeret rengi</label><input type="color" data-sc="excuseExcel" value="' + esc(d.colors.excuseExcel) + '"></div>' +
        '<div class="field"><label>Tatil / hafta sonu gölgesi (Excel)</label><input type="color" data-sc="holiday" value="' + esc(d.colors.holiday) + '"></div>' +
        f('specialistKeyword', 'Uzman sayılacak unvan anahtar kelimesi', d.specialistKeyword) + '</div>' +
        '<p class="note" style="margin-top:12px">Unvanında bu kelime geçen hekimler puantajda <b>UZM.DR.</b> yazılır ve listenin başına alınır; diğerleri <b>TABİP</b> olur. ' +
        'Yeni bir ayda hafta sonları otomatik olarak tatil işaretlenir; gün numarasına tıklayarak değiştirebilirsiniz.</p>';
    } else if (m.sub === 'users') {
      body = '<p class="note">Giriş hesapları: <b>admin</b> (yönetici) ve <b>pratisyen</b> (görüntüleme). Güvenlik için şifreler bu ekranda değil, sunucu ayarlarında ' +
        '(Render → Environment: <code>ADMIN_PASSWORD</code>, <code>USER_PASSWORD</code>) tutulur. Şifre değiştirmek için oradaki değeri güncelleyin.</p>';
    } else if (m.sub === 'backup') {
      body = '<p class="note">Tüm hekimler, aylar ve ayarlar tek bir dosyaya yedeklenir. Geri yükleme mevcut veriyi tamamen değiştirir.</p>' +
        '<p><button class="btn" data-sm="export-json">Yedeği indir (.json)</button> ' +
        '<label class="btn">Yedekten geri yükle<input type="file" accept=".json,application/json" data-sm="import-json" hidden></label></p>' +
        '<p class="note">Excel şablonları (puantaj, nöbet listesi) sunucudaki <code>templates/</code> klasöründen okunur ve çıktılar bu şablonların üzerine yazılır.</p>';
    }
    return '<div class="modal"><header><h2>Ayarlar</h2><button class="btn ghost icon" data-m="cancel" aria-label="Kapat">✕</button></header><div class="body">' +
      '<div class="subtabs">' + SETTING_TABS.map(function (t) {
        return '<button class="btn' + (m.sub === t[0] ? ' on' : '') + '" data-sub="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>' + body + '</div>' +
      '<footer><button class="btn" data-m="cancel">Vazgeç</button><button class="btn primary" data-sm="save">Kaydet</button></footer></div>';
  }

  /* ================= Bildirim ================= */
  var toastTimer;
  function toast(msg, isErr) {
    var el = $('toast');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isErr ? 6000 : 3000);
  }

  /* ================= Eylemler ================= */
  function gotoMonth(n) {
    S.sel = null;
    if (!EDIT) {
      // Görüntüleme: yalnızca yayınlanmış aylar arasında gezilir, veri sunucudan alınır
      var i = S.available.indexOf(S.ym) + n;
      if (i >= 0 && i < S.available.length) loadView(S.available[i]);
      return;
    }
    S.ym = ymShift(S.ym, n);
    storeSet('nobet.ym', S.ym);
    render();
  }

  function doExport(kind) {
    S.menu = false; renderToolbar();
    var url = '/api/export/' + kind + '?ym=' + S.ym + (EDIT ? '' : '&source=published');
    var ready = EDIT ? flush() : Promise.resolve();
    ready.then(function () { return fetch(url, { credentials: 'same-origin' }); }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.message || 'Excel oluşturulamadı'); });
      var cd = r.headers.get('Content-Disposition') || '', name = 'nobet.xlsx';
      var m1 = /filename\*=UTF-8''([^;]+)/i.exec(cd), m2 = /filename="?([^";]+)"?/i.exec(cd);
      if (m1) name = decodeURIComponent(m1[1]); else if (m2) name = m2[1];
      return r.blob().then(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  function tableTSV() {
    var lines = [], n = dim(S.ym), month = getMonth(S.ym);
    if (S.tab === 'isimler') {
      var r = isimlerRows(S.ym);
      lines.push(['Tarih', 'Gün', 'MESAİ (08:00-16:00) 8', 'NÖBET (08:00-08:00) 24', 'NÖBET (08:00-08:00) 24', 'NÖBET (08:00-08:00) 24', 'DOKTOR']);
      r.rows.forEach(function (row, i) { lines.push([fmtDate(S.ym, row.day), row.weekday, row.mesai].concat(row.nobet, [r.doctors[i] || ''])); });
    } else if (S.tab === 'puantaj') {
      var head = ['Sıra', 'TC Kimlik No', 'Adı Soyadı', 'Branş'];
      for (var d = 1; d <= n; d++) head.push(String(d));
      lines.push(head);
      puantajOrder(monthPhysicians(S.ym)).forEach(function (p, i) {
        var row = [String(i + 1), p.tc || '', trUpper(p.name), isSpecialist(p) ? 'UZM.DR.' : 'TABİP'];
        for (var d = 1; d <= n; d++) {
          var v = month.schedule[p.id + '-' + d] || '', ex = excuseOf(v);
          row.push(SHIFT_HOURS[v] ? v : (ex ? ex.puantaj || '' : v));
        }
        lines.push(row);
      });
    } else {
      var phys = monthPhysicians(S.ym);
      lines.push(['Tarih', 'Gün'].concat(phys.map(function (p) { return p.displayName; })));
      for (var dd = 1; dd <= n; dd++) {
        lines.push([fmtDate(S.ym, dd), DAYS_FULL[weekday(S.ym, dd)]].concat(phys.map(function (p) {
          var v = month.schedule[p.id + '-' + dd] || ''; return v === 'B' ? '' : v;
        })));
      }
    }
    return lines.map(function (l) { return l.map(function (c) { return String(c).replace(/[\t\n]/g, ' '); }).join('\t'); }).join('\n');
  }

  function copyTable() {
    var text = tableTSV();
    var done = function () { toast('Tablo panoya kopyalandı. Excel veya WhatsApp\'a yapıştırabilirsiniz.'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Kopyalanamadı', true); }
      ta.remove();
    }
  }

  function doPublish() {
    flush().then(function () { return api('POST', '/api/publish', { ym: S.ym }); }).then(function (j) {
      if (!j.success) throw new Error(j.message || 'Yayınlanamadı');
      S.published[S.ym] = j.snapshot;
      toast(ymLabel(S.ym) + ' çizelgesi yayınlandı. Pratisyenler artık görebilir.');
      render();
    }).catch(function (e) { toast(e.message, true); });
  }

  function physicianHasData(pid) {
    return Object.keys(S.doc.months).some(function (ym) {
      var s = S.doc.months[ym].schedule || {};
      return Object.keys(s).some(function (k) { return s[k] && k.slice(0, k.lastIndexOf('-')) === pid; });
    });
  }

  function onPhysicianAction(act, i) {
    var list = S.doc.physicians, p = list[i];
    if (act === 'up' || act === 'down') {
      var j = act === 'up' ? i - 1 : i + 1;
      list[i] = list[j]; list[j] = p;
    } else if (act === 'del') {
      if (physicianHasData(p.id)) {
        p.active = false;
        toast(p.name + ' nöbet kaydı olduğu için pasif yapıldı (geçmiş aylar korunur).');
      } else {
        list.splice(i, 1);
      }
    } else if (act === 'add') {
      var name = $('np-name').value.trim();
      if (!name) { toast('Ad Soyad girin', true); return; }
      list.push({
        id: newId(), name: name, displayName: $('np-short').value.trim() || name.split(' ')[0],
        color: $('np-color').value.toUpperCase(), title: $('np-title').value, tc: $('np-tc').value.replace(/\D/g, ''), active: true
      });
      S.modal.newColor = PALETTE[list.length % PALETTE.length];
    }
    markDirty(); render();
  }

  function onPhysicianField(el) {
    var p = S.doc.physicians[+el.getAttribute('data-i')], field = el.getAttribute('data-pf');
    if (field === 'active') { p.active = el.checked; markDirty(); render(); return; }
    var v = el.value;
    if (field === 'name') { v = v.trim(); if (!v) { el.value = p.name; toast('Ad boş olamaz', true); return; } }
    if (field === 'tc') v = v.replace(/\D/g, '');
    if (field === 'color') v = v.toUpperCase();
    p[field] = v;
    markDirty();
    renderTop(); renderStats(); renderMain(); // pencereyi yeniden çizme: odak kaybolmasın
  }

  function setPath(obj, path, val) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }

  function onSettingsAction(act, el) {
    var d = S.modal.draft;
    if (act === 'exadd') { d.excuses.push({ code: '', label: '', puantaj: '' }); renderModal(); }
    else if (act === 'exdel') { d.excuses.splice(+el.getAttribute('data-i'), 1); renderModal(); }
    else if (act === 'save') {
      var codes = {};
      for (var i = 0; i < d.excuses.length; i++) {
        var e = d.excuses[i];
        e.code = trUpper(e.code.trim());
        if (!/^[A-ZÇĞİÖŞÜ]{1,4}$/.test(e.code)) { toast('Mazeret kodu 1-4 büyük harf olmalı: "' + e.code + '"', true); return; }
        if (codes[e.code]) { toast('Aynı mazeret kodu iki kez var: ' + e.code, true); return; }
        codes[e.code] = true;
      }
      S.doc.settings = d;
      if (!excuseOf(S.excuse) && d.excuses.length) S.excuse = d.excuses[0].code;
      closeModal(); markDirty(); render();
      toast('Ayarlar kaydedildi');
    } else if (act === 'export-json') {
      var blob = new Blob([JSON.stringify(S.doc, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'nobet-yedek-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('Dosya okunamadı (geçerli bir JSON değil)', true); return; }
      if (!data || !Array.isArray(data.physicians) || typeof data.months !== 'object' || !data.settings) {
        toast('Bu dosya bir nöbet sistemi yedeği değil', true); return;
      }
      confirmBox('Yedekten geri yükle', 'Mevcut tüm hekimler, aylar ve ayarlar bu yedekle değiştirilecek. Devam edilsin mi?', 'Geri yükle', function () {
        S.doc = data; S.undo = []; markDirty(); render();
        toast('Yedek yüklendi');
      });
    };
    reader.readAsText(file);
  }

  function moveSel(dx, dy) {
    if (!S.sel) return;
    var n = dim(S.ym);
    if (S.tab === 'puantaj') {
      var list = puantajOrder(monthPhysicians(S.ym)).map(function (p) { return p.id; });
      var pi = Math.max(0, Math.min(list.length - 1, list.indexOf(S.sel.p) + dy));
      S.sel = { p: list[pi], d: Math.max(1, Math.min(n, S.sel.d + dx)) };
    } else {
      var ids = monthPhysicians(S.ym).map(function (p) { return p.id; });
      var i = Math.max(0, Math.min(ids.length - 1, ids.indexOf(S.sel.p) + dx));
      S.sel = { p: ids[i], d: Math.max(1, Math.min(n, S.sel.d + dy)) };
    }
    renderMain();
    var el = document.querySelector('#main .sel');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ================= Olaylar ================= */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-tab],[data-tool],[data-export],[data-m],[data-pm],[data-sm],[data-sub],[data-swatch],[data-hday]');
    if (S.menu && !e.target.closest('.menu')) { S.menu = false; renderToolbar(); }
    if (!t) return;
    if (t.hasAttribute('data-tab')) { S.tab = t.getAttribute('data-tab'); S.sel = null; storeSet('nobet.tab', S.tab); render(); return; }
    if (t.hasAttribute('data-tool')) { S.tool = t.getAttribute('data-tool'); renderToolbar(); return; }
    if (t.hasAttribute('data-export')) { doExport(t.getAttribute('data-export')); return; }
    if (t.hasAttribute('data-hday')) { if (EDIT) toggleHoliday(+t.getAttribute('data-hday')); return; }
    if (t.hasAttribute('data-swatch')) { $('np-color').value = t.getAttribute('data-swatch'); S.modal.newColor = t.getAttribute('data-swatch'); return; }
    if (t.hasAttribute('data-sub')) { S.modal.sub = t.getAttribute('data-sub'); renderModal(); return; }
    if (t.hasAttribute('data-pm')) { onPhysicianAction(t.getAttribute('data-pm'), +t.getAttribute('data-i')); return; }
    if (t.hasAttribute('data-sm') && t.tagName !== 'INPUT') { onSettingsAction(t.getAttribute('data-sm'), t); return; }
    if (t.hasAttribute('data-m')) {
      var mm = t.getAttribute('data-m');
      if (mm === 'backdrop' && e.target !== t) return;
      var ok = mm === 'ok' && S.modal && S.modal.onOk;
      closeModal();
      if (ok) ok();
      return;
    }
    switch (t.getAttribute('data-act')) {
      case 'prev': gotoMonth(-1); break;
      case 'next': gotoMonth(1); break;
      case 'menu': S.menu = !S.menu; renderToolbar(); break;
      case 'undo': undo(); break;
      case 'copy': copyTable(); break;
      case 'publish': doPublish(); break;
      case 'reload': loadView(S.ym); break;
      case 'physicians': openModal({ type: 'physicians' }); break;
      case 'settings': openModal({ type: 'settings', sub: 'kurum', draft: clone(S.doc.settings) }); break;
      case 'clearmonth':
        confirmBox('Ayı temizle', ymLabel(S.ym) + ' ayındaki tüm nöbet ve mazeret kayıtları silinecek. "Geri al" ile geri getirilebilir.', 'Temizle', function () {
          pushUndo(); ensureMonth(S.ym).schedule = {}; markDirty(); render();
        });
        break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        break;
      case 'logout':
        Promise.resolve(EDIT ? flush().catch(function () { }) : null).then(function () {
          return api('POST', '/api/logout');
        }).then(function () { location.href = 'nobet_login.html'; });
        break;
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute('data-act') === 'excuse') { S.excuse = t.value; S.tool = 'excuse'; renderToolbar(); return; }
    if (t.hasAttribute('data-pf')) { onPhysicianField(t); return; }
    if (t.getAttribute('data-sm') === 'import-json' && t.files[0]) { importJSON(t.files[0]); return; }
    if (!S.modal || !S.modal.draft) return;
    if (t.hasAttribute('data-sf')) setPath(S.modal.draft, t.getAttribute('data-sf'), t.value);
    if (t.hasAttribute('data-sc')) S.modal.draft.colors[t.getAttribute('data-sc')] = t.value.toUpperCase();
    if (t.hasAttribute('data-ef')) S.modal.draft.excuses[+t.getAttribute('data-i')][t.getAttribute('data-ef')] = t.value;
  });

  // Hücre boyama: tıkla veya basılı tutup sürükle
  document.addEventListener('mousedown', function (e) {
    if (!EDIT || e.button !== 0) return;
    var td = e.target.closest('#main td[data-p]');
    if (!td) return;
    e.preventDefault();
    var pid = td.getAttribute('data-p'), day = +td.getAttribute('data-d');
    var value = toolValue(cellVal(S.ym, pid, day));
    pushUndo();
    S.sel = { p: pid, d: day };
    S.painting = { value: value, changed: setCell(pid, day, value) };
    if (S.painting.changed) markDirty();
    renderMain(); renderStats(); renderStatus();
  });
  document.addEventListener('mouseover', function (e) {
    if (!S.painting) return;
    var td = e.target.closest('#main td[data-p]');
    if (!td) return;
    var pid = td.getAttribute('data-p'), day = +td.getAttribute('data-d');
    if (setCell(pid, day, S.painting.value)) {
      S.painting.changed = true;
      S.sel = { p: pid, d: day };
      markDirty(); renderMain(); renderStats();
    }
  });
  document.addEventListener('mouseup', function () {
    if (S.painting && !S.painting.changed) S.undo.pop(); // değişiklik olmadıysa geri al kaydını tutma
    S.painting = null;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (S.modal) closeModal(); else if (S.menu) { S.menu = false; renderToolbar(); } return; }
    if (!EDIT || S.modal || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (!S.sel || S.tab === 'isimler') return;
    var map = { '2': '24', '1': '16', '8': '8', 'Delete': '', 'Backspace': '' };
    if (e.key in map) {
      e.preventDefault();
      pushUndo();
      if (setCell(S.sel.p, S.sel.d, map[e.key])) markDirty(); else S.undo.pop();
      renderMain(); renderStats();
      return;
    }
    var moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) { e.preventDefault(); moveSel(moves[e.key][0], moves[e.key][1]); }
  });

  /* ================= Başlangıç ================= */
  function shell() {
    document.body.innerHTML = '<header class="top" id="top"></header><div class="toolbar" id="toolbar"></div>' +
      '<div class="stats" id="stats"></div><main id="main"></main><div id="modal"></div><div class="toast" id="toast" hidden></div>';
  }

  function loadAdmin() {
    return api('GET', '/api/working-data').then(function (j) {
      if (!j.success) throw new Error(j.message || 'Veri yüklenemedi');
      S.doc = j.data; S.rev = j.rev; S.published = j.published || {}; S.loadError = null;
      var saved = storeGet('nobet.ym');
      S.ym = saved && /^\d{4}-\d{2}$/.test(saved) ? saved : ymOf(new Date());
      if (S.doc.settings.excuses.length && !excuseOf(S.excuse)) S.excuse = S.doc.settings.excuses[0].code;
    });
  }

  function loadView(ym) {
    return api('GET', '/api/published' + (ym ? '?ym=' + ym : '')).then(function (j) {
      if (!j.success) throw new Error(j.message || 'Veri yüklenemedi');
      S.available = j.available || [];
      S.published = {};
      if (j.data) {
        S.ym = j.data.ym;
        S.published[S.ym] = j.data;
        S.doc = { settings: j.data.settings, physicians: j.data.physicians, months: {} };
        S.doc.months[S.ym] = j.data.month;
      } else {
        S.doc = S.doc || { settings: { kurum: {}, excuses: [] }, physicians: [], months: {} };
        S.ym = S.ym || ymOf(new Date());
      }
      S.loadError = null;
      render();
    }).catch(function (e) { S.loadError = e.message; render(); });
  }

  function start() {
    shell();
    var tab = storeGet('nobet.tab');
    if (tab && TABS.some(function (t) { return t[0] === tab; })) S.tab = tab;
    renderMain();
    api('GET', '/api/check-auth').then(function (a) {
      if (!a.authenticated) { location.href = 'nobet_login.html'; return; }
      if (EDIT && a.role !== 'admin') { location.href = 'nobet_view.html'; return; }
      S.user = a;
      if (EDIT) return loadAdmin().then(render, function (e) { S.loadError = e.message + ' Sayfayı yenileyin.'; render(); });
      return loadView();
    }).catch(function () {
      S.loadError = 'Sunucuya ulaşılamıyor. İnternet bağlantınızı kontrol edip sayfayı yenileyin.';
      renderMain();
    });
  }

  start();
})();
