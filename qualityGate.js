'use strict';
// qualityGate.js — Yayın öncesi temel doğrulama kapısı (CJS ikizi)
//
// D:\INDIVA PANEL APP\scripts\qualityGate.js (ESM) ile aynı mantık; bu klasör
// CommonJS kullandığı ve taşınabilir/tek-klasör kurulum gerektirdiği için
// (bkz. KURULUM-REHBERI.txt) burada ayrı bir kopya tutuluyor.
//
// NOT: AI zevk/beğeni puanlaması (satisPotansiyeli/ilgiCekicilik + eşik)
// kullanıcı talebiyle kaldırıldı — "kafasına göre derecelendirip yayınlamayı
// engellemesin" istendi. Artık yalnızca temel veri bütünlüğü (fiyat/link
// geçerliliği) ve kaynaklar arası mükerrer kontrolü yapılır.
//
// NOT: HTTP tabanlı bir "ölü link" kontrolü YOKTUR — kasıtlı olarak. Canlı
// testte doğrulandı: Playwright ile az önce scrape edilmiş, gerçekte canlı bir
// Trendyol linki, bare fetch() HEAD isteğine 404, GET isteğine 403 döndürdü.
// Bot koruması yüzünden HTTP durum koduna güvenmek yanlış-pozitif üretiyor ve
// iyi fırsatları gereksiz yere eliyordu. Gerçek canlılık kontrolü
// price-checker.js'in içerik-tabanlı, AI destekli, 2 kademeli teyitli
// sistemine bırakılmıştır.

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

// NOT (Cimri): Cimri adayları bu aşamada henüz cimri.com linkine sahiptir —
// gerçek mağaza linki sadece yayın anında resolveCimriStoreLink ile çözülür.
// scrape.js'in publishBatch'i, Cimri linkini çözdükten SONRA checkExistingLinks
// ile İKİNCİ bir kontrol yapar.
async function runQualityGate(candidates, options = {}) {
  const { db } = options;
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
  survivors.forEach(c => {
    if (dupSet.has(c.normalizedLink)) {
      results.push({ id: c.id, publish: false, reason: 'Mükerrer: bu ürün başka bir kaynaktan zaten yayında' });
      return;
    }
    results.push({ id: c.id, publish: true, reason: 'Otomatik onay (kalite/beğeni filtresi kaldırıldı)', normalizedLink: c.normalizedLink });
  });

  return results;
}

module.exports = { runQualityGate, checkPriceSanity, checkLinkFormat, normalizeLink, checkExistingLinks };
