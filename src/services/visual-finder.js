const sharp = require("sharp");

// AI Visual Finder: classical computer vision built on OpenCV.js (compiled to WebAssembly, no external model download).
// Pipeline
//   1. Reference cropping   - the item is separated from its plain background (Otsu threshold + largest contour).
//   2. Feature matching     - ORB keypoints matched with a Hamming BFMatcher and Lowe's ratio test, then RANSAC
//                             homography. Textured items (logos, patterns, labels) are localised as a quadrilateral.
//   3. Template matching    - multi-scale normalised cross-correlation for plain, low-texture items, verified with an
//                             HSV colour histogram so that a similarly shaped but differently coloured object is rejected.
//   4. Merge                - detections are de-duplicated with non-maximum suppression and ranked by confidence.
// Every number returned is produced by this analysis of the two uploaded images; nothing is randomised or looked up.

const MAX_SCENE_SIDE = 1600;
const MAX_REFERENCE_SIDE = 600;
const MATCH_THRESHOLD = 45;      // confidence (0-100) required to report a detection
const MAX_DETECTIONS = 5;

// The OpenCV.js module object is thenable, so it must never be passed straight to resolve(); wrap it instead.
let cvPromise = null;
function loadOpenCv() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCV.js did not initialise in time.")), 30000);
      const cvModule = require("@techstark/opencv-js");
      const ready = () => { clearTimeout(timer); resolve({ cv: cvModule }); };
      if (cvModule.Mat) ready(); else cvModule.onRuntimeInitialized = ready;
    });
    cvPromise.catch(() => { cvPromise = null; });
  }
  return cvPromise;
}

// Width and height after EXIF orientation is applied, so coordinates map back to what the user sees.
async function orientedSize(buffer) {
  const meta = await sharp(buffer, { failOn: "none" }).metadata();
  const swap = meta.orientation >= 5;
  return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

// Decodes an image into raw RGBA, scaled so its longest side is at most maxSide.
async function decode(buffer, maxSide) {
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // transparent PNG areas become white, not black
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const oriented = await orientedSize(buffer);
  return { data, width: info.width, height: info.height, originalWidth: oriented.width, originalHeight: oriented.height };
}

// Cuts a rectangle out of raw RGBA pixels without decoding the image a second time.
function cropRaw(data, width, box) {
  const out = Buffer.alloc(box.width * box.height * 4);
  for (let row = 0; row < box.height; row += 1) {
    const source = ((box.y + row) * width + box.x) * 4;
    data.copy ? data.copy(out, row * box.width * 4, source, source + box.width * 4) : out.set(data.subarray(source, source + box.width * 4), row * box.width * 4);
  }
  return out;
}

class Tracker {
  constructor() { this.items = []; }
  add(item) { this.items.push(item); return item; }
  release() { for (const item of this.items) { try { item.delete(); } catch { /* already released */ } } this.items = []; }
}

function rgbaMat(cv, tracker, decoded) {
  return tracker.add(cv.matFromArray(decoded.height, decoded.width, cv.CV_8UC4, decoded.data));
}

// Finds the item in a reference photo by separating it from the dominant background colour at the image border.
function cropReference(cv, tracker, rgba, width, height) {
  const border = [0, 0, 0]; let samples = 0;
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.05));
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x > margin && x < width - margin && y > margin && y < height - margin) continue;
      const i = (y * width + x) * 4;
      border[0] += rgba[i]; border[1] += rgba[i + 1]; border[2] += rgba[i + 2]; samples += 1;
    }
  }
  const bg = border.map((value) => value / samples);
  // Only a plain, light studio backdrop is cut away. A coloured or busy border means the photo is already the item.
  const plainLightBorder = Math.min(...bg) >= 185 && borderLuminanceSpread(rgba, width, height, margin, bg) <= 22;
  if (!plainLightBorder) return { x: 0, y: 0, width, height, cropped: false };
  const distance = new Uint8Array(width * height);
  let maxDistance = 1;
  const raw = new Float32Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const d = Math.hypot(rgba[i] - bg[0], rgba[i + 1] - bg[1], rgba[i + 2] - bg[2]);
    raw[p] = d; if (d > maxDistance) maxDistance = d;
  }
  for (let p = 0; p < raw.length; p += 1) distance[p] = Math.min(255, Math.round((raw[p] / maxDistance) * 255));
  const dist = tracker.add(cv.matFromArray(height, width, cv.CV_8UC1, distance));
  const binary = tracker.add(new cv.Mat());
  cv.threshold(dist, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const kernel = tracker.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));
  cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
  const contours = tracker.add(new cv.MatVector());
  const hierarchy = tracker.add(new cv.Mat());
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i); const area = cv.contourArea(contour);
    if (area > bestArea) { bestArea = area; best = cv.boundingRect(contour); }
  }
  const pageArea = width * height;
  if (!best || bestArea < pageArea * 0.02 || bestArea > pageArea * 0.97) return { x: 0, y: 0, width, height, cropped: false };
  const padX = Math.round(best.width * 0.03), padY = Math.round(best.height * 0.03);
  const x = Math.max(0, best.x - padX), y = Math.max(0, best.y - padY);
  return { x, y, width: Math.min(width - x, best.width + padX * 2), height: Math.min(height - y, best.height + padY * 2), cropped: true };
}

function borderLuminanceSpread(rgba, width, height, margin, bg) {
  let sum = 0, sumSquares = 0, count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x > margin && x < width - margin && y > margin && y < height - margin) continue;
      const i = (y * width + x) * 4;
      const d = Math.hypot(rgba[i] - bg[0], rgba[i + 1] - bg[1], rgba[i + 2] - bg[2]);
      sum += d; sumSquares += d * d; count += 1;
    }
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
}

function quadFromCorners(cv, tracker, homography, refWidth, refHeight) {
  const corners = tracker.add(cv.matFromArray(4, 1, cv.CV_32FC2, new Float32Array([0, 0, refWidth, 0, refWidth, refHeight, 0, refHeight])));
  const projected = tracker.add(new cv.Mat());
  cv.perspectiveTransform(corners, projected, homography);
  const points = projected.data32F; const quad = [];
  for (let i = 0; i < 8; i += 2) quad.push([points[i], points[i + 1]]);
  return quad;
}

function polygonArea(quad) {
  let area = 0;
  for (let i = 0; i < quad.length; i += 1) { const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % quad.length]; area += x1 * y2 - x2 * y1; }
  return Math.abs(area) / 2;
}

function boxFromQuad(quad) {
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

// Feature-based localisation of the reference object, repeated to find several instances.
function featureDetections(cv, tracker, sceneGray, refGray, sceneWidth, sceneHeight, refWidth, refHeight) {
  const orb = tracker.add(new cv.ORB(2000));
  const sceneKeys = tracker.add(new cv.KeyPointVector()); const sceneDesc = tracker.add(new cv.Mat());
  const refKeys = tracker.add(new cv.KeyPointVector()); const refDesc = tracker.add(new cv.Mat());
  const noMask = tracker.add(new cv.Mat());
  orb.detectAndCompute(sceneGray, noMask, sceneKeys, sceneDesc);
  orb.detectAndCompute(refGray, noMask, refKeys, refDesc);
  if (sceneDesc.rows < 8 || refDesc.rows < 8) return [];

  const matcher = tracker.add(new cv.BFMatcher(cv.NORM_HAMMING, false));
  const knn = tracker.add(new cv.DMatchVectorVector());
  matcher.knnMatch(refDesc, sceneDesc, knn, 2);
  let good = [];
  for (let i = 0; i < knn.size(); i += 1) {
    const pair = knn.get(i);
    if (pair.size() < 2) continue;
    const best = pair.get(0), second = pair.get(1);
    if (best.distance < 0.8 * second.distance) good.push({ q: best.queryIdx, t: best.trainIdx });
  }

  const detections = [];
  const goodTotalAtStart = good.length;
  for (let instance = 0; instance < 3 && good.length >= 8; instance += 1) {
    const src = new Float32Array(good.length * 2), dst = new Float32Array(good.length * 2);
    good.forEach((match, index) => {
      src[index * 2] = refKeys.get(match.q).pt.x; src[index * 2 + 1] = refKeys.get(match.q).pt.y;
      dst[index * 2] = sceneKeys.get(match.t).pt.x; dst[index * 2 + 1] = sceneKeys.get(match.t).pt.y;
    });
    const srcMat = tracker.add(cv.matFromArray(good.length, 1, cv.CV_32FC2, src));
    const dstMat = tracker.add(cv.matFromArray(good.length, 1, cv.CV_32FC2, dst));
    const inlierMask = tracker.add(new cv.Mat());
    const homography = tracker.add(cv.findHomography(srcMat, dstMat, cv.RANSAC, 6, inlierMask));
    if (homography.empty()) break;
    const flags = inlierMask.data;
    const inlierIndexes = []; for (let k = 0; k < good.length; k += 1) if (flags[k]) inlierIndexes.push(k);
    if (inlierIndexes.length < 8) break;
    const quad = quadFromCorners(cv, tracker, homography, refWidth, refHeight);
    const area = polygonArea(quad);
    const inBounds = quad.every(([x, y]) => x > -sceneWidth * 0.1 && x < sceneWidth * 1.1 && y > -sceneHeight * 0.1 && y < sceneHeight * 1.1);
    const sideLengths = quad.map((p, idx) => Math.hypot(p[0] - quad[(idx + 1) % 4][0], p[1] - quad[(idx + 1) % 4][1]));
    const plausible = inBounds && area > sceneWidth * sceneHeight * 0.0008 && area < sceneWidth * sceneHeight * 0.6 && Math.min(...sideLengths) > 10;
    if (!plausible) break;
    const inlierRatio = inlierIndexes.length / goodTotalAtStart;
    const confidence = Math.round(100 * Math.min(1, 0.55 * Math.min(1, inlierIndexes.length / 30) + 0.45 * Math.min(1, inlierRatio * 2.5)));
    detections.push({ ...boxFromQuad(quad), quad, confidence, method: "feature", inliers: inlierIndexes.length });
    const remove = new Set(inlierIndexes);
    good = good.filter((_, index) => !remove.has(index));
  }
  return detections;
}

// Template matching at several scales, verified by colour-histogram similarity.
function templateDetections(cv, tracker, sceneRgba, sceneGray, sceneWidth, sceneHeight, refRgba, refGray, refWidth, refHeight) {
  const found = [];
  const refHsv = tracker.add(new cv.Mat());
  const refCrop = tracker.add(cv.matFromArray(refHeight, refWidth, cv.CV_8UC4, refRgba));
  const sceneColor = tracker.add(cv.matFromArray(sceneHeight, sceneWidth, cv.CV_8UC4, sceneRgba));
  cv.cvtColor(refCrop, refHsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(refHsv, refHsv, cv.COLOR_RGB2HSV);
  const sceneHsv = tracker.add(new cv.Mat());
  cv.cvtColor(sceneColor, sceneHsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(sceneHsv, sceneHsv, cv.COLOR_RGB2HSV);

  const refHist = histogramOf(cv, tracker, refHsv);

  const refAspect = refHeight / refWidth;
  for (const fraction of [0.05, 0.075, 0.11, 0.16, 0.23, 0.32]) {
    const templateWidth = Math.round(sceneWidth * fraction);
    const templateHeight = Math.round(templateWidth * refAspect);
    if (templateWidth < 12 || templateHeight < 12 || templateWidth >= sceneWidth || templateHeight >= sceneHeight) continue;
    const templ = tracker.add(new cv.Mat());
    cv.resize(refGray, templ, new cv.Size(templateWidth, templateHeight), 0, 0, cv.INTER_AREA);
    const response = tracker.add(new cv.Mat());
    cv.matchTemplate(sceneGray, templ, response, cv.TM_CCOEFF_NORMED);
    const scores = response.data32F;
    const candidates = [];
    for (let index = 0; index < scores.length; index += 1) {
      if (scores[index] >= 0.55) candidates.push({ index, score: scores[index] });
    }
    candidates.sort((a, b) => b.score - a.score);
    const accepted = [];
    for (const candidate of candidates) {
      if (accepted.length >= 6) break;
      const x = candidate.index % response.cols, y = Math.floor(candidate.index / response.cols);
      const box = { x, y, width: templateWidth, height: templateHeight };
      if (accepted.some((other) => iou(other.box, box) > 0.3)) continue;
      const patch = tracker.add(sceneHsv.roi(new cv.Rect(x, y, templateWidth, templateHeight)));
      const patchHist = histogramOf(cv, tracker, patch);
      const colorSimilarity = cv.compareHist(refHist, patchHist, cv.HISTCMP_CORREL);
      accepted.push({ box, score: candidate.score, colorSimilarity });
    }
    for (const { box, score, colorSimilarity } of accepted) {
      if (colorSimilarity < 0.45) continue;
      const confidence = Math.round(100 * Math.max(0, 0.6 * score + 0.4 * colorSimilarity));
      found.push({ ...box, quad: null, confidence, method: "template", ncc: Math.round(score * 100), colorSimilarity: Math.round(colorSimilarity * 100) });
    }
  }
  return found;
}

// Hue/saturation histogram: hue separates colours, saturation keeps grey or white backgrounds from dominating.
function histogramOf(cv, tracker, hsvMat) {
  const images = tracker.add(new cv.MatVector());
  images.push_back(hsvMat);
  const hist = tracker.add(new cv.Mat());
  cv.calcHist(images, [0, 1], tracker.add(new cv.Mat()), hist, [30, 32], [0, 180, 0, 256], false);
  cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX, -1, new cv.Mat());
  return hist;
}

// Keeps the strongest detection when boxes overlap heavily, or when a weaker box mostly sits inside a stronger one.
function overlapFraction(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller <= 0 ? 0 : inter / smaller;
}

function nonMaximumSuppression(detections) {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const detection of sorted) {
    if (kept.some((other) => iou(other, detection) > 0.3 || overlapFraction(other, detection) > 0.5)) continue;
    kept.push(detection);
  }
  return kept;
}

async function annotate(sceneBuffer, detections, sceneWidth, sceneHeight) {
  const targetWidth = Math.min(1200, sceneWidth);
  const factor = targetWidth / sceneWidth;
  const base = await sharp(sceneBuffer, { failOn: "none" }).rotate().resize({ width: targetWidth }).jpeg({ quality: 88 }).toBuffer();
  const boxes = detections.map((d, index) => {
    const x = d.x * factor, y = d.y * factor, w = d.width * factor, h = d.height * factor;
    const label = `#${index + 1} ${d.confidence}%`;
    const labelWidth = label.length * 9 + 14;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="rgba(201,240,100,0.12)" stroke="#c9f064" stroke-width="3"/>` +
      `<rect x="${x.toFixed(1)}" y="${Math.max(0, y - 24).toFixed(1)}" width="${labelWidth}" height="22" rx="4" fill="#0a4b33"/>` +
      `<text x="${(x + 7).toFixed(1)}" y="${Math.max(16, y - 8).toFixed(1)}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#c9f064">${label}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${Math.round(sceneHeight * factor)}">${boxes}</svg>`);
  const out = await sharp(base).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 86 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function cropPreview(sceneBuffer, detection, sceneSize) {
  const left = Math.max(0, Math.floor(detection.x)), top = Math.max(0, Math.floor(detection.y));
  const width = Math.min(sceneSize.width - left, Math.ceil(detection.width)), height = Math.min(sceneSize.height - top, Math.ceil(detection.height));
  if (width < 4 || height < 4) return null;
  const buffer = await sharp(sceneBuffer, { failOn: "none" }).rotate().extract({ left, top, width, height }).resize({ width: 240, height: 240, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

// Main entry: sceneBuffer = crowded-area photo, referenceBuffer = photo of the missing item.
async function findItemInScene(sceneBuffer, referenceBuffer) {
  const { cv } = await loadOpenCv();
  const tracker = new Tracker();
  try {
    const scene = await decode(sceneBuffer, MAX_SCENE_SIDE);
    const reference = await decode(referenceBuffer, MAX_REFERENCE_SIDE);
    const cropBox = cropReference(cv, tracker, reference.data, reference.width, reference.height);
    const refCrop = { data: cropRaw(reference.data, reference.width, cropBox), width: cropBox.width, height: cropBox.height };

    const sceneMat = rgbaMat(cv, tracker, scene);
    const sceneGray = tracker.add(new cv.Mat()); cv.cvtColor(sceneMat, sceneGray, cv.COLOR_RGBA2GRAY);
    const refCropMat = tracker.add(cv.matFromArray(refCrop.height, refCrop.width, cv.CV_8UC4, refCrop.data));
    const refGray = tracker.add(new cv.Mat()); cv.cvtColor(refCropMat, refGray, cv.COLOR_RGBA2GRAY);

    const feature = featureDetections(cv, tracker, sceneGray, refGray, scene.width, scene.height, refCrop.width, refCrop.height);
    const template = templateDetections(cv, tracker, scene.data, sceneGray, scene.width, scene.height, refCrop.data, refGray, refCrop.width, refCrop.height);
    const merged = nonMaximumSuppression([...feature, ...template]).filter((d) => d.confidence >= MATCH_THRESHOLD).slice(0, MAX_DETECTIONS);

    // Convert from the analysed (resized) scene back to the original photo's pixel coordinates.
    const sceneSize = { width: scene.originalWidth, height: scene.originalHeight };
    const scaleBack = scene.originalWidth / scene.width;
    const detections = await Promise.all(merged.map(async (d, index) => {
      const box = { x: Math.round(d.x * scaleBack), y: Math.round(d.y * scaleBack), width: Math.round(d.width * scaleBack), height: Math.round(d.height * scaleBack) };
      return { id: index + 1, ...box, confidence: d.confidence, method: d.method, inliers: d.inliers ?? null, ncc: d.ncc ?? null, colorSimilarity: d.colorSimilarity ?? null, preview: await cropPreview(sceneBuffer, box, sceneSize) };
    }));
    const annotatedImage = await annotate(sceneBuffer, detections, sceneSize.width, sceneSize.height);
    return {
      found: detections.length > 0,
      detections,
      annotatedImage,
      reference: { cropped: cropBox.cropped },
      method: "OpenCV.js: ORB feature matching with RANSAC homography, plus multi-scale template matching verified by HSV colour histograms",
    };
  } finally {
    tracker.release();
  }
}

module.exports = { findItemInScene, loadOpenCv, MATCH_THRESHOLD };
