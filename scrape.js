// Trendyol scraper — PC'de listener.js tarafından (cron + telefon tetiği) çağrılır.
// CLI olarak da çalışır: `node scrape.js` tek seferlik bir tarama yapar.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { runQualityGate, normalizeLink, checkExistingLinks } = require('./qualityGate.js');
const { maybeNotifyHighScoreDeal } = require('./notifyGate.js');
const { maybeQueueSocialContent } = require('./socialContentGate.js');

// .env dosyasından ortam değişkenlerini yükle (GEMINI_API_KEY için) — kendi
// içinde yükler, onual.js'in yan etkisine bağımlı kalmaz.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const k = trimmed.substring(0, idx).trim();
    const v = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

// Bu çalışan örneğin kimliği (hangi bilgisayar/süreç) — kilit sahipliği için.
const INSTANCE_ID = `${os.hostname()}#${process.pid}`;

// ── Firebase ───────────────────────────────────────────────────────────────────
// Servis hesabı sırasıyla: (1) klasördeki service-account.json [taşınabilir kurulum],
// (2) FIREBASE_SERVICE_ACCOUNT ortam değişkeni, (3) eski sabit yol [bu PC için].
function loadServiceAccount() {
  const localFile = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(localFile)) {
    return JSON.parse(fs.readFileSync(localFile, 'utf8').replace(/^﻿/, ''));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.replace(/^﻿/, ''));
  }
  const legacy = 'D:\\INDIVA PANEL APP\\firebase-service-account.json';
  if (fs.existsSync(legacy)) {
    return JSON.parse(fs.readFileSync(legacy, 'utf8').replace(/^﻿/, ''));
  }
  throw new Error('Firebase service account bulunamadı. service-account.json dosyasını scraper klasörüne koyun.');
}
function initFirebase() {
  if (getApps().length) return getFirestore();
  initializeApp({ credential: cert(loadServiceAccount()) });
  return getFirestore();
}
const db = initFirebase();
const CONTROL = db.collection('scraper_control');
const RUN_HISTORY = db.collection('scraper_run_history');

// ── Yayınlanan ürün linkleri: kalıcı yerel önbellek ──────────────────────────
// ESKİ DAVRANIŞ (BÜYÜK OKUMA MALİYETİ): uploadToFirestore() her taramada
// (saatte 1 otomatik + her manuel tetiklemede) 'discounts' koleksiyonundaki
// TÜM trendyol-scraper ürünlerini sınırsız bir sorguyla okuyordu — toplam
// yayınlanan ürün sayısı arttıkça bu sorgu her gün daha pahalı hale geliyordu
// (binlerce ürün birikince günde 100K+ okumaya çıkabiliyordu, canlı ölçümde
// gözlemlendi). Bu PC (GitHub Actions'ın aksine) SÜREKLİ/kalıcı çalıştığı
// için, diske yazılan bir dosya restart'lar arasında hayatta kalır — bu
// yüzden ağ sorgusu yerine kalıcı bir Set kullanıyoruz: normal operasyonda
// okuma maliyeti SIFIR. Dinleyici ilk kez başladığında (veya dosya
// silinmişse) TEK SEFERLİK bir tam tarama yapılıp önbellek doldurulur —
// bundan sonra sadece BU sürecin yeni yayınladığı ürünler eklenir.
const PUBLISHED_LINKS_CACHE_FILE = path.join(__dirname, 'data', 'published_trendyol_links.json');
let publishedLinksCache = null; // lazy-loaded Set<string>

function loadPublishedLinksCacheFromDisk() {
  try {
    const raw = fs.readFileSync(PUBLISHED_LINKS_CACHE_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return null; // dosya yok/bozuk — ilk kurulum veya seed gerekiyor
  }
}

function savePublishedLinksCacheToDisk() {
  try {
    fs.mkdirSync(path.dirname(PUBLISHED_LINKS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(PUBLISHED_LINKS_CACHE_FILE, JSON.stringify([...publishedLinksCache]));
  } catch (e) {
    console.warn('[Önbellek] Diske yazılamadı (önemsiz):', e.message);
  }
}

// Önbellek dosyası yoksa (ilk kurulum) TEK SEFERLİK tam tarama ile doldurur.
// Bu, eski pahalı sorgunun aynısı ama artık her taramada değil, sadece bir
// kez (ya da dosya silinip yeniden kurulursa) çalışıyor.
async function ensurePublishedLinksCache() {
  if (publishedLinksCache) return publishedLinksCache;
  const fromDisk = loadPublishedLinksCacheFromDisk();
  if (fromDisk) { publishedLinksCache = fromDisk; return publishedLinksCache; }

  console.log('[Önbellek] İlk kurulum: mevcut yayınlanan ürünler Firestore\'dan tek seferlik okunuyor...');
  publishedLinksCache = new Set();
  try {
    const snap = await db.collection('discounts').where('submittedBy', '==', 'trendyol-scraper').select('link').get();
    snap.docs.forEach(d => { const l = d.data().link; if (l) publishedLinksCache.add(l); });
    console.log(`[Önbellek] ${publishedLinksCache.size} ürün önbelleğe alındı.`);
  } catch (e) {
    console.warn('[Önbellek] İlk doldurma başarısız (önemsiz, boş başlanıyor):', e.message);
  }
  savePublishedLinksCacheToDisk();
  return publishedLinksCache;
}

function markLinkAsPublished(link) {
  if (!link || !publishedLinksCache) return;
  if (publishedLinksCache.has(link)) return;
  publishedLinksCache.add(link);
  savePublishedLinksCacheToDisk();
}

// Görünmezlik adımları (minimize/PID alma) "best effort" olmalı — CDP
// çağrılarından biri yanıt vermezse tüm taramayı SONSUZA kadar kilitlememeli.
// Her çağrıyı bu zaman sınırıyla sarmalıyoruz (varsayılan 5 sn).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} zaman aşımı (${ms}ms)`)), ms)),
  ]);
}

// ── Pencereyi tamamen görünmez yap ────────────────────────────────────────────
// headless:false ZORUNLU (Trendyol/Cloudflare headless'ı engelliyor), ama gerçek
// bir kullanıcı bunu hiç görmemeli / odağını kaybetmemeli. Chrome DevTools
// Protocol ile pencereyi gerçekten "minimize" durumuna alıyoruz — bu, sadece
// ekran dışına taşımaktan (eski yöntem) daha güvenilir: minimize edilmiş bir
// pencere görev çubuğunda görünür ama asla öne gelmez/odağı çalmaz/flaş yapmaz.
// --disable-backgrounding-occluded-windows vb. bayraklar sayesinde minimize
// olsa bile tarama YAVAŞLAMAZ (arka planda tam hızda çalışmaya devam eder).
// Tek monitörlü sistemlerde Windows, ekranın tamamen dışına konumlanan
// pencereleri "kaybolmasın" diye otomatik olarak ekrana geri çekiyor — bu da
// pencerenin CDP hedef kimliğinin (targetId) tam o anda geçersiz kalmasına ve
// "No target with given id found" hatasına yol açıyor (canlı testte
// gözlemlendi). Bu yüzden tek seferlik değil, kısa aralıklarla birkaç deneme
// yapıyoruz — pencere/hedef stabilize olduğunda minimize başarıyla uygulanır.
async function minimizeWindow(context, page) {
  // Deneme aralığı 400ms'den 120ms'ye düşürüldü, deneme sayısı 4'ten 8'e
  // çıkarıldı (toplam en kötü durum süresi benzer kalıyor ~960ms ama ilk
  // başarılı deneme çok daha erken yakalanıyor) — açılış anındaki görünürlük
  // süresini kısaltmak için (canlı testte "1 saniye açık kaldı" bildirildi).
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await withTimeout((async () => {
        const client = await context.newCDPSession(page);
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      })(), 3000, 'Minimize');
      return;
    } catch (e) {
      if (attempt === 8) {
        console.warn('[Pencere] Minimize edilemedi (önemsiz):', e.message);
        return;
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
}

// Chrome'un gerçek işletim sistemi PID'sini alır. NOT: Playwright'ın normal
// Browser nesnesinde .process() YOKTUR (sadece launchServer()'ın döndürdüğü
// BrowserServer'da var — bu kod yanlışlıkla o API'yi varsaymıştı ve
// "browser.process is not a function" hatasına yol açmıştı). Doğru yol: CDP
// üzerinden SystemInfo.getProcessInfo ile tüm Chrome süreçlerini listeleyip
// type==='browser' olanı (ana/pencere sahibi süreç) bulmak.
async function getBrowserPid(browser) {
  let session;
  try {
    return await withTimeout((async () => {
      session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const main = (processInfo || []).find(p => p.type === 'browser');
      return main?.id || null;
    })(), 5000, 'PID alma');
  } catch (e) {
    console.warn('[Pencere] PID alınamadı (önemsiz):', e.message);
    return null;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

// Pencereyi görev çubuğundan TAMAMEN gizler (Chrome'un kendi ayarlarıyla mümkün
// değil — Windows'un pencere API'sine (WS_EX_TOOLWINDOW) doğrudan erişen bir
// PowerShell/C# yardımcı script çağırıyoruz, bkz. hide-taskbar.ps1). CDP
// minimize'a EK bir katman — "best effort": başarısız olsa bile scraping
// durmaz, Chrome yine de minimize kalır.
// NOT: Bu, minimizeWindow() gibi TEK SEFERLİK değil, HER sayfa geçişinde
// tekrar çağrılmalı — Chrome'un pencere/sekme değişiklikleri WS_EX_TOOLWINDOW
// stilini sıfırlayabiliyor, bu da birkaç sayfa sonra simgenin görev
// çubuğunda tekrar belirmesine yol açıyordu (canlı şikayette bildirildi).
function hideFromTaskbar(pid) {
  if (!pid) return;
  const scriptPath = path.join(__dirname, 'hide-taskbar.ps1');
  if (!fs.existsSync(scriptPath)) return;
  try {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', scriptPath, '-ProcessId', String(pid),
    ], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', (e) => console.warn('[GörevÇubuğu] Gizleme başlatılamadı (önemsiz):', e.message));
  } catch (e) {
    console.warn('[GörevÇubuğu] Gizleme hatası (önemsiz):', e.message);
  }
}

// Chrome'u güvenli şekilde kapatır — browser.close() bazen (pencere gizli/
// minimize haldeyken Chrome'un CDP yanıtı askıda kalabildiği için) SONSUZA
// KADAR TAMAMLANMIYORDU. Canlı şikayet tam olarak buydu: "bazen kapanmıyor,
// ben Chrome'a tıklayınca kapanıyor" — kullanıcının tıklaması bir OS olayı
// (WM_ACTIVATE/paint) ilettiği için askıdaki CDP yanıtını serbest bırakıp
// kapanışı tetikliyordu. Artık close() bir zaman aşımıyla sarmalanıyor;
// takılırsa OS sürecini PID ile ZORLA sonlandırıyoruz — kullanıcı tıklamak
// zorunda kalmadan, garanti bir şekilde.
async function closeBrowserSafely(browser, pid, label) {
  try {
    await withTimeout(browser.close(), 8000, `${label} browser.close()`);
    return;
  } catch (e) {
    console.warn(`[Pencere] browser.close() takıldı/başarısız oldu (${label}): ${e.message} — PID ile zorla kapatılıyor.`);
  }
  if (pid) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (e2) {
      console.warn('[Pencere] taskkill başlatılamadı (önemsiz):', e2.message);
    }
  }
}

// ── Varsayılan kaynaklar ────────────────────────────────────────────────────────
const DEFAULT_SOURCES = [
  // ── Trendyol ──
  {
    id: 'kampanya',
    site: 'trendyol',
    label: 'Kampanya Ürünleri',
    description: 'Kırmızı/turuncu/sarı etiketli, %50+ indirimli ürünler',
    baseUrl: 'https://www.trendyol.com/sr?tag=kirmizi_kampanya_urunu%2Cturuncu_kampanya_urunu%2Csari_kampanya_urunu&lpd=10,14,30&sst=SCORE&dcr=50',
    pages: 3,
    enabled: true,
  },
  {
    id: 'coksatan',
    site: 'trendyol',
    label: 'En Çok Satanlar',
    description: 'Kampanya ürünleri arasında en çok satanlar',
    baseUrl: 'https://www.trendyol.com/sr?tag=kirmizi_kampanya_urunu%2Cturuncu_kampanya_urunu%2Csari_kampanya_urunu&lpd=10,14,30&sst=BEST_SELLER&dcr=50',
    pages: 2,
    enabled: true,
  },
  {
    id: 'enyeni',
    site: 'trendyol',
    label: 'En Yeniler',
    description: 'Yeni eklenen indirimli kampanya ürünleri',
    baseUrl: 'https://www.trendyol.com/sr?tag=kirmizi_kampanya_urunu%2Cturuncu_kampanya_urunu%2Csari_kampanya_urunu&lpd=10,14,30&sst=MOST_RECENT&dcr=50',
    pages: 2,
    enabled: true,
  },
  // ── Cimri ──
  // NOT (2026-07-16): Cimri kod seviyesinde devre dışı (bkz. CIMRI_DISABLED
  // aşağıda) — kaynak tanımı burada duruyor, ileride tekrar açılabilir.
  {
    id: 'cimri_indirim',
    site: 'cimri',
    label: 'İndirimli Ürünler',
    description: "Cimri'de fiyatı düşen (indirimli) ürünler",
    baseUrl: 'https://www.cimri.com/indirimli-urunler',
    pages: 3,
    enabled: true,
  },
  // ── N11 ──
  // Cimri'nin yerini alıyor — "İndirimde" filtresi + satış hacmine göre
  // sıralanmış arama sonuçları. `pg` (sayfa) parametresi pageUrl() ile her
  // sayfa için yeniden yazılıyor, baseUrl'deki pg=3 sadece kullanıcının
  // verdiği orijinal linkten kalma, göz ardı ediliyor.
  {
    id: 'n11_indirim',
    site: 'n11',
    label: 'İndirimdeki Ürünler',
    description: "N11'de indirimde olan, satış hacmine göre sıralı ürünler",
    baseUrl: 'https://www.n11.com/arama?in-deal=true&srt=SALES_VOLUME&promotions=2076410',
    pages: 3,
    enabled: true,
  },
];

// Site bazlı ayarlar (etiket, çerez butonu, sayfalama biçimi)
const SITE_META = {
  trendyol: { label: 'Trendyol', store: 'Trendyol' },
  cimri:    { label: 'Cimri',    store: 'Cimri' },
  n11:      { label: 'N11',      store: 'N11' },
};

// ── Yardımcılar ────────────────────────────────────────────────────────────────
function parseFiyat(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;
}
function tahminKategori(isim, marka) {
  const t = (isim + ' ' + marka).toLowerCase();
  if (/kahve|çay|gıda|yağ|tahin|tozu|kapsül|tablet|vitamin|biotin|magnezyum|demir/.test(t)) return 'Gıda & Sağlık';
  if (/krem|serum|sabun|cilt|göz altı|bb krem|güneş/.test(t)) return 'Kozmetik';
  if (/giyim|elbise|pantolon|korse|t-shirt|perde/.test(t)) return 'Giyim';
  if (/kedi|köpek|pet/.test(t)) return 'Pet';
  if (/oyuncak|çocuk|bebek/.test(t)) return 'Anne & Çocuk';
  return 'Genel';
}

// ── Config oku/yaz (Firestore) ───────────────────────────────────────────────────
async function loadSources() {
  // Firestore'dan SADECE enabled bilgisi korunur; label/desc/baseUrl/pages koddan gelir.
  const savedEnabled = {};
  try {
    const snap = await CONTROL.doc('config').get();
    if (snap.exists && Array.isArray(snap.data().sources)) {
      snap.data().sources.forEach(s => { savedEnabled[s.id] = s.enabled; });
    }
  } catch {}
  const merged = DEFAULT_SOURCES.map(def => ({
    ...def,
    enabled: savedEnabled[def.id] ?? def.enabled,
  }));
  // Panel görünümü için config'i koddaki güncel değerlerle senkronla (enabled korunur)
  await CONTROL.doc('config').set({
    sources: merged.map(({ id, site, label, description, pages, enabled }) =>
      ({ id, site: site || 'trendyol', label, description, pages, enabled })),
    sites: Object.entries(SITE_META).map(([id, m]) => ({ id, label: m.label })),
  }, { merge: false }).catch(() => {});
  return merged;
}

async function setStatus(data) {
  await CONTROL.doc('status').set(data, { merge: true });
}

// ── Sınırlı kaydırma (sonsuz kaydırmaya girmeden ilk ürünleri yükle) ───────────
async function scrollPage(page) {
  const STEPS = 3;
  for (let i = 1; i <= STEPS; i++) {
    await page.evaluate(y => window.scrollTo(0, y), i * 900).catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(200);
}

// ── Trendyol çıkarıcı ──────────────────────────────────────────────────────────
async function extractTrendyol(page) {
  await scrollPage(page);
  const tryExtract = () => page.evaluate(() => {
    const kartlar = document.querySelectorAll(
      'a[data-testid="product-card"], .p-card-wrppr a.product-card, .product-card'
    );
    return Array.from(kartlar).map(kart => {
      const marka = kart.querySelector('.product-brand')?.childNodes[0]?.textContent?.trim()
        || kart.querySelector('[class*="brand-name"]')?.textContent?.trim() || '';
      const isim = kart.querySelector('.product-name')?.textContent?.trim()
        || kart.querySelector('[data-testid="product-name"]')?.textContent?.trim() || '';
      let yeniF = kart.querySelector('[data-testid="sale-price"]')?.textContent?.trim()
        || kart.querySelector('.sale-price')?.textContent?.trim()
        || kart.querySelector('[data-testid="price-value"]')?.textContent?.trim() || '';
      let eskiF = kart.querySelector('[data-testid="strikethrough-price"], .strikethrough-price')?.textContent?.trim() || '';
      const puan = kart.querySelector('.average-rating')?.textContent?.trim() || '';
      const gorsel = kart.querySelector('img[data-testid="image-img"], img.image')?.src
        || kart.querySelector('img')?.src || '';
      const href = kart.getAttribute('href') || '';
      const link = href.startsWith('http') ? href : `https://www.trendyol.com${href}`;
      if (!yeniF && eskiF) { yeniF = eskiF; eskiF = ''; }
      return { isim, marka, yeniF, eskiF, puan, gorsel, link };
    }).filter(u => u.isim && u.link);
  });
  try {
    return await tryExtract();
  } catch (e) {
    if (e.message?.includes('Execution context was destroyed') || e.message?.includes('navigation')) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return await tryExtract().catch(() => []);
    }
    return [];
  }
}

// ── Cimri çıkarıcı ─────────────────────────────────────────────────────────────
async function extractCimri(page) {
  await scrollPage(page);
  const tryExtract = () => page.evaluate(() => {
    const kartlar = document.querySelectorAll('article[data-size="listing"]');
    return Array.from(kartlar).map(kart => {
      const a = kart.querySelector('a[href]');
      const isim = (a?.getAttribute('title') || kart.querySelector('h3')?.textContent || '').trim();
      const href = a?.getAttribute('href') || '';
      const link = href.startsWith('http') ? href : `https://www.cimri.com${href}`;
      const gorsel = kart.querySelector('img')?.src || '';
      const fiyatlar = Array.from(kart.querySelectorAll('span'))
        .map(s => s.textContent.trim())
        .filter(t => /^[\d.]+(,\d+)?\s*TL$/.test(t));
      const yeniF = fiyatlar[0] || '';
      const eskiF = fiyatlar[1] || '';
      return { isim, marka: '', yeniF, eskiF, puan: '', gorsel, link };
    }).filter(u => u.isim && u.yeniF && u.link);
  });
  try {
    return await tryExtract();
  } catch (e) {
    if (e.message?.includes('Execution context was destroyed') || e.message?.includes('navigation')) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return await tryExtract().catch(() => []);
    }
    return [];
  }
}

// ── N11 çıkarıcı ───────────────────────────────────────────────────────────────
// Gerçek N11 kart yapısı canlı taramada (debug-n11.js ile) doğrulandı:
// kartın kendisi <a class="product-item" data-prod-id="..."> — başlık ayrı
// bir "productName" elemanında DEĞİL, resmin üstündeki [title] div'inde veya
// img[alt]'ta; fiyat "h3.price-currency" (satış fiyatı) ve "div.price"
// (liste/eski fiyatı) sınıflarında; görsel karuselinde ilk slayt gerçek
// src'yi taşıyor, sonrakiler lazy-load placeholder (data: URI).
async function extractN11(page) {
  await scrollPage(page);
  const tryExtract = () => page.evaluate(() => {
    let kartlar = document.querySelectorAll('a.product-item[data-prod-id]');
    if (!kartlar.length) {
      // N11 markup'ı değiştiyse son çare: doğrudan ürün linklerini kullan.
      kartlar = document.querySelectorAll('a[href*="/urun/"]');
    }
    return Array.from(kartlar).map(kart => {
      const a = kart.matches('a') ? kart : kart.querySelector('a[href*="/urun/"], a[href]');
      const href = a?.getAttribute('href') || '';
      const link = href.startsWith('http') ? href : `https://www.n11.com${href}`;
      const isim = (
        kart.querySelector('[title]')?.getAttribute('title')
        || kart.querySelector('img[alt]')?.getAttribute('alt')
        || ''
      ).trim();
      const marka = ''; // N11 kartlarında ayrı bir marka etiketi yok.
      let yeniF = kart.querySelector('h3.price-currency, .price-currency')?.textContent?.trim() || '';
      let eskiF = kart.querySelector('div.price, .price')?.textContent?.trim() || '';
      const puan = kart.querySelector('.rate-number-text')?.textContent?.replace(/[()]/g, '').trim() || '';
      // Karusel: sadece gerçek bir http(s) src'si olan (data: URI/placeholder
      // olmayan) İLK ürün görselini al.
      const gorsel = Array.from(kart.querySelectorAll('img.listing-items-image'))
        .map(img => img.getAttribute('src') || '')
        .find(src => /^https?:/.test(src)) || '';
      if (!yeniF && eskiF) { yeniF = eskiF; eskiF = ''; }
      return { isim, marka, yeniF, eskiF, puan, gorsel, link };
    }).filter(u => u.isim && u.link);
  });
  try {
    return await tryExtract();
  } catch (e) {
    if (e.message?.includes('Execution context was destroyed') || e.message?.includes('navigation')) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return await tryExtract().catch(() => []);
    }
    return [];
  }
}

const EXTRACTORS = { trendyol: extractTrendyol, cimri: extractCimri, n11: extractN11 };

// ── Tüm aktif kaynakları tara ─────────────────────────────────────────────────
// siteFilter verilirse yalnızca o sitenin kaynakları taranır (örn. 'trendyol' / 'cimri').
// Chrome'un ne zaman, kaç kez açılıp kapandığını zaman damgasıyla loglar.
// "Bazen bir sürü Chrome açılıyor" şikayetini teşhis etmek için — bir
// sonraki tekrarında bu loglar, gerçekten AYNI ANDA birden fazla örneğin mi
// açıldığını, yoksa art arda hızlı açılıp kapanan tek pencerelerin mi
// kafa karıştırdığını kesin olarak gösterecek.
let _chromeInstanceCounter = 0;
function logChromeEvent(source, phase, extra = '') {
  const t = new Date().toISOString().split('T')[1].slice(0, 12);
  console.log(`[Chrome-Izleme ${t}] ${source} — ${phase}${extra ? ' ' + extra : ''}`);
}

// ── Açık tarayıcı kaydı — "çoklu Chrome" hatasına karşı güvenlik ağı ─────────
// runScrape'i saran 5 dakikalık zaman aşımı (withTimeout) süresi dolduğunda,
// tarama fonksiyonu HÂLÂ arka planda çalışmaya devam ediyor olabilir (Node bir
// promise'i "iptal edemez", sadece dış taraf onu beklemeyi bırakır). Bu durumda
// kilit serbest bırakılıp YENİ bir tarama/yayın başlayabiliyor — ama eski
// Chrome örneği henüz kapanmamış olabiliyor, iki pencere aynı anda görünür
// hale geliyor (canlı şikayette gözlemlenen "birden fazla Chrome" durumu bu
// olabilir). Bu kayıt, zaman aşımı anında hâlâ açık kalan örnekleri zorla
// kapatarak bu ihtimali ortadan kaldırıyor.
const _openBrowsers = new Set();
function registerBrowser(browser, label) {
  _openBrowsers.add(browser);
  browser.on('disconnected', () => _openBrowsers.delete(browser));
}
async function forceCloseAllBrowsers(reason) {
  if (_openBrowsers.size === 0) return;
  logChromeEvent('GUVENLIK', `${_openBrowsers.size} acik Chrome ornegi zorla kapatiliyor`, `(sebep: ${reason})`);
  const toClose = [..._openBrowsers];
  _openBrowsers.clear();
  await Promise.all(toClose.map(async b => {
    const pid = await getBrowserPid(b).catch(() => null);
    await closeBrowserSafely(b, pid, 'GUVENLIK');
  }));
}

// CIMRI GEÇİCİ OLARAK KAPALI (2026-07-16): Cimri linki çözme adımı (her ürün
// için "Mağazaya Git" tıklaması) Chrome görünürlük sorununu tetikliyordu —
// kullanıcı kararıyla, kalıcı bir çözüm bulana kadar kod seviyesinde
// devre dışı bırakıldı. Panelin kendi Cimri anahtarı ne durumda olursa
// olsun bu satır Cimri kaynaklarını tarama listesinden çıkarır. TEKRAR
// AÇMAK İÇİN: aşağıdaki .filter(...) satırını kaldırın (ya da yorum satırı
// yapın) — panel taraftaki mevcut anahtar/toggle davranışına geri döner.
const CIMRI_DISABLED = true;

async function scrapeAllSources(sources, siteFilter) {
  const enabled = sources
    .filter(s => s.enabled && (!siteFilter || (s.site || 'trendyol') === siteFilter))
    .filter(s => !CIMRI_DISABLED || (s.site || 'trendyol') !== 'cimri');
  if (!enabled.length) throw new Error(siteFilter ? `${siteFilter} için aktif kaynak yok` : 'Aktif kaynak yok');

  // Trendyol headless tarayıcıyı engeller → headless:false (gerçek Chrome).
  // GÖRÜNMEZLİK: pencereyi ekran dışına taşımak yerine (tek monitörlü
  // sistemlerde Windows bunu otomatik geri çekiyor ve CDP hedefini geçici
  // olarak bozuyor — canlı testte gözlemlendi) doğrudan CDP ile minimize
  // ediyoruz (bkz. minimizeWindow) + görev çubuğundan gizliyoruz (bkz.
  // hideFromTaskbar). Arka plan pencereler Chrome tarafından kısılmasın diye
  // throttle kapatıcılar yine de eklenir.
  const _scanInstanceId = ++_chromeInstanceCounter;
  logChromeEvent('TARAMA', `#${_scanInstanceId} LAUNCH baslatiliyor`);
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Chrome'un KENDİ "başlangıçtan minimize" bayrağı — önceki yöntem
      // (önce görünür aç, SONRA CDP ile minimize et) arada kaçınılmaz bir
      // "flash" penceresi bırakıyordu (canlı şikayette "saniyelerce açık
      // görünüyor" olarak bildirildi). --start-minimized ile pencere DAHA
      // İLK KAREDEN itibaren minimize durumunda oluşturuluyor — CDP'nin
      // "yetişmesini" beklemeye gerek kalmıyor. Ekran dışı konum + CDP
      // minimize (aşağıda) yine de ek güvenlik katmanı olarak duruyor.
      '--start-minimized',
      '--window-position=-32000,-32000',
      '--window-size=1280,900',
      '--disable-backgrounding-occluded-windows', // arka plan pencere kısılmasın
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // Windows Service (Session 0) altında çalışırken gerçek bir ekran/GPU
      // sürücüsü yok — GPU process bu ortamda başlatılmaya çalışırsa
      // sessizce çökebilir/yeniden başlama döngüsüne girebilir. Yazılım
      // render'a zorlamak taramayı etkilemez (sayfa hiç görüntülenmiyor).
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });
  registerBrowser(browser, 'TARAMA');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'tr-TR',
    viewport: { width: 1280, height: 900 },
  });

  // HIZ: yalnızca medya/font indirmesini engelle. GÖRSELLERİ ENGELLEMEYİZ —
  // engellenirse Trendyol lazy-load gerçek görsel yerine placeholder URL'si bırakıyor.
  // (Zaten 'domcontentloaded' + kart selektörü beklediğimiz için görselleri beklemiyoruz,
  //  bu yüzden görselleri yüklemek tarama süresini uzatmaz.)
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  logChromeEvent('TARAMA', `#${_scanInstanceId} LAUNCH tamamlandi (PID: ${browser.process?.()?.pid ?? 'bilinmiyor'})`);
  const page = await context.newPage();
  await minimizeWindow(context, page);
  const _scanPid = await getBrowserPid(browser);
  hideFromTaskbar(_scanPid);
  logChromeEvent('TARAMA', `#${_scanInstanceId} minimize+gizleme denendi`, `(gercek PID: ${_scanPid})`);
  const all = [];
  const seen = new Set();
  const cookieDoneBySite = {};

  // Site bazlı ayarlar
  const SITE_CFG = {
    trendyol: {
      cardSel: 'a[data-testid="product-card"], .product-card',
      cookieSel: 'button:has-text("Tümünü Reddet")',
      pageUrl: (base, p) => (p === 1 ? base : `${base}&pi=${p}`),
    },
    cimri: {
      cardSel: 'article[data-size="listing"]',
      cookieSel: '#onetrust-accept-btn-handler',
      pageUrl: (base, p) => (p === 1 ? base : `${base}?page=${p}`),
    },
    n11: {
      // extractN11'deki birincil seçicilerle aynı + href fallback'i — bu
      // sayede waitForSelector, tam seçici tutmasa bile en azından ürün
      // linkleri DOM'a geldiğinde ilerleyebilir.
      cardSel: 'a.product-item[data-prod-id], a[href*="/urun/"]',
      cookieSel: '#onetrust-accept-btn-handler, button:has-text("Kabul Et")',
      // N11'in "pg" sayfa parametresini her sayfa için yeniden yazar.
      pageUrl: (base, p) => {
        const u = new URL(base);
        u.searchParams.set('pg', String(p));
        return u.toString();
      },
    },
  };

  try {
    for (const src of enabled) {
      const site = src.site || 'trendyol';
      const cfg = SITE_CFG[site];
      const extractor = EXTRACTORS[site] || extractTrendyol;
      console.log(`[${SITE_META[site]?.label || site} · ${src.label}] Tarıyor...`);
      for (let p = 1; p <= src.pages; p++) {
        const url = cfg.pageUrl(src.baseUrl, p);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        // SPA routing bitmesini bekle (kısa timeout — hata verse de devam)
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        if (!cookieDoneBySite[site]) {
          try { await page.click(cfg.cookieSel, { timeout: 3000 }); } catch {}
          cookieDoneBySite[site] = true;
        }
        // Her sayfa yüklemesi (page.goto) veya tıklama (çerez onayı gibi) gibi
        // gerçek kullanıcı etkileşimleri Windows'un pencereyi kendiliğinden
        // geri yüklemesine (minimized durumdan çıkarmasına) VE görev
        // çubuğundan gizleme stilini sıfırlamasına yol açabiliyor — canlı
        // testte gözlemlendi: pencere taramanın BAŞINDA gizleniyordu ama
        // birkaç sayfa sonra tekrar görünür hale gelmişti. Tek seferlik
        // gizleme uzun (çok sayfalı) bir tarama boyunca yetmiyor — bu yüzden
        // İKİSİNİ DE (minimize + görev çubuğu) HER sayfa geçişinde tekrar
        // uyguluyoruz (ikisi de kendi içinde hızlı/best-effort).
        await minimizeWindow(context, page);
        hideFromTaskbar(_scanPid);
        // Kartlar görünür görünmez devam et (hızlı + güvenilir)
        await page.waitForSelector(cfg.cardSel, { timeout: 10000 }).catch(() => {});
        const urunler = await extractor(page);
        let yeni = 0;
        for (const u of urunler) {
          if (seen.has(u.link)) continue;
          seen.add(u.link);
          all.push({ ...u, site, sourceId: src.id, sourceName: src.label });
          yeni++;
        }
        console.log(`[${src.label}] Sayfa ${p}: ${yeni} yeni ürün`);
      }
    }
  } finally {
    logChromeEvent('TARAMA', `#${_scanInstanceId} CLOSE baslatiliyor`);
    await closeBrowserSafely(browser, _scanPid, 'TARAMA');
    logChromeEvent('TARAMA', `#${_scanInstanceId} CLOSE tamamlandi`);
  }
  console.log(`[Scraper] Toplam: ${all.length} benzersiz ürün`);
  return all;
}

// ── Firebase'e yükle ──────────────────────────────────────────────────────────
async function uploadToFirestore(urunler) {
  const publishedLinks = await ensurePublishedLinksCache();
  if (publishedLinks.size) console.log(`[Dedup] ${publishedLinks.size} ürün zaten yayında (yerel önbellek, okuma maliyeti yok).`);

  const now = Timestamp.now();
  let batch = db.batch();
  let count = 0;
  let alreadyPublished = 0; // dedup: link zaten discounts'ta var
  let filteredOut = 0; // eksik veri veya indirim eşiğinin altında
  const staged = []; // otomatik yayın kalite kapısı için (docId, fiyat, kategori, link)
  for (const u of urunler) {
    const site = u.site || 'trendyol';
    const yeniF = parseFiyat(u.yeniF);
    const eskiF = parseFiyat(u.eskiF);
    if (!yeniF || !u.isim || !u.link) { filteredOut++; continue; }
    if (publishedLinks.has(u.link)) { alreadyPublished++; continue; }

    // Site bazlı belge ID'si (URL'den ürün ID'si)
    let docId;
    if (site === 'cimri') {
      const m = u.link.match(/,(\d+)(?:[/?#]|$)/);
      docId = m ? `cm_${m[1]}` : `cm_${Date.now()}_${count}`;
    } else if (site === 'n11') {
      // N11 ürün linkleri: .../urun/<slug>-<id> veya ...-P<id> biçiminde.
      const m = u.link.match(/-P?(\d+)(?:[/?#]|$)/i);
      docId = m ? `n11_${m[1]}` : `n11_${Date.now()}_${count}`;
    } else {
      const m = u.link.match(/-p-(\d+)/);
      docId = m ? `ty_${m[1]}` : `ty_${Date.now()}_${count}`;
    }
    const store = SITE_META[site]?.store || 'Trendyol';
    const category = tahminKategori(u.isim, u.marka);
    batch.set(db.collection('trendyol_staging').doc(docId), {
      title: u.isim,
      brand: u.marka || store,
      category,
      newPrice: yeniF,
      oldPrice: eskiF || yeniF,
      imageUrl: u.gorsel,
      link: u.link,
      deleteUrl: '',
      submittedBy: 'trendyol-scraper',
      storeName: store,
      site,
      originalSource: 'trendyol-scraper',
      sourceId: u.sourceId || site,
      sourceName: u.sourceName || store,
      reviewCount: u.puan,
      status: 'pending',
      importedAt: now,
      createdAt: now,
    }, { merge: false });
    staged.push({ id: docId, title: u.isim, oldPrice: eskiF || yeniF, newPrice: yeniF, category, link: u.link, site });
    count++;
    if (count % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  return { count, staged, alreadyPublished, filteredOut };
}

// ── Çalışma geçmişi (panelde "son 24 saat" istatistikleri için) ──────────────
// Her tarama sonunda tek bir özet doküman eklenir (otomatik ID). 24 saatten
// eski kayıtlar her yeni kayıtta otomatik temizlenir — ayrı bir cron/Firestore
// TTL politikası kurulumu gerekmez, koleksiyon kendiliğinden küçük kalır.
async function cleanupOldRunHistory() {
  const cutoff = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const snap = await RUN_HISTORY.where('timestamp', '<', cutoff).limit(500).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  console.log(`[Geçmiş] ${snap.size} eski kayıt silindi (24 saatten eski).`);
}

async function recordRunHistory(entry) {
  await RUN_HISTORY.add({ ...entry, timestamp: Timestamp.now() });
  await cleanupOldRunHistory().catch(e => console.warn('[Geçmiş] temizlik hatası:', e.message));
}

// ── Otomatik yayın kuyruğu ("sürekli aktif" hissi) ────────────────────────────
// Onaylanan ürünler HEPSİ BİRDEN değil, teker teker yayınlanır — uygulamanın
// sürekli yeni fırsat aldığı hissi verir. Panelin manuel "Çöz & Yayınla"
// kuyruğundan (scraper_control/publish_request) AYRI bir doküman kullanır
// (scraper_control/auto_publish_queue) — admin panelden elle bir şey
// yayınlarken bu otomatik kuyrukla çakışmasın diye.
//
// ARALIK ARTIK DİNAMİK (sabit 1-3 dk değil): kuyruktaki TÜM ürünler, bir
// sonraki saatlik otomatik taramaya kalan süreye eşit dağıtılır. Örn. 120
// ürün onaylandıysa ve bir sonraki taramaya 60 dk varsa, 30 saniyede bir
// yayınlanır — böylece bu taramanın ürünleri, YENİ tarama gelmeden hepsi
// yayınlanmış olur. Yeni bir tarama (aynı saatte veya kuyruk hâlâ boşalmamışken)
// kalan ürünlere yenilerini eklerse, TOPLAM kuyruk yine kalan süreye göre
// yeniden hesaplanır — hep "bir sonraki taramaya kadar bitir" hedeflenir.
const AUTO_QUEUE_MIN_INTERVAL_MS = 5 * 1000; // güvenlik payı: aşırı kalabalık kuyrukta bile en az 5 sn arayla

// listener.js bu kuyruğu her birkaç saniyede bir "sırası geldi mi" diye
// kontrol ediyor (bkz. processAutoPublishQueue) — ESKİDEN her kontrolde
// Firestore'a gidiyordu (dakikada 1, günde 24 saat = ~1.440 gereksiz okuma,
// üstelik kuyruk boşken bile). Artık bu süreç zaten kendi yazdığı nextAt'i
// hafızada tuttuğu için (aynı Node process'i hem yazıyor hem okuyor),
// gerçekten sırası gelene kadar Firestore'a HİÇ gitmiyoruz — sadece zamanı
// geldiğinde 1 okuma. Yeni ürün kuyruğa eklendiğinde (enqueueAutoPublish)
// veya PC yeniden başladığında (0 = "bilinmiyor, kontrol et") önbellek sıfırlanır.
let _autoQueueNextAtCache = 0;

// Bir sonraki saat başına (otomatik tarama zamanına) kalan süre (ms).
function msUntilNextScan() {
  const now = Date.now();
  const nextHour = Math.ceil((now + 1) / 3_600_000) * 3_600_000; // +1: tam saat başındaysak bir sonrakini al
  return nextHour - now;
}

async function enqueueAutoPublish(ids) {
  if (!ids.length) return;
  const REQ = CONTROL.doc('auto_publish_queue');
  let mergedCount = 0, intervalMs = 0, total = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(REQ);
    const d = snap.exists ? snap.data() : {};
    // Önceki kuyruk tamamen bitmişse (status !== 'processing') TEMİZ bir
    // döngü başlıyoruz — done/failed sayaçları sıfırlanır, panelde "37/135
    // Yayınlandı" göstergesi bu turun ilerlemesini yansıtır, eski turlardan
    // kalan sayılarla karışmaz. Kuyruk hâlâ işleniyorsa (yeni tarama, eski
    // kuyruk boşalmadan geldi) sayaçlar korunur — aynı turun devamı sayılır.
    const wasActive = d.status === 'processing';
    const existing = wasActive && Array.isArray(d.ids) ? d.ids : [];
    const merged = [...existing, ...ids.filter(id => !existing.includes(id))];
    mergedCount = merged.length;
    intervalMs = Math.max(AUTO_QUEUE_MIN_INTERVAL_MS, Math.floor(msUntilNextScan() / merged.length));
    const doneSoFar = wasActive ? (d.done || 0) : 0;
    const failedSoFar = wasActive ? (d.failed || 0) : 0;
    total = doneSoFar + failedSoFar + merged.length;
    tx.set(REQ, {
      ids: merged,
      status: 'processing',
      intervalMs,
      total,
      // Yeni eklemeyle birlikte aralık yeniden hesaplandığı için zamanlamayı
      // da tazeleriz — kalan ürünler artık YENİ (muhtemelen daha sık) aralıkla ilerler.
      nextAt: Date.now(),
      done: doneSoFar,
      failed: failedSoFar,
    }, { merge: true });
  });
  _autoQueueNextAtCache = 0; // yeni ürün geldi — bir sonraki tikte hemen gerçek kontrol yap
  console.log(`[Otomatik Yayın Kuyruğu] ${ids.length} yeni ürün eklendi (kuyruk ${mergedCount}, tur toplamı ${total}), ~${Math.round(intervalMs / 1000)} sn aralıkla, bir sonraki taramaya kadar bitirilecek.`);
}

// listener.js'teki zamanlayıcı tarafından SIK aralıklarla (birkaç saniyede
// bir) çağrılır — ama _autoQueueNextAtCache sayesinde çoğu çağrı Firestore'a
// HİÇ gitmez (aşağıdaki ilk satır). Bu, hem eski 60sn'lik kaba pollingin
// israfını ortadan kaldırıyor HEM DE yayın aralığının (intervalMs, kuyruk
// büyükken 5-30 sn gibi kısa olabiliyor) daha isabetli zamanlanmasını
// sağlıyor — eskiden 60sn'lik sabit kontrol aralığı, kısa aralıklı
// yayınların panelde gösterilen sayaçtan daha YAVAŞ gerçekleşmesine yol
// açıyordu.
let _autoPublishing = false;
async function processAutoPublishQueue() {
  if (_autoPublishing) return;
  if (_autoQueueNextAtCache && Date.now() < _autoQueueNextAtCache) return; // Firestore'a gitmeden yerel kontrol
  const REQ = CONTROL.doc('auto_publish_queue');
  let d;
  try { d = (await REQ.get()).data() || {}; } catch { return; }
  if (d.status !== 'processing') { _autoQueueNextAtCache = Date.now() + 60 * 60 * 1000; return; } // boş/bitmiş kuyruk — 1 saat sessiz kal (yeni tarama enqueueAutoPublish ile zaten uyandırır)
  const ids = Array.isArray(d.ids) ? d.ids : [];
  if (!ids.length) { await REQ.set({ status: 'done', finishedAt: Timestamp.now() }, { merge: true }).catch(() => {}); _autoQueueNextAtCache = Date.now() + 60 * 60 * 1000; return; }
  if (Date.now() < (d.nextAt || 0)) { _autoQueueNextAtCache = d.nextAt; return; } // sırası henüz gelmedi — tam o zamana kadar tekrar sorma

  _autoPublishing = true;
  try {
    const r = await publishBatch([ids[0]]);
    if (r.skipped) { _autoQueueNextAtCache = 0; return; } // kilit meşgul — sıradaki tikte gerçekten tekrar dener
    const rest = ids.slice(1);
    // Kalan ürün sayısı azaldıkça aralığı DARALTMIYORUZ (kayıtlı intervalMs
    // sabit kalır) — aksi halde kuyruk sonuna doğru anormal hızlanır. Yeni bir
    // enqueueAutoPublish çağrısı geldiğinde zaten yeniden hesaplanıyor.
    const intervalMs = d.intervalMs || AUTO_QUEUE_MIN_INTERVAL_MS;
    const nextAt = Date.now() + intervalMs;
    await REQ.set({
      ids: rest,
      done: (d.done || 0) + r.done,
      failed: (d.failed || 0) + r.failed,
      nextAt,
      status: rest.length ? 'processing' : 'done',
      ...(rest.length ? {} : { finishedAt: Timestamp.now() }),
    }, { merge: true });
    _autoQueueNextAtCache = rest.length ? nextAt : Date.now() + 60 * 60 * 1000;
    console.log(`[Otomatik Yayın Kuyruğu] 1 yayınlandı, ${rest.length} kaldı, ~${Math.round(intervalMs / 1000)} sn sonra devam.`);
    if (!rest.length) await closeSharedBrowserNow('otomatik kuyruk tamamen bitti');
  } finally {
    _autoPublishing = false;
  }
}

// ── Otomatik yayın: kalite kapısından geçenleri kuyruğa ekle ──────────────────
// Düşük puan alanlar staging'de kalır — panelden manuel onay hâlâ mümkün (yedek yol).
async function autoPublishQualified(staged) {
  if (!staged.length) return { approved: 0, rejected: 0, approvedItems: [], rejectedItems: [] };

  const gateResults = await runQualityGate(staged, { db });
  const approved = gateResults.filter(r => r.publish);
  const rejected = gateResults.filter(r => !r.publish);

  // staged ile gateResults'u id üzerinden birleştir — panelde bildirim listesi
  // için ürün adı/fiyatı lazım (gateResults'ta sadece id/sebep var).
  const stagedById = new Map(staged.map(s => [s.id, s]));
  const approvedItems = approved.map(r => {
    const s = stagedById.get(r.id) || {};
    return { id: r.id, title: s.title || '', newPrice: s.newPrice ?? null, oldPrice: s.oldPrice ?? null, site: s.site || null, link: s.link || null, reason: r.reason || '' };
  });
  const rejectedItems = rejected.map(r => {
    const s = stagedById.get(r.id) || {};
    return { id: r.id, title: s.title || '', newPrice: s.newPrice ?? null, oldPrice: s.oldPrice ?? null, site: s.site || null, link: s.link || null, reason: r.reason || '' };
  });

  rejected.forEach(r => console.log(`   🚫 [Kalite Kapısı] Reddedildi (${r.id}): ${r.reason} — staging'de kaldı`));
  console.log(`[Kalite Kapısı] ${approved.length}/${staged.length} onaylandı, yayın kuyruğuna ekleniyor...`);

  if (approved.length === 0) return { approved: 0, rejected: rejected.length, approvedItems: [], rejectedItems };

  await enqueueAutoPublish(approved.map(r => r.id));
  return { approved: approved.length, rejected: rejected.length, queued: true, approvedItems, rejectedItems };
}

// ── Tarayıcı aç (paylaşılan ayar) ─────────────────────────────────────────────
async function openBrowser() {
  const _pubInstanceId = ++_chromeInstanceCounter;
  logChromeEvent('YAYIN', `#${_pubInstanceId} LAUNCH baslatiliyor`);
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      // bkz. scrapeAllSources'taki aynı satır — DAHA İLK KAREDEN minimize
      // başlatır, "önce görünür aç sonra minimize et" arasındaki flash'ı
      // tamamen ortadan kaldırır.
      '--start-minimized',
      '--window-position=-32000,-32000',
      '--window-size=1280,900',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // bkz. scrapeAllSources'taki aynı satır — Session 0 servis ortamında GPU yok.
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });
  logChromeEvent('YAYIN', `#${_pubInstanceId} LAUNCH tamamlandi`);
  registerBrowser(browser, 'YAYIN');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'tr-TR', viewport: { width: 1280, height: 900 },
  });
  // "Mağazaya Git" gibi tıklamalar yeni pencere/sekme açabilir; bunlar ana
  // pencerenin gizli durumunu miras almaz, varsayılan (görünür) konumda açılır.
  // Her yeni sayfa oluşur oluşmaz minimize et + görev çubuğundan gizle — kısa
  // süreli "flash" görünmesin. (İlk sayfa dahil — aşağıda ayrıca çağırmaya
  // gerek yok, bu olay onun için de tetiklenir.)
  let _pageCounter = 0;
  context.on('page', async (newPage) => {
    const pageNum = ++_pageCounter;
    logChromeEvent('YAYIN', `#${_pubInstanceId} yeni SAYFA #${pageNum} acildi`, `url:${newPage.url()}`);
    try {
      await minimizeWindow(context, newPage);
      hideFromTaskbar(await getBrowserPid(browser));
      logChromeEvent('YAYIN', `#${_pubInstanceId} sayfa #${pageNum} minimize+gizleme denendi`);
    } catch { /* sekme ise (ayrı pencere değil) zaten ana pencereyle birlikte gizli */ }
  });
  const firstPage = await context.newPage();
  await firstPage.close();
  const pid = await getBrowserPid(browser);
  return { browser, context, pid };
}

// ── Paylaşılan (kalıcı) yayın tarayıcısı ─────────────────────────────────────
// ESKİ DAVRANIŞ: her yayınlanan ürün için (Cimri linki çözülürken) TAM BİR
// Chrome SÜRECİ açılıp kapanıyordu. Kuyruk her 10-30 saniyede bir ürün
// yayınladığı için bu, art arda "açılıp kapanan Chrome" görüntüsüne yol
// açıyordu (canlı şikayette bildirildi) — her açılışın kendi ~1 sn'lik
// görünürlük anı da var.
//
// YENİ DAVRANIŞ: Kuyruk aktif olduğu sürece TEK bir gizli Chrome süreci açık
// tutulur; her ürün için sadece o sürecin İÇİNDE yeni bir SEKME açılıp
// kapanıyor (tüm süreç değil) — çok daha az göze batar, hatta pratikte
// fark edilmez. Kuyruk bir süre (5 dk) boş kalırsa süreç kendini kapatır
// (kaynak israfı olmasın diye), bir sonraki ihtiyaçta yeniden açılır.
let _sharedBrowser = null;
let _sharedContext = null;
let _sharedBrowserPid = null;
let _sharedBrowserIdleTimer = null;
// ÖNEMLİ: kuyrukta az ürün kalınca (bir sonraki taramaya kalan süreye göre
// hesaplanan) yayın aralığı kolayca 5 dakikayı AŞABİLİYOR — bu durumda eski
// 5 dk'lık sınır süreci erken kapatıp bir sonraki ürün için gereksiz yere
// yeniden açtırıyordu (canlı testte gözlemlendi: "daha az ama yine
// açıyor"). 20 dakikaya çıkarıldı — gerçekçi yayın aralıklarının neredeyse
// tamamını kapsıyor. Kuyruk GERÇEKTEN bittiğinde zaten closeSharedBrowserNow()
// ile hemen ve kesin olarak kapatılıyor (aşağıya bkz.), bu süre sadece
// "hâlâ devam ediyor ama yavaş" durumunu tolere etmek için bir güvenlik payı.
const SHARED_BROWSER_IDLE_MS = 20 * 60 * 1000;

async function getSharedPublishBrowser() {
  if (_sharedBrowserIdleTimer) { clearTimeout(_sharedBrowserIdleTimer); _sharedBrowserIdleTimer = null; }
  if (_sharedBrowser && _sharedBrowser.isConnected()) {
    return { browser: _sharedBrowser, context: _sharedContext };
  }
  const { browser, context, pid } = await openBrowser();
  _sharedBrowser = browser;
  _sharedContext = context;
  _sharedBrowserPid = pid;
  return { browser, context };
}

// Süreci hemen kapatmak yerine, kuyruk boşsa diye kısa bir süre daha canlı
// tutar — kuyrukta hemen ardından yeni bir ürün gelirse (çok olası) süreci
// yeniden açmaktan (ve bir "flash" daha yaşamaktan) kaçınılmış olur.
function scheduleSharedBrowserIdleClose() {
  if (_sharedBrowserIdleTimer) clearTimeout(_sharedBrowserIdleTimer);
  _sharedBrowserIdleTimer = setTimeout(async () => {
    _sharedBrowserIdleTimer = null;
    if (_sharedBrowser) {
      logChromeEvent('YAYIN', 'paylasilan surec bosta kaldigi icin kapatiliyor (zaman asimi)');
      await closeBrowserSafely(_sharedBrowser, _sharedBrowserPid, 'YAYIN');
      _sharedBrowser = null;
      _sharedContext = null;
      _sharedBrowserPid = null;
    }
  }, SHARED_BROWSER_IDLE_MS);
}

// Kuyruk (otomatik veya manuel) GERÇEKTEN tamamen bittiğinde çağrılır —
// zamanlayıcının dolmasını beklemeden hemen ve kesin olarak kapatır.
async function closeSharedBrowserNow(reason) {
  if (_sharedBrowserIdleTimer) { clearTimeout(_sharedBrowserIdleTimer); _sharedBrowserIdleTimer = null; }
  if (_sharedBrowser) {
    logChromeEvent('YAYIN', 'paylasilan surec kapatiliyor', `(sebep: ${reason})`);
    await closeBrowserSafely(_sharedBrowser, _sharedBrowserPid, 'YAYIN');
    _sharedBrowser = null;
    _sharedContext = null;
    _sharedBrowserPid = null;
  }
}

// ── Çözülen URL'den mağaza adını tespit et ───────────────────────────────
function detectStoreName(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/amazon\.com\.tr/.test(host))      return 'Amazon';
    if (/hepsiburada\.com/.test(host))     return 'Hepsiburada';
    if (/trendyol\.com/.test(host))        return 'Trendyol';
    if (/n11\.com/.test(host))             return 'n11';
    if (/getir\.com/.test(host))           return 'Getir';
    if (/morhipo\.com/.test(host))         return 'Morhipo';
    if (/gittigidiyor\.com/.test(host))    return 'GittiGidiyor';
    if (/boyner\.com\.tr/.test(host))      return 'Boyner';
    if (/lcwaikiki\.com/.test(host))       return 'LC Waikiki';
    if (/mavi\.com/.test(host))            return 'Mavi';
    if (/koton\.com/.test(host))           return 'Koton';
    if (/flo\.com\.tr/.test(host))         return 'Flo';
    if (/adidas\.com\.tr/.test(host))      return 'Adidas';
    if (/nike\.com/.test(host))            return 'Nike';
    if (/vatanbilgisayar\.com/.test(host)) return 'Vatan Bilgisayar';
    if (/mediamarkt\.com\.tr/.test(host))  return 'MediaMarkt';
    if (/teknosa\.com/.test(host))         return 'Teknosa';
    if (/gratis\.com/.test(host))          return 'Gratis';
    if (/watsons\.com\.tr/.test(host))     return 'Watsons';
    if (/rossmann\.com\.tr/.test(host))    return 'Rossmann';
    if (/pazarama\.com/.test(host))        return 'Pazarama';
    if (/migros\.com\.tr/.test(host))      return 'Migros';
    if (/carrefoursa\.com/.test(host))     return 'CarrefourSA';
    if (/ikea\.com/.test(host))            return 'IKEA';
    if (/defacto\.com\.tr/.test(host))     return 'DeFacto';
    if (/zara\.com/.test(host))            return 'Zara';
    if (/reebok\.com/.test(host))          return 'Reebok';
    // Bilinmeyenler için domain'in ilk segmentini kullan (örn. "xyz.com.tr" → "Xyz")
    const seg = host.split('.')[0];
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  } catch { return null; }
}

// ── Cimri linkini gerçek mağaza linkine çöz ──────────────────────────────────
// İzleme/affiliate parametrelerini temizle (kullanıcı kendi affiliate'ini ekleyebilsin)
function cleanStoreUrl(url) {
  try {
    const u = new URL(url);
    ['tag', 'linkCode', 'ascsubtag', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

async function resolveCimriStoreLink(context, cimriLink) {
  const page = await context.newPage();
  try {
    await page.goto(cimriLink, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    try { await page.click('#onetrust-accept-btn-handler', { timeout: 1500 }); } catch {}
    await page.evaluate(() => window.scrollTo(0, 600)).catch(() => {});
    await page.waitForTimeout(800);
    // "Mağazaya Git" → açılan popup mağazaya yönlenir
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 12000 }).catch(() => null),
      page.click('button:has-text("Mağazaya Git")', { timeout: 6000 }).catch(() => null),
    ]);
    if (!popup) return null;
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await popup.waitForTimeout(5000); // yönlendirme zincirini bekle
    const finalUrl = popup.url();
    await popup.close().catch(() => {});
    if (finalUrl && /^https?:/.test(finalUrl) && !/cimri\.com/.test(finalUrl)) {
      return cleanStoreUrl(finalUrl);
    }
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Dağıtık kilit ───────────────────────────────────────────────────────────────
// İki bilgisayar (ev + iş yeri) aynı anda dinliyorsa, aynı anda SADECE biri tarasın.
// Firestore transaction ile atomik kilit. Bayat kilit (çöken süreç) 8 dk sonra devralınır.
const LOCK_STALE_MS = 8 * 60 * 1000;

async function acquireLock() {
  const ref = CONTROL.doc('lock');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const now = Date.now();
    if (data && data.active) {
      const age = now - (data.claimedAt || 0);
      if (age < LOCK_STALE_MS) return false; // başka bilgisayar tarıyor
      // bayat kilit (çökmüş olabilir) → devral
    }
    tx.set(ref, { active: true, owner: INSTANCE_ID, claimedAt: now }, { merge: true });
    return true;
  });
}

async function releaseLock() {
  try {
    await CONTROL.doc('lock').set(
      { active: false, owner: INSTANCE_ID, releasedAt: Date.now() }, { merge: true });
  } catch {}
}

// ── Çöz & Yayınla (kuyruk) ────────────────────────────────────────────────────
// Verilen ID'leri yayınlar (Cimri ise gerçek mağaza linkini çözer). Kuyruğu yönetmez.
let _publishing = false;
async function publishBatch(ids) {
  let done = 0, failed = 0, skipped = 0;
  let locked = false;
  try { locked = await acquireLock(); } catch { locked = true; }
  if (!locked) { console.log('[Yayın] Başka iş çalışıyor — atlandı.'); return { done, failed, skipped: true }; }

  const { context } = await getSharedPublishBrowser();
  try {
    for (const id of ids) {
      try {
        const ref = db.collection('trendyol_staging').doc(id);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const p = snap.data();
        let link = p.link;
        let storeName = p.storeName;

        if ((p.site || 'trendyol') === 'cimri') {
          console.log(`[Çöz] ${(p.title || '').slice(0, 35)} ...`);
          const resolved = await resolveCimriStoreLink(context, p.link);
          if (resolved) {
            link = resolved;
            storeName = detectStoreName(resolved) || storeName;
            console.log(`   -> ${storeName} | ${link.slice(0, 60)}`);
          } else {
            console.log('   -> çözülemedi, Cimri linki kullanılacak');
          }
        }

        // Son kontrol: Cimri'nin gerçek mağaza linki bu ana kadar bilinmiyordu
        // (kalite kapısı geçtiğinde hâlâ cimri.com linkiydi). Şimdi çözüldüğüne
        // göre başka bir kaynaktan zaten yayında mı diye son kez bak.
        const normalizedLink = normalizeLink(link);
        const dup = await checkExistingLinks(db, [normalizedLink]);
        if (dup.has(normalizedLink)) {
          console.log(`   ⏭️  Mükerrer (başka kaynaktan zaten yayında), atlanıyor: ${(p.title || '').slice(0, 35)}`);
          markLinkAsPublished(link); // önbelleğe al — aynı ürün için bir daha bu sorguyu tekrarlamayalım
          await ref.delete();
          skipped++;
          continue;
        }

        const newRef = await db.collection('discounts').add({
          title: p.title, brand: p.brand, category: p.category,
          newPrice: p.newPrice, oldPrice: p.oldPrice, imageUrl: p.imageUrl,
          link, deleteUrl: '', submittedBy: 'trendyol-scraper',
          storeName, site: p.site || 'trendyol', originalSource: 'trendyol-scraper',
          reviewCount: p.reviewCount || '', affiliateLinkUpdated: false,
          importedAt: p.importedAt || Timestamp.now(), createdAt: Timestamp.now(),
          expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          priceHistory: [{ price: p.newPrice, at: Timestamp.now() }],
          normalizedLink,
          // qualityScore sadece otomatik onaylanan üründe var (bkz. autoPublishQualified) —
          // panelde "AI Tarafından Yayınlananlar" bölümünü doldurmak için kalıcı yazılır.
          ...(typeof p.qualityScore === 'number' ? {
            qualityScore: p.qualityScore,
            satisPotansiyeli: p.satisPotansiyeli ?? null,
            ilgiCekicilik: p.ilgiCekicilik ?? null,
            qualityReason: p.qualityReason || '',
            autoPublishedAt: Timestamp.now(),
          } : {}),
        });
        await ref.delete();
        done++;
        markLinkAsPublished(link);

        // qualityScore sadece otomatik onaylanan ürünlerde var (bkz. autoPublishQualified).
        // Panelden manuel yayınlananlarda yok — bildirim tetiklenmez, mevcut davranış korunur.
        if (typeof p.qualityScore === 'number') {
          await maybeNotifyHighScoreDeal(db, getMessaging(), {
            docId: newRef.id, title: p.title, imageUrl: p.imageUrl,
            score: p.qualityScore, newPrice: p.newPrice, oldPrice: p.oldPrice,
          }).catch(() => {});

          await maybeQueueSocialContent(db, process.env.GEMINI_API_KEY, {
            discountId: newRef.id, title: p.title, imageUrl: p.imageUrl,
            category: p.category, storeName, score: p.qualityScore,
            newPrice: p.newPrice, oldPrice: p.oldPrice,
          }).catch(() => {});
        }
      } catch (e) { failed++; console.error('[Yayın hata]', e.message); }
    }
  } finally {
    // Süreci hemen kapatmıyoruz — paylaşılan (kalıcı) tarayıcı, kuyruk devam
    // ettiği sürece açık kalır (bkz. getSharedPublishBrowser). Sadece "boşta
    // kalırsa kapat" zamanlayıcısını sıfırlıyoruz.
    scheduleSharedBrowserIdleClose();
    await releaseLock();
  }
  if (skipped > 0) console.log(`[Yayın] ${skipped} ürün mükerrer olduğu için atlandı.`);
  return { done, failed, skipped };
}

// Kuyruğu işler. interval 0 → hepsini hemen; interval>0 → zamanı gelmiş 1 ürünü yayınla.
// onSnapshot (anlık) ve timer (her ~20 sn, aralıklı + dayanıklılık) tarafından çağrılır.
async function processPublishQueue() {
  if (_publishing) return;
  const REQ = CONTROL.doc('publish_request');
  let d;
  try { d = (await REQ.get()).data() || {}; } catch { return; }
  if (d.status !== 'processing') return;
  const ids = Array.isArray(d.ids) ? d.ids : [];
  if (!ids.length) { await REQ.set({ status: 'done', finishedAt: Timestamp.now() }, { merge: true }).catch(() => {}); return; }

  const interval = Number(d.interval) || 0;
  _publishing = true;
  try {
    if (interval === 0) {
      const r = await publishBatch(ids);
      if (r.skipped) return;
      await REQ.set({ ids: [], done: (d.done || 0) + r.done, failed: (d.failed || 0) + r.failed, status: 'done', finishedAt: Timestamp.now() }, { merge: true });
      console.log(`[Yayın] Hemen: ${r.done} yayınlandı, ${r.failed} hata.`);
      await closeSharedBrowserNow('manuel kuyruk (hemen) tamamlandı');
    } else {
      if (Date.now() < (d.nextAt || 0)) return; // henüz zamanı değil
      const r = await publishBatch([ids[0]]);
      if (r.skipped) return;
      const rest = ids.slice(1);
      await REQ.set({
        ids: rest,
        done: (d.done || 0) + r.done, failed: (d.failed || 0) + r.failed,
        nextAt: Date.now() + interval * 60000,
        status: rest.length ? 'processing' : 'done',
        ...(rest.length ? {} : { finishedAt: Timestamp.now() }),
      }, { merge: true });
      console.log(`[Yayın] Aralıklı (${interval} dk): 1 yayınlandı, ${rest.length} kaldı.`);
      if (!rest.length) await closeSharedBrowserNow('manuel kuyruk tamamen bitti');
    }
  } finally {
    _publishing = false;
  }
}

// ── Tek tarama akışı (durum güncellemeli) ───────────────────────────────────────
let _running = false;
async function runScrape(trigger = 'manual', site = null) {
  if (_running) { console.log('[Scrape] Bu süreçte zaten çalışıyor, atlanıyor.'); return; }
  _running = true;

  // GÜVENLİK PAYI: fonksiyonun HER adımı (kilit alma dahil — daha önce bunun
  // dışındaydı ve Firestore kota sorunuyla sessizce sonsuza kadar takılabiliyordu,
  // canlı testte gözlemlendi) artık tek bir dış zaman sınırıyla sarmalanıyor.
  // _running bayrağı ne olursa olsun (başarı/hata/zaman aşımı) finally'de
  // sıfırlanıyor — böylece bir tek takılan çalışma, sonraki TÜM tetikleri
  // sonsuza kadar "atlanıyor" yapamaz.
  let count = 0;
  let staged = [];
  let locked = false;
  let totalScraped = 0;
  let alreadyPublished = 0;
  let filteredOut = 0;
  let ranSuccessfully = false;
  try {
    await withTimeout((async () => {
      try {
        locked = await acquireLock();
      } catch (e) {
        console.error('[Kilit] kontrol hatası, yine de devam ediliyor:', e.message);
        locked = true; // kilit kontrolü başarısızsa engelleme (Firebase erişilemiyorsa zaten tarama da yazamaz)
      }
      if (!locked) {
        console.log('[Kilit] Başka bir bilgisayar şu an tarıyor — bu çalışma atlandı.');
        return;
      }

      await setStatus({ isRunning: true, lastError: null, startedAt: Timestamp.now(), lastTrigger: trigger, lastSite: site || 'tümü', activeOwner: INSTANCE_ID });
      const sources = await loadSources();
      const urunler = await scrapeAllSources(sources, site);
      totalScraped = urunler.length;
      const uploadResult = await uploadToFirestore(urunler);
      count = uploadResult.count;
      staged = uploadResult.staged;
      alreadyPublished = uploadResult.alreadyPublished;
      filteredOut = uploadResult.filteredOut;
      await setStatus({ isRunning: false, lastRunTime: Timestamp.now(), lastRunCount: count, lastError: null });
      console.log(`[Tamamlandı] ${count} ürün staging'e yüklendi.`);
      ranSuccessfully = true;
    })(), 5 * 60 * 1000, 'Tarama');
  } catch (err) {
    console.error('[Hata]', err.message);
    // "Tarama zaman aşımı" hatası, iç taramanın (scrapeAllSources) HÂLÂ arka
    // planda çalışıyor olabileceği anlamına gelir — Node bir promise'i iptal
    // edemez, sadece dış taraf beklemeyi bırakır. Bu durumda kilit az sonra
    // serbest kalıp YENİ bir tarama/yayın başlayabilir, ama eski Chrome
    // penceresi henüz kapanmamış olur — iki pencere aynı anda görünür
    // (canlı şikayette gözlemlenen "birden fazla Chrome" durumu). Zaman
    // aşımında açık kalan tüm örnekleri zorla kapatarak bunu önlüyoruz.
    if (err.message && err.message.includes('zaman aşımı')) {
      await forceCloseAllBrowsers(err.message).catch(() => {});
    }
    await withTimeout(
      setStatus({ isRunning: false, lastError: err.message, lastRunTime: Timestamp.now() }),
      10000, 'Durum güncelleme'
    ).catch(() => {});
    throw err;
  } finally {
    if (locked) await withTimeout(releaseLock(), 10000, 'Kilit bırakma').catch(() => {});
    _running = false;
  }

  let qualityApproved = 0;
  let qualityRejected = 0;
  let approvedItems = [];
  let rejectedItems = [];
  try {
    const gateResult = await autoPublishQualified(staged);
    qualityApproved = gateResult.approved;
    qualityRejected = gateResult.rejected;
    approvedItems = gateResult.approvedItems || [];
    rejectedItems = gateResult.rejectedItems || [];
  } catch (e) {
    console.error('[Otomatik Yayın] hata:', e.message);
  }

  if (ranSuccessfully) {
    try {
      await recordRunHistory({
        trigger,
        site: site || 'tümü',
        totalScraped,
        alreadyPublished,
        filteredOut,
        newlyStaged: count,
        qualityApproved,
        approvedItems,
        rejectedItems,
        qualityRejected,
      });
    } catch (e) {
      console.error('[Geçmiş] kayıt hatası:', e.message);
    }
  }

  return count;
}

module.exports = { runScrape, processPublishQueue, processAutoPublishQueue, db, CONTROL, setStatus, loadSources };

// CLI: doğrudan çalıştırılırsa tek tarama yap.
// İsteğe bağlı ilk argüman site filtresidir — verilirse SADECE o sitenin
// kaynakları taranır (panelin site seçicisiyle aynı davranış):
//   node scrape.js          → tüm aktif siteler
//   node scrape.js n11      → yalnızca N11
//   node scrape.js trendyol → yalnızca Trendyol
if (require.main === module) {
  const siteArg = (process.argv[2] || '').trim().toLowerCase() || null;
  if (siteArg && !SITE_META[siteArg]) {
    console.error(`Bilinmeyen site: "${siteArg}". Geçerli değerler: ${Object.keys(SITE_META).join(', ')}`);
    process.exit(1);
  }
  if (siteArg) console.log(`[CLI] Yalnızca "${SITE_META[siteArg].label}" taranacak.`);
  runScrape('cli', siteArg)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
