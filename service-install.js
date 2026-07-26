// İNDİVA Scraper dinleyicisini gerçek bir Windows Servisi olarak kurar.
//
// NEDEN SERVİS (Görev Zamanlayıcı yerine): Görev Zamanlayıcı ile başlatılan
// süreç, kullanıcının OTURUM AÇMIŞ interaktif masaüstünde (Session 1+) çalışır
// — Chrome'u ne kadar minimize edip görev çubuğundan gizlersek gizleyelim,
// yine de o masaüstünde GERÇEKTEN VAR olan bir pencere. Windows Servisleri
// ise Vista'dan beri ayrı, ekranı/klavyesi/faresi OLMAYAN "Session 0"da
// çalışır (bkz. Microsoft: "Session 0 Isolation"). Chrome orada normal
// şekilde (headless:false) başlatılabilir — pencere oluşturma çağrıları
// başarılı olur ama gösterilecek hiçbir ekran yoktur, yani kullanıcı
// ASLA hiçbir şey görmez. Bu, tüm minimize/taskbar-gizleme hack'lerinin
// çözmeye çalıştığı sorunu kökten ortadan kaldırır.
//
// Kurulum yönetici (Administrator) yetkisi gerektirir — node-windows kendi
// UAC yükseltme adımını otomatik tetikler.
const path = require('path');
const { Service } = require('node-windows');
const { execFile } = require('child_process');

const svc = new Service({
  name: 'IndivaScraperService',
  description: 'İNDİVA Trendyol/N11 scraper dinleyicisi — Firestore tetik + cron. Session 0\'da çalışır, Chrome asla görünmez.',
  script: path.join(__dirname, 'listener.js'),
  // listener.js çökerse node-windows kendi restart mantığını uygular
  // (aşağıdaki wait/grow/maxRestarts ile üstel geri çekilme).
  wait: 2,
  grow: 0.5,
  maxRestarts: 999,
  abortOnError: false,
});

function removeOldScheduledTask() {
  // Eski Görev Zamanlayıcı tabanlı otomatik başlatmayı (install-autostart.ps1
  // ile kurulmuş "IndivaScraperListener" görevi) kaldır — aksi halde hem
  // servis hem de eski görev aynı anda listener.js çalıştırıp aynı tetikte
  // ÇİFT tarama yapabilir.
  execFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Unregister-ScheduledTask -TaskName 'IndivaScraperListener' -Confirm:$false -ErrorAction SilentlyContinue",
  ], (err) => {
    if (err) console.warn('[Kurulum] Eski Görev Zamanlayıcı görevi kaldırılamadı (önemsiz):', err.message);
    else console.log('[Kurulum] Eski Görev Zamanlayıcı görevi (varsa) kaldırıldı.');
  });
}

svc.on('install', () => {
  console.log('[Kurulum] Servis kuruldu:', svc.name);
  removeOldScheduledTask();
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('[Kurulum] Servis zaten kurulu. Yeniden başlatılıyor...');
  removeOldScheduledTask();
  svc.restart();
});

svc.on('start', () => {
  console.log('[Kurulum] Servis başlatıldı. Artık PC açıksa (oturum açık olması bile GEREKMEZ), Session 0\'da sessizce çalışır.');
  console.log('[Kurulum] Durumu görmek için: Get-Service IndivaScraperService  veya  services.msc');
  console.log('[Kurulum] Loglar: ' + path.join(__dirname, 'daemon'));
});

svc.on('error', (err) => {
  console.error('[Kurulum] Servis hatası:', err);
});

console.log('[Kurulum] "IndivaScraperService" Windows Servisi kuruluyor (yönetici yetkisi gerekir)...');
svc.install();
