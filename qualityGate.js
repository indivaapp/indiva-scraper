'use strict';
// qualityGate.js — Yayın öncesi AI kalite kapısı (CJS ikizi)
//
// D:\INDIVA PANEL APP\scripts\qualityGate.js (ESM) ile aynı mantık; bu klasör
// CommonJS kullandığı ve taşınabilir/tek-klasör kurulum gerektirdiği için
// (bkz. KURULUM-REHBERI.txt) burada ayrı bir kopya tutuluyor.
//
// Felsefe: emin olamadığın durumda SIKI davranma. Ucuz kontrol (fiyat mantığı)
// önce çalışır, AI'ya hiç gitmeyen adayları eler. Hayatta kalanlar TEK istekte
// (batch) AI'dan puan alır.
//
// NOT: HTTP tabanlı bir "ölü link" kontrolü YOKTUR — kasıtlı olarak. Canlı
// testte doğrulandı: Playwright ile az önce scrape edilmiş, gerçekte canlı bir
// Trendyol linki, bare fetch() HEAD isteğine 404, GET isteğine 403 döndürdü.
// Bot koruması yüzünden HTTP durum koduna güvenmek yanlış-pozitif üretiyor ve
// iyi fırsatları gereksiz yere eliyordu (ilk canlı testte 240 adaydan 145'i
// yanlışlıkla reddedildi). Gerçek canlılık kontrolü price-checker.js'in
// içerik-tabanlı, AI destekli, 2 kademeli teyitli sistemine bırakılmıştır.

const DEFAULT_THRESHOLD = 6;
const DEFAULT_SCORE_ON_SKIP = 6;

function checkPriceSanity(oldPrice, newPrice) {
  if (!newPrice || newPrice <= 0) return { ok: false, reason: 'Geçersiz fiyat (0 veya yok)' };
  if (!oldPrice || oldPrice <= 0) return { ok: true, reason: 'Eski fiyat yok, kontrol atlandı' };
  if (newPrice > oldPrice) return { ok: false, reason: 'Yeni fiyat eski fiyattan yüksek' };
  const discount = (oldPrice - newPrice) / oldPrice;
  if (discount > 0.90) return { ok: false, reason: `İndirim oranı gerçekçi değil (%${Math.round(discount * 100)})` };
  return { ok: true, discount };
}

// Sadece yapısal geçerlilik — gerçek HTTP canlılık kontrolü değil (yukarıdaki nota bakın).
function checkLinkFormat(url) {
  if (!url) return { ok: false, reason: 'Link yok' };
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith('http')) return { ok: false, reason: 'Geçersiz protokol' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Geçersiz URL formatı' };
  }
}

// Linki kaynaktan bağımsız karşılaştırılabilir kimliğe indirger (Amazon ASIN,
// Trendyol/Hepsiburada ürün ID'si) — aynı ürün başka kaynaktan gelirse yakalanır.
function normalizeLink(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('amazon.')) {
      const m = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (m) return `amazon:${m[1].toUpperCase()}`;
    }
    if (host.includes('trendyol.com')) {
      const m = u.pathname.match(/-p-(\d+)/);
      if (m) return `trendyol:${m[1]}`;
    }
    if (host.includes('hepsiburada.com')) {
      const m = u.pathname.match(/-p-([a-z0-9]+)$/i);
      if (m) return `hepsiburada:${m[1].toLowerCase()}`;
    }
    return `${host}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

// Verilen normalize linklerden hangileri Firestore'da ZATEN var (kaynaktan bağımsız).
async function checkExistingLinks(db, normalizedLinks) {
  const existing = new Set();
  const unique = [...new Set(normalizedLinks.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    try {
      const snap = await db.collection('discounts')
        .where('normalizedLink', 'in', chunk)
        .select('normalizedLink')
        .get();
      snap.docs.forEach(d => {
        const v = d.data()?.normalizedLink;
        if (v) existing.add(v);
      });
    } catch (e) {
      console.warn(`   ⚠️ [QualityGate] Mükerrer kontrolü hatası: ${e.message}`);
    }
  }
  return existing;
}

async function scoreDealsBatch(apiKey, items) {
  if (!apiKey || items.length === 0) {
    return items.map(it => ({ id: it.id, score: DEFAULT_SCORE_ON_SKIP, reason: 'AI atlandı (anahtar yok), varsayılan geç' }));
  }
  const list = items.map((it, i) =>
    `${i + 1}. id=${it.id} | "${it.title}" | ${it.oldPrice || '?'} TL -> ${it.newPrice} TL | kategori: ${it.category || '?'}`
  ).join('\n');

  const prompt = `Sen İNDİVA uygulamasının kıdemli fırsat editörüsün. Aşağıdaki ${items.length} adayı
iki ayrı boyutta 1-10 puanla:

1) satisPotansiyeli — bu ürün gerçekten SATIN ALINIR mı?
   - Kategori talebi: elektronik, kişisel bakım, ev/mutfak gibi kanıtlanmış yüksek talepli
     kategoriler yüksek puan; niş/nadir ihtiyaç ürünleri düşük puan
   - Fiyat aralığı: dürtüsel satın alma bandında mı (~0-500 TL) yoksa yüksek düşünme
     gerektiren pahalı bir ürün mü (pahalı ürün otomatik düşük puan almaz ama net
     indirim ve marka güveniyle desteklenmeli)
   - Marka tanınırlığı: bilinen/güvenilir marka güven arttırır, bilinmeyen marka düşürür
   - Evrensellik: geniş kitleye mi hitap ediyor, yoksa çok spesifik/dar bir kesime mi

2) ilgiCekicilik — kullanıcı bu kartı görünce durur, tıklar mı?
   - İndirim yüzdesinin görsel çarpıcılığı (%50+ dikkat çeker, tek haneli % çekmez)
   - Başlıktaki "wow" faktörü: tanınan marka adı, ilgi çekici/popüler ürün tipi
   - Fiyat eşiği psikolojisi (yuvarlak/caydırıcı eşiklerin altında kalması artı puan)
   - Trend/mevsimsellik: şu anki mevsim ve gündemle örtüşen ürünler artı puan

Ayrıca genel filtre olarak:
- İndirim oranı gerçekçi mi (mantıksız yüksekse şüpheli, düşürücü)
- Ürün/başlık anlamlı mı, spam veya bozuk veri değil mi (öyleyse ikisine de 1 ver)

Adaylar:
${list}

SADECE JSON array döndür, her id için sırayla:
[{"id":"...","satisPotansiyeli":1-10,"ilgiCekicilik":1-10,"reason":"kısa neden (max 12 kelime)"}]`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://indiva-proxy.vercel.app',
        'X-Title': 'INDIVA Trendyol Scraper',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return items.map(it => ({ id: it.id, score: DEFAULT_SCORE_ON_SKIP, reason: 'AI JSON döndürmedi, varsayılan geç' }));
    const parsed = JSON.parse(match[0]);
    return items.map(it => {
      const found = parsed.find(p => String(p.id) === String(it.id));
      if (!found) return { id: it.id, score: DEFAULT_SCORE_ON_SKIP, reason: 'AI bu id için cevap vermedi, varsayılan geç' };
      const satisPotansiyeli = Number(found.satisPotansiyeli) || DEFAULT_SCORE_ON_SKIP;
      const ilgiCekicilik = Number(found.ilgiCekicilik) || DEFAULT_SCORE_ON_SKIP;
      const score = Math.round((satisPotansiyeli + ilgiCekicilik) / 2);
      return { id: it.id, score, satisPotansiyeli, ilgiCekicilik, reason: String(found.reason || '').slice(0, 100) };
    });
  } catch (err) {
    console.warn(`   ⚠️ [QualityGate] AI puanlama hatası: ${err.message}`);
    return items.map(it => ({ id: it.id, score: DEFAULT_SCORE_ON_SKIP, reason: `AI hata: ${err.message}, varsayılan geç` }));
  }
}

// NOT (Cimri): Cimri adayları bu aşamada henüz cimri.com linkine sahiptir —
// gerçek mağaza linki sadece yayın anında resolveCimriStoreLink ile çözülür.
// scrape.js'in publishBatch'i, Cimri linkini çözdükten SONRA checkExistingLinks
// ile İKİNCİ bir kontrol yapar.
async function runQualityGate(candidates, options = {}) {
  const { apiKey, threshold = DEFAULT_THRESHOLD, db } = options;
  const results = [];
  const survivors = [];

  for (const c of candidates) {
    const priceCheck = checkPriceSanity(c.oldPrice, c.newPrice);
    if (!priceCheck.ok) {
      results.push({ id: c.id, publish: false, reason: `Fiyat kontrolü: ${priceCheck.reason}` });
      continue;
    }
    const linkCheck = checkLinkFormat(c.link);
    if (!linkCheck.ok) {
      results.push({ id: c.id, publish: false, reason: `Link kontrolü: ${linkCheck.reason}` });
      continue;
    }
    survivors.push({ ...c, normalizedLink: normalizeLink(c.link) });
  }
  if (survivors.length === 0) return results;

  let dupSet = new Set();
  if (db) dupSet = await checkExistingLinks(db, survivors.map(c => c.normalizedLink));
  const afterDedup = [];
  survivors.forEach(c => {
    if (dupSet.has(c.normalizedLink)) {
      results.push({ id: c.id, publish: false, reason: 'Mükerrer: bu ürün başka bir kaynaktan zaten yayında' });
      return;
    }
    afterDedup.push(c);
  });
  if (afterDedup.length === 0) return results;

  const scores = await scoreDealsBatch(apiKey, afterDedup);
  afterDedup.forEach(c => {
    const s = scores.find(x => x.id === c.id) || { score: DEFAULT_SCORE_ON_SKIP, reason: 'skor bulunamadı' };
    results.push({
      id: c.id,
      publish: s.score >= threshold,
      score: s.score,
      satisPotansiyeli: s.satisPotansiyeli,
      ilgiCekicilik: s.ilgiCekicilik,
      reason: s.reason,
      normalizedLink: c.normalizedLink,
    });
  });

  return results;
}

module.exports = { runQualityGate, checkPriceSanity, checkLinkFormat, normalizeLink, checkExistingLinks, scoreDealsBatch };
