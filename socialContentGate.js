'use strict';
// socialContentGate.js — Yüksek puanlı fırsatlar için Instagram içerik kuyruğu (CJS ikizi)
//
// D:\INDIVA PANEL APP\scripts\socialContentGate.js (ESM) ile aynı mantık.
// Bildirim eşiğiyle (notifyGate.js) AYNI bar: kalite puanı 9/10+. Soğuma/tavan
// YOK — admin'in panelde seçtiği bir içerik havuzu, kullanıcıya gitmiyor.

const QUEUE_THRESHOLD = 9;

async function generateCaption(apiKey, deal) {
  const { title, newPrice, oldPrice, category, storeName } = deal;
  const discountPct = oldPrice > 0 && newPrice > 0
    ? Math.round(((oldPrice - newPrice) / oldPrice) * 100)
    : 0;

  const fallback = `🔥 %${discountPct} indirim: ${title}\n${Math.floor(newPrice)} TL — ${storeName}\n\nFırsatı kaçırmadan İNDİVA'dan yakala! 📲\n\n#indirim #firsat #kampanya #indivaapp`;
  if (!apiKey) return fallback;

  let GoogleGenAI;
  try { ({ GoogleGenAI } = require('@google/genai')); } catch { return fallback; }
  const genAI = new GoogleGenAI({ apiKey });
  const prompt = `Sen İNDİVA uygulamasının sosyal medya içerik editörü ve satış metni
yazarısın (copywriter). Instagram'da paylaşılacak, ürünü SATMAYA çalışan, indirimli
alışverişe teşvik eden dikkat çekici bir gönderi metni (caption) yaz.

Ürün: "${title}"
Fiyat: ${oldPrice} TL -> ${newPrice} TL (%${discountPct} indirim)
Mağaza: ${storeName || 'bilinmiyor'}
Kategori: ${category || 'bilinmiyor'}

KURALLAR:
1. İlk satır dikkat çekici bir kanca, emoji ile başla (fiyat/indirim vurgulu)
2. Ürünü tanıt ve fırsatı 2-3 cümlede heyecanlı, ikna edici bir satış diliyle anlat
   (abartma/yalan yok ama "kaçırma", "şimdi al", "stoklar tükenmeden" gibi aciliyet
   hissi ver — gerçek bir e-ticaret pazarlamacısı gibi yaz)
3. Son satır MUTLAKA İNDİVA uygulamasını indirmeye teşvik eden, "Sen de İNDİVA'yı
   indir, fırsatları kaçırma!" temalı bir slogan cümlesi olsun (birebir aynı cümleyi
   kullanmak zorunda değilsin, ama anlamı ve enerjisi aynı olsun)
4. Altına 5-8 adet ilgili Türkçe hashtag ekle (#indirim #firsat gibi genel + kategoriye özel + #indivaapp)
5. Emoji kullan ama abartma, samimi bir Instagram tonu olsun
6. SADECE caption metnini döndür, açıklama/markdown ekleme`;

  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.7 },
    });
    const text = (response.text || '').trim();
    if (text) return text;
  } catch (err) {
    console.warn(`   ⚠️ [SosyalİçerikKapısı] Caption üretme hatası: ${err.message}`);
  }
  return fallback;
}

async function maybeQueueSocialContent(db, apiKey, deal) {
  if (process.env.SOCIAL_CONTENT_ENABLED === 'false') {
    return { queued: false, reason: 'SOCIAL_CONTENT_ENABLED=false' };
  }
  const { discountId, title, imageUrl, category, storeName, score, newPrice, oldPrice } = deal;
  if (!(score >= QUEUE_THRESHOLD)) return { queued: false, reason: 'eşik altı' };

  try {
    const caption = await generateCaption(apiKey, { title, newPrice, oldPrice, category, storeName });
    await db.collection('social_content_queue').add({
      discountId, title, imageUrl, category: category || '', storeName: storeName || '',
      newPrice, oldPrice, score, caption,
      status: 'pending',
      createdAt: new Date(),
    });
    console.log(`   📱 [Sosyal İçerik] Kuyruğa eklendi (puan ${score}/10): ${title.substring(0, 40)}`);
    return { queued: true };
  } catch (err) {
    return { queued: false, reason: `Firestore hata: ${err.message}` };
  }
}

module.exports = { maybeQueueSocialContent };
