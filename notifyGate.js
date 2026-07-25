'use strict';
// notifyGate.js — Yüksek puanlı fırsatlar için NADİR push bildirimi (CJS ikizi)
//
// D:\INDIVA PANEL APP\scripts\notifyGate.js (ESM) ile aynı mantık.
//
// GEÇMİŞ (ÖNEMLİ): Bu özellik önceden vardı ve KAPATILMIŞTI çünkü kullanıcılar
// her yeni ürün için bildirim almak istemiyordu. Üç fren var:
//   1) Çok sıkı eşik (10 üzerinden 9+)
//   2) Soğuma süresi (min 45 dk)
//   3) Günlük tavan (en fazla 4/gün)
// Tekrar şikayet gelirse NOTIFICATIONS_ENABLED=false ile kapatılır.

const NOTIFY_THRESHOLD = 9;
const COOLDOWN_MS = 45 * 60 * 1000;
const DAILY_CAP = 4;

async function maybeNotifyHighScoreDeal(db, messaging, deal) {
  if (process.env.NOTIFICATIONS_ENABLED === 'false') {
    return { sent: false, reason: 'NOTIFICATIONS_ENABLED=false' };
  }
  const { docId, title, imageUrl, score, newPrice, oldPrice } = deal;
  if (!(score >= NOTIFY_THRESHOLD)) return { sent: false, reason: 'eşik altı' };

  const STATE = db.collection('scraper_control').doc('notification_state');
  const today = new Date().toISOString().slice(0, 10);

  let allowed = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(STATE);
      const d = snap.exists ? snap.data() : {};
      const lastSentAt = d.lastSentAt || 0;
      const sentToday = d.dateKey === today ? (d.sentToday || 0) : 0;

      if (Date.now() - lastSentAt < COOLDOWN_MS) return;
      if (sentToday >= DAILY_CAP) return;

      allowed = true;
      tx.set(STATE, { lastSentAt: Date.now(), dateKey: today, sentToday: sentToday + 1 }, { merge: true });
    });
  } catch (e) {
    return { sent: false, reason: `Firestore hata: ${e.message}` };
  }

  if (!allowed) return { sent: false, reason: 'soğuma süresi veya günlük tavan' };

  const discountPct = oldPrice > 0 && newPrice > 0
    ? Math.round(((oldPrice - newPrice) / oldPrice) * 100)
    : 0;
  const body = discountPct > 0
    ? `%${discountPct} indirim: ${title} — ${Math.floor(newPrice)} TL`
    : `${title} — ${Math.floor(newPrice)} TL`;

  try {
    await messaging.send({
      notification: {
        title: '🚨 İndiva Fırsat Alarmı',
        body,
        ...(imageUrl ? { image: imageUrl } : {}),
      },
      topic: 'all_users',
      data: { url: `https://indiva.app/discount/${docId}` },
      android: {
        priority: 'high',
        notification: { channelId: 'indiva_notifications', sound: 'default' },
      },
    });
    console.log(`   🚨 [Bildirim] Gönderildi (puan ${score}/10): ${title.substring(0, 40)}`);
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `FCM hata: ${e.message}` };
  }
}

module.exports = { maybeNotifyHighScoreDeal };
