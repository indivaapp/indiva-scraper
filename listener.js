// İNDİVA Scraper dinleyicisi — PC açılışında sessizce başlar.
// 1) Telefon panelinden gelen tetikleri (Firestore: scraper_control/trigger) dinler → anında tarar.
// 2) Her 4 saatte bir otomatik tarar (cron).

const cron = require('node-cron');
const { runScrape, processPublishQueue, processAutoPublishQueue, CONTROL, setStatus, loadSources } = require('./scrape');
const { runOnual } = require('./onual');

console.log('='.repeat(50));
console.log('İNDİVA Scraper Dinleyicisi başladı.');
console.log(new Date().toLocaleString('tr-TR'));
console.log('='.repeat(50));

// ── Telefon tetiği ──────────────────────────────────────────────────────────────
// Panel "Veri Çek"e basınca scraper_control/trigger.requestedAt güncellenir.
// İlk snapshot'taki mevcut değeri yok sayıp sonraki değişiklikleri dinleriz.
let lastHandled = null;
let initialized = false;

CONTROL.doc('trigger').onSnapshot(async (snap) => {
  const data = snap.data() || {};
  const req = data.requestedAt?.toMillis?.() ?? data.requestedAt ?? null;

  // Panel hangi siteyi seçtiyse (trendyol/cimri); yoksa null = tümü
  const site = data.site || null;

  if (!initialized) {
    initialized = true;
    lastHandled = req;
    console.log('[Dinleyici] Tetik dinleniyor...');
    // Başlangıç-yakalama: dinleyici kapalıyken/yeniden başlarken gelen tetiği kaçırma.
    // Tetik son taramadan YENİ ve son 15 dakika içindeyse hemen çalıştır.
    try {
      const stat = (await CONTROL.doc('status').get()).data() || {};
      const lastRun = stat.lastRunTime?.toMillis?.() ?? 0;
      const taze = req && (Date.now() - req) < 15 * 60 * 1000;
      if (req && taze && req > lastRun) {
        console.log(`[Başlangıç] İşlenmemiş taze tetik bulundu (${site || 'tümü'}) — tarama başlıyor...`);
        try { await runScrape('panel', site); } catch {}
      }
    } catch {}
    return;
  }
  if (req && req !== lastHandled) {
    lastHandled = req;
    console.log(`[Tetik] Telefondan istek geldi (${site || 'tümü'}, ${new Date().toLocaleTimeString('tr-TR')}). Tarama başlıyor...`);
    try { await runScrape('panel', site); } catch {}
  }
}, (err) => {
  console.error('[Dinleyici hatası]', err.message);
});

// ── Çöz & Yayınla kuyruğu ─────────────────────────────────────────────────────
// Panel scraper_control/publish_request'e yazar (ids + interval).
// Yeni istek geldiğinde anında işle; aralıklı yayın için her 20 sn'de bir kontrol et.
CONTROL.doc('publish_request').onSnapshot(async (snap) => {
  const data = snap.data() || {};
  if (data.status === 'processing') {
    try { await processPublishQueue(); } catch (e) { console.error('[Yayın hata]', e.message); }
  }
}, (err) => console.error('[Yayın dinleyici hatası]', err.message));

// Aralıklı yayın zamanlayıcıları (+ PC yeniden başlasa kuyrukları sürdürür).
// NOT: onSnapshot zaten YENİ istekleri anında yakalıyor — bu zamanlayıcılar
// sadece "aralıklı yayın" özelliklerinin süresi dolduğunda bir sonraki ürünü
// tetiklemek için var.
// - processPublishQueue (manuel "Çöz & Yayınla"): 60 sn'de bir kontrol yeterli
//   — nadiren kullanılan, admin tetikli bir özellik.
// - processAutoPublishQueue (otomatik yayın kuyruğu): 2 sn'de bir tetiklenir
//   ama artık her tetiklemede Firestore'a GİTMİYOR — scrape.js içindeki
//   _autoQueueNextAtCache sayesinde çoğu tık tamamen yerel/ücretsiz, sadece
//   sırası gerçekten geldiğinde 1 okuma yapılıyor. Sık tetiklemek bu yüzden
//   ek maliyet getirmiyor, tam tersine kuyruğun kısa aralıklarını (5-30 sn)
//   daha isabetli zamanlıyor (eskiden 60 sn'lik kaba kontrol, panelde
//   gösterilen sayaçtan daha yavaş yayın yapılmasına yol açıyordu).
setInterval(() => { processPublishQueue().catch(() => {}); }, 60000);
setInterval(() => { processAutoPublishQueue().catch(() => {}); }, 2000);

// ── Otomatik zamanlama: Trendyol ve N11 artık AYRI saatlerde ─────────────────
// Önceden ikisi de aynı saat başı taramasında birlikte taranıyordu (site=null
// → scrapeAllSources tüm kaynakları tek Chrome oturumunda geziyordu). Kullanıcı
// isteği: sonuçları site bazlı ayrı ayrı görebilmek (panelde bildirim/geçmiş
// kayıtları da artık site başına ayrı doküman olduğu için bu tarama düzeyinde
// de ayrılmazsa iki sitenin istatistikleri tek kayıtta karışırdı).
//   Trendyol: her saat BAŞI  (12:00, 13:00, 14:00, ...)
//   N11:      her saat BUÇUĞU (12:30, 13:30, 14:30, ...)
cron.schedule('0 * * * *', async () => {
  console.log('[Cron] Trendyol otomatik taraması başlıyor...');
  try { await runScrape('cron', 'trendyol'); } catch {}
});
cron.schedule('30 * * * *', async () => {
  console.log('[Cron] N11 otomatik taraması başlıyor...');
  try { await runScrape('cron', 'n11'); } catch {}
});

// ── OnuAl: TAMAMEN DURDURULDU (2026-07-13) ───────────────────────────────────
// Kullanıcı kararı: onual.com'dan yeterli/doğru veri çekilemiyor, indirimradar
// zaten ihtiyacı karşılıyor (bkz. GitHub Actions auto-onual.yml — aynı gerekçeyle
// orada da tamamen durduruldu). Bu PC'deki onual.js bağımsız bir kod yolu olduğu
// için GitHub Actions tarafını durdurmak bunu durdurmuyordu — saatte bir sessizce
// çalışmaya devam ediyordu. İleride tekrar gerekirse (başka bir dakikada,
// N11'in :30 taramasıyla çakışmasın diye) aşağıdaki satırı geri açın:
// cron.schedule('45 * * * *', async () => {
//   console.log('[Cron] OnuAl taraması başlıyor...');
//   try { await runOnual(); } catch (e) { console.error('[Cron] OnuAl hatası:', e.message); }
// });

// ── Başlangıçta durum bildir + config güncelle ──────────────────────────────
setStatus({ listenerOnline: true, listenerStartedAt: Date.now() }).catch(() => {});
// Firestore config dokümanını her başlangıçta güncelle (sites listesi dahil)
loadSources().then(() => console.log('[Config] Firestore config güncellendi.')).catch(() => {});

// Süreç ayakta kalsın
process.stdin.resume();
