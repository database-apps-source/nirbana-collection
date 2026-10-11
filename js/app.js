// ============================================================
// PT Nirbana Collection Persada — Frontend publik (vanilla JS)
// Komunikasi ke GAS hanya lewat fetch(). Tidak ada google.script.run.
// ============================================================

(function () {
  'use strict';

  const CACHE_PREFIX = 'nirbana:v1:';
  const TTL_MS = 10 * 60 * 1000;          // data publik dipakai ulang 10 menit
  const KATEGORI_WARNA = { 'Cetak': '', 'Kemasan': 'yellow', 'Alat Tulis': 'green', 'Produk Khusus': 'lavender' };
  const LOGO_FALLBACK = 'N';

  // ---------- Utilitas ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(pesan, tipe) {
    const el = document.getElementById('toast');
    el.textContent = pesan;
    el.className = 'toast' + (tipe === 'error' ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 3800);
  }

  function normWA(v) {
    let s = String(v || '').replace(/\D/g, '');
    if (s.indexOf('62') === 0) s = '0' + s.slice(2);
    else if (s.indexOf('8') === 0) s = '0' + s;
    return /^08\d{8,12}$/.test(s) ? s : '';
  }

  function linkWA(teks) {
    return 'https://wa.me/' + CONFIG.WA_NOMOR + (teks ? '?text=' + encodeURIComponent(teks) : '');
  }

  // ---------- Lapisan data: cache lokal + SWR ----------
  function cacheBaca(kunci) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + kunci);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function cacheTulis(kunci, data) {
    try { localStorage.setItem(CACHE_PREFIX + kunci, JSON.stringify({ t: Date.now(), data: data })); }
    catch (e) { /* kuota penuh: lanjut tanpa cache */ }
  }

  async function apiGet(params) {
    const q = new URLSearchParams(params).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 25000);
    try {
      const res = await fetch(CONFIG.GAS_URL + '?' + q, { cache: 'no-store', signal: ctrl.signal });
      const json = await res.json();
      return json;
    } catch (err) {
      return { success: false, data: null, message: err.name === 'AbortError' ? 'Server terlalu lama merespons.' : 'Koneksi bermasalah.' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stale-while-revalidate: tampilkan cache seketika bila ada,
   * lalu segarkan di latar bila cache sudah lebih dari TTL.
   */
  async function swr(kunci, params, render) {
    const c = cacheBaca(kunci);
    if (c) render(c.data, true);
    if (c && Date.now() - c.t < TTL_MS) return;
    const res = await apiGet(params);
    if (res.success) {
      const sama = c && JSON.stringify(c.data) === JSON.stringify(res.data);
      cacheTulis(kunci, res.data);
      if (!sama) render(res.data, false);
    } else if (!c) {
      render(null, false, res.message);
    }
  }

  // ---------- Katalog ----------
  const state = { produk: [], kategori: 'Semua', cari: '' };

  function renderKatalog(data, dariCache, galat) {
    const wadah = document.getElementById('katalog');
    if (data === null) {
      wadah.innerHTML = '<div class="card"><h3>Katalog belum dapat dimuat</h3><p class="muted">' + esc(galat || '') +
        '</p><button class="btn btn-brand btn-sm" id="ulangKatalog">Coba lagi</button></div>';
      document.getElementById('ulangKatalog').onclick = muatKatalog;
      return;
    }
    state.produk = data || [];
    terapkanFilter();
  }

  function terapkanFilter() {
    const q = state.cari.trim().toLowerCase();
    const hasil = state.produk.filter(function (p) {
      const katOk = state.kategori === 'Semua' || p.kategori === state.kategori;
      const cariOk = !q || (p.nama + ' ' + p.deskripsi).toLowerCase().indexOf(q) > -1;
      return katOk && cariOk;
    });
    const wadah = document.getElementById('katalog');
    document.getElementById('katalogKosong').hidden = hasil.length > 0;
    wadah.innerHTML = hasil.map(kartuProduk).join('');
  }

  /** Berkas Drive: pilih ukuran lebar lewat parameter =wN agar tajam di layar Retina. */
  function urlFoto(u, lebar) {
    return /^https:\/\/lh3\.googleusercontent\.com\/d\//.test(u) ? u.replace(/=w\d+$/, '') + '=w' + lebar : u;
  }

  /** Foto produk. Bila gagal dimuat, gambar dilepas dan inisial tetap tampil. */
  function fotoProduk(p) {
    const drive = /^https:\/\/lh3\.googleusercontent\.com\/d\//.test(p.gambar);
    const srcset = drive
      ? ' srcset="' + esc(urlFoto(p.gambar, 480) + ' 480w, ' + urlFoto(p.gambar, 800) + ' 800w, ' + urlFoto(p.gambar, 1200) + ' 1200w') + '"' +
        ' sizes="(max-width: 767px) 46vw, 300px"'
      : '';
    return '<span class="media-ph" aria-hidden="true">' + esc(p.nama.charAt(0)) + '</span>' +
      '<img src="' + esc(urlFoto(p.gambar, 800)) + '"' + srcset + ' alt="' + esc(p.nama) +
      '" loading="lazy" decoding="async" onerror="this.remove()">';
  }

  function kartuProduk(p) {
    const warna = KATEGORI_WARNA[p.kategori] || '';
    const label = p.kategori === 'Cetak' ? 'Percetakan' : p.kategori;
    const media = p.gambar
      ? fotoProduk(p)
      : '<span class="media-ph" aria-hidden="true">' + esc(p.nama.charAt(0)) + '</span>';
    return '<article class="card">' +
      '<div class="media ' + warna + (p.gambar ? ' berfoto' : '') + '">' + media + '<span class="tag">' + esc(label) + '</span></div>' +
      '<h3>' + esc(p.nama) + '</h3>' +
      '<p class="desc">' + esc(p.deskripsi) + '</p>' +
      '<div class="card-foot"><span class="muted">Harga: ' + esc(p.harga || 'Konsultasi') + '</span>' +
      '<button type="button" data-tanya="' + esc(p.nama) + '">Tanya harga →</button></div>' +
      '</article>';
  }

  async function muatKatalog() {
    await swr('katalog', { action: 'katalog' }, renderKatalog);
  }

  // Event filter & pencarian
  function pasangFilter() {
    document.getElementById('filters').addEventListener('click', function (e) {
      const b = e.target.closest('[data-kat]');
      if (!b) return;
      state.kategori = b.dataset.kat;
      document.querySelectorAll('#filters .pill-btn').forEach(function (x) {
        const aktif = x === b;
        x.classList.toggle('active', aktif);
        x.setAttribute('aria-selected', aktif ? 'true' : 'false');
      });
      terapkanFilter();
    });

    let t;
    document.getElementById('cari').addEventListener('input', function (e) {
      clearTimeout(t);
      t = setTimeout(function () { state.cari = e.target.value; terapkanFilter(); }, 250);
    });

    document.getElementById('katalog').addEventListener('click', function (e) {
      const b = e.target.closest('[data-tanya]');
      if (!b) return;
      const nama = b.dataset.tanya;
      window.open(linkWA('Halo, saya ingin bertanya harga untuk produk: ' + nama), '_blank', 'noopener');
    });
  }

  // ---------- Galeri (marquee kanan ke kiri) ----------
  function renderGaleri(data, dariCache, galat) {
    const track = document.getElementById('track');
    if (!data || !data.length) {
      track.innerHTML = '<p class="muted" style="padding:20px">' + esc(galat || 'Galeri belum tersedia.') + '</p>';
      return;
    }
    const satuSet = data.map(function (g) {
      return '<figure class="shot"><div class="media">' +
        (g.gambar ? '<img src="' + esc(g.gambar) + '" alt="' + esc(g.judul) + '" loading="lazy">' : '<span class="media-ph" aria-hidden="true">' + esc(g.judul.charAt(0)) + '</span>') +
        '</div><div class="body"><h3>' + esc(g.judul) + '</h3><p>' + esc(g.deskripsi) + '</p></div></figure>';
    }).join('');
    // Dua salinan agar animasi -50% berulang mulus.
    track.innerHTML = satuSet + satuSet;
  }

  function pasangGaleri() {
    const m = document.getElementById('marquee');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) m.classList.add('touch');

    m.addEventListener('touchstart', function () { m.classList.add('paused'); }, { passive: true });
    m.addEventListener('touchend', function () { m.classList.remove('paused'); }, { passive: true });
  }

  async function muatGaleri() {
    await swr('galeri', { action: 'galeri' }, renderGaleri);
  }

  // ---------- Perusahaan (legalitas & kontak) ----------
  function renderPerusahaan(d, dariCache, galat) {
    if (!d) return;
    const grid = document.getElementById('legalGrid');
    const kartu = [
      ['Nama Perusahaan', d.NamaPerusahaan, 'Entitas perseroan terbatas berizin resmi'],
      ['Direktur', d.Direktur, 'Penanggung jawab operasional dan legalitas'],
      ['Nomor Induk Berusaha (NIB)', d.NIB, 'Terdaftar melalui sistem OSS Republik Indonesia'],
      ['SK Kemenkumham', d.SKKemenkumham, 'Pengesahan pendirian badan hukum']
    ];
    grid.innerHTML = kartu.map(function (k) {
      return '<div class="legal-card"><div class="kicker">' + esc(k[0]) + '</div>' +
        '<div class="val">' + esc(k[1] || '-') + '</div>' +
        '<p class="muted small">' + esc(k[2]) + '</p>' +
        '<span class="ok">✓ Terverifikasi</span></div>';
    }).join('');

    const nama = d.NamaPerusahaan || CONFIG.NAMA_PERUSAHAAN;
    document.getElementById('brandNama').textContent = nama;
    if (d.Alamat) {
      document.getElementById('infoAlamat').textContent = d.Alamat;
      document.getElementById('footAlamat').textContent = d.Alamat;
    }
    if (d.WhatsApp) {
      document.getElementById('infoWA').textContent = d.WhatsApp;
      document.getElementById('footWA').textContent = d.WhatsApp;
    }
    if (d.Email) {
      document.getElementById('infoEmail').textContent = d.Email;
      document.getElementById('footEmail').textContent = d.Email;
    }
    if (d.JamKerja) {
      document.getElementById('infoJam').textContent = d.JamKerja;
      document.getElementById('footJam').textContent = d.JamKerja;
    }
  }

  function renderLegalGagal(data, dariCache, galat) {
    if (data) return renderPerusahaan(data, dariCache, galat);
    document.getElementById('legalGrid').innerHTML =
      '<p class="muted">Informasi legalitas belum dapat dimuat. <button class="btn btn-ghost btn-sm" id="ulangLegal">Coba lagi</button></p>';
    document.getElementById('ulangLegal').onclick = muatPerusahaan;
  }

  async function muatPerusahaan() {
    await swr('perusahaan', { action: 'perusahaan' }, renderLegalGagal);
  }

  // ---------- Formulir penawaran ----------
  let berkasTerpilih = null;

  function tampilkanErrorForm(pesan) {
    const el = document.getElementById('formError');
    el.textContent = pesan;
    el.hidden = false;
  }

  function sembunyikanErrorForm() {
    document.getElementById('formError').hidden = true;
    document.querySelectorAll('#formPenawaran .invalid').forEach(function (x) { x.classList.remove('invalid'); });
  }

  function validasiFormLokal(f) {
    const nama = f.nama.value.trim();
    const layanan = f.layanan.value;
    const wa = normWA(f.whatsapp.value);
    const email = f.email.value.trim();
    if (!nama) return { field: f.nama, pesan: 'Nama wajib diisi.' };
    if (!layanan) return { field: f.layanan, pesan: 'Pilih jenis layanan.' };
    if (!wa) return { field: f.whatsapp, pesan: 'Nomor WhatsApp tidak valid. Contoh: 08xxxxxxxxxx.' };
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { field: f.email, pesan: 'Format email tidak valid.' };
    return null;
  }

  function pilihBerkas(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const izin = ['pdf', 'docx', 'cdr', 'ai', 'psd', 'eps', 'jpg', 'jpeg', 'png'];
    if (izin.indexOf(ext) < 0) { toast('Format berkas tidak diizinkan.', 'error'); return false; }
    if (file.size > CONFIG.MAKS_BERKAS_BYTE) { toast('Ukuran berkas melebihi 10 MB.', 'error'); return false; }
    berkasTerpilih = file;
    document.getElementById('namaBerkas').textContent = file.name + ' (' + (file.size / 1048576).toFixed(2) + ' MB)';
    return true;
  }

  function bacaBase64(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(new Error('Berkas tidak dapat dibaca.')); };
      r.readAsDataURL(file);
    });
  }

  async function kirimForm(e) {
    e.preventDefault();
    sembunyikanErrorForm();
    const f = e.target;
    const galat = validasiFormLokal(f);
    if (galat) {
      galat.field.classList.add('invalid');
      galat.field.focus();
      tampilkanErrorForm(galat.pesan);
      return;
    }

    const btn = document.getElementById('btnKirim');
    const teksAsli = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Mengirim…';

    try {
      const data = {
        nama: f.nama.value.trim(),
        whatsapp: f.whatsapp.value.trim(),
        email: f.email.value.trim(),
        layanan: f.layanan.value,
        jumlah: f.jumlah.value.trim(),
        spesifikasi: f.spesifikasi.value.trim(),
        catatan: f.catatan.value.trim(),
        website: f.website.value              // honeypot, harus kosong
      };
      if (berkasTerpilih) {
        data.berkas = {
          nama: berkasTerpilih.name,
          mime: berkasTerpilih.type || 'application/octet-stream',
          base64: await bacaBase64(berkasTerpilih)
        };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 90000);
      let json;
      try {
        // text/plain: menghindari CORS preflight di GAS
        const res = await fetch(CONFIG.GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'kirimPermintaan', data: data }),
          signal: ctrl.signal
        });
        json = await res.json();
      } finally { clearTimeout(timer); }

      if (!json.success) {
        tampilkanErrorForm(json.message || 'Permintaan gagal dikirim.');
        return;
      }
      tampilkanSukses(json.data);
      f.reset();
      berkasTerpilih = null;
      document.getElementById('namaBerkas').textContent = '';
    } catch (err) {
      tampilkanErrorForm(err.name === 'AbortError'
        ? 'Pengiriman terlalu lama. Periksa koneksi lalu coba lagi.'
        : 'Gagal mengirim. Periksa koneksi lalu coba lagi.');
    } finally {
      btn.disabled = false;
      btn.textContent = teksAsli;
    }
  }

  function tampilkanSukses(d) {
    document.getElementById('formPenawaran').hidden = true;
    const s = document.getElementById('sukses');
    document.getElementById('nomorTiket').textContent = d.nomor;
    document.getElementById('linkWASukses').href = d.waLink || linkWA();
    s.hidden = false;
    s.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function pasangFormulir() {
    const f = document.getElementById('formPenawaran');
    f.addEventListener('submit', kirimForm);

    const input = document.getElementById('berkas');
    const dz = document.getElementById('dropzone');
    input.addEventListener('change', function () {
      if (input.files[0] && !pilihBerkas(input.files[0])) input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      const file = e.dataTransfer.files[0];
      if (file && pilihBerkas(file)) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      }
    });

    document.getElementById('btnSalin').addEventListener('click', async function () {
      const nomor = document.getElementById('nomorTiket').textContent;
      try {
        await navigator.clipboard.writeText(nomor);
        toast('Nomor permintaan disalin.');
      } catch (e) {
        toast('Salin manual: ' + nomor);
      }
    });

    document.getElementById('btnBaru').addEventListener('click', function () {
      document.getElementById('sukses').hidden = true;
      f.hidden = false;
      document.getElementById('kontak').scrollIntoView({ behavior: 'smooth' });
    });

    document.getElementById('linkWA').addEventListener('click', function (e) {
      e.preventDefault();
      window.open(linkWA('Halo, saya ingin konsultasi cetak.'), '_blank', 'noopener');
    });
  }

  // ---------- Navigasi & tombol melayang ----------
  function pasangNavigasi() {
    const btn = document.getElementById('menuBtn');
    const menu = document.getElementById('menu');
    btn.addEventListener('click', function () {
      const buka = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', buka ? 'true' : 'false');
    });
    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    document.getElementById('waFloat').href = linkWA('Halo, saya ingin bertanya tentang layanan PT Nirbana Collection Persada.');
  }

  // ---------- Inisialisasi ----------
  document.addEventListener('DOMContentLoaded', function () {
    pasangNavigasi();
    pasangFilter();
    pasangGaleri();
    pasangFormulir();
    // Data dimuat paralel; setiap bagian tampil begitu siap.
    muatKatalog();
    muatGaleri();
    muatPerusahaan();
  });
})();
