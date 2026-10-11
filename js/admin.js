// ============================================================
// Panel admin — PT Nirbana Collection Persada
// Vanilla JS, tanpa framework. Semua data lewat GAS (doPost, JSON).
// GAS Instant UX PRO: SWR + freshness TTL, login+bootstrap,
// retry baca, reqId idempoten, warm-up, prefetch idle.
// ============================================================
(function () {
  'use strict';

  const KUNCI_SESI    = 'nirbana:admin:sesi';
  const LS_PFX        = 'nrb:a:v1:';            // naikkan v bila bentuk data berubah
  const IDLE_MS       = 60 * 60 * 1000;          // 60 menit tanpa aktivitas
  const PERAN_SUPER   = 'SUPER_ADMIN';
  const STATUS        = ['Baru', 'Diproses', 'Selesai', 'Dibatalkan'];
  const LAYANAN       = ['Cetak', 'Kemasan', 'Alat Tulis', 'Produk Khusus'];
  const JENIS         = [['penawaran', 'Surat Penawaran'], ['tanda_terima', 'Tanda Terima'], ['faktur', 'Faktur']];
  const BULAN         = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  // Aksi baca yang aman di-retry (tanpa efek samping)
  const READ_ACTIONS  = /^(adminBootstrap|dashboard|produkList|permintaanList|permintaanDetail|dokumenList|dokumenPindai|adminList)$/;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  let sesi      = null;           // { token, nama, peran, mustChange }
  let aktivitas = Date.now();
  let viewId    = 0;              // mencegah render dari tampilan lama
  let state     = {
    tahun: null,
    prefill: null,
    filterP: { cari: '', status: 'Semua', layanan: 'Semua', tanggalDari: '', tanggalSampai: '', halaman: 1 }
  };
  let produkCache = [];

  const main = $('#main');

  // ============================================================
  // PERF — ukur waktu total vs server (Prinsip 0)
  // ============================================================
  const Perf = {
    rows: [],
    add(action, total, server) {
      this.rows.push({ action, total, server: server ?? null, net: server != null ? total - server : null, at: new Date().toISOString() });
      if (this.rows.length > 200) this.rows.shift();
    },
    table() { console.table(this.rows.slice(-30)); }   // panggil Perf.table() di console
  };
  window.PerfAdmin = Perf;   // tersedia di console untuk debug

  // ============================================================
  // STORE — localStorage per user dengan namespace + versi (Prinsip 2)
  // ============================================================
  function uKey(k) { return LS_PFX + 'u:' + (sesi ? sesi.email || sesi.username : 'anon') + ':' + k; }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h + ':' + s.length; }

  const Store = {
    get(k, d) {
      try { const v = localStorage.getItem(LS_PFX + k); return v ? JSON.parse(v) : d; }
      catch (e) { return d; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { localStorage.setItem(LS_PFX + k, s); }
      catch (e) {
        // kuota penuh → buang cache user lain, coba sekali lagi
        Object.keys(localStorage).filter(x => x.startsWith(LS_PFX + 'u:') && !x.includes('u:' + (sesi ? sesi.username : '') + ':'))
          .forEach(x => localStorage.removeItem(x));
        try { localStorage.setItem(LS_PFX + k, s); } catch (e2) { /* jalan tanpa cache */ }
      }
    },
    del(k) { try { localStorage.removeItem(LS_PFX + k); } catch (e) {} }
  };

  // ============================================================
  // API — fetch + retry + reqId idempoten (Prinsip 3, 6, 8)
  // ============================================================
  async function apiOnce(action, data, timeout, reqId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(CONFIG.GAS_URL, {
        method: 'POST',
        redirect: 'follow',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: sesi ? sesi.token : '', reqId: reqId || '', data: data || {} })
      });
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        Perf.add(action, Math.round(performance.now() - t0), j.ms);
        return j;
      } catch (e) {
        return { success: false, network: true, retryable: res.status >= 500 || res.status === 429, message: 'Server membalas HTTP ' + res.status + ' (bukan JSON).' };
      }
    } catch (err) {
      return { success: false, network: true, retryable: true, message: err.name === 'AbortError' ? 'Server lambat, mencoba lagi…' : 'Koneksi terputus.' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitOnline(ms) {
    return new Promise(r => {
      if (navigator.onLine !== false) return r();
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); removeEventListener('online', done); r(); }
      addEventListener('online', done);
    });
  }

  async function api(action, data, opt) {
    opt = opt || {};
    if (!sesi && action !== 'login') throw new Error('Belum masuk.');
    if (sesi && Date.now() - aktivitas > IDLE_MS) {
      keluar('Sesi berakhir karena tidak ada aktivitas selama 60 menit.');
      throw new Error('Sesi berakhir.');
    }
    const isRead = READ_ACTIONS.test(action);
    // reqId untuk aksi tulis agar aman di-retry
    const reqId = isRead ? '' : (opt.reqId || (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()));
    const tries = isRead ? 3 : 2;

    let res;
    for (let i = 0; i < tries; i++) {
      if (i) {
        await new Promise(r => setTimeout(r, 1200 * i));
        if (navigator.onLine === false) await waitOnline(15000);
      }
      res = await apiOnce(action, data, isRead ? (i ? 40000 : 25000) : 90000, reqId);
      if (res.success || !res.retryable) break;
    }

    if (!res.success) {
      if (res.kode === 'AUTH') { keluar('Sesi berakhir. Silakan masuk kembali.'); }
      if (res.kode === 'MUST_CHANGE' && sesi) { sesi.mustChange = true; simpanSesi(); location.hash = '#/sandi'; }
      throw new Error(res.message || 'Permintaan gagal.');
    }
    aktivitas = Date.now();
    return res.data;
  }

  // ============================================================
  // SWR — cache lokal dengan freshness TTL (Prinsip 2)
  // ============================================================
  async function swr(key, action, payload, render, opt) {
    opt = opt || {};
    const fresh = opt.fresh != null ? opt.fresh : 60000;   // default 60 dtk
    const cacheKey = uKey(key);
    const c = Store.get(cacheKey, null);
    if (c) render(c.data, true);                            // tampilkan cache seketika
    if (c && !opt.force && Date.now() - c.t < fresh) return { cached: true, data: c.data };

    let res;
    try {
      const raw = await api(action, payload);
      res = raw;
    } catch (err) {
      if (!c && opt.onError) opt.onError(err);
      else if (!c) throw err;
      return { cached: true, data: c ? c.data : null };
    }

    const h = hashStr(JSON.stringify(res));
    Store.set(cacheKey, { t: Date.now(), h, data: res });
    if (!c || c.h !== h) render(res, false);               // render ulang hanya bila data berubah
    return { cached: false, data: res };
  }

  /** Paksa invalidasi cache lokal untuk kunci tertentu */
  function invalidasiCache(key) { Store.del(uKey(key)); }

  // ============================================================
  // WARM-UP (Prinsip 8)
  // ============================================================
  function warmUp() {
    // Ping GAS agar container tidak cold saat admin mulai kerja
    fetch(CONFIG.GAS_URL + '?ping=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  }

  // Warm-up saat kembali dari latar belakang > 2 menit
  let _bgAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { _bgAt = Date.now(); return; }
    if (_bgAt && Date.now() - _bgAt > 120000 && sesi) warmUp();
  });

  // ============================================================
  // PREFETCH IDLE — muat data semua menu via batch saat idle (Prinsip 3)
  // ============================================================
  function prefetchIdle() {
    if (!sesi) return;
    const run = () => {
      // Panggil setiap aksi baca secara paralel (1 fetch per aksi, tapi serentak)
      const tasks = [
        { key: 'produkList', action: 'produkList', data: {} },
        { key: 'permintaanList', action: 'permintaanList', data: state.filterP },
        { key: 'dokumenList', action: 'dokumenList', data: { cari: '', jenis: 'Semua' } }
      ];
      tasks.forEach(function (t) {
        const cacheKey = uKey(t.key);
        const c = Store.get(cacheKey, null);
        if (c && Date.now() - c.t < 55000) return;  // sudah segar, lewati
        api(t.action, t.data).then(function (data) {
          const h = hashStr(JSON.stringify(data));
          Store.set(cacheKey, { t: Date.now(), h, data });
        }).catch(() => {});
      });
    };
    (window.requestIdleCallback || function (cb) { setTimeout(cb, 1500); })(run);
  }

  // ============================================================
  // UTILITAS
  // ============================================================
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function opsi(arr, sel) {
    return arr.map(function (v) {
      const val = Array.isArray(v) ? v[0] : v;
      const lbl = Array.isArray(v) ? v[1] : v;
      return '<option value="' + esc(val) + '"' + (val === sel ? ' selected' : '') + '>' + esc(lbl) + '</option>';
    }).join('');
  }
  function fmtTgl(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d) ? '-' : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function rupiah(n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); }
  function urlFoto(u, lebar) {
    return /^https:\/\/lh3\.googleusercontent\.com\/d\//.test(u) ? u.replace(/=w\d+$/, '') + '=w' + lebar : u;
  }

  async function kompresFoto(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Pilih foto berformat JPG, PNG, atau WebP.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Ukuran foto asli maksimal 10 MB.');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * s);
      const h = Math.round(img.naturalHeight * s);
      const kanvas = document.createElement('canvas');
      kanvas.width = w; kanvas.height = h;
      const ctx = kanvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
      const data = kanvas.toDataURL('image/jpeg', 0.88);
      return { base64: data.split(',')[1], mime: 'image/jpeg', pratinjau: data, kb: Math.round(data.length * 3 / 4 / 1024) };
    } finally { URL.revokeObjectURL(url); }
  }

  function waLink(nomor) {
    const s = String(nomor || '').replace(/\D/g, '');
    return s ? 'https://wa.me/62' + s.replace(/^0/, '') : '#';
  }

  function toast(pesan, galat) {
    const t = $('#toast');
    t.textContent = pesan;
    t.className = 'toast tampil' + (galat ? ' galat' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function isi(html) { main.innerHTML = html; }

  function setNav(sec) {
    $$('#navUtama a').forEach(function (a) {
      if (a.dataset.menu === sec) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function simpanSesi() { try { sessionStorage.setItem(KUNCI_SESI, JSON.stringify(sesi)); } catch (e) {} }
  function bacaSesi() { try { return JSON.parse(sessionStorage.getItem(KUNCI_SESI) || 'null'); } catch (e) { return null; } }
  function hapusSesi() { try { sessionStorage.removeItem(KUNCI_SESI); } catch (e) {} }

  // ============================================================
  // SESI & TAMPILAN DASAR
  // ============================================================
  function tampilLogin() {
    $('#vLogin').hidden = false;
    $('#vApp').hidden = true;
  }

  function mulaiApp(boot) {
    $('#vLogin').hidden = true;
    $('#vApp').hidden = false;
    $('#uNama').textContent = sesi.nama;
    $('#uPeran').textContent = sesi.peran === PERAN_SUPER ? 'Super Admin' : 'Admin Operasional';
    $$('.hanya-super').forEach(function (el) { el.classList.toggle('nonaktif-peran', sesi.peran !== PERAN_SUPER); });
    if (sesi.mustChange && location.hash !== '#/sandi') { location.hash = '#/sandi'; return; }

    // Bootstrap dari login: simpan ke cache agar pindah menu langsung dari cache
    if (boot) {
      if (boot.dashboard) {
        const h = hashStr(JSON.stringify(boot.dashboard));
        Store.set(uKey('dashboard'), { t: Date.now(), h, data: boot.dashboard });
      }
      if (boot.produkList) {
        const h = hashStr(JSON.stringify(boot.produkList));
        Store.set(uKey('produkList'), { t: Date.now(), h, data: boot.produkList });
      }
      if (boot.permintaanList) {
        const h = hashStr(JSON.stringify(boot.permintaanList));
        Store.set(uKey('permintaanList'), { t: Date.now(), h, data: boot.permintaanList });
      }
    }

    route();
    // Prefetch menu lain saat idle
    prefetchIdle();
  }

  function keluar(pesan) {
    sesi = null;
    hapusSesi();
    tampilLogin();
    if (pesan) toast(pesan, true);
  }

  async function keluarManual() {
    try { await api('logout'); } catch (e) {}
    keluar('Anda telah keluar.');
  }

  // ============================================================
  // MODAL
  // ============================================================
  function bukaModal(judul, html) {
    $('#modalJudul').textContent = judul;
    $('#modalIsi').innerHTML = html;
    $('#modal').hidden = false;
  }
  function tutupModal() { $('#modal').hidden = true; $('#modalIsi').innerHTML = ''; }

  // ============================================================
  // ROUTING (Prinsip 1)
  // ============================================================
  function route() {
    if (!sesi) return;
    const bagian = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/');
    const sec = bagian[0] || 'dashboard';
    const id = bagian[1] ? decodeURIComponent(bagian[1]) : '';
    if (sesi.mustChange && sec !== 'sandi') { location.hash = '#/sandi'; return; }
    setNav(sec === 'permintaan' && id ? 'permintaan' : sec);
    viewId++;
    const my = viewId;
    if (sec === 'dashboard') return vDashboard(my);
    if (sec === 'permintaan') return id ? vDetail(id, my) : vPermintaan(my);
    if (sec === 'produk') return vProduk(my);
    if (sec === 'dokumen') return vDokumen(my);
    if (sec === 'ekspor') return vEkspor();
    if (sec === 'akun') return sesi.peran === PERAN_SUPER ? vAkun(my) : (location.hash = '#/dashboard');
    if (sec === 'sandi') return vSandi();
    location.hash = '#/dashboard';
  }

  // Wrapper: batalkan render bila user sudah pindah halaman
  async function muat(my, fn) {
    try {
      const hasil = await fn();
      return my === viewId ? hasil : undefined;
    } catch (err) {
      if (my === viewId) toast(err.message, true);
      return undefined;
    }
  }

  // ============================================================
  // DASHBOARD — SWR 90 dtk (Prinsip 2)
  // ============================================================
  async function vDashboard(my) {
    isi('<h1>Dashboard</h1><p class="muted">Memuat…</p>');

    await swr('dashboard', 'dashboard', { tahun: state.tahun || undefined },
      function (d, fromCache) {
        if (my !== viewId) return;
        state.tahun = d.tahun;
        const max = Math.max.apply(null, [1].concat(d.bulan));
        const daftarTahun = d.tahunTersedia.length ? d.tahunTersedia : [d.tahun];
        if (daftarTahun.indexOf(d.tahun) < 0) daftarTahun.push(d.tahun);
        const kartu = function (angka, label) {
          return '<div class="ringkas"><div class="angka">' + esc(angka) + '</div><div class="label">' + esc(label) + '</div></div>';
        };
        isi(
          '<h1>Dashboard' + (fromCache ? ' <span class="muted small" style="font-size:12px;font-weight:400">· cache</span>' : '') + '</h1>' +
          '<div class="grid-ringkas">' +
            kartu(d.ringkas.hariIni, 'Permintaan hari ini') +
            kartu(d.ringkas.baru, 'Permintaan baru') +
            kartu(d.ringkas.diproses, 'Sedang diproses') +
            kartu(d.ringkas.selesaiBulanIni, 'Selesai bulan ini') +
            kartu(d.ringkas.total, 'Total permintaan') +
          '</div>' +
          '<div class="kartu">' +
            '<div class="toolbar"><h2 style="margin:0;flex:1 1 auto">Permintaan per bulan</h2>' +
            '<select id="selTahun" aria-label="Pilih tahun" style="flex:0 0 auto;width:auto">' + opsi(daftarTahun, d.tahun) + '</select></div>' +
            '<div class="grafik">' + d.bulan.map(function (v, i) {
              const tinggi = Math.max(2, Math.round((v / max) * 170));
              return '<div class="kolom"><div class="batang" style="height:' + tinggi + 'px"><b>' + v + '</b></div>' + BULAN[i] + '</div>';
            }).join('') + '</div>' +
          '</div>' +
          '<div class="kartu"><h2>Permintaan terbaru</h2>' + tabelPermintaan(d.terbaru) + '</div>'
        );
      },
      { fresh: 90000, onError: function (err) { if (my === viewId) toast(err.message, true); } }
    );
  }

  function tabelPermintaan(rows) {
    if (!rows.length) return '<p class="muted">Belum ada data.</p>';
    return '<div class="tabel-wrap"><table class="tabel"><thead><tr>' +
      '<th>Nomor</th><th>Tanggal</th><th>Nama</th><th>Layanan</th><th>Jumlah</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><a href="#/permintaan/' + encodeURIComponent(r.id) + '"><b>' + esc(r.id) + '</b></a></td>' +
          '<td>' + fmtTgl(r.tanggal) + '</td><td>' + esc(r.nama) + '</td><td>' + esc(r.layanan) +
          '</td><td>' + esc(r.jumlah) + '</td><td><span class="status ' + esc(r.status) + '">' + esc(r.status) + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ============================================================
  // PERMINTAAN — SWR 45 dtk (Prinsip 2)
  // ============================================================
  async function vPermintaan(my) {
    const f = state.filterP;
    isi(
      '<h1>Permintaan</h1>' +
      '<form class="kartu" id="fFilterP"><div class="toolbar">' +
        '<input name="cari" placeholder="Cari nomor, nama, atau WhatsApp" value="' + esc(f.cari) + '" aria-label="Cari">' +
        '<select name="status" aria-label="Status">' + opsi(['Semua'].concat(STATUS), f.status) + '</select>' +
        '<select name="layanan" aria-label="Layanan">' + opsi(['Semua'].concat(LAYANAN), f.layanan) + '</select>' +
        '<input type="date" name="tanggalDari" value="' + esc(f.tanggalDari) + '" aria-label="Dari tanggal">' +
        '<input type="date" name="tanggalSampai" value="' + esc(f.tanggalSampai) + '" aria-label="Sampai tanggal">' +
        '<button class="btn btn-primary" type="submit">Terapkan</button>' +
      '</div></form>' +
      '<div class="kartu" id="hasilP"><p class="muted">Memuat…</p></div>'
    );
    await muatDaftarPermintaan(my);
  }

  async function muatDaftarPermintaan(my) {
    const cacheKey = 'permintaanList:' + JSON.stringify(state.filterP);
    await swr(cacheKey, 'permintaanList', state.filterP,
      function (d, fromCache) {
        if (my !== viewId) return;
        state.filterP.halaman = d.halaman;
        const pager = d.jumlahHalaman > 1
          ? '<div class="pager">' +
              '<button class="btn btn-ghost btn-sm" data-aksi="hal" data-hal="' + (d.halaman - 1) + '"' + (d.halaman <= 1 ? ' disabled' : '') + '>‹ Sebelumnya</button>' +
              '<span>Halaman ' + d.halaman + ' / ' + d.jumlahHalaman + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-aksi="hal" data-hal="' + (d.halaman + 1) + '"' + (d.halaman >= d.jumlahHalaman ? ' disabled' : '') + '>Berikutnya ›</button>' +
            '</div>'
          : '';
        $('#hasilP').innerHTML = '<p class="muted small" style="margin:0 0 10px">' + d.total + ' permintaan ditemukan' + (fromCache ? ' · <span style="opacity:.6">cache</span>' : '') + '</p>' +
          tabelPermintaan(d.rows) + pager;
      },
      { fresh: 45000, onError: function (err) { if (my === viewId) toast(err.message, true); } }
    );
  }

  async function vDetail(id, my) {
    isi('<p><a href="#/permintaan">← Kembali ke daftar</a></p><p class="muted">Memuat…</p>');
    const cacheKey = 'detail:' + id;
    await swr(cacheKey, 'permintaanDetail', { id: id },
      function (d, _fromCache) {
        if (my !== viewId) return;
        const dokumen = d.dokumen.length
          ? '<div class="tabel-wrap"><table class="tabel"><thead><tr><th>Nomor</th><th>Jenis</th><th>Total</th><th>Tanggal</th><th>PDF</th></tr></thead><tbody>' +
            d.dokumen.map(function (x) {
              const lbl = (JENIS.filter(function (j) { return j[0] === x.jenis; })[0] || [0, x.jenis])[1];
              return '<tr><td>' + esc(x.nomor) + '</td><td>' + esc(lbl) + '</td><td>' + (x.total ? rupiah(x.total) : '-') +
                '</td><td>' + fmtTgl(x.tanggal) + '</td><td><a href="' + esc(x.link) + '" target="_blank" rel="noopener">Buka</a></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<p class="muted">Belum ada dokumen untuk permintaan ini.</p>';
        isi(
          '<p><a href="#/permintaan">← Kembali ke daftar</a></p>' +
          '<h1>' + esc(d.id) + ' <span class="status ' + esc(d.status) + '">' + esc(d.status) + '</span></h1>' +
          '<div class="kartu"><h2>Data permintaan</h2><div class="form-grid">' +
            info('Tanggal', fmtTgl(d.tanggal)) +
            info('Nama', d.nama) +
            info('WhatsApp', '<a href="' + waLink(d.whatsapp) + '" target="_blank" rel="noopener">' + esc(d.whatsapp) + '</a>') +
            info('Email', d.email || '-') +
            info('Layanan', d.layanan) +
            info('Jumlah', d.jumlah || '-') +
            info('Sumber', d.sumber || '-') +
            info('Spesifikasi', d.spesifikasi || '-', true) +
            info('Catatan pelanggan', d.catatan || '-', true) +
            (d.linkBerkas ? info('Berkas', '<a href="' + esc(d.linkBerkas) + '" target="_blank" rel="noopener">Buka berkas</a>', true) : '') +
          '</div></div>' +
          '<form class="kartu" id="fUbahP" data-id="' + esc(d.id) + '"><h2>Tindak lanjut</h2><div class="form-grid">' +
            '<label class="fld"><span>Status</span><select name="status">' + opsi(STATUS, d.status) + '</select></label>' +
            '<label class="fld penuh"><span>Catatan internal (tidak tampil ke pelanggan)</span><textarea name="catatanInternal" maxlength="1000">' + esc(d.catatanInternal) + '</textarea></label>' +
          '</div><div class="aksi" style="margin-top:12px"><button class="btn btn-primary" type="submit">Simpan perubahan</button></div></form>' +
          '<div class="kartu"><h2>Dokumen</h2><div class="aksi" style="margin-bottom:12px">' +
            '<button class="btn btn-ghost btn-sm" data-aksi="buat-dok" data-jenis="penawaran" data-id="' + esc(d.id) + '">Buat penawaran</button>' +
            '<button class="btn btn-ghost btn-sm" data-aksi="buat-dok" data-jenis="tanda_terima" data-id="' + esc(d.id) + '">Buat tanda terima</button>' +
            '<button class="btn btn-ghost btn-sm" data-aksi="buat-dok" data-jenis="faktur" data-id="' + esc(d.id) + '">Buat faktur</button>' +
          '</div>' + dokumen + '</div>'
        );
      },
      { fresh: 30000, onError: function (err) { if (my === viewId) toast(err.message, true); } }
    );
  }

  function info(label, nilai, penuh) {
    return '<div class="fld' + (penuh ? ' penuh' : '') + '" style="grid-column:' + (penuh ? '1 / -1' : 'auto') + '"><span class="muted small">' + esc(label) + '</span><div>' + nilai + '</div></div>';
  }

  // ============================================================
  // PRODUK — SWR 120 dtk (Prinsip 2)
  // ============================================================
  async function vProduk(my) {
    isi(
      '<h1>Produk</h1>' +
      '<div class="toolbar">' +
        '<button class="btn btn-primary" data-aksi="produk-tambah" type="button">+ Tambah produk</button>' +
        '<button class="btn btn-ghost" data-aksi="urutan-simpan" type="button">Simpan urutan tampilan</button>' +
      '</div>' +
      '<div id="tabelProduk"><p class="muted">Memuat…</p></div>' +
      '<p class="muted small">Urutan memengaruhi tampilan di beranda. Produk nonaktif tidak tampil untuk publik.</p>'
    );

    await swr('produkList', 'produkList', {},
      function (d, _fromCache) {
        if (my !== viewId) return;
        produkCache = d;
        renderProduk();
      },
      { fresh: 120000, onError: function (err) { if (my === viewId) { $('#tabelProduk').innerHTML = '<p class="muted">Gagal memuat. <button class="btn btn-ghost btn-sm" onclick="location.reload()">Coba lagi</button></p>'; toast(err.message, true); } } }
    );
  }

  function renderProduk() {
    if (!produkCache.length) { $('#tabelProduk').innerHTML = '<p class="muted">Belum ada produk.</p>'; return; }
    $('#tabelProduk').innerHTML = '<div class="tabel-wrap"><table class="tabel"><thead><tr>' +
      '<th>Urutan</th><th>Foto</th><th>Nama</th><th>Kategori</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' +
      produkCache.map(function (p, i) {
        const foto = p.gambarURL
          ? '<img class="thumb" src="' + esc(urlFoto(p.gambarURL, 240)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
          : '<span class="muted small">Belum ada</span>';
        return '<tr><td>' + (i + 1) + '</td><td>' + foto + '</td><td><b>' + esc(p.nama) + '</b><br><span class="muted small">' + esc(p.id) + '</span></td>' +
          '<td>' + esc(p.kategori) + '</td>' +
          '<td><span class="status ' + (p.aktif ? 'Selesai' : 'Dibatalkan') + '">' + (p.aktif ? 'Aktif' : 'Nonaktif') + '</span></td>' +
          '<td><div class="aksi">' +
            '<button class="btn btn-ghost btn-sm" data-aksi="produk-naik" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button class="btn btn-ghost btn-sm" data-aksi="produk-turun" data-i="' + i + '"' + (i === produkCache.length - 1 ? ' disabled' : '') + '>↓</button>' +
            '<button class="btn btn-ghost btn-sm" data-aksi="produk-edit" data-i="' + i + '">Ubah</button>' +
            '<button class="btn btn-ghost btn-sm" data-aksi="produk-aktif" data-i="' + i + '">' + (p.aktif ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
            '<button class="btn btn-bahaya btn-sm" data-aksi="produk-hapus" data-i="' + i + '"' + (p.aktif ? ' disabled title="Nonaktifkan dahulu"' : '') + '>Hapus</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  let pilihanFoto = null;

  function bukaFormProduk(p) {
    const baru = !p;
    pilihanFoto = null;
    p = p || { nama: '', kategori: LAYANAN[0], deskripsi: '', keterangan: 'Konsultasi', gambarURL: '', aktif: true, urutan: produkCache.length + 1 };
    bukaModal(baru ? 'Tambah produk' : 'Ubah produk',
      '<form id="fProduk" class="form-grid" data-id="' + esc(p.id || '') + '">' +
        '<label class="fld penuh"><span>Nama produk</span><input name="nama" required maxlength="120" value="' + esc(p.nama) + '"></label>' +
        '<label class="fld"><span>Kategori</span><select name="kategori">' + opsi(LAYANAN, p.kategori) + '</select></label>' +
        '<label class="fld"><span>Keterangan harga</span><input name="keterangan" maxlength="60" value="' + esc(p.keterangan) + '"></label>' +
        '<label class="fld penuh"><span>Deskripsi singkat</span><textarea name="deskripsi" required maxlength="160">' + esc(p.deskripsi) + '</textarea></label>' +
        '<div class="fld penuh"><span>Foto produk (otomatis disimpan ke Google Drive)</span>' +
          '<input id="fFoto" type="file" accept="image/jpeg,image/png,image/webp">' +
          '<img id="pratinjauFoto" class="pratinjau" alt="Pratinjau foto produk"' + (p.gambarURL ? ' src="' + esc(urlFoto(p.gambarURL, 480)) + '"' : ' hidden') + '>' +
          '<p class="muted small" id="infoFoto">' + (p.gambarURL ? 'Foto saat ini. Pilih foto baru untuk menggantinya.' : 'JPG, PNG, atau WebP. Foto dikecilkan otomatis agar cepat dimuat.') + '</p>' +
          (p.gambarURL ? '<label class="small"><input type="checkbox" name="hapusGambar"> Hapus foto dari produk</label>' : '') +
        '</div>' +
        '<label class="fld penuh"><span>atau URL gambar eksternal (opsional)</span><input name="gambarURL" type="url" maxlength="500" value="' + esc(p.gambarURL) + '"></label>' +
        '<label class="fld"><span>Status</span><select name="aktif"><option value="YA"' + (p.aktif ? ' selected' : '') + '>Aktif</option><option value="TIDAK"' + (!p.aktif ? ' selected' : '') + '>Nonaktif</option></select></label>' +
        '<div class="penuh aksi"><button class="btn btn-primary" type="submit">Simpan</button><button class="btn btn-ghost" type="button" data-tutup>Batal</button></div>' +
        '<p class="galat penuh" id="galatProduk"></p>' +
      '</form>'
    );
    $('#fFoto').addEventListener('change', async function () {
      const file = this.files[0];
      $('#galatProduk').textContent = '';
      if (!file) { pilihanFoto = null; return; }
      try {
        pilihanFoto = await kompresFoto(file);
        const pra = $('#pratinjauFoto');
        pra.src = pilihanFoto.pratinjau;
        pra.hidden = false;
        $('#infoFoto').textContent = 'Akan diunggah sebagai JPG sekitar ' + pilihanFoto.kb + ' KB, lebar maks 1600 px.';
      } catch (err) {
        this.value = '';
        pilihanFoto = null;
        $('#galatProduk').textContent = err.message;
      }
    });

    $('#fProduk').addEventListener('submit', async function (e) {
      e.preventDefault();
      const f = e.target;
      const tombol = f.querySelector('button[type="submit"]');
      const data = {
        id: f.dataset.id || '', nama: f.nama.value.trim(), kategori: f.kategori.value,
        keterangan: f.keterangan.value.trim(), deskripsi: f.deskripsi.value.trim(),
        gambarURL: f.gambarURL.value.trim(), aktif: f.aktif.value === 'YA',
        urutan: p.urutan || produkCache.length + 1,
        hapusGambar: !!(f.hapusGambar && f.hapusGambar.checked)
      };
      if (pilihanFoto) data.gambar = { base64: pilihanFoto.base64, mime: pilihanFoto.mime };

      tombol.disabled = true;
      tombol.textContent = pilihanFoto ? 'Mengunggah foto…' : 'Menyimpan…';
      try {
        await api('produkSimpan', data);
        tutupModal();
        toast('Produk disimpan.' + (pilihanFoto ? ' Foto tersimpan di Drive.' : ''));
        invalidasiCache('produkList');
        vProduk(viewId);
      } catch (err) {
        $('#galatProduk').textContent = err.message;
      } finally {
        tombol.disabled = false;
        tombol.textContent = 'Simpan';
      }
    });
  }

  // ============================================================
  // CETAK DOKUMEN (Prinsip 2)
  // ============================================================
  async function vDokumen(my) {
    const pre = state.prefill || {};
    state.prefill = null;
    isi(
      '<h1>Cetak Dokumen</h1>' +
      '<form class="kartu" id="fDok">' +
        '<div class="form-grid">' +
          '<label class="fld"><span>Jenis dokumen</span><select name="jenis">' + opsi(JENIS, pre.jenis || 'penawaran') + '</select></label>' +
          '<label class="fld"><span>ID permintaan (opsional)</span><input name="permintaanId" value="' + esc(pre.permintaanId || '') + '"></label>' +
          '<div class="aksi penuh">' +
            '<button class="btn btn-ghost btn-sm" type="button" data-aksi="muat-pemohon">Muat data pemohon</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-aksi="pindai">Pindai placeholder template</button>' +
          '</div>' +
          '<label class="fld"><span>Nama pemohon</span><input name="nama" required maxlength="120"></label>' +
          '<label class="fld"><span>Instansi</span><input name="instansi" maxlength="120"></label>' +
          '<label class="fld penuh"><span>Alamat</span><input name="alamat" maxlength="300"></label>' +
          '<label class="fld"><span>WhatsApp</span><input name="whatsapp" maxlength="16"></label>' +
          '<label class="fld"><span>Email</span><input name="email" type="email" maxlength="120"></label>' +
          '<label class="fld"><span>Layanan</span><select name="layanan">' + opsi(LAYANAN, '') + '</select></label>' +
          '<label class="fld"><span>Jumlah</span><input name="jumlah" maxlength="80"></label>' +
          '<label class="fld penuh"><span>Spesifikasi</span><textarea name="spesifikasi" maxlength="400"></textarea></label>' +
          '<label class="fld"><span>Perihal</span><input name="perihal" maxlength="200"></label>' +
          '<label class="fld penuh"><span>Isi / pengantar</span><textarea name="isi" maxlength="2000"></textarea></label>' +
        '</div>' +
        '<div id="bagianItem" class="penuh" style="margin-top:16px"><h2>Item</h2>' +
          '<div id="listItem"></div>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-aksi="tambah-item">+ Tambah item</button>' +
        '</div>' +
        '<div class="form-grid" style="margin-top:16px">' +
          '<label class="fld"><span>Diskon (Rp)</span><input name="diskon" type="number" min="0" value="0"></label>' +
          '<label class="fld"><span>Jatuh tempo (untuk faktur)</span><input name="tglJatuhTempo" type="date"></label>' +
          '<label class="fld"><span>Status bayar</span><input name="statusBayar" placeholder="BELUM LUNAS" maxlength="40"></label>' +
          '<label class="fld"><span>Rekening (kosongkan untuk memakai data perusahaan)</span><input name="rekening" maxlength="300"></label>' +
          '<label class="fld penuh"><span>Catatan</span><textarea name="catatan" maxlength="1000"></textarea></label>' +
        '</div>' +
        '<div class="aksi" style="margin-top:16px"><button class="btn btn-primary" type="submit">Buat dokumen PDF</button></div>' +
      '</form>' +
      '<div id="hasilDok"></div>' +
      '<div id="pindaiDok"></div>' +
      '<div class="kartu"><h2>Dokumen terbaru</h2>' +
        '<form id="fFilterDok" class="toolbar">' +
          '<input name="cari" placeholder="Cari nomor atau ID permintaan" aria-label="Cari dokumen">' +
          '<select name="jenis" aria-label="Jenis">' + opsi([['Semua', 'Semua jenis']].concat(JENIS), 'Semua') + '</select>' +
          '<button class="btn btn-ghost" type="submit">Cari</button>' +
        '</form>' +
        '<div id="listDok"></div>' +
      '</div>'
    );
    tambahBarisItem();
    syaratItem();
    if (pre.permintaanId) { await muatPemohon(my); }
    await muatDaftarDokumen(my);
  }

  function syaratItem() {
    const jenis = $('#fDok').jenis.value;
    $('#bagianItem').hidden = jenis === 'tanda_terima';
  }

  function tambahBarisItem(it) {
    it = it || {};
    const n = $('#listItem').children.length + 1;
    $('#listItem').insertAdjacentHTML('beforeend',
      '<div class="baris-item">' +
        '<span class="nomor">' + n + '</span>' +
        '<input placeholder="Nama item" data-f="nama" value="' + esc(it.nama || '') + '" aria-label="Nama item">' +
        '<input placeholder="Spesifikasi" data-f="spesifikasi" value="' + esc(it.spesifikasi || '') + '" aria-label="Spesifikasi">' +
        '<input type="number" min="0" placeholder="Jumlah" data-f="jumlah" value="' + esc(it.jumlah || '') + '" aria-label="Jumlah">' +
        '<input type="number" min="0" placeholder="Harga satuan" data-f="harga" value="' + esc(it.harga || '') + '" aria-label="Harga satuan">' +
        '<button type="button" class="btn btn-bahaya btn-sm" data-aksi="hapus-item">Hapus</button>' +
      '</div>');
  }

  function nomorUlangItem() {
    $$('#listItem .baris-item').forEach(function (el, i) { el.querySelector('.nomor').textContent = i + 1; });
  }

  async function muatPemohon(my) {
    const id = $('#fDok').permintaanId.value.trim();
    if (!id) { toast('Isi ID permintaan terlebih dahulu.', true); return; }
    const d = await muat(my, function () { return api('permintaanDetail', { id: id }); });
    if (!d) return;
    const f = $('#fDok');
    f.nama.value = d.nama || '';
    f.whatsapp.value = d.whatsapp || '';
    f.email.value = d.email || '';
    f.layanan.value = d.layanan || '';
    f.jumlah.value = d.jumlah || '';
    f.spesifikasi.value = d.spesifikasi || '';
    toast('Data pemohon dimuat.');
  }

  async function muatDaftarDokumen(my) {
    const f = $('#fFilterDok');
    const payload = { cari: f.cari.value.trim(), jenis: f.jenis.value };
    const cacheKey = 'dokumenList:' + JSON.stringify(payload);
    await swr(cacheKey, 'dokumenList', payload,
      function (d, _fromCache) {
        if (my !== viewId) return;
        $('#listDok').innerHTML = d.length
          ? '<div class="tabel-wrap"><table class="tabel"><thead><tr><th>Nomor</th><th>Jenis</th><th>Permintaan</th><th>Total</th><th>Tanggal</th><th>PDF</th></tr></thead><tbody>' +
            d.map(function (x) {
              return '<tr><td>' + esc(x.nomor) + '</td><td>' + esc(x.label) + '</td><td>' + esc(x.permintaanId || '-') + '</td>' +
                '<td>' + (x.total ? rupiah(x.total) : '-') + '</td><td>' + fmtTgl(x.tanggal) + '</td>' +
                '<td><a href="' + esc(x.link) + '" target="_blank" rel="noopener">Buka</a></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<p class="muted">Belum ada dokumen.</p>';
      },
      { fresh: 60000 }
    );
  }

  async function pindaiTemplate(my) {
    const jenis = $('#fDok').jenis.value;
    const d = await muat(my, function () { return api('dokumenPindai', { jenis: jenis }); });
    if (!d) return;
    const tag = function (arr) {
      return arr.length ? arr.map(function (k) { return '<code>' + esc(k) + '</code>'; }).join(' ') : '<span class="muted">tidak ada</span>';
    };
    $('#pindaiDok').innerHTML =
      '<div class="kartu"><h2>Pemindaian: ' + esc(d.judul) + '</h2>' +
        '<p><b>Penanda ditemukan:</b> ' + tag(d.ditemukan) + '</p>' +
        '<p><b>Tidak dikenali (periksa ejaan):</b> ' + tag(d.tidakDikenal) + '</p>' +
        '<p><b>Belum ada di template:</b> ' + tag(d.belumAda) + '</p>' +
        '<p><b>Blok opsional:</b> ' + tag(d.blok) + '</p>' +
        '<p class="muted small">Penanda dengan awalan ITEM. harus berada di satu baris tabel yang akan diulang otomatis.</p>' +
      '</div>';
  }

  // ============================================================
  // EKSPOR
  // ============================================================
  function vEkspor() {
    const f = state.filterP;
    isi(
      '<h1>Ekspor data</h1>' +
      '<form class="kartu" id="fEkspor"><p class="muted">Ekspor mengikuti filter di bawah. Maksimal 5.000 baris per unduhan.</p>' +
        '<div class="toolbar">' +
          '<input name="cari" placeholder="Cari nomor, nama, atau WhatsApp" value="' + esc(f.cari) + '">' +
          '<select name="status">' + opsi(['Semua'].concat(STATUS), f.status) + '</select>' +
          '<select name="layanan">' + opsi(['Semua'].concat(LAYANAN), f.layanan) + '</select>' +
          '<input type="date" name="tanggalDari" value="' + esc(f.tanggalDari) + '" aria-label="Dari tanggal">' +
          '<input type="date" name="tanggalSampai" value="' + esc(f.tanggalSampai) + '" aria-label="Sampai tanggal">' +
        '</div>' +
        '<button class="btn btn-primary" type="submit">Unduh Excel (.xlsx)</button>' +
      '</form>'
    );
  }

  function unduhBase64(b64, nama) {
    const biner = atob(b64);
    const bytes = new Uint8Array(biner.length);
    for (let i = 0; i < biner.length; i++) bytes[i] = biner.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nama;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ============================================================
  // AKUN ADMIN (Prinsip 2 — SWR 120 dtk)
  // ============================================================
  async function vAkun(my) {
    isi(
      '<h1>Akun Admin</h1>' +
      '<div id="tabelAkun"><p class="muted">Memuat…</p></div>' +
      '<form class="kartu" id="fAdminBuat" style="margin-top:16px"><h2>Tambah akun</h2><div class="form-grid">' +
        '<label class="fld"><span>Username</span><input name="username" required pattern="[a-z0-9_]{3,30}" title="Huruf kecil, angka, atau garis bawah (3–30)"></label>' +
        '<label class="fld"><span>Nama lengkap</span><input name="nama" required maxlength="80"></label>' +
        '<label class="fld"><span>Peran</span><select name="peran">' + opsi([['ADMIN_OPERASIONAL', 'Admin Operasional'], ['SUPER_ADMIN', 'Super Admin']], 'ADMIN_OPERASIONAL') + '</select></label>' +
        '<label class="fld"><span>Kata sandi awal (min. 8)</span><input name="sandiAwal" type="password" required minlength="8"></label>' +
      '</div><div class="aksi" style="margin-top:12px"><button class="btn btn-primary" type="submit">Buat akun</button></div>' +
      '<p class="muted small">Pengguna baru wajib mengganti kata sandi saat masuk pertama.</p></form>'
    );

    await swr('adminList', 'adminList', {},
      function (d, _fromCache) {
        if (my !== viewId) return;
        $('#tabelAkun').innerHTML = '<div class="tabel-wrap"><table class="tabel"><thead><tr>' +
          '<th>Username</th><th>Nama</th><th>Peran</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' +
          d.map(function (a) {
            return '<tr><td><b>' + esc(a.username) + '</b></td><td>' + esc(a.nama) + '</td>' +
              '<td><select data-aksi="peran" data-u="' + esc(a.username) + '" aria-label="Peran ' + esc(a.username) + '">' +
                opsi([['ADMIN_OPERASIONAL', 'Admin Operasional'], ['SUPER_ADMIN', 'Super Admin']], a.peran) + '</select></td>' +
              '<td><span class="status ' + (a.aktif ? 'Selesai' : 'Dibatalkan') + '">' + (a.aktif ? 'Aktif' : 'Nonaktif') + '</span>' +
                (a.mustChange ? ' <span class="muted small">· wajib ganti sandi</span>' : '') + '</td>' +
              '<td><div class="aksi">' +
                '<button class="btn btn-ghost btn-sm" data-aksi="akun-aktif" data-u="' + esc(a.username) + '" data-aktif="' + (a.aktif ? '1' : '0') + '">' + (a.aktif ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-aksi="akun-reset" data-u="' + esc(a.username) + '">Reset sandi</button>' +
              '</div></td></tr>';
          }).join('') + '</tbody></table></div>';
      },
      { fresh: 120000, onError: function (err) { if (my === viewId) toast(err.message, true); } }
    );
  }

  // ============================================================
  // UBAH KATA SANDI
  // ============================================================
  function vSandi() {
    isi(
      '<h1>Ubah kata sandi</h1>' +
      (sesi.mustChange ? '<p class="galat">Anda wajib mengganti kata sandi sementara sebelum melanjutkan.</p>' : '') +
      '<form class="kartu login-card" id="fSandi" style="max-width:420px">' +
        '<label class="fld"><span>Kata sandi lama</span><input name="sandiLama" type="password" required autocomplete="current-password"></label>' +
        '<label class="fld"><span>Kata sandi baru (min. 8)</span><input name="sandiBaru" type="password" required minlength="8" autocomplete="new-password"></label>' +
        '<label class="fld"><span>Ulangi kata sandi baru</span><input name="ulang" type="password" required minlength="8" autocomplete="new-password"></label>' +
        '<p class="galat" id="galatSandi"></p>' +
        '<button class="btn btn-primary" type="submit">Simpan kata sandi</button>' +
      '</form>'
    );
  }

  // ============================================================
  // EVENT DELEGATION
  // ============================================================
  main.addEventListener('click', async function (e) {
    const el = e.target.closest('[data-aksi]');
    if (!el || el.disabled) return;
    const aksi = el.dataset.aksi;
    const my = viewId;
    const i = Number(el.dataset.i);

    if (aksi === 'hal') { state.filterP.halaman = Number(el.dataset.hal); muatDaftarPermintaan(my); return; }

    if (aksi === 'buat-dok') {
      state.prefill = { jenis: el.dataset.jenis, permintaanId: el.dataset.id };
      location.hash = '#/dokumen';
      return;
    }
    if (aksi === 'muat-pemohon') { muatPemohon(my); return; }
    if (aksi === 'pindai') { pindaiTemplate(my); return; }
    if (aksi === 'tambah-item') { tambahBarisItem(); return; }
    if (aksi === 'hapus-item') { el.closest('.baris-item').remove(); nomorUlangItem(); return; }

    if (aksi === 'produk-tambah') { bukaFormProduk(null); return; }
    if (aksi === 'produk-edit') { bukaFormProduk(produkCache[i]); return; }
    if (aksi === 'produk-naik' || aksi === 'produk-turun') {
      const j = aksi === 'produk-naik' ? i - 1 : i + 1;
      if (j < 0 || j >= produkCache.length) return;
      const tmp = produkCache[i]; produkCache[i] = produkCache[j]; produkCache[j] = tmp;
      renderProduk();
      return;
    }
    if (aksi === 'urutan-simpan') {
      const urutan = produkCache.map(function (p, k) { return { id: p.id, urutan: k + 1 }; });
      try {
        await api('produkUrutan', { urutan: urutan });
        produkCache.forEach(function (p, k) { p.urutan = k + 1; });
        invalidasiCache('produkList');
        toast('Urutan tampilan disimpan.');
      } catch (err) { toast(err.message, true); }
      return;
    }
    // Optimistic UI: toggle aktif langsung ke layar, rollback bila gagal (Prinsip 2)
    if (aksi === 'produk-aktif') {
      const p = produkCache[i];
      const sebelumnya = p.aktif;
      p.aktif = !p.aktif;
      renderProduk();   // instan
      try {
        await api('produkSimpan', { id: p.id, nama: p.nama, kategori: p.kategori, deskripsi: p.deskripsi,
          keterangan: p.keterangan, gambarURL: p.gambarURL, aktif: p.aktif, urutan: p.urutan });
        invalidasiCache('produkList');
        toast(p.aktif ? 'Produk diaktifkan.' : 'Produk dinonaktifkan.');
      } catch (err) {
        p.aktif = sebelumnya;   // rollback
        renderProduk();
        toast(err.message, true);
      }
      return;
    }
    if (aksi === 'produk-hapus') {
      const p = produkCache[i];
      const konf = window.prompt('Ketik HAPUS untuk menghapus permanen "' + p.nama + '".');
      if (konf !== 'HAPUS') return;
      try {
        await api('produkHapus', { id: p.id, konfirmasi: 'HAPUS' });
        toast('Produk dihapus.');
        invalidasiCache('produkList');
        vProduk(my);
      } catch (err) { toast(err.message, true); }
      return;
    }

    if (aksi === 'akun-aktif') {
      const u = el.dataset.u;
      const aktifSekarang = el.dataset.aktif === '1';
      if (aktifSekarang && !window.confirm('Nonaktifkan akun ' + u + '? Sesi aktifnya akan langsung dicabut.')) return;
      try {
        await api('adminUbah', { username: u, aktif: !aktifSekarang });
        toast('Status akun diperbarui.');
        invalidasiCache('adminList');
        vAkun(my);
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (aksi === 'akun-reset') {
      const u = el.dataset.u;
      if (!window.confirm('Buat kata sandi sementara untuk ' + u + '? Sesi aktifnya akan dicabut.')) return;
      try {
        const d = await api('adminResetSandi', { username: u });
        bukaModal('Kata sandi sementara',
          '<p>Berikan kata sandi ini kepada <b>' + esc(u) + '</b>. Ditampilkan sekali saja, dan pengguna wajib menggantinya saat masuk.</p>' +
          '<p style="font-size:20px"><code>' + esc(d.sandiSementara) + '</code></p>' +
          '<div class="aksi"><button class="btn btn-primary" type="button" data-tutup>Sudah dicatat</button></div>');
        invalidasiCache('adminList');
        vAkun(my);
      } catch (err) { toast(err.message, true); }
      return;
    }
  });

  main.addEventListener('change', function (e) {
    const t = e.target;
    if (t.name === 'jenis' && t.form && t.form.id === 'fDok') { syaratItem(); return; }
    if (t.dataset.aksi === 'peran') {
      api('adminUbah', { username: t.dataset.u, peran: t.value })
        .then(function () { toast('Peran diperbarui.'); invalidasiCache('adminList'); })
        .catch(function (err) { toast(err.message, true); vAkun(viewId); });
    }
    if (t.id === 'selTahun') {
      state.tahun = Number(t.value);
      invalidasiCache('dashboard');
      vDashboard(viewId);
    }
  });

  main.addEventListener('submit', async function (e) {
    const f = e.target;
    e.preventDefault();
    const my = viewId;

    if (f.id === 'fFilterP') {
      Object.assign(state.filterP, {
        cari: f.cari.value.trim(), status: f.status.value, layanan: f.layanan.value,
        tanggalDari: f.tanggalDari.value, tanggalSampai: f.tanggalSampai.value, halaman: 1
      });
      muatDaftarPermintaan(my);
      return;
    }

    if (f.id === 'fUbahP') {
      try {
        await api('permintaanUbah', { id: f.dataset.id, status: f.status.value, catatanInternal: f.catatanInternal.value.trim() });
        toast('Perubahan disimpan.');
        invalidasiCache('detail:' + f.dataset.id);
        invalidasiCache('permintaanList');
        vDetail(f.dataset.id, my);
      } catch (err) { toast(err.message, true); }
      return;
    }

    if (f.id === 'fDok') {
      const item = $$('#listItem .baris-item').map(function (row) {
        const g = function (k) { return row.querySelector('[data-f="' + k + '"]').value; };
        return { nama: g('nama'), spesifikasi: g('spesifikasi'), jumlah: g('jumlah'), harga: g('harga') };
      }).filter(function (x) { return x.nama.trim(); });
      const data = {
        jenis: f.jenis.value,
        permintaanId: f.permintaanId.value.trim(),
        pemohon: {
          nama: f.nama.value.trim(), instansi: f.instansi.value.trim(), alamat: f.alamat.value.trim(),
          whatsapp: f.whatsapp.value.trim(), email: f.email.value.trim(), layanan: f.layanan.value,
          jumlah: f.jumlah.value.trim(), spesifikasi: f.spesifikasi.value.trim()
        },
        perihal: f.perihal.value.trim(), isi: f.isi.value.trim(), item: item,
        diskon: Number(f.diskon.value) || 0, tglJatuhTempo: f.tglJatuhTempo.value,
        statusBayar: f.statusBayar.value.trim(), rekening: f.rekening.value.trim(), catatan: f.catatan.value.trim()
      };
      const tombol = f.querySelector('button[type="submit"]');
      tombol.disabled = true;
      try {
        const d = await api('dokumenCetak', data);
        $('#hasilDok').innerHTML = '<div class="kartu"><h2>Dokumen siap</h2>' +
          '<p><b>' + esc(d.nomor) + '</b> · ' + esc(JENIS.filter(function (j) { return j[0] === d.jenis; })[0][1]) +
          (d.total ? ' · ' + rupiah(d.total) : '') + '</p>' +
          '<p class="muted small">Kode verifikasi: <code>' + esc(d.kodeVerifikasi) + '</code></p>' +
          '<div class="aksi"><a class="btn btn-primary btn-sm" href="' + esc(d.link) + '" target="_blank" rel="noopener">Buka PDF</a></div></div>';
        toast('Dokumen berhasil dibuat.');
        invalidasiCache('dokumenList:' + JSON.stringify({ cari: '', jenis: 'Semua' }));
        muatDaftarDokumen(my);
      } catch (err) { toast(err.message, true); }
      finally { tombol.disabled = false; }
      return;
    }

    if (f.id === 'fFilterDok') {
      invalidasiCache('dokumenList:' + JSON.stringify({ cari: f.cari.value.trim(), jenis: f.jenis.value }));
      muatDaftarDokumen(my);
      return;
    }

    if (f.id === 'fEkspor') {
      const tombol = f.querySelector('button[type="submit"]');
      tombol.disabled = true;
      try {
        const d = await api('ekspor', {
          cari: f.cari.value.trim(), status: f.status.value, layanan: f.layanan.value,
          tanggalDari: f.tanggalDari.value, tanggalSampai: f.tanggalSampai.value
        });
        unduhBase64(d.base64, d.nama);
        toast('Unduhan siap: ' + d.jumlah + ' baris.');
      } catch (err) { toast(err.message, true); }
      finally { tombol.disabled = false; }
      return;
    }

    if (f.id === 'fAdminBuat') {
      try {
        await api('adminBuat', {
          username: f.username.value.trim().toLowerCase(), nama: f.nama.value.trim(),
          peran: f.peran.value, sandiAwal: f.sandiAwal.value
        });
        toast('Akun dibuat.');
        invalidasiCache('adminList');
        vAkun(my);
      } catch (err) { toast(err.message, true); }
      return;
    }

    if (f.id === 'fSandi') {
      const galat = $('#galatSandi');
      galat.textContent = '';
      if (f.sandiBaru.value !== f.ulang.value) { galat.textContent = 'Kata sandi baru dan ulangannya tidak sama.'; return; }
      try {
        await api('ubahSandi', { sandiLama: f.sandiLama.value, sandiBaru: f.sandiBaru.value });
        sesi.mustChange = false;
        simpanSesi();
        toast('Kata sandi berhasil diperbarui.');
        location.hash = '#/dashboard';
      } catch (err) { galat.textContent = err.message; }
      return;
    }
  });

  // ============================================================
  // LOGIN, LOGOUT, DAN INISIALISASI
  // ============================================================
  $('#fLogin').addEventListener('submit', async function (e) {
    e.preventDefault();
    const f = e.target;
    const galat = $('#loginGalat');
    galat.textContent = '';
    const u = f.username.value.trim();
    const p = f.password.value;
    if (!u || !p) { galat.textContent = 'Username dan kata sandi wajib diisi.'; return; }
    const tombol = f.querySelector('button[type="submit"]');
    tombol.disabled = true;
    try {
      // Login mengembalikan data + bootstrap (Prinsip 3)
      const d = await api('login', { username: u, password: p });
      sesi = { token: d.token, nama: d.nama, peran: d.peran, username: u, mustChange: !!d.mustChange };
      simpanSesi();
      f.password.value = '';
      mulaiApp(d.boot || null);   // d.boot berisi dashboard + produkList dari satu panggilan
      toast(d.mustChange ? 'Silakan ganti kata sandi sementara Anda.' : 'Selamat datang, ' + d.nama + '.');
    } catch (err) {
      galat.textContent = err.message;
    } finally {
      tombol.disabled = false;
    }
  });

  $('#btnKeluar').addEventListener('click', keluarManual);
  $('#modal').addEventListener('click', function (e) {
    if (e.target === this || e.target.hasAttribute('data-tutup')) tutupModal();
  });
  window.addEventListener('hashchange', route);

  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { aktivitas = Date.now(); }, { passive: true });
  });
  setInterval(function () {
    if (sesi && Date.now() - aktivitas > IDLE_MS) keluar('Sesi berakhir karena tidak ada aktivitas selama 60 menit.');
  }, 30000);

  document.addEventListener('DOMContentLoaded', function () {
    warmUp();   // warm-up ping saat halaman dibuka (Prinsip 8)
    const tersimpan = bacaSesi();
    if (tersimpan && tersimpan.token) {
      sesi = tersimpan;
      mulaiApp(null);   // sesi dari sessionStorage: pakai cache lokal, fetch di latar
    } else {
      tampilLogin();
    }
  });
})();
