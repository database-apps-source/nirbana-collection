// ============================================================
// KONFIGURASI FRONTEND
// Ganti GAS_URL dengan URL Web App (/exec) dari Apps Script
// setelah Deploy → New deployment → Web app (Execute as: Me, Anyone).
// ============================================================
const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwY1uRTkuAjzT8uX7AwE4Gx0_OtiRnEHVgHE1QloolcKYQqNvVwcOjpSlyIa_feeDyx6w/exec',
  NAMA_PERUSAHAAN: 'PT Nirbana Collection Persada',
  // Fallback bila API belum bisa dihubungi. Isi info publik saja.
  WA_NOMOR: '6285223119983',
  MAKS_BERKAS_BYTE: 10 * 1024 * 1024
};
