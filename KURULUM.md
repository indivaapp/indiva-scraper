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
3. **`KUR.cmd`** dosyasına çift tıkla.
   - Bağımlılıkları kurar (`npm install`)
   - PC açılışında otomatik başlamayı ayarlar
   - Dinleyiciyi hemen başlatır
4. Bitti. Telefondan panelde "🛒 Şimdi Veri Çek" → bu PC tarar.

## Önemli notlar
- Hedef PC **açık ve oturum açık** olmalı (headless olmayan Chrome masaüstü oturumu gerektirir).
- Tek bir PC dinleyici çalıştırmalı. Birden fazla PC çalıştırırsa aynı tetikte iki kez tarar.
  Bu PC'yi devreye alınca, eski PC'deki otomatik başlatmayı kapat:
  Başlangıç klasöründen `indiva-scraper-runner.vbs` dosyasını sil
  (`shell:startup` çalıştır → dosyayı sil).
- `service-account.json` gizli bir anahtardır; kimseyle paylaşma, repoya ekleme (gitignore'da).
