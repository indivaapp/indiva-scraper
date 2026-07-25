'use strict';
// onual.js — OnuAl.com scraper (PC tabanlı, listener.js tarafından çağrılır)
// Saatte bir çalışır. Önce direkt HTTP (residential IP), Cloudflare engeli varsa Gemini URL Context.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');

// .env dosyasından ortam değişkenlerini yükle (GEMINI_API_KEY için)
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

// ── Firebase ──────────────────────────────────────────────────────────────────
function loadServiceAccount() {
  const localFile = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(localFile)) return JSON.parse(fs.readFileSync(localFile, 'utf8').replace(/^﻿/, ''));
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const legacy = 'D:\\INDIVA PANEL APP\\firebase-service-account.json';
  if (fs.existsSync(legacy)) return JSON.parse(fs.readFileSync(legacy, 'utf8').replace(/^﻿/, ''));
  throw new Error('service-account.json bulunamadı. Dosyayı C:\\trendyol-scraper klasörüne koyun.');
}

function initFirebase() {
  if (getApps().length) return getFirestore();
  const sa = loadServiceAccount();
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n').replace(/\n\n/g, '\n');
  initializeApp({ credential: cert(sa) });
  return getFirestore();
}

// ── Sabitler ──────────────────────────────────────────────────────────────────
const ONUAL_MAX = 15;
const CACHE_FILE = path.join(__dirname, 'data', 'onual_ids.json');

const CATEGORY_MAP = [
  { keywords: ['klavye', 'mouse', 'fare', 'monitör', 'bilgisayar', 'laptop', 'tablet', 'telefon', 'iphone', 'samsung', 'kulaklık', 'hoparlör', 'kamera', 'ssd', 'şarj', 'powerbank', 'akıllı saat', 'drone', 'gaming'], category: 'Teknoloji' },
  { keywords: ['buzdolabı', 'çamaşır makinesi', 'bulaşık makinesi', 'fırın', 'mikrodalga', 'klima', 'su ısıtıcı', 'elektrikli süpürge', 'fritöz', 'blender', 'kahve makinesi'], category: 'Beyaz Eşya' },
  { keywords: ['mont', 'ceket', 'kazak', 'gömlek', 'pantolon', 'elbise', 'tişört', 't-shirt', 'sweatshirt', 'pijama', 'iç giyim'], category: 'Giyim & Moda' },
  { keywords: ['ayakkabı', 'sneaker', 'bot', 'sandalet', 'terlik', 'çanta', 'sırt çantası', 'cüzdan', 'valiz'], category: 'Ayakkabı & Çanta' },
  { keywords: ['tencere', 'tava', 'çaydanlık', 'nevresim', 'perde', 'halı', 'aydınlatma', 'lamba', 'havlu', 'yastık', 'yorgan', 'banyo', 'ev tekstili'], category: 'Ev & Yaşam' },
  { keywords: ['mobilya', 'masa', 'sandalye', 'yatak', 'dolap', 'koltuk', 'raf', 'kitaplık', 'dekorasyon', 'tablo', 'ayna'], category: 'Mobilya & Dekorasyon' },
  { keywords: ['spor', 'fitness', 'bisiklet', 'forma', 'pilates', 'kamp', 'çadır', 'yürüyüş', 'koşu', 'dambıl'], category: 'Spor & Outdoor' },
  { keywords: ['şampuan', 'krem', 'losyon', 'maske', 'serum', 'parfüm', 'deodorant', 'saç', 'cilt', 'makyaj', 'kozmetik', 'sabun', 'duş jeli'], category: 'Kozmetik & Bakım' },
  { keywords: ['deterjan', 'temizlik', 'bakliyat', 'yağ', 'şeker', 'çay', 'kahve', 'gıda', 'bisküvi', 'market'], category: 'Süpermarket' },
  { keywords: ['bebek bezi', 'emzik', 'bebek arabası', 'bebek kıyafeti', 'bebek'], category: 'Anne & Bebek' },
  { keywords: ['kalem', 'defter', 'boya', 'kitap', 'roman', 'kırtasiye'], category: 'Kitap & Kırtasiye' },
  { keywords: ['oyuncak', 'lego', 'puzzle', 'oyun seti', 'playstation', 'nintendo'], category: 'Oyun & Oyuncak' },
  { keywords: ['vitamini', 'takviye', 'kapsül', 'şurup', 'sağlık', 'ateş ölçer'], category: 'Sağlık' },
  { keywords: ['araba', 'otomobil', 'lastik', 'motor yağı', 'motosiklet', 'oto aksesuar'], category: 'Otomotiv' },
  { keywords: ['kedi', 'köpek', 'pet mama', 'kedi kumu', 'tasma', 'evcil hayvan'], category: 'Pet Shop' },
  { keywords: ['bahçe', 'çiçek', 'toprak', 'saksı', 'hortum', 'testere', 'matkap'], category: 'Bahçe & Yapı' },
];

const STORE_MAP = [
  { domain: 'trendyol.com', name: 'Trendyol' },
  { domain: 'hepsiburada.com', name: 'Hepsiburada' },
  { domain: 'amazon.com.tr', name: 'Amazon' },
  { domain: 'amazon.com', name: 'Amazon' },
  { domain: 'n11.com', name: 'n11' },
  { domain: 'teknosa.com', name: 'Teknosa' },
  { domain: 'vatan.com.tr', name: 'Vatan' },
  { domain: 'mediamarkt.com.tr', name: 'MediaMarkt' },
  { domain: 'boyner.com.tr', name: 'Boyner' },
  { domain: 'lcwaikiki.com', name: 'LC Waikiki' },
  { domain: 'defacto.com.tr', name: 'DeFacto' },
  { domain: 'morhipo.com', name: 'Morhipo' },
  { domain: 'ciceksepeti.com', name: 'ÇiçekSepeti' },
];

function detectCategory(title) {
  const lower = title.toLowerCase();
  for (const { keywords, category } of CATEGORY_MAP) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return 'Ev & Yaşam';
}

function detectStore(url) {
  if (!url) return { name: 'Online Mağaza', domain: '' };
  for (const s of STORE_MAP) { if (url.includes(s.domain)) return s; }
  return { name: 'Online Mağaza', domain: '' };
}

function simulateOldPrice(newPrice) {
  const ratio = 0.20 + Math.random() * 0.40;
  return Math.round(Math.round(newPrice / (1 - ratio)) / 5) * 5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ID Cache ──────────────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const ageDays = (Date.now() - new Date(data.lastUpdate || 0).getTime()) / 86400000;
    if (ageDays > 7) return {};
    return data.ids || {};
  } catch { return {}; }
}

function saveCache(ids) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ids, lastUpdate: new Date().toISOString() }));
  } catch (e) { console.error('[OnuAl] Cache kaydetme hatası:', e.message); }
}

// ── HTTP Yardımcıları ──────────────────────────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchHtml(url, timeout = 15000) {
  return new Promise((resolve) => {
    const doFetch = (currentUrl, hops = 0) => {
      if (hops > 5) { resolve(''); return; }
      try {
        const parsed = new URL(currentUrl);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get(currentUrl, {
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
          },
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
            doFetch(next, hops + 1);
            return;
          }
          if (res.statusCode !== 200) { resolve(''); return; }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.setTimeout(timeout, () => { req.destroy(); resolve(''); });
        req.on('error', () => resolve(''));
      } catch { resolve(''); }
    };
    doFetch(url);
  });
}

function resolveStoreLink(url, timeout = 12000) {
  // URL parametresinde direkt link var mı?
  try {
    const u = new URL(url);
    const encoded = u.searchParams.get('url');
    if (encoded) {
      const decoded = decodeURIComponent(encoded);
      if (STORE_MAP.some(s => decoded.includes(s.domain))) return Promise.resolve(decoded);
    }
  } catch {}

  return new Promise((resolve) => {
    const tryFollow = (currentUrl, hops = 0) => {
      if (hops > 8) { resolve(url); return; }
      try {
        const mod = currentUrl.startsWith('https') ? https : http;
        const req = mod.request(currentUrl, { method: 'HEAD', headers: { 'User-Agent': BROWSER_UA } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
            tryFollow(next, hops + 1);
          } else {
            resolve(currentUrl);
          }
        });
        req.setTimeout(timeout, () => { req.destroy(); resolve(url); });
        req.on('error', () => resolve(url));
        req.end();
      } catch { resolve(url); }
    };
    tryFollow(url);
  });
}

// ── HTML Parser (cheerio) ──────────────────────────────────────────────────────
function parseDeals(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const deals = [];
  const seenIds = new Set();

  $('[data-share-id]').each((_, card) => {
    const $card = $(card);
    const productId = $card.attr('data-share-id');
    if (!productId || seenIds.has(productId)) return;
    seenIds.add(productId);
    const title = ($card.find('.product-title').attr('title') || $card.find('.product-title').text()).trim();
    if (!title || title.length < 3) return;
    let newPrice = 0;
    const priceText = $card.find('.product-price').first().text().trim();
    const priceMatch = priceText.match(/([\d.]+(?:,\d+)?)\s*TL/i);
    if (priceMatch) newPrice = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
    if (!newPrice) {
      const href = $card.attr('href') || '';
      const hashMatch = href.match(/fiyat=(\d+)/);
      if (hashMatch) { const raw = parseInt(hashMatch[1], 10); newPrice = raw > 10000 ? Math.round(raw / 100) : raw; }
    }
    const thumbnailUrl = $card.find('.product-image').attr('src') || '';
    const storeName = $card.find('.product-store-logo-badge').attr('title') || '';
    const href = ($card.attr('href') || '').split('#')[0];
    const fullLink = href.startsWith('http') ? href : `https://www.onual.com/${href.replace(/^\//, '')}`;
    deals.push({ id: productId, title: title.replace(/\s+/g, ' ').trim(), url: fullLink, newPrice, thumbnailUrl, storeName, storeUrl: '' });
  });
  return deals;
}

// ── Gemini URL Context (Cloudflare bypass fallback) ───────────────────────────
async function fetchOnualViaGemini(apiKey) {
  let GoogleGenAI;
  try { ({ GoogleGenAI } = require('@google/genai')); } catch {
    console.warn('[OnuAl] @google/genai paketi yüklü değil (npm install çalıştırın).');
    return [];
  }
  const genAI = new GoogleGenAI({ apiKey });
  console.log('[OnuAl] Gemini URL Context devreye alındı...');
  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: `Visit: https://www.onual.com

Sayfadaki TÜM ürün kartlarını bul. Her kart <a class="product-card group" data-share-id="..."> formatındadır.
Her kart için çıkart:
- id: data-share-id değeri
- title: h3.product-title elementinin title attribute veya text içeriği
- newPrice: .product-price içindeki fiyat (integer, TL)
- imageUrl: img.product-image src (tam https:// URL)
- storeName: .product-store-logo-badge title attribute (Amazon, Trendyol vb.)
- productUrl: <a> kartının href (relative ise https://www.onual.com/ prefix ekle)
- storeUrl: Kart içinde mağaza sitesine giden href (yoksa boş string)

SADECE JSON array, başka metin yok. Maks 20 ürün.
Örnek: [{"id":"126081","title":"Ürün Adı","newPrice":52,"imageUrl":"https://...","storeName":"Amazon","productUrl":"https://www.onual.com/urun/...","storeUrl":""}]` }] }],
      config: { tools: [{ urlContext: {} }], temperature: 0 },
    });
    const text = response.text || (response.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.warn('[OnuAl] Gemini: JSON bulunamadı'); return []; }
    const parsed = JSON.parse(match[0]);
    const result = parsed
      .filter(p => p.id && String(p.title || '').trim().length > 2)
      .map(p => ({
        id: String(p.id),
        title: String(p.title).trim(),
        url: String(p.productUrl || '').startsWith('http') ? p.productUrl : `https://www.onual.com/${String(p.productUrl || '').replace(/^\//, '')}`,
        newPrice: Number(p.newPrice) || 0,
        thumbnailUrl: String(p.imageUrl || ''),
        storeName: String(p.storeName || ''),
        storeUrl: String(p.storeUrl || ''),
      }));
    console.log(`[OnuAl] Gemini → ${result.length} ürün`);
    return result;
  } catch (err) {
    console.warn(`[OnuAl] Gemini hatası: ${err.message}`);
    return [];
  }
}

// ── Ürün Listesi (direkt → Gemini fallback) ────────────────────────────────────
async function fetchProductList() {
  console.log('[OnuAl] onual.com taranıyor...');
  // PC'de residential IP ile direkt deniyoruz önce
  try {
    const html = await fetchHtml('https://www.onual.com');
    if (html && html.length > 5000 && !html.includes('window._cf_chl_opt') && !html.includes('/cdn-cgi/challenge-platform/')) {
      const deals = parseDeals(html);
      if (deals.length > 0) {
        console.log(`[OnuAl] Direkt fetch → ${deals.length} ürün`);
        return deals;
      }
    }
    console.warn('[OnuAl] Direkt fetch başarısız (Cloudflare) → Gemini fallback');
  } catch (err) {
    console.warn(`[OnuAl] Direkt fetch hatası: ${err.message}`);
  }
  // Gemini URL Context fallback
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[OnuAl] GEMINI_API_KEY yok — .env dosyasına ekleyin. Tarama atlandı.');
    return [];
  }
  return fetchOnualViaGemini(apiKey);
}

// ── Detay Sayfası ──────────────────────────────────────────────────────────────
async function fetchProductDetails(product) {
  try {
    const cheerio = require('cheerio');
    const html = await fetchHtml(product.url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const button = $('#buton');
    let intermediateLink = button.attr('href') || product.url;
    if (intermediateLink && !intermediateLink.startsWith('http')) intermediateLink = `https://www.onual.com${intermediateLink}`;
    const imageUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
    let newPrice = product.newPrice || 0;
    let oldPrice = 0;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || '{}');
        if (data.offers) {
          if (!newPrice && data.offers.price) newPrice = parseFloat(String(data.offers.price).replace(',', '.'));
          if (data.offers.highPrice) oldPrice = parseFloat(String(data.offers.highPrice).replace(',', '.'));
        }
      } catch {}
    });
    if (!oldPrice) {
      const strikeText = $('del, s, .old-price, .price-old').first().text().replace(/[^\d.,]/g, '').trim();
      if (strikeText) oldPrice = parseFloat(strikeText.replace(',', '.')) || 0;
    }
    const buttonText = button.text().toLowerCase().trim();
    const isExpired = ['tükendi', 'sonlandı', 'indirim bitti', 'stok yok', 'kampanya bitti'].some(p => buttonText === p || buttonText.startsWith(p));
    return { imageUrl, newPrice, oldPrice, intermediateLink, isExpired };
  } catch { return null; }
}

// ── Firebase Batch Kontrol ──────────────────────────────────────────────────────
async function filterExistingIds(db, docIds) {
  const existing = new Set();
  for (let i = 0; i < docIds.length; i += 30) {
    const chunk = docIds.slice(i, i + 30);
    try {
      const snap = await db.collection('discounts').where(FieldPath.documentId(), 'in', chunk).select().get();
      snap.docs.forEach(d => existing.add(d.id));
    } catch {}
  }
  return existing;
}

// ── Ana Pipeline ──────────────────────────────────────────────────────────────
let _running = false;

async function runOnual() {
  if (_running) { console.log('[OnuAl] Zaten çalışıyor, atlandı.'); return; }
  _running = true;
  console.log(`\n[OnuAl] Pipeline başladı — ${new Date().toLocaleString('tr-TR')}`);
  try {
    const db = initFirebase();
    const allProducts = await fetchProductList();
    if (!allProducts.length) { console.log('[OnuAl] Ürün bulunamadı.'); return; }

    const cache = loadCache();
    const toProcess = allProducts.slice(0, ONUAL_MAX).reverse();
    const uncached = toProcess.filter(p => !cache[`onual_${p.id}`]);
    if (uncached.length < toProcess.length) console.log(`[OnuAl] ${toProcess.length - uncached.length} ürün cache'de zaten var.`);

    const uncachedIds = uncached.map(p => `onual_${p.id}`);
    const existingInDb = uncachedIds.length ? await filterExistingIds(db, uncachedIds) : new Set();
    if (existingInDb.size) existingInDb.forEach(id => { cache[id] = true; });
    const finalList = uncached.filter(p => !existingInDb.has(`onual_${p.id}`));
    console.log(`[OnuAl] ${finalList.length} yeni ürün işlenecek`);

    let success = 0, fail = 0;
    for (const product of finalList) {
      const docId = `onual_${product.id}`;
      try {
        const details = await fetchProductDetails(product);
        if (!details) { fail++; continue; }
        if (details.isExpired) { console.log(`[OnuAl] Sona ermiş, atlandı: ${product.id}`); continue; }
        const imageUrl = details.imageUrl || product.thumbnailUrl || '';
        if (!imageUrl) { fail++; continue; }

        let storeLink = null;
        const isDirectStore = STORE_MAP.some(s => details.intermediateLink.includes(s.domain)) &&
          !details.intermediateLink.includes('zxro.com') && !details.intermediateLink.includes('onu.al') && !details.intermediateLink.includes('knv.al');
        if (isDirectStore) {
          storeLink = details.intermediateLink;
        } else {
          storeLink = await resolveStoreLink(details.intermediateLink);
        }
        if (!storeLink && product.storeUrl) storeLink = product.storeUrl;
        if (!storeLink) storeLink = product.url;

        const store = detectStore(storeLink);
        if (store.name === 'Online Mağaza' && product.storeName) store.name = product.storeName;
        const newPrice = details.newPrice || product.newPrice || 0;
        const oldPrice = details.oldPrice || simulateOldPrice(newPrice);

        await db.collection('discounts').doc(docId).set({
          title: product.title.substring(0, 200),
          brand: store.name,
          category: detectCategory(product.title),
          description: '',
          link: storeLink,
          originalStoreLink: storeLink,
          oldPrice, newPrice,
          imageUrl,
          deleteUrl: '',
          submittedBy: 'auto-onual-bot',
          isAd: false,
          affiliateLinkUpdated: false,
          originalSource: 'onual.com',
          storeName: store.name,
          status: 'aktif',
          telegramMessageId: `onual_${product.id}`,
          pushNotifications: [],
          autoPublishedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          aiFomoScore: 5,
          expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
        });

        cache[docId] = true;
        success++;
        console.log(`[OnuAl] ✅ ${docId} → ${store.name} (${newPrice} TL)`);
        await sleep(500);
      } catch (err) {
        fail++;
        console.error(`[OnuAl] ❌ ${docId}: ${err.message}`);
      }
    }

    saveCache(cache);
    console.log(`[OnuAl] Tamamlandı: ${success} yeni, ${fail} hata — ${new Date().toLocaleString('tr-TR')}\n`);
  } catch (err) {
    console.error('[OnuAl] Kritik hata:', err.message);
  } finally {
    _running = false;
  }
}

module.exports = { runOnual };

// CLI: node onual.js
if (require.main === module) {
  runOnual().then(() => process.exit(0)).catch(() => process.exit(1));
}
