/**
 * embeddingUtil.js — Ürün Değerlendirme'nin (indiva-panel'deki product_feedback)
 * AI "emsal edinme" kararı için ortak yardımcılar (indiva-panel/scripts/
 * embeddingUtil.js ile aynı mantık, CJS).
 *
 * TASARIM (kullanıcı isteğiyle maliyetsiz kalması için): karar mekanizmasının
 * kendisi LLM'e HİÇ SORMAZ — sadece embedding (vektör) üretimi + cosine
 * similarity + ağırlıklı oy sayımı gibi ucuz/matematiksel işlemlerden oluşur.
 *
 * NOT: Bu bir öneri/danışma sistemidir — sonucu (aiSimilarityJudgment) ilgili
 * ürün dokümanına yazılır ama YAYIN KARARINI ETKİLEMEZ.
 */

const EMBED_MODEL = 'gemini-embedding-001';
const TOP_K = 10;

function buildEmbeddingText({ title, brand, category, storeName }) {
    return [title, brand, category, storeName].filter(Boolean).join(' · ').slice(0, 500);
}

async function getEmbedding(text, apiKey) {
    if (!apiKey || !text) return null;
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: text.slice(0, 2000) }] } }),
                signal: AbortSignal.timeout(15000),
            }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const values = data?.embedding?.values;
        return Array.isArray(values) && values.length ? values : null;
    } catch {
        return null;
    }
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function judgeBySimilarity(candidateEmbedding, feedbackDocs, k = TOP_K) {
    if (!candidateEmbedding || !feedbackDocs?.length) {
        return { decision: 'unknown', score: 0, matchCount: 0 };
    }
    const scored = feedbackDocs
        .filter(d => Array.isArray(d.embedding) && d.embedding.length)
        .map(d => ({ sim: cosineSimilarity(candidateEmbedding, d.embedding), rating: d.rating }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k);

    if (scored.length === 0) return { decision: 'unknown', score: 0, matchCount: 0 };

    const weightedSum = scored.reduce((sum, s) => sum + (s.rating === 'positive' ? s.sim : -s.sim), 0);
    const decision = weightedSum > 0 ? 'positive' : weightedSum < 0 ? 'negative' : 'unknown';
    return { decision, score: Number(weightedSum.toFixed(3)), matchCount: scored.length };
}

/** product_feedback embedding'lerini indiva-panel'in Firestore projesinden çeker (aynı Firebase projesi). */
async function loadFeedbackEmbeddings(db) {
    const snap = await db.collection('product_feedback').select('embedding', 'rating').get();
    return snap.docs
        .map(d => d.data())
        .filter(d => Array.isArray(d.embedding) && d.embedding.length && d.rating);
}

module.exports = { buildEmbeddingText, getEmbedding, cosineSimilarity, judgeBySimilarity, loadFeedbackEmbeddings };
