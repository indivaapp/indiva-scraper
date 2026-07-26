# İNDİVA Trendyol Scraper — Başka Bilgisayara Kurulum

Bu klasör, telefondan tetiklenen Trendyol veri çekme dinleyicisidir. Sürekli açık bir
bilgisayara (örn. iş yeri PC'si) kurulur. Telefon "Veri Çek" deyince Firebase üzerinden
bu PC tarar. Aynı ağda olmak gerekmez.

## Gereksinimler (hedef PC'de)
1. **Node.js** (LTS) — https://nodejs.org
2. **Google Chrome** — https://www.google.com/chrome
3. **service-account.json** — Firebase servis hesabı anahtarı (bu klasöre konacak)

## Adımlar
1. Bu klasörü hedef PC'ye kopyala (GitHub'dan ZIP indir veya `git clone`).
2. Firebase anahtar dosyasını bu klasöre **`service-account.json`** adıyla koy.
3. **`KUR.cmd`** dosyasına **sağ tık → "Yönetici olarak çalıştır"**.
   - Bağımlılıkları kurar (`npm install`)
   - `IndivaScraperService` adlı bir **Windows Servisi** kurar ve başlatır
     (Session 0'da çalışır — Chrome ekranda **hiçbir zaman görünmez**)
4. Bitti. Telefondan panelde "🛒 Şimdi Veri Çek" → bu PC tarar (görünmeden).

## Önemli notlar
- Hedef PC **açık** olmalı — Windows **oturumunun açık olması artık gerekmiyor**
  (servis Session 0'da, oturumdan bağımsız çalışır).
- Kurulum yönetici (Administrator) yetkisi gerektirir.
- Tek bir PC dinleyici çalıştırmalı. Birden fazla PC çalıştırırsa aynı tetikte iki kez tarar.
  Bu PC'yi devreye alınca, eski PC'deki otomatik başlatmayı kapat: yönetici terminalde
  `node service-uninstall.js` çalıştır (eski Görev Zamanlayıcı kurulumu varsa
  `services.msc`/`taskschd.msc`'den elle kaldır).
- `service-account.json` gizli bir anahtardır; kimseyle paylaşma, repoya ekleme (gitignore'da).
- Servis durumu: `services.msc` → `IndivaScraperService`. Loglar: `daemon\` klasörü.
