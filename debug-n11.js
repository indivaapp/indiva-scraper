/**
 * debug-n11.js — N11 kart yapısını teşhis eder (geçici geliştirme aracı)
 *
 * N11 Cloudflare arkasında olduğu için geliştirme ortamından canlı DOM
 * görülemiyor; bu script gerçek Chrome ile sayfayı açıp ilk ürün kartlarının
 * HTML'ini ve mevcut seçicilerin ne döndürdüğünü yazdırır — böylece
 * scrape.js'teki extractN11 seçicileri gerçek yapıya göre düzeltilebilir.
 *
 * Çalıştırma: node debug-n11.js
 * (Firebase'e HİÇBİR ŞEY yazmaz, sadece okur ve ekrana basar.)
 */

const { chromium } = require('playwright');

const URL = 'https://www.n11.com/arama?in-deal=true&srt=SALES_VOLUME&promotions=2076410&pg=1';

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-position=-32000,-32000', '--window-size=1280,900'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'tr-TR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  console.log('Sayfa açılıyor...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  try { await page.click('#onetrust-accept-btn-handler', { timeout: 3000 }); } catch {}

  // scrape.js'teki scrollPage ile aynı
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await page.waitForTimeout(400);
  }

  const rapor = await page.evaluate(() => {
    const out = { sayaclar: {}, ornekKartHtml: '', mevcutSeciciSonuclari: [], fiyatAdaylari: [] };

    // Hangi kart seçicisi kaç eleman buluyor?
    const adaySeciciler = [
      'div.column.pro',
      'li.column',
      'div[class*="productCard"]',
      'div[class*="product-card"]',
      '[data-testid="product-card"]',
      'a[href*="/urun/"]',
      'li[class*="column"]',
      'div.pro',
      'ul.list-ul > li',
    ];
    adaySeciciler.forEach(s => {
      try { out.sayaclar[s] = document.querySelectorAll(s).length; } catch { out.sayaclar[s] = 'HATA'; }
    });

    // scrape.js'in şu an kullandığı zincir
    let kartlar = document.querySelectorAll(
      'div.column.pro, li.column, div[class*="productCard"], div[class*="product-card"], [data-testid="product-card"]'
    );
    if (!kartlar.length) kartlar = document.querySelectorAll('a[href*="/urun/"]');

    const ilk = kartlar[0];
    if (ilk) {
      // Kartın kendisi çok küçükse (ör. sadece <a>), üst kabı daha bilgilendirici
      const hedef = ilk.matches('a') ? (ilk.closest('li, div.column, div[class*="card"]') || ilk) : ilk;
      out.ornekKartHtml = hedef.outerHTML.slice(0, 4000);

      // Bu kartın içindeki TÜM metin taşıyan elemanları class'larıyla dök —
      // fiyatın hangi elemanda olduğunu buradan görebiliriz.
      Array.from(hedef.querySelectorAll('*')).forEach(el => {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 40) return;
        if (el.children.length > 0) return; // sadece yaprak düğümler
        out.fiyatAdaylari.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
          text: t,
        });
      });
    }

    // Mevcut extractN11 mantığının ilk 3 kart için ne döndürdüğü
    Array.from(kartlar).slice(0, 3).forEach(kart => {
      const a = kart.matches('a') ? kart : kart.querySelector('a[href*="/urun/"], a[href]');
      out.mevcutSeciciSonuclari.push({
        isim: (kart.querySelector('.productName, [class*="product-name"], [data-testid="product-name"], h3')?.textContent || a?.getAttribute('title') || '').trim().slice(0, 60),
        marka: kart.querySelector('.brand, [class*="brand"]')?.textContent?.trim() || '(BOŞ)',
        yeniF: kart.querySelector('.newPrice, [class*="newPrice"], [class*="price-new"], [data-testid="price-value"], ins')?.textContent?.trim() || '(BOŞ)',
        eskiF: kart.querySelector('.oldPrice, [class*="oldPrice"], [class*="price-old"], del')?.textContent?.trim() || '(BOŞ)',
        gorsel: (kart.querySelector('img')?.getAttribute('data-original') || kart.querySelector('img')?.getAttribute('data-src') || kart.querySelector('img')?.src || '(BOŞ)').slice(0, 80),
        link: (a?.getAttribute('href') || '(BOŞ)').slice(0, 80),
      });
    });

    return out;
  });

  console.log('\n===== KART SEÇİCİ SAYIMLARI =====');
  console.log(JSON.stringify(rapor.sayaclar, null, 2));

  console.log('\n===== MEVCUT extractN11 SONUÇLARI (ilk 3) =====');
  console.log(JSON.stringify(rapor.mevcutSeciciSonuclari, null, 2));

  console.log('\n===== KART İÇİ YAPRAK ELEMANLAR (tag | class | metin) =====');
  rapor.fiyatAdaylari.forEach(x => console.log(`${x.tag} | ${x.cls} | ${x.text}`));

  console.log('\n===== ÖRNEK KART HTML (ilk 4000 karakter) =====');
  console.log(rapor.ornekKartHtml);

  await browser.close();
})();
