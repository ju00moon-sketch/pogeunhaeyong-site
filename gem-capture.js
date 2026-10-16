// Browser runtime for gem-helper.html: screen share, still images, region crops and the single OCR worker.
// Frames, crops and OCR text stay in this page's memory. The only network use is the same-origin OCR
// program and language files under ./vendor/.
import { VALUE_REGIONS, splitRow, selectValueGlyphs, outlinedInk, brighterInk, isBarGlyph, lastDigit, pickVote, otsuThreshold, luma, localMean } from './gem-screen.js';

export const LIMITS = Object.freeze({
  imageBytes: 15 * 1024 * 1024,
  imagePixels: 4096 * 4096,
  imageSide: 8192,
  regionPixels: 1_500_000,
  canvasSide: 2400,
});

const vendor = path => new URL(`./vendor/${path}`, import.meta.url).href;

// One worker holds both languages; switching with reinitialize reuses the loaded data (no refetch). At most one
// worker exists: a start waits until the previous worker, or a start that stop() cut short, has been terminated.
// Tesseract.js hands out no worker before it has loaded, so a cut-short start terminates its own worker on arrival.
// stop() also fails the reads in flight, since Tesseract.js leaves the jobs of a terminated worker unsettled.
export function createOcr({ loadTesseract = () => import('./vendor/tesseract/7.0.0/tesseract.esm.min.js') } = {}) {
  let worker = null, starting = null, language = null, generation = 0;
  let released = Promise.resolve();
  let halt = haltSignal();
  function ensure() {
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    const current = generation;
    const start = released.then(async () => {
      if (current !== generation) throw new Error('ocr_stopped');
      const { default: Tesseract } = await loadTesseract();
      if (current !== generation) throw new Error('ocr_stopped');
      const created = await Tesseract.createWorker(['kor', 'eng'], 1, {
        workerPath: vendor('tesseract/7.0.0/worker.min.js'),
        corePath: vendor('tesseract/7.0.0/core/'),
        langPath: vendor('tessdata/4.0.0_best_int'),
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
      });
      if (current !== generation) { await created.terminate(); throw new Error('ocr_stopped'); }
      worker = created; language = 'kor+eng';
      return created;
    });
    starting = start;
    const settled = () => { if (starting === start) starting = null; };
    start.then(settled, settled);
    return start;
  }
  async function read(canvas, { lang, psm, whitelist = '' }) {
    const stopped = halt.promise;
    const guard = job => Promise.race([job, stopped]);
    const active = await guard(ensure());
    if (language !== lang) { await guard(active.reinitialize(lang, 1)); language = lang; }
    await guard(active.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist }));
    const result = await guard(active.recognize(canvas));
    return result.data.text.replace(/\s+/g, ' ').trim();
  }
  function stop() {
    generation++;
    halt.reject(new Error('ocr_stopped'));
    halt = haltSignal();
    const active = worker, pending = starting;
    worker = null; starting = null; language = null;
    // Chained: a second stop right after the first (clear, then a new image) still waits for the first one's worker.
    released = Promise.allSettled([released, active?.terminate(), pending?.then(created => created.terminate())]).then(() => {});
    return released;
  }
  return { ensure, read, stop, get ready() { return Boolean(worker); } };
}

function haltSignal() {
  let reject;
  const promise = new Promise((_, fail) => { reject = fail; });
  promise.catch(() => {});
  return { promise, reject };
}

function canvas(width, height) {
  const element = document.createElement('canvas');
  element.width = Math.max(1, Math.round(width));
  element.height = Math.max(1, Math.round(height));
  return element;
}
const context = element => element.getContext('2d', { willReadFrequently: true });
const bright = (r, g, b) => { const max = Math.max(r, g, b), min = Math.min(r, g, b); return max > 175 && (max - min < 70 || (r > 170 && g > 150)); };
const whiteStrict = (r, g, b) => Math.min(r, g, b) > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 35;

// Crop one region, scaled so its height becomes targetHeight (longest side capped). blocky keeps the source
// pixels when enlarging, so thin value strokes are not blurred into fragments before the colour mask.
function crop(source, [x, y, w, h], targetHeight, { blocky = false } = {}) {
  const scale = Math.min(targetHeight / h, LIMITS.canvasSide / w);
  const out = canvas(w * scale, h * scale);
  const g = context(out);
  g.imageSmoothingEnabled = !blocky || scale < 1; g.imageSmoothingQuality = 'high';
  g.drawImage(source.element, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

// Binarised copy for OCR (ink black on white). bright/whiteStrict test colour; grayOtsu splits brightness globally;
// lumaLocal keeps pixels brighter than their own neighbourhood, which holds in screen-share video where colour is
// stored at half resolution and smeared into the background while brightness stays sharp.
function variant(base, kind, scale, pad = 12) {
  const factor = Math.min(scale, LIMITS.canvasSide / Math.max(base.width, base.height));
  const scaled = canvas(base.width * factor, base.height * factor);
  const g = context(scaled);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(base, 0, 0, scaled.width, scaled.height);
  if (kind === 'raw') return scaled;
  const image = g.getImageData(0, 0, scaled.width, scaled.height);
  const { width, height, data } = image;
  let inkAt;
  if (kind === 'grayOtsu' || kind === 'lumaLocal') {
    const values = new Float32Array(width * height);
    for (let p = 0; p < values.length; p++) values[p] = luma(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    if (kind === 'grayOtsu') {
      const threshold = otsuThreshold(values);
      inkAt = p => values[p] > threshold;
    } else {
      const mean = localMean(values, width, height, Math.max(4, Math.round(height / 3)));
      inkAt = p => values[p] > 110 && values[p] > mean[p] + 18;
    }
  } else {
    const test = kind === 'whiteStrict' ? whiteStrict : bright;
    inkAt = p => test(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  }
  const out = canvas(width + pad * 2, height + pad * 2);
  const og = context(out);
  og.fillStyle = '#fff'; og.fillRect(0, 0, out.width, out.height);
  const mask = og.createImageData(width, height);
  for (let p = 0; p < width * height; p++) {
    const value = inkAt(p) ? 0 : 255;
    mask.data[p * 4] = mask.data[p * 4 + 1] = mask.data[p * 4 + 2] = value; mask.data[p * 4 + 3] = 255;
  }
  og.putImageData(mask, pad, pad);
  return out;
}

function drawGlyphs(glyphs, imageWidth, scale, pad) {
  const x0 = Math.min(...glyphs.map(c => c.x0)) - 1, y0 = Math.min(...glyphs.map(c => c.y0)) - 1;
  const x1 = Math.max(...glyphs.map(c => c.x1)) + 1, y1 = Math.max(...glyphs.map(c => c.y1)) + 1;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const small = canvas(w, h);
  const sg = context(small);
  const image = sg.createImageData(w, h);
  image.data.fill(255);
  for (const glyph of glyphs) for (const p of glyph.pixels) {
    const px = p % imageWidth, py = (p - px) / imageWidth, i = ((py - y0) * w + (px - x0)) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = 0;
  }
  sg.putImageData(image, 0, 0);
  const out = canvas(w * scale + pad * 2, h * scale + pad * 2);
  const og = context(out);
  og.fillStyle = '#fff'; og.fillRect(0, 0, out.width, out.height);
  og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
  og.drawImage(small, 0, 0, w, h, pad, pad, w * scale, h * scale);
  return out;
}

// Evidence for one current value: the bar shape (the font's "1"), then digit-only OCR of the glyph and of the whole
// "Lv. N" line with the English model. Screen-share frames thin the yellow colour mask (colour at half resolution),
// so the glyph is also taken by brightness: its dark outline, then its local contrast. Those passes must land on the
// glyph found first and may only confirm the colour votes; with no colour vote they need two agreeing votes.
async function readValue(ocr, source, box, level) {
  const band = crop(source, box, 44, { blocky: true });
  const image = context(band).getImageData(0, 0, band.width, band.height);
  const coloured = selectValueGlyphs(image, { level });
  const votes = coloured ? await glyphVotes(ocr, coloured, image.width) : [];
  const seen = votes.filter(vote => vote !== null);
  let digit = coloured?.digit ?? null;
  for (const ink of [outlinedInk, brighterInk]) {
    if (pickVote(votes, 2) !== null) break;
    const shaped = selectValueGlyphs(image, { level, predicate: ink(image), maxHeight: 0.62 });
    if (!shaped || (digit && !overlaps(shaped.digit, digit))) continue;
    digit ??= shaped.digit;
    const shapeVotes = await glyphVotes(ocr, shaped, image.width);
    votes.push(...(seen.length ? shapeVotes.filter(vote => seen.includes(vote)) : shapeVotes));
  }
  return { found: Boolean(digit), votes };
}

async function glyphVotes(ocr, found, imageWidth) {
  const votes = [isBarGlyph(found.digit, imageWidth) ? 1 : null];
  votes.push(lastDigit(await ocr.read(drawGlyphs([found.digit], imageWidth, 3, 24), { lang: 'eng', psm: 10, whitelist: '12345' })));
  if (pickVote(votes, 2) === null) {
    votes.push(lastDigit(await ocr.read(drawGlyphs(found.glyphs, imageWidth, 2.5, 20), { lang: 'eng', psm: 7, whitelist: 'Lv.12345' })));
  }
  return votes;
}

const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

// Variants are read in order until two agree under the field parser (minimum two votes).
async function readText(ocr, base, { kinds, scale, lang, psm, whitelist = '', parse }) {
  const texts = [], picks = [];
  for (const kind of kinds) {
    const text = await ocr.read(variant(base, kind, scale), { lang, psm, whitelist });
    texts.push(text); picks.push(parse(text));
    if (pickVote(picks, 2) !== null) break;
  }
  return texts;
}

const LABEL = { height: 36, scale: 2, kinds: ['bright', 'whiteStrict', 'grayOtsu', 'raw', 'lumaLocal'], psm: 7 };
const KOREAN_FIELDS = Object.freeze([
  ['gemName', { height: 48, scale: 1.5, kinds: ['grayOtsu', 'bright', 'raw', 'lumaLocal'], psm: 7 }],
  ['gemPoints', { height: 44, scale: 1.5, kinds: ['bright', 'grayOtsu', 'raw', 'lumaLocal'], psm: 7 }],
  ['labelPoints', LABEL],
  ['labelEffect1', LABEL],
  ['labelEffect2', LABEL],
  ['attempts', { height: 52, scale: 1.5, kinds: ['bright', 'grayOtsu', 'raw', 'lumaLocal'], psm: 7 }],
  ['rerolls', { height: 44, scale: 1.5, kinds: ['bright', 'grayOtsu', 'raw', 'lumaLocal'], psm: 7 }],
]);
const OFFER_FIELD = { height: 46, scale: 3, kinds: ['raw', 'grayOtsu', 'bright', 'lumaLocal'], psm: 6 };
const COST_FIELD = { height: 40, scale: 2, kinds: ['bright', 'grayOtsu', 'raw', 'lumaLocal'], psm: 7, whitelist: '0123456789,' };

// regions: clamped source-pixel boxes. fields: keys to read (null = all). Returns null when cancelled.
export async function readWindow(ocr, source, regions, parsers, { fields = null, cancelled = () => false } = {}) {
  const wanted = key => regions[key] && (!fields || fields.has(key));
  const out = {};
  for (const [key, config] of KOREAN_FIELDS) {
    if (!wanted(key)) continue;
    if (cancelled()) return null;
    const parse = key.startsWith('labelEffect') ? text => parsers.labelEffect(text) : parsers[key];
    out[key] = await readText(ocr, crop(source, regions[key], config.height), { ...config, lang: 'kor', parse });
  }
  if (wanted('offers')) {
    out.offers = [];
    for (const slot of splitRow(regions.offers, 4)) {
      if (cancelled()) return null;
      out.offers.push(await readText(ocr, crop(source, slot, OFFER_FIELD.height), { ...OFFER_FIELD, lang: 'kor', parse: parsers.offer }));
    }
  }
  for (const [index, key] of VALUE_REGIONS.entries()) {
    if (!wanted(key)) continue;
    if (cancelled()) return null;
    (out.values ??= [])[index] = await readValue(ocr, source, regions[key], key === 'valueEffect1' || key === 'valueEffect2');
  }
  if (wanted('cost')) {
    if (cancelled()) return null;
    out.cost = await readText(ocr, crop(source, regions.cost, COST_FIELD.height), { ...COST_FIELD, lang: 'eng', parse: parsers.cost });
  }
  return out;
}

// ---- change detection ----

const signatureCanvas = { element: null };
export function regionSignature(source, [x, y, w, h]) {
  signatureCanvas.element ??= canvas(24, 8);
  const g = context(signatureCanvas.element);
  g.imageSmoothingEnabled = true;
  g.drawImage(source.element, x, y, w, h, 0, 0, 24, 8);
  const data = g.getImageData(0, 0, 24, 8).data;
  const signature = new Uint8Array(192);
  for (let i = 0; i < 192; i++) signature[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return signature;
}
export function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
export function signatureSpread(signature) {
  let min = 255, max = 0;
  for (const value of signature) { if (value < min) min = value; if (value > max) max = value; }
  return max - min;
}

// ---- sources ----

export const videoSource = video => ({ kind: 'stream', element: video, width: video.videoWidth, height: video.videoHeight });
export const bitmapSource = bitmap => ({ kind: 'image', element: bitmap, width: bitmap.width, height: bitmap.height });

export function createCapture(video, { onState }) {
  let stream = null, generation = 0;
  const framed = () => { try { return window.top !== window.self; } catch { return true; } };
  const supported = () => window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  function release() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.pause();
    video.srcObject = null;
  }
  // Must be called synchronously from a user click: the browser shows its own chooser.
  async function start() {
    if (framed()) { onState('framed'); return false; }
    if (!supported()) { onState('unsupported'); return false; }
    const current = ++generation;
    release();
    onState('requesting');
    let media;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false, selfBrowserSurface: 'exclude' });
    } catch (error) {
      if (current === generation) onState(error?.name === 'NotAllowedError' ? 'denied' : 'failed');
      return false;
    }
    if (current !== generation) { for (const track of media.getTracks()) track.stop(); return false; }
    stream = media;
    const [track] = stream.getVideoTracks();
    track?.addEventListener('ended', () => { if (current === generation) stop('ended'); });
    video.srcObject = stream;
    try { await video.play(); } catch { /* muted inline video; frames still arrive */ }
    if (current !== generation) return false;
    onState(track?.getSettings?.().displaySurface === 'browser' ? 'selfSurface' : 'active');
    return true;
  }
  function stop(reason = 'idle') { generation++; release(); onState(reason); }
  return { start, stop, get active() { return Boolean(stream); }, framed, supported };
}

const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));
const u16be = (bytes, i) => (bytes[i] << 8) | bytes[i + 1];
const u24le = (bytes, i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const sized = (type, width, height) => (width > 0 && height > 0 ? { type, width, height } : { type, broken: true });

// Format and declared size, read before any decoding. A JPEG frame header can sit behind large metadata segments, so
// segments are walked by their lengths; when the given bytes end first the answer is { more: true } and the caller
// passes the whole (already capped) file. An unknown chunk, a broken segment or a missing or zero size gives
// { broken: true }, and such a file is never handed to the decoder.
export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 8) === 'PNG\r\n\x1a\n') {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== 'IHDR') return { type: 'image/png', broken: true };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return sized('image/png', view.getUint32(16), view.getUint32(20));
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return webpSize(bytes);
  return null;
}

function jpegSize(bytes) {
  const type = 'image/jpeg';
  let i = 2;
  for (;;) {
    while (i < bytes.length && bytes[i] !== 0xff) i++; // stray bytes before a marker, which decoders tolerate
    while (i < bytes.length && bytes[i] === 0xff) i++; // fill bytes
    if (i >= bytes.length) return { type, more: true };
    const marker = bytes[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // markers without a length
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return { type, broken: true }; // data or end before a frame header
    if (i + 2 > bytes.length) return { type, more: true };
    const length = u16be(bytes, i);
    if (length < 2) return { type, broken: true };
    if (JPEG_FRAMES.has(marker)) {
      if (length < 8) return { type, broken: true };
      if (i + 7 > bytes.length) return { type, more: true };
      return sized(type, u16be(bytes, i + 5), u16be(bytes, i + 3));
    }
    i += length;
  }
}

function webpSize(bytes) {
  const type = 'image/webp';
  if (bytes.length < 30) return { type, broken: true };
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') return sized(type, 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  if (chunk === 'VP8 ') {
    // A still image is one key frame: frame tag bit 0 clear, then the start code 9D 01 2A.
    if ((bytes[20] & 1) || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return { type, broken: true };
    return sized(type, (bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return { type, broken: true };
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return sized(type, 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  return { type, broken: true };
}

const tooLarge = (width, height) => width * height > LIMITS.imagePixels || Math.max(width, height) > LIMITS.imageSide;

// PNG/JPEG/WebP only, and only once the container states a size within the limits: the decoder never sees a file
// whose size could not be read. The decoded picture must be the declared one (a JPEG may be turned by its EXIF
// orientation) and is checked against the limits again.
export async function loadImageFile(file) {
  if (!(file instanceof Blob)) return { error: 'type' };
  if (file.size > LIMITS.imageBytes) return { error: 'size' };
  let info = sniffImage(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
  if (info?.more) info = sniffImage(new Uint8Array(await file.arrayBuffer()));
  if (!info || (file.type && file.type !== info.type)) return { error: 'type' };
  if (!info.width) return { error: 'decode' };
  if (tooLarge(info.width, info.height)) return { error: 'pixels' };
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return { error: 'decode' }; }
  const declared = (bitmap.width === info.width && bitmap.height === info.height)
    || (info.type === 'image/jpeg' && bitmap.width === info.height && bitmap.height === info.width);
  if (!declared || tooLarge(bitmap.width, bitmap.height)) { bitmap.close(); return { error: declared ? 'pixels' : 'decode' }; }
  return { bitmap };
}
