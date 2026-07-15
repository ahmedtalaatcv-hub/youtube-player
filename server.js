/**
 * ================================================================
 *  YouTube API Server — سيرفر يوتيوب متكامل لمشروع IPTV
 * ================================================================
 *  المتطلبات:
 *    - Node.js 18+ (يحتاج fetch المدمج)
 *    - yt-dlp مثبت على النظام ومتاح في PATH
 *      (تثبيت: pip install -U yt-dlp   أو   sudo apt install yt-dlp)
 *    - ffmpeg (اختياري، لبعض صيغ الدمج)
 *
 *  تشغيل:
 *    npm install
 *    node server.js
 * ================================================================
 */

const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP_TIMEOUT_MS = 25000;      // مهلة تنفيذ yt-dlp لكل طلب
const MAX_BUFFER = 1024 * 1024 * 25; // 25MB لأخراج yt-dlp (فيديوهات بها روابط كثيرة)

/* ================================================================
 * ⚡ Cache — نظام تخزين مؤقت بسيط داخل الذاكرة لتسريع الاستجابة
 * ================================================================ */
class SimpleCache {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    return item.data;
  }
  set(key, data, ttlMs) {
    this.store.set(key, { data, expires: Date.now() + ttlMs });
    return data;
  }
  clear() {
    this.store.clear();
  }
  size() {
    return this.store.size;
  }
}

const cache = new SimpleCache();

const TTL = {
  SUGGEST: 10 * 60 * 1000,      // 10 دقائق
  SEARCH: 5 * 60 * 1000,        // 5 دقائق
  INFO: 10 * 60 * 1000,         // 10 دقائق
  FORMATS: 3 * 60 * 60 * 1000,  // 3 ساعات (روابط yt-dlp تنتهي صلاحيتها بعد ساعات)
  STREAM: 4 * 60 * 60 * 1000,   // 4 ساعات
  LIVE_STREAM: 60 * 1000,       // دقيقة واحدة فقط للبث المباشر (يتغيّر رابطه)
};

/* ================================================================
 * 🛡️ أدوات مساعدة عامة
 * ================================================================ */

// تشغيل yt-dlp بأمان (execFile بدل exec لمنع حقن الأوامر عبر الروابط)
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      args,
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const errLine =
            (stderr || "")
              .split(/\r?\n/)
              .find((l) => l.includes("ERROR")) || error.message;
          reject(new Error(errLine.replace(/^ERROR:\s*/, "").trim()));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// تحويل مخرجات --dump-json (متعددة الأسطر) إلى مصفوفة كائنات
function parseJsonLines(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isYoutubeUrl(u) {
  return /(youtube\.com|youtu\.be)/i.test(u || "");
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function bestThumbnail(v) {
  if (v.thumbnail) return v.thumbnail;
  if (Array.isArray(v.thumbnails) && v.thumbnails.length) {
    return v.thumbnails[v.thumbnails.length - 1].url;
  }
  return v.id ? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` : "";
}

// يلتقط الخطأ داخل async route handler ويحوّله لرد JSON منظم
function safeRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${req.method} ${req.path}]`, err.message);
      res.status(500).json({ error: err.message || "خطأ داخلي في السيرفر" });
    }
  };
}

/* ================================================================
 * 📝 GET /  — توثيق كل الـ Endpoints
 * ================================================================ */
app.get("/", (req, res) => {
  res.json({
    name: "YouTube API Server",
    version: "2.0.0",
    status: "running",
    cacheSize: cache.size(),
    endpoints: [
      {
        method: "GET",
        path: "/suggest?q=",
        description: "🔍 اقتراحات البحث أثناء الكتابة (autocomplete)",
        params: { q: "نص البحث الجزئي (مطلوب)" },
        example: "/suggest?q=%D8%A7%D9%81%D9%84%D8%A7%D9%85",
      },
      {
        method: "GET",
        path: "/ytsearch?q=&limit=",
        description: "📋 بحث عن فيديوهات وإرجاع قائمة نتائج مع الصور والمعلومات",
        params: {
          q: "نص البحث (مطلوب)",
          limit: "عدد النتائج، الافتراضي 20، الحد الأقصى 50",
        },
        example: "/ytsearch?q=cartoon&limit=15",
      },
      {
        method: "GET",
        path: "/video/info?url=",
        description: "🎬 معلومات الفيديو كاملة (العنوان، الوصف، القناة، المشاهدات...)",
        params: { url: "رابط فيديو يوتيوب (مطلوب)" },
        example: "/video/info?url=https://youtube.com/watch?v=XXXX",
      },
      {
        method: "GET",
        path: "/video/formats?url=",
        description: "▶️ جميع روابط التشغيل والجودات المتاحة (فيديو + صوت)",
        params: { url: "رابط فيديو يوتيوب (مطلوب)" },
        example: "/video/formats?url=https://youtube.com/watch?v=XXXX",
      },
      {
        method: "GET",
        path: "/audio?url=",
        description: "🎵 استخراج رابط الصوت فقط (bestaudio)",
        params: { url: "رابط فيديو يوتيوب (مطلوب)" },
        example: "/audio?url=https://youtube.com/watch?v=XXXX",
      },
      {
        method: "GET",
        path: "/youtube?url=&quality=",
        description:
          "⚡ استخراج رابط بث مباشر (متوافق مع الإصدار السابق) — يدعم الفيديوهات والبث المباشر",
        params: {
          url: "رابط يوتيوب (مطلوب)",
          quality: "معرّف الجودة بصيغة yt-dlp، الافتراضي best",
        },
        example: "/youtube?url=https://youtube.com/watch?v=XXXX",
      },
      {
        method: "GET",
        path: "/live/check?url=",
        description: "📺 التحقق مما إذا كان الفيديو/القناة تبث الآن مباشرة",
        params: { url: "رابط قناة أو فيديو يوتيوب (مطلوب)" },
        example: "/live/check?url=https://youtube.com/watch?v=XXXX",
      },
      {
        method: "GET",
        path: "/cache/stats",
        description: "إحصائيات الكاش الحالية",
      },
      {
        method: "POST",
        path: "/cache/clear",
        description: "تفريغ الكاش بالكامل",
      },
    ],
  });
});

/* ================================================================
 * 🔍 GET /suggest — اقتراحات البحث
 * ================================================================ */
app.get(
  "/suggest",
  safeRoute(async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "يجب إرسال معامل q" });

    const cacheKey = `suggest:${q.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const apiUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(
      q
    )}`;

    const r = await fetch(apiUrl);
    if (!r.ok) throw new Error("تعذر الاتصال بخدمة الاقتراحات");
    const data = await r.json();
    const suggestions = Array.isArray(data?.[1]) ? data[1] : [];

    const result = { query: q, suggestions };
    cache.set(cacheKey, result, TTL.SUGGEST);
    res.json({ ...result, cached: false });
  })
);

/* ================================================================
 * 📋 GET /ytsearch — بحث وإرجاع قائمة نتائج
 * ================================================================ */
app.get(
  "/ytsearch",
  safeRoute(async (req, res) => {
    const q = (req.query.q || "").trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 50));

    if (!q) return res.status(400).json({ error: "يجب إرسال معامل q" });

    // لو المستخدم لصق رابط يوتيوب مباشرة داخل حقل البحث
    if (isYoutubeUrl(q)) {
      return res.status(400).json({
        error: "هذا رابط وليس نص بحث، استخدم /youtube?url= بدلاً من ذلك",
      });
    }

    const cacheKey = `search:${q.toLowerCase()}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // --flat-playlist لسرعة أكبر بكثير (بدون جلب تفاصيل كل فيديو)
    const stdout = await runYtDlp([
      "-j",
      "--flat-playlist",
      "--no-warnings",
      `ytsearch${limit}:${q}`,
    ]);

    const items = parseJsonLines(stdout);

    const results = items
      .filter((v) => v.id)
      .map((v) => ({
        videoId: v.id,
        title: v.title || "بدون عنوان",
        channelTitle: v.channel || v.uploader || "",
        channelId: v.channel_id || v.uploader_id || "",
        duration: fmtDuration(v.duration),
        durationSeconds: v.duration || 0,
        thumbnail: bestThumbnail(v),
        viewCount: v.view_count ?? null,
        isLive: !!v.is_live,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      }));

    const result = { query: q, count: results.length, results };
    cache.set(cacheKey, result, TTL.SEARCH);
    res.json({ ...result, cached: false });
  })
);

/* ================================================================
 * 🎬 GET /video/info — معلومات الفيديو كاملة
 * ================================================================ */
app.get(
  "/video/info",
  safeRoute(async (req, res) => {
    const url = req.query.url;
    if (!url || !isValidUrl(url))
      return res.status(400).json({ error: "رابط غير صالح" });

    const cacheKey = `info:${url}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const stdout = await runYtDlp([
      "-j",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);
    const v = JSON.parse(stdout);

    const info = {
      id: v.id,
      title: v.title,
      description: v.description || "",
      channel: v.channel || v.uploader || "",
      channelUrl: v.channel_url || v.uploader_url || "",
      channelId: v.channel_id || v.uploader_id || "",
      duration: fmtDuration(v.duration),
      durationSeconds: v.duration || 0,
      viewCount: v.view_count ?? null,
      likeCount: v.like_count ?? null,
      uploadDate: v.upload_date || null,
      thumbnail: bestThumbnail(v),
      thumbnails: v.thumbnails || [],
      isLive: !!v.is_live,
      wasLive: !!v.was_live,
      liveStatus: v.live_status || null,
      concurrentViewers: v.concurrent_view_count ?? null,
      tags: v.tags || [],
      categories: v.categories || [],
      webpageUrl: v.webpage_url || url,
    };

    cache.set(cacheKey, info, TTL.INFO);
    res.json({ ...info, cached: false });
  })
);

/* ================================================================
 * ▶️ GET /video/formats — جميع روابط التشغيل والجودات
 * ================================================================ */
app.get(
  "/video/formats",
  safeRoute(async (req, res) => {
    const url = req.query.url;
    if (!url || !isValidUrl(url))
      return res.status(400).json({ error: "رابط غير صالح" });

    const cacheKey = `formats:${url}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const stdout = await runYtDlp([
      "-j",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);
    const v = JSON.parse(stdout);

    const formats = (v.formats || [])
      .filter((f) => f.url)
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        quality:
          f.format_note ||
          (f.height ? `${f.height}p` : f.abr ? `${f.abr}kbps` : "unknown"),
        width: f.width || null,
        height: f.height || null,
        fps: f.fps || null,
        vcodec: f.vcodec || "none",
        acodec: f.acodec || "none",
        hasVideo: !!f.vcodec && f.vcodec !== "none",
        hasAudio: !!f.acodec && f.acodec !== "none",
        filesize: f.filesize || f.filesize_approx || null,
        tbr: f.tbr || null,
        protocol: f.protocol || null,
        url: f.url,
      }));

    // ترتيب: فيديو+صوت مدمج أولاً، ثم الأعلى جودة
    formats.sort((a, b) => {
      const aMuxed = a.hasVideo && a.hasAudio;
      const bMuxed = b.hasVideo && b.hasAudio;
      if (aMuxed !== bMuxed) return aMuxed ? -1 : 1;
      return (b.height || 0) - (a.height || 0);
    });

    const result = {
      title: v.title,
      isLive: !!v.is_live,
      formatsCount: formats.length,
      formats,
    };

    cache.set(cacheKey, result, TTL.FORMATS);
    res.json({ ...result, cached: false });
  })
);

/* ================================================================
 * 🎵 GET /audio — استخراج الصوت فقط
 * ================================================================ */
app.get(
  "/audio",
  safeRoute(async (req, res) => {
    const url = req.query.url;
    if (!url || !isValidUrl(url))
      return res.status(400).json({ error: "رابط غير صالح" });

    const cacheKey = `audio:${url}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const [streamOut, titleOut] = await Promise.all([
      runYtDlp(["-f", "bestaudio/best", "-g", "--no-warnings", url]),
      runYtDlp(["--get-title", "--no-warnings", url]),
    ]);

    const lines = streamOut.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error("لم يتم العثور على مسار صوتي");

    const result = {
      youtube: url,
      title: titleOut.trim(),
      audio: lines[0],
      updated: Date.now(),
    };

    cache.set(cacheKey, result, TTL.STREAM);
    res.json({ ...result, cached: false });
  })
);

/* ================================================================
 * ⚡ GET /youtube — استخراج رابط بث (متوافق مع النسخة القديمة)
 *    يدعم الفيديوهات العادية والبث المباشر (Live)
 * ================================================================ */
app.get(
  "/youtube",
  safeRoute(async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!isValidUrl(url))
      return res.status(400).json({ error: "رابط غير صالح" });

    const quality = (req.query.quality || "best").trim();
    const cacheKey = `stream:${url}:${quality}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const [streamOut, infoOut] = await Promise.all([
      runYtDlp(["-f", quality, "-g", "--no-warnings", url]),
      runYtDlp(["-j", "--no-playlist", "--no-warnings", url]),
    ]);

    const lines = streamOut.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error("No stream found");

    const info = JSON.parse(infoOut);

    const result = {
      youtube: url,
      title: info.title,
      stream: lines[0],
      isLive: !!info.is_live,
      duration: fmtDuration(info.duration),
      thumbnail: bestThumbnail(info),
      updated: Date.now(),
    };

    // روابط البث المباشر تتغيّر بسرعة، كاش قصير جدًا
    cache.set(cacheKey, result, info.is_live ? TTL.LIVE_STREAM : TTL.STREAM);
    res.json({ ...result, cached: false });
  })
);

/* ================================================================
 * 📺 GET /live/check — التحقق من حالة البث المباشر
 * ================================================================ */
app.get(
  "/live/check",
  safeRoute(async (req, res) => {
    const url = req.query.url;
    if (!url || !isValidUrl(url))
      return res.status(400).json({ error: "رابط غير صالح" });

    const stdout = await runYtDlp([
      "-j",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);
    const v = JSON.parse(stdout);

    res.json({
      title: v.title,
      isLive: !!v.is_live,
      liveStatus: v.live_status || null,
      concurrentViewers: v.concurrent_view_count ?? null,
    });
  })
);

/* ================================================================
 * ⚡ إدارة الكاش
 * ================================================================ */
app.get("/cache/stats", (req, res) => {
  res.json({ size: cache.size() });
});

app.post("/cache/clear", (req, res) => {
  cache.clear();
  res.json({ cleared: true });
});

/* ================================================================
 * 🛡️ معالجة الأخطاء العامة
 * ================================================================ */
app.use((req, res) => {
  res.status(404).json({ error: "المسار غير موجود", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("خطأ غير متوقع:", err);
  res.status(500).json({ error: "خطأ داخلي في السيرفر" });
});

/* ================================================================
 * تشغيل السيرفر
 * ================================================================ */
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
    console.log("================================");
    console.log("YouTube API Server Running");
    console.log(`Listening on http://${HOST}:${PORT}`);
    console.log("================================");
});
