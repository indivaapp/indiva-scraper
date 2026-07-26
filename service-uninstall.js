// "IndivaScraperService" Windows Servisini kaldırır (geri alma / güncelleme
// öncesi temiz kurulum için). Yönetici yetkisi gerektirir.
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'IndivaScraperService',
  script: path.join(__dirname, 'listener.js'),
});

svc.on('uninstall', () => {
  console.log('[Kaldırma] Servis kaldırıldı:', svc.name);
  console.log('[Kaldırma] Var olmadığı: ' + !svc.exists);
});

svc.on('error', (err) => {
  console.error('[Kaldırma] Hata:', err);
});

console.log('[Kaldırma] "IndivaScraperService" Windows Servisi kaldırılıyor...');
svc.uninstall();
