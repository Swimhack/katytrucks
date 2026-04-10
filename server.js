'use strict';
require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3155;
const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed');
const JOBS_FILE     = path.join(__dirname, 'jobs.json');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY || '';
const AYRSHARE_KEY   = process.env.AYRSHARE_KEY  || '';
const JAMES_EMAIL    = 'james@stricklandtechnology.net';
const ERIC_EMAIL     = process.env.ERIC_EMAIL || '';
const DEALER_NAME    = 'Katy Truck & Equipment Sales';
const DEALER_PHONE   = '(281) 891-0597';
const BASE_URL       = process.env.BASE_URL || 'https://stricklandtechnology.net/trucks';

// ── Access control ───────────────────────────────────────
// Admin dashboard + admin API routes require HTTP Basic auth.
// Client gallery requires the CLIENT_TOKEN query param (?t=...).
// Individual video URLs use a per-job accessToken minted at upload time.
const ADMIN_USER   = process.env.ADMIN_USER   || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS   || '';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || '';

// Fonts
const FONT_BOLD   = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_NORMAL = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

[UPLOADS_DIR, PROCESSED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { return []; }
}
function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}
function updateJob(id, patch) {
  const jobs = loadJobs();
  const j = jobs.find(x => x.id === id);
  if (j) { Object.assign(j, patch); saveJobs(jobs); }
}

// Multer
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /video\/(mp4|quicktime|x-msvideo|webm|3gpp)|image\/(jpeg|png|jpg)/.test(file.mimetype);
    if (!ok) return cb(new Error('Please upload a video or image file.'));
    cb(null, true);
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Admin Basic auth middleware ──────────────────────────
function adminAuth(req, res, next) {
  if (!ADMIN_PASS) {
    // Fail closed in production; fail open only if explicitly no password set AND not on a public host
    return res.status(503).send('Admin disabled: set ADMIN_PASS in environment.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Truck Autopilot Admin"');
  return res.status(401).send('Authentication required.');
}

function isAdmin(req) {
  if (!ADMIN_PASS) return false;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  return u === ADMIN_USER && p === ADMIN_PASS;
}

// ── Per-job access token helpers ─────────────────────────
function mintToken() { return crypto.randomBytes(24).toString('hex'); }

// Backfill: any legacy job without an accessToken gets one now. Returns the
// token so callers can build URLs without an extra disk read.
function ensureAccessToken(jobId) {
  const jobs = loadJobs();
  const j = jobs.find(x => x.id === jobId);
  if (!j) return null;
  if (!j.accessToken) {
    j.accessToken = mintToken();
    saveJobs(jobs);
  }
  return j.accessToken;
}

// Build the public URL a client should use to play/download a variant.
// variant: 'main' (the overlaid mp4), 'popcorn' (the popcorn variant), or 'original'.
function videoUrl(job, variant = 'main') {
  const tok = job.accessToken || ensureAccessToken(job.id);
  if (!tok) return null;
  return `${BASE_URL}/v/${job.id}/${variant}?t=${tok}`;
}

// Resolve a variant name to an on-disk file path for a given job.
function resolveVariantPath(job, variant) {
  switch (variant) {
    case 'main':     return job.processedFile || null;
    case 'popcorn':  return job.popcornFile   || null;
    case 'original': return job.originalFile  || null;
    default:         return null;
  }
}

// ── Authenticated video delivery ─────────────────────────
// Streams the requested variant if ?t= matches the job's accessToken OR the
// caller is authenticated as admin. Replaces the old unauthenticated
// `app.use('/processed', express.static(...))` mount.
app.get('/v/:id/:variant', (req, res) => {
  const jobs = loadJobs();
  const job  = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).send('Not found');

  const ok = (req.query.t && job.accessToken && req.query.t === job.accessToken) || isAdmin(req);
  if (!ok) return res.status(403).send('Forbidden');

  const filePath = resolveVariantPath(job, req.params.variant);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  // Let Express handle Range requests, content-type, etc.
  return res.sendFile(path.resolve(filePath));
});

// SMTP via Zoho
const mailer = nodemailer.createTransport({
  host: 'smtp.zoho.com', port: 587, secure: false,
  auth: { user: JAMES_EMAIL, pass: process.env.SMTP_PASS || 'rPpXS6FM0hqd' }
});

// ── Escape text for FFmpeg drawtext ──────────────────────
function ffEsc(str) {
  // Strip all chars that break FFmpeg drawtext
  return String(str || '')
    .replace(/[$,\\:'"\[\]{}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Professional ad overlay via FFmpeg ───────────────────
function buildOverlay(specs) {
  const { year, make, model, mileage, price, financing } = specs;
  const truck      = ffEsc(`${year} ${make} ${model}`.toUpperCase());
  const priceNum   = price ? Number(price) : 0;
  const priceStr   = priceNum > 0 ? priceNum.toLocaleString().replace(/,/g,'') + ' OBO' : 'CALL FOR PRICE';
  const milesNum   = mileage ? Number(mileage) : 0;
  const milesStr   = milesNum > 0 ? milesNum.toLocaleString().replace(/,/g,'') + ' MI' : '';
  const finStr     = financing === 'yes' ? ' | FINANCING AVAIL' : '';
  const phone      = DEALER_PHONE.replace(/[()\s]/g, '-').replace(/--/g,'-');
  const infoLine   = ffEsc(`${milesStr}${finStr} | ${phone}`);
  const dealerLine = ffEsc(DEALER_NAME.toUpperCase());
  const priceEsc   = ffEsc(priceStr);

  // Bar height: 140px from bottom. Layers:
  //  1) Semi-transparent black bar
  //  2) Red accent line at top of bar
  //  3) Dealer name (small, gray, top of bar)
  //  4) Truck title (large white bold)
  //  5) Price (large red bold)
  //  6) Info line (small gray)
  //  7) Small "Tap to Call" badge top-right
  return [
    // Normalize pixel format first (handles iPhone HEVC/MOV)
    `format=yuv420p`,
    // Dark gradient bar
    `drawbox=x=0:y=ih-150:w=iw:h=150:color=0x000000BB:t=fill`,
    // Red accent top border
    `drawbox=x=0:y=ih-150:w=iw:h=4:color=0xDC2626FF:t=fill`,
    // Dealer name (top of bar, small)
    `drawtext=fontfile=${FONT_NORMAL}:text='${dealerLine}':fontsize=20:fontcolor=0xFFFFFF88:x=20:y=h-142`,
    // Truck title
    `drawtext=fontfile=${FONT_BOLD}:text='${truck}':fontsize=42:fontcolor=white:x=20:y=h-115`,
    // Price (red, bold)
    `drawtext=fontfile=${FONT_BOLD}:text='${priceEsc}':fontsize=38:fontcolor=0xEF4444FF:x=20:y=h-68`,
    // Info line
    `drawtext=fontfile=${FONT_NORMAL}:text='${infoLine}':fontsize=22:fontcolor=0xFFFFFFAA:x=20:y=h-30`,
    // "CALL NOW" badge top-right
    `drawbox=x=iw-160:y=ih-145:w=150:h=40:color=0xDC2626FF:t=fill`,
    `drawtext=fontfile=${FONT_BOLD}:text='CALL NOW':fontsize=20:fontcolor=white:x=w-145:y=h-138`,
  ].join(',');
}

// ── Process video with FFmpeg ─────────────────────────────
function processVideo(inputPath, outputPath, specs) {
  return new Promise((resolve, reject) => {
    const vf  = buildOverlay(specs);
    // Portrait crop for Reels/TikTok (9:16) stored separately
    const cmd = [
      'ffmpeg -y',
      `-i "${inputPath}"`,
      `-vf "${vf}"`,
      '-c:v libx264 -preset fast -crf 20',
      '-c:a aac -b:a 128k',
      '-movflags +faststart',
      '-pix_fmt yuv420p',
      `"${outputPath}"`,
      '2>&1'
    ].join(' ');

    exec(cmd, { timeout: 360000 }, (err, out) => {
      if (err) return reject(new Error('Video processing failed: ' + out.slice(-400)));
      resolve(outputPath);
    });
  });
}

// ── Generate captions with Claude ────────────────────────
async function generateCaptions(specs) {
  const { year, make, model, mileage, price, financing, notes } = specs;
  const truck   = `${year} ${make} ${model}`;
  const priceStr = price ? `$${Number(price).toLocaleString()}` : 'Call for Price';
  const finStr  = financing === 'yes' ? 'Financing available.' : '';
  const notesTxt = notes ? `Details: ${notes}` : '';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `You write scroll-stopping social media posts for a truck dealership. Write 3 captions for this truck. Be direct, energetic, and sales-focused.

Truck: ${truck}
Mileage: ${mileage ? Number(mileage).toLocaleString() + ' miles' : 'N/A'}
Price: ${priceStr}
Financing: ${finStr || 'No'}
${notesTxt}
Dealer: ${DEALER_NAME}
Phone: ${DEALER_PHONE}
Address: 5349 Hwy Blvd, Katy TX 77494

Return ONLY valid JSON with keys: facebook, instagram, tiktok
- facebook: 120-180 words. Specs, price, financing, location, phone. 3-4 hashtags. Professional but exciting.
- instagram: 60-90 words. Punchy, emojis, strong hook first line, price, phone. 8-10 hashtags.
- tiktok: 30-50 words. Very short. Hooky opener. Price. Phone. 5 relevant hashtags including #trucksoftiktok`
      }]
    });

    const text = msg.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(text);
  } catch (e) {
    console.error('Caption error:', e.message);
    // Fallback captions
    const truck = `${specs.year} ${specs.make} ${specs.model}`;
    const p = specs.price ? `$${Number(specs.price).toLocaleString()}` : 'Call for price';
    return {
      facebook: `🚛 Just Listed: ${truck}\n\nPriced at ${p}${specs.mileage ? ` with ${Number(specs.mileage).toLocaleString()} miles` : ''}. ${specs.financing === 'yes' ? 'Financing available — ' : ''}ready to work. Come see it at 5349 Hwy Blvd, Katy TX.\n\n📞 Call Eric at ${DEALER_PHONE}\n\n#KatyTrucks #TruckForSale #CommercialTruck #TexasTrucks`,
      instagram: `🔥 ${truck} — ${p} 🚛\n${specs.mileage ? Number(specs.mileage).toLocaleString() + ' miles. ' : ''}${specs.financing === 'yes' ? 'Financing available! ' : ''}Call ${DEALER_PHONE} 📞\n\n#KatyTrucks #TruckLife #TruckForSale #HeavyEquipment #Texas #CommercialTruck #PeterbiltNation #Freightliner #TruckDriver`,
      tiktok: `${truck} for ${p}! 🚛🔥 ${specs.financing === 'yes' ? 'Financing available — ' : ''}Call ${DEALER_PHONE} #trucksoftiktok #katytrucks #truckforsale #semitruck #texas`
    };
  }
}

// ── Notify James by email ─────────────────────────────────
async function notifyJames(job) {
  const videoLink = job.processedFile ? videoUrl(job, 'main') : null;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:620px;color:#111">
  <div style="background:#dc2626;padding:1.5rem;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0">🚛 New Truck Ready to Post</h2>
  </div>
  <div style="background:#f9f9f9;padding:1.5rem;border:1px solid #e5e5e5;border-top:none">
    <h3 style="margin:0 0 0.5rem">${job.specs.year} ${job.specs.make} ${job.specs.model}</h3>
    <p style="color:#555;margin:0 0 1.5rem">
      Price: <strong>$${Number(job.specs.price||0).toLocaleString()}</strong> &nbsp;·&nbsp;
      Miles: <strong>${Number(job.specs.mileage||0).toLocaleString()}</strong> &nbsp;·&nbsp;
      Financing: <strong>${job.specs.financing === 'yes' ? 'Yes' : 'No'}</strong>
    </p>
    ${videoLink ? `<p><a href="${videoLink}" style="background:#dc2626;color:#fff;padding:0.75rem 1.5rem;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">⬇ Download Processed Video</a></p>` : ''}
    <hr style="margin:1.5rem 0;border:none;border-top:1px solid #e5e5e5">
    <h4 style="color:#1877f2;margin:0 0 0.5rem">📘 Facebook</h4>
    <p style="background:#fff;border:1px solid #e5e5e5;padding:1rem;border-radius:6px;white-space:pre-wrap;font-size:0.9rem">${(job.captions?.facebook||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>
    <h4 style="color:#e1306c;margin:1rem 0 0.5rem">📸 Instagram</h4>
    <p style="background:#fff;border:1px solid #e5e5e5;padding:1rem;border-radius:6px;white-space:pre-wrap;font-size:0.9rem">${(job.captions?.instagram||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>
    <h4 style="color:#69c9d0;margin:1rem 0 0.5rem">🎵 TikTok</h4>
    <p style="background:#fff;border:1px solid #e5e5e5;padding:1rem;border-radius:6px;white-space:pre-wrap;font-size:0.9rem">${(job.captions?.tiktok||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>
    <hr style="margin:1.5rem 0;border:none;border-top:1px solid #e5e5e5">
    <a href="${BASE_URL}/admin" style="background:#111;color:#fff;padding:0.75rem 1.5rem;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">Open Admin Dashboard</a>
  </div>
</div>`;

  await mailer.sendMail({
    from: `"Truck Autopilot" <${JAMES_EMAIL}>`,
    to: JAMES_EMAIL,
    subject: `🚛 ${job.specs.year} ${job.specs.make} ${job.specs.model} — Ready to Post`,
    html
  });
}


// ── Notify Eric by email (replaces Ayrshare) ─────────────
async function notifyEric(job) {
  if (!ERIC_EMAIL) return; // No email configured, skip
  const videoLink   = job.processedFile ? videoUrl(job, 'main')    : null;
  const popcornLink = job.popcornFile   ? videoUrl(job, 'popcorn') : null;
  const galleryLink = CLIENT_TOKEN      ? `${BASE_URL}/gallery?t=${CLIENT_TOKEN}` : null;
  const truck = `${job.specs.year} ${job.specs.make} ${job.specs.model}`;

  const platformSection = (name, icon, color, caption) => `
<div style="margin-bottom:1.5rem">
  <div style="background:${color};color:#fff;padding:0.5rem 1rem;border-radius:8px 8px 0 0;font-weight:700;font-size:0.85rem;font-family:Arial,sans-serif">${icon} ${name} — copy and paste this</div>
  <div style="background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;padding:1rem;border-radius:0 0 8px 8px;font-size:0.9rem;line-height:1.6;white-space:pre-wrap;font-family:Arial,sans-serif;color:#222">${(caption||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
</div>`;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
  <div style="background:#dc2626;padding:1.5rem;border-radius:8px 8px 0 0;text-align:center">
    <h2 style="color:#fff;margin:0;font-size:1.4rem">🚛 Your Truck Is Ready to Post!</h2>
    <p style="color:rgba(255,255,255,0.85);margin:0.4rem 0 0;font-size:0.9rem">${truck}</p>
  </div>
  <div style="background:#fff;padding:1.5rem;border:1px solid #e0e0e0;border-top:none">
    <p style="margin:0 0 1.25rem;color:#444;font-size:0.95rem">Your branded video is done and your captions are ready. Download the video, then copy each caption and post.</p>
    ${videoLink ? `<div style="text-align:center;margin-bottom:1.5rem">
      <a href="${videoLink}" style="background:#dc2626;color:#fff;padding:0.875rem 2rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;display:inline-block">⬇ Download Your Video</a>
      ${popcornLink ? `<br><a href="${popcornLink}" style="color:#dc2626;font-size:0.85rem;display:inline-block;margin-top:0.6rem">Download popcorn variant</a>` : ''}
    </div>` : ''}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:0 0 1.5rem">
    ${platformSection('Facebook', '📘', '#1877f2', job.captions?.facebook)}
    ${platformSection('Instagram', '📸', '#e1306c', job.captions?.instagram)}
    ${platformSection('TikTok', '🎵', '#010101', job.captions?.tiktok)}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:1.5rem 0 1rem">
    ${galleryLink ? `<p style="text-align:center;margin:0 0 1rem"><a href="${galleryLink}" style="color:#dc2626;font-weight:700;text-decoration:none">🎞 Open your video gallery</a></p>` : ''}
    <p style="color:#888;font-size:0.8rem;margin:0;text-align:center">Questions? Call James at (713) 444-6732</p>
  </div>
</div>`;

  await mailer.sendMail({
    from: `"Truck Autopilot" <${JAMES_EMAIL}>`,
    to: ERIC_EMAIL,
    subject: `🚛 ${truck} — Ready to Post! Video + Captions Inside`,
    html
  });
}

// ── Post via Ayrshare ─────────────────────────────────────
async function postViaAyrshare(job) {
  if (!AYRSHARE_KEY) return null;
  // Ayrshare must be able to fetch the media, so the token is embedded in the URL.
  const videoLink = job.processedFile ? videoUrl(job, 'main') : null;
  const platforms = ['facebook', 'instagram', 'tiktok'];
  const results = {};
  for (const p of platforms) {
    try {
      const body = {
        post: job.captions?.[p] || job.captions?.facebook || '',
        platforms: [p]
      };
      if (videoLink) { body.mediaUrls = [videoLink]; body.isVideo = true; }
      const r = await fetch('https://app.ayrshare.com/api/post', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AYRSHARE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      results[p] = await r.json();
    } catch (e) { results[p] = { error: e.message }; }
  }
  return results;
}

// ─── ROUTES ──────────────────────────────────────────────

// Eric's upload page
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post a Truck — Katy Truck & Equipment Sales</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Plus Jakarta Sans',sans-serif;background:#080808;color:#fff;min-height:100vh;padding:1.5rem 1rem 3rem;display:flex;flex-direction:column;align-items:center}
.wrap{width:100%;max-width:500px;margin-top:0.5rem}
.header{text-align:center;padding:1.5rem 0 1.75rem}
.header-badge{display:inline-block;background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.35);color:#ef4444;font-size:0.7rem;font-weight:700;padding:0.3rem 0.9rem;border-radius:50px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:1rem}
.header h1{font-size:1.65rem;font-weight:800;line-height:1.15}
.header h1 span{color:#ef4444}
.header p{color:rgba(255,255,255,0.45);font-size:0.875rem;margin-top:0.4rem}
.card{background:#111;border:1px solid #1f1f1f;border-radius:20px;padding:2rem}
.upload-zone{border:2px dashed #2a2a2a;border-radius:14px;padding:2.5rem 1.5rem;text-align:center;cursor:pointer;transition:all 0.2s;position:relative;margin-bottom:0.25rem}
.upload-zone:hover,.upload-zone.drag{border-color:#ef4444;background:rgba(220,38,38,0.04)}
.upload-zone input[type=file]{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}
.upload-icon{font-size:2.75rem;margin-bottom:0.6rem;display:block}
.upload-main{font-weight:700;font-size:1rem;color:#fff}
.upload-sub{color:rgba(255,255,255,0.35);font-size:0.8rem;margin-top:0.35rem}
.file-name{color:#ef4444;font-size:0.82rem;margin-top:0.75rem;font-weight:600;min-height:1.2em}
.field-group{margin-top:1.25rem}
label{display:block;font-size:0.72rem;font-weight:700;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:0.4rem}
input[type=text],input[type=number],select,textarea{width:100%;background:#181818;border:1.5px solid #242424;border-radius:10px;padding:0.8rem 1rem;color:#fff;font-size:0.95rem;font-family:inherit;outline:none;transition:border-color 0.2s;-webkit-appearance:none}
input:focus,select:focus,textarea:focus{border-color:#ef4444}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23666' d='M6 8L0 0h12z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 1rem center;padding-right:2.5rem}
select option{background:#181818}
textarea{resize:vertical;min-height:75px;line-height:1.5}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0.875rem}
.submit-btn{width:100%;margin-top:1.75rem;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;padding:1rem;border:none;border-radius:12px;font-weight:800;font-size:1.05rem;font-family:inherit;cursor:pointer;letter-spacing:0.3px;transition:opacity 0.2s;box-shadow:0 4px 20px rgba(220,38,38,0.3)}
.submit-btn:hover:not(:disabled){opacity:0.92}
.submit-btn:disabled{opacity:0.4;cursor:not-allowed}
.status-bar{display:none;margin-top:1.25rem;background:#181818;border:1px solid #2a2a2a;border-radius:12px;padding:1.25rem;text-align:center}
.status-bar .icon{font-size:1.75rem;display:block;margin-bottom:0.5rem}
.status-bar p{color:rgba(255,255,255,0.6);font-size:0.9rem;line-height:1.5}
.progress-bar{height:4px;background:#2a2a2a;border-radius:50px;margin-top:1rem;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#dc2626,#ef4444);border-radius:50px;width:0%;transition:width 0.5s ease}
.success-card{display:none;margin-top:1.25rem;background:#052e16;border:1.5px solid #166534;border-radius:16px;padding:2rem;text-align:center}
.success-card .icon{font-size:3rem;display:block;margin-bottom:0.75rem}
.success-card h3{font-size:1.2rem;font-weight:800;color:#4ade80;margin-bottom:0.5rem}
.success-card p{color:rgba(255,255,255,0.5);font-size:0.875rem;line-height:1.6}
.error-card{display:none;margin-top:1.25rem;background:#2d0a0a;border:1.5px solid #7f1d1d;border-radius:16px;padding:1.5rem;text-align:center}
.error-card p{color:#fca5a5;font-size:0.9rem}
.footer-note{text-align:center;color:rgba(255,255,255,0.2);font-size:0.75rem;margin-top:1.5rem}
@media(max-width:400px){.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="header-badge">Powered by Strickland Technology</div>
    <h1><span>Katy Truck</span> & Equipment</h1>
    <p>Upload once. Posted everywhere automatically.</p>
  </div>

  <div class="card">
    <div class="upload-zone" id="uploadZone">
      <input type="file" id="fileInput" accept="video/*,image/jpeg,image/png" required>
      <span class="upload-icon">🚛</span>
      <div class="upload-main">Tap to add your truck video</div>
      <div class="upload-sub">MP4, MOV, or photos — up to 500MB</div>
      <div class="file-name" id="fileName"></div>
    </div>

    <form id="truckForm">
      <div class="row">
        <div class="field-group">
          <label>Year</label>
          <input type="number" id="year" placeholder="2022" min="1990" max="2026" required>
        </div>
        <div class="field-group">
          <label>Make</label>
          <input type="text" id="make" placeholder="Peterbilt" required>
        </div>
      </div>
      <div class="row">
        <div class="field-group">
          <label>Model</label>
          <input type="text" id="model" placeholder="389">
        </div>
        <div class="field-group">
          <label>Mileage</label>
          <input type="number" id="mileage" placeholder="480000">
        </div>
      </div>
      <div class="row">
        <div class="field-group">
          <label>Asking Price ($)</label>
          <input type="number" id="price" placeholder="89500" required>
        </div>
        <div class="field-group">
          <label>Financing?</label>
          <select id="financing">
            <option value="yes">Yes — Available</option>
            <option value="no">No</option>
          </select>
        </div>
      </div>
      <div class="field-group">
        <label>Extra Details (optional)</label>
        <textarea id="notes" placeholder="Engine, transmission, upgrades, condition..."></textarea>
      </div>

      <button type="submit" class="submit-btn" id="submitBtn">🚀 Submit for Posting</button>
    </form>

    <div class="status-bar" id="statusBar">
      <span class="icon" id="statusIcon">⏳</span>
      <p id="statusMsg">Uploading your video...</p>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    </div>

    <div class="success-card" id="successCard">
      <span class="icon">✅</span>
      <h3>Truck Submitted!</h3>
      <p>We're processing your video and getting it ready to post across Facebook, Instagram, and TikTok. You'll hear from us shortly.</p>
    </div>

    <div class="error-card" id="errorCard">
      <p id="errorMsg">Something went wrong. Please try again or call (713) 444-6732.</p>
    </div>
  </div>

  <div class="footer-note">Katy Truck & Equipment Sales · Katy, TX · (281) 891-0597</div>
</div>

<script>
const fileInput = document.getElementById('fileInput');
const fileName  = document.getElementById('fileName');
const uploadZone = document.getElementById('uploadZone');
const form      = document.getElementById('truckForm');
const submitBtn = document.getElementById('submitBtn');
const statusBar = document.getElementById('statusBar');
const statusMsg = document.getElementById('statusMsg');
const statusIcon = document.getElementById('statusIcon');
const progressFill = document.getElementById('progressFill');
const successCard = document.getElementById('successCard');
const errorCard  = document.getElementById('errorCard');
const errorMsg   = document.getElementById('errorMsg');

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) {
    fileName.textContent = '✓ ' + fileInput.files[0].name;
    uploadZone.style.borderColor = '#ef4444';
  }
});
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag'); });
['dragleave','drop'].forEach(ev => uploadZone.addEventListener(ev, () => uploadZone.classList.remove('drag')));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) {
    fileInput.files = e.dataTransfer.files;
    fileName.textContent = '✓ ' + e.dataTransfer.files[0].name;
  }
});

function setStatus(icon, msg, pct) {
  statusIcon.textContent = icon;
  statusMsg.textContent  = msg;
  progressFill.style.width = pct + '%';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files[0]) { alert('Please select a video or photo first.'); return; }

  const required = ['year','make','price'];
  for (const f of required) {
    if (!document.getElementById(f).value.trim()) {
      alert('Please fill in ' + f + ' before submitting.'); return;
    }
  }

  submitBtn.disabled = true;
  form.style.opacity = '0.4';
  form.style.pointerEvents = 'none';
  statusBar.style.display = 'block';
  setStatus('📤', 'Uploading your video...', 15);

  const fd = new FormData();
  fd.append('video',     fileInput.files[0]);
  fd.append('year',      document.getElementById('year').value);
  fd.append('make',      document.getElementById('make').value);
  fd.append('model',     document.getElementById('model').value);
  fd.append('mileage',   document.getElementById('mileage').value);
  fd.append('price',     document.getElementById('price').value);
  fd.append('financing', document.getElementById('financing').value);
  fd.append('notes',     document.getElementById('notes').value);

  // Simulate progress while uploading
  let pct = 15;
  const ticker = setInterval(() => {
    if (pct < 85) { pct += 3; progressFill.style.width = pct + '%'; }
    if (pct > 30)  setStatus('🔧', 'Adding professional overlay...', pct);
    if (pct > 55)  setStatus('✍️', 'Writing captions for each platform...', pct);
    if (pct > 75)  setStatus('📨', 'Almost done...', pct);
  }, 1800);

  try {
    const res = await fetch('/upload', { method: 'POST', body: fd });
    clearInterval(ticker);
    const data = await res.json();
    if (data.ok) {
      setStatus('✅', 'Done!', 100);
      setTimeout(() => {
        statusBar.style.display = 'none';
        successCard.style.display = 'block';
      }, 600);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    clearInterval(ticker);
    statusBar.style.display  = 'none';
    form.style.opacity       = '1';
    form.style.pointerEvents = 'auto';
    submitBtn.disabled       = false;
    errorMsg.textContent     = 'Something went wrong: ' + err.message + '. Please try again or call (713) 444-6732.';
    errorCard.style.display  = 'block';
  }
});
</script>
</body>
</html>`);
});

// ── Upload + process handler ──────────────────────────────
app.post('/upload', upload.single('video'), async (req, res) => {
  // Respond immediately so client doesn't time out on large files
  const jobId = uuidv4();
  const file  = req.file;

  if (!file) return res.status(400).json({ error: 'No file received. Please try again.' });

  const specs = {
    year:      req.body.year      || '',
    make:      req.body.make      || '',
    model:     req.body.model     || '',
    mileage:   req.body.mileage   || '',
    price:     req.body.price     || '',
    financing: req.body.financing || 'no',
    notes:     req.body.notes     || ''
  };

  const isVideo = file.mimetype.startsWith('video/');
  const accessToken = mintToken();
  const job = {
    id:            jobId,
    createdAt:     new Date().toISOString(),
    specs,
    originalFile:  file.path,
    processedFile: null,
    popcornFile:   null,
    isVideo,
    captions:      null,
    status:        'processing',
    postResults:   null,
    error:         null,
    accessToken
  };

  const jobs = loadJobs();
  jobs.unshift(job);
  saveJobs(jobs);

  // Tell client we're good — process async. Include the tokenized URL so the
  // upload page can show/share it immediately.
  res.json({
    ok: true,
    jobId,
    videoUrl:   videoUrl(job, 'main'),
    statusUrl:  `${BASE_URL}/status/${jobId}?t=${accessToken}`,
    galleryUrl: CLIENT_TOKEN ? `${BASE_URL}/gallery?t=${CLIENT_TOKEN}` : null
  });

  // Background processing
  setImmediate(async () => {
    try {
      // 1. Process video
      if (isVideo) {
        const outPath = path.join(PROCESSED_DIR, jobId + '.mp4');
        try {
          await processVideo(file.path, outPath, specs);
          updateJob(jobId, { processedFile: outPath });
          job.processedFile = outPath;
          // Generate popcorn variant
          try {
            const popcornPath = path.join(PROCESSED_DIR, jobId + '_popcorn.mp4');
            await processPopcorn(file.path, popcornPath, specs);
            updateJob(jobId, { popcornFile: popcornPath });
            job.popcornFile = popcornPath;
          } catch (ep) { console.error('Popcorn error:', ep.message); }
        } catch (e) {
          console.error('FFmpeg error:', e.message);
          // Copy original as fallback so something is always deliverable
          fs.copyFileSync(file.path, outPath);
          updateJob(jobId, { processedFile: outPath, error: 'overlay_failed' });
          job.processedFile = outPath;
        }
      } else {
        // Image — copy to processed dir
        const outPath = path.join(PROCESSED_DIR, jobId + path.extname(file.path));
        fs.copyFileSync(file.path, outPath);
        updateJob(jobId, { processedFile: outPath });
        job.processedFile = outPath;
      }

      // 2. Generate captions
      const captions = await generateCaptions(specs);
      updateJob(jobId, { captions, status: 'ready' });
      job.captions = captions;

      // 3. Email James
      try { await notifyJames(job); } catch (e) { console.error('Email James error:', e.message); }

      // 3b. Email Eric with video + copy-paste captions (replaces Ayrshare)
      try { await notifyEric(job); } catch (e) { console.error('Email Eric error:', e.message); }

      // 4. Auto-post if Ayrshare configured
      if (AYRSHARE_KEY) {
        const results = await postViaAyrshare(job);
        updateJob(jobId, { postResults: results, status: 'posted' });
      }

    } catch (e) {
      console.error('Processing error:', e.message);
      updateJob(jobId, { status: 'failed', error: e.message });
      // Still email James even on failure
      try {
        await mailer.sendMail({
          from: `"Truck Autopilot" <${JAMES_EMAIL}>`,
          to: JAMES_EMAIL,
          subject: `⚠️ Truck upload needs manual attention`,
          html: `<p>Job ${jobId} failed: ${e.message}</p><p>Specs: ${JSON.stringify(specs)}</p>`
        });
      } catch (_) {}
    }
  });
});

// ── Shared helpers ────────────────────────────────────────
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function diskUsage(jobs) {
  let bytes = 0;
  for (const j of jobs) {
    if (j.processedFile) bytes += fileSize(j.processedFile);
    if (j.popcornFile)   bytes += fileSize(j.popcornFile);
    if (j.originalFile)  bytes += fileSize(j.originalFile);
  }
  return bytes;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Build the HTML for a single job card. `context` is 'admin' or 'gallery' and
// controls which action buttons render.
function renderJobCard(j, context) {
  const statusColors = { posted: '#16a34a', ready: '#d97706', processing: '#2563eb', failed: '#dc2626' };
  const sc = statusColors[j.status] || '#555';
  const mainLink    = j.processedFile ? videoUrl(j, 'main')    : null;
  const popcornLink = j.popcornFile   ? videoUrl(j, 'popcorn') : null;

  const captionBlock = j.captions ? `
  <details><summary style="cursor:pointer;color:rgba(255,255,255,0.45);font-size:0.82rem;user-select:none">▸ View Captions</summary>
    <div style="margin-top:0.75rem;display:flex;flex-direction:column;gap:0.5rem">
      ${['facebook','instagram','tiktok'].map(p => `
      <div style="background:#1a1a1a;border-radius:8px;padding:0.875rem">
        <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:0.35rem">${p}</div>
        <div style="font-size:0.82rem;color:rgba(255,255,255,0.7);white-space:pre-wrap">${(j.captions[p]||'').replace(/</g,'&lt;')}</div>
      </div>`).join('')}
    </div>
  </details>` : '';

  const adminActions = context === 'admin' ? `
  <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap">
    ${j.status === 'ready' ? `<button onclick="post('${j.id}',this)" style="background:#111;border:1px solid #dc2626;color:#ef4444;padding:0.5rem 1rem;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.82rem">Post to All Platforms</button>` : ''}
    ${j.status === 'failed' ? `<button onclick="retry('${j.id}',this)" style="background:#111;border:1px solid #2563eb;color:#60a5fa;padding:0.5rem 1rem;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.82rem">Retry</button>` : ''}
    <button onclick="del('${j.id}',this)" style="background:#111;border:1px solid #555;color:#bbb;padding:0.5rem 1rem;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.82rem">Delete</button>
  </div>` : '';

  const preview = mainLink && j.status !== 'processing' && j.isVideo !== false ? `
  <video controls preload="metadata" style="width:100%;max-width:100%;border-radius:8px;margin-bottom:0.75rem;background:#000">
    <source src="${mainLink}" type="video/mp4">
  </video>` : '';

  return `
<div style="background:#111;border:1px solid #222;border-radius:14px;padding:1.5rem;margin-bottom:1rem">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem">
    <div>
      <div style="font-size:1.1rem;font-weight:800">${j.specs.year} ${j.specs.make} ${j.specs.model}</div>
      <div style="color:rgba(255,255,255,0.4);font-size:0.8rem">${new Date(j.createdAt).toLocaleString()} &nbsp;·&nbsp; $${Number(j.specs.price||0).toLocaleString()} &nbsp;·&nbsp; ${Number(j.specs.mileage||0).toLocaleString()} mi</div>
    </div>
    <span style="background:${sc}22;color:${sc};border:1px solid ${sc}44;padding:0.2rem 0.7rem;border-radius:50px;font-size:0.75rem;font-weight:700;text-transform:uppercase">${j.status}</span>
  </div>
  ${preview}
  ${mainLink ? `<a href="${mainLink}" download style="display:inline-block;background:#dc2626;color:#fff;padding:0.5rem 1.1rem;border-radius:8px;text-decoration:none;font-size:0.82rem;font-weight:700;margin-right:0.4rem;margin-bottom:0.75rem">⬇ Main</a>` : ''}
  ${popcornLink ? `<a href="${popcornLink}" download style="display:inline-block;background:#222;color:#fff;padding:0.5rem 1.1rem;border-radius:8px;text-decoration:none;font-size:0.82rem;font-weight:700;margin-bottom:0.75rem">⬇ Popcorn</a>` : ''}
  ${captionBlock}
  ${adminActions}
</div>`;
}

// ── Admin dashboard ───────────────────────────────────────
app.get('/admin', adminAuth, (req, res) => {
  const jobs = loadJobs();
  const counts = jobs.reduce((a, j) => (a[j.status] = (a[j.status] || 0) + 1, a), {});
  const usage = fmtBytes(diskUsage(jobs));
  const rows = jobs.map(j => renderJobCard(j, 'admin')).join('') ||
    '<p style="color:rgba(255,255,255,0.35)">No submissions yet.</p>';

  res.send(`<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truck Autopilot — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Plus Jakarta Sans',sans-serif;background:#080808;color:#fff;padding:2rem 1rem;max-width:760px;margin:0 auto}h1{font-size:1.6rem;font-weight:800;margin-bottom:0.2rem}h1 span{color:#ef4444}.sub{color:rgba(255,255,255,0.35);font-size:0.85rem;margin-bottom:2rem}.stats{display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:1.5rem}.stat{background:#111;border:1px solid #222;border-radius:10px;padding:0.6rem 0.9rem;font-size:0.78rem;color:rgba(255,255,255,0.8)}.stat b{color:#fff;font-size:1rem}details summary::-webkit-details-marker{display:none}</style>
</head><body>
<h1><span>Truck</span> Autopilot</h1>
<p class="sub">Admin · ${jobs.length} submission${jobs.length !== 1 ? 's' : ''} · <a href="/" style="color:#ef4444">Upload page</a></p>
<div class="stats">
  <div class="stat">Total: <b>${jobs.length}</b></div>
  <div class="stat">Ready: <b>${counts.ready || 0}</b></div>
  <div class="stat">Posted: <b>${counts.posted || 0}</b></div>
  <div class="stat">Processing: <b>${counts.processing || 0}</b></div>
  <div class="stat">Failed: <b>${counts.failed || 0}</b></div>
  <div class="stat">Disk: <b>${usage}</b></div>
</div>
${rows}
<script>
async function post(id, btn) {
  if (!confirm('Post this truck to all platforms now?')) return;
  btn.disabled=true; btn.textContent='Posting...';
  const r = await fetch('/admin/post/'+id,{method:'POST'});
  const d = await r.json();
  d.ok ? location.reload() : (alert(JSON.stringify(d.error)), btn.disabled=false, btn.textContent='Post to All Platforms');
}
async function del(id, btn) {
  if (!confirm('Delete this job and its video files? This cannot be undone.')) return;
  btn.disabled=true; btn.textContent='Deleting...';
  const r = await fetch('/admin/delete/'+id,{method:'POST'});
  const d = await r.json();
  d.ok ? location.reload() : (alert(JSON.stringify(d.error)), btn.disabled=false, btn.textContent='Delete');
}
async function retry(id, btn) {
  btn.disabled=true; btn.textContent='Retrying...';
  const r = await fetch('/admin/retry/'+id,{method:'POST'});
  const d = await r.json();
  d.ok ? location.reload() : (alert(JSON.stringify(d.error)), btn.disabled=false, btn.textContent='Retry');
}
</script>
</body></html>`);
});

// Manual post trigger
app.post('/admin/post/:id', adminAuth, async (req, res) => {
  const jobs = loadJobs();
  const job  = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  try {
    const results = await postViaAyrshare(job);
    updateJob(req.params.id, { postResults: results, status: 'posted' });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a job and all its files.
app.post('/admin/delete/:id', adminAuth, (req, res) => {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const job = jobs[idx];
  for (const p of [job.processedFile, job.popcornFile, job.originalFile]) {
    if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
  }
  jobs.splice(idx, 1);
  saveJobs(jobs);
  res.json({ ok: true });
});

// Retry a failed job: re-run ffmpeg overlay + popcorn variant against the
// original upload, then regenerate captions. Reuses the same code paths as
// the upload handler's background block.
app.post('/admin/retry/:id', adminAuth, async (req, res) => {
  const jobs = loadJobs();
  const job  = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (!job.originalFile || !fs.existsSync(job.originalFile)) {
    return res.status(400).json({ error: 'Original upload is gone; cannot retry.' });
  }

  updateJob(job.id, { status: 'processing', error: null });
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      if (job.isVideo !== false) {
        const outPath = path.join(PROCESSED_DIR, job.id + '.mp4');
        await processVideo(job.originalFile, outPath, job.specs);
        updateJob(job.id, { processedFile: outPath });
        job.processedFile = outPath;
        try {
          const popcornPath = path.join(PROCESSED_DIR, job.id + '_popcorn.mp4');
          await processPopcorn(job.originalFile, popcornPath, job.specs);
          updateJob(job.id, { popcornFile: popcornPath });
          job.popcornFile = popcornPath;
        } catch (ep) { console.error('Popcorn retry error:', ep.message); }
      }
      const captions = await generateCaptions(job.specs);
      updateJob(job.id, { captions, status: 'ready' });
      job.captions = captions;
    } catch (e) {
      console.error('Retry error:', e.message);
      updateJob(job.id, { status: 'failed', error: e.message });
    }
  });
});

// ── Client-facing gallery ────────────────────────────────
// Gated by the CLIENT_TOKEN query param. Shows all jobs with inline players
// and copy-paste captions. The same page also works for admins (Basic auth
// bypass) so you can preview what the client sees.
app.get('/gallery', (req, res) => {
  const allowed = (CLIENT_TOKEN && req.query.t === CLIENT_TOKEN) || isAdmin(req);
  if (!allowed) return res.status(403).send('Forbidden');

  const jobs = loadJobs();
  const ready = jobs.filter(j => j.status === 'ready' || j.status === 'posted');
  const rows = ready.map(j => renderJobCard(j, 'gallery')).join('') ||
    '<p style="color:rgba(255,255,255,0.35)">No videos yet. Upload a truck from the <a href="/" style="color:#ef4444">home page</a>.</p>';

  res.send(`<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Truck Videos</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Plus Jakarta Sans',sans-serif;background:#080808;color:#fff;padding:2rem 1rem;max-width:760px;margin:0 auto}h1{font-size:1.6rem;font-weight:800;margin-bottom:0.2rem}h1 span{color:#ef4444}.sub{color:rgba(255,255,255,0.35);font-size:0.85rem;margin-bottom:2rem}details summary::-webkit-details-marker{display:none}</style>
</head><body>
<h1><span>Your</span> Videos</h1>
<p class="sub">${ready.length} video${ready.length !== 1 ? 's' : ''} · <a href="/" style="color:#ef4444">Upload another truck</a></p>
${rows}
</body></html>`);
});

// Lightweight per-job status poll for the upload page / client.
app.get('/status/:id', (req, res) => {
  const jobs = loadJobs();
  const job  = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const ok = (req.query.t && job.accessToken && req.query.t === job.accessToken) || isAdmin(req);
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    id:        job.id,
    status:    job.status,
    error:     job.error,
    videoUrl:  job.processedFile ? videoUrl(job, 'main')    : null,
    popcornUrl:job.popcornFile   ? videoUrl(job, 'popcorn') : null,
    captions:  job.captions
  });
});

app.get('/health', (req, res) => res.json({ ok: true, jobs: loadJobs().length }));

app.listen(PORT, () => console.log(`Truck Autopilot v2 on port ${PORT}`));

// ── POPCORN-STYLE TEXT OVERLAY ────────────────────────────────────────────────
// Text pops in sequentially from top-center, each line fading in with a slight
// scale feel via alpha transitions. Best practices: centered, large, outlined.

function buildPopcornOverlay(specs) {
  const { year, make, model, mileage, price, financing } = specs;
  const truck    = ffEsc(`${year} ${make} ${model}`.toUpperCase());
  const priceNum = price ? Number(price) : 0;
  const priceStr = priceNum > 0 ? '$' + priceNum.toLocaleString().replace(/,/g,'') : 'CALL FOR PRICE';
  const miles    = mileage ? ffEsc(mileage.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')) + ' Miles' : '';
  const dealerLine = ffEsc('KATY TRUCK & EQUIPMENT SALES');
  const phoneStr = ffEsc('(281) 891-0597');

  // Shadow helper: offset dark copy behind main text for legibility
  const shadow = (font, text, size, color, x, y, t0) =>
    `drawtext=fontfile=${font}:text='${text}':fontsize=${size}:fontcolor=black@0.7:x=${x}+2:y=${y}+2:enable='gte(t,${t0})':alpha='if(lt(t,${t0+0.4}),(t-${t0})/0.4,1)'`;
  const main   = (font, text, size, color, x, y, t0) =>
    `drawtext=fontfile=${font}:text='${text}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:enable='gte(t,${t0})':alpha='if(lt(t,${t0+0.4}),(t-${t0})/0.4,1)'`;

  const cx = '(main_w-text_w)/2'; // horizontally centered
  const BOLD   = FONT_BOLD;
  const NORMAL = FONT_NORMAL;

  const filters = [
    // Subtle dark gradient at top for readability
    `drawbox=x=0:y=0:w=iw:h=220:color=black@0.45:t=fill`,

    // Line 1 — Dealer (small, pops at t=0.5)
    shadow(NORMAL, dealerLine,  22, 'white', cx, '18',  0.5),
    main  (NORMAL, dealerLine,  22, '0xFFFFFFBB', cx, '18',  0.5),

    // Line 2 — Truck name (big bold, pops at t=1.2)
    shadow(BOLD,   truck,       46, 'white', cx, '50',  1.2),
    main  (BOLD,   truck,       46, 'white', cx, '50',  1.2),

    // Line 3 — Price (red, bold, pops at t=2.0)
    shadow(BOLD,   priceStr,    52, '0xEF4444FF', cx, '108', 2.0),
    main  (BOLD,   priceStr,    52, '0xEF4444FF', cx, '108', 2.0),

    // Line 4 — Miles (pops at t=2.7)
    ...(miles ? [
      shadow(NORMAL, miles,     24, 'white', cx, '170', 2.7),
      main  (NORMAL, miles,     24, '0xFFFFFFCC', cx, '170', 2.7),
    ] : []),

    // Line 5 — Phone (pops at t=3.4)
    shadow(BOLD,   phoneStr,    28, 'white', cx, '200', 3.4),
    main  (BOLD,   phoneStr,    28, '0xFFFF00FF', cx, '200', 3.4),
  ];

  return filters.join(',');
}

// Process a popcorn-style variant -- uses execFile to bypass shell quoting
function processPopcorn(inputPath, outputPath, specs) {
  return new Promise((resolve, reject) => {
    const vf   = buildPopcornOverlay(specs);
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ];
    const { execFile } = require('child_process');
    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024, timeout: 300000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}


