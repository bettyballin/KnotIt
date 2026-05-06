(() => {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const nextBtn = document.getElementById("nextBtn");
  const prevBtn = document.getElementById("prevBtn");
  const resetBtn = document.getElementById("resetBtn");
  const rematchBtn = document.getElementById("rematchBtn");
  const templateSection = document.getElementById("templateSection");
  const templateHint = document.getElementById("templateHint");
  const templateCanvas = document.getElementById("templateCanvas");
  const tplCtx = templateCanvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const counterEl = document.getElementById("counter");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const zoomCanvas = document.getElementById("zoomCanvas");
  const zctx = zoomCanvas.getContext("2d");
  const zoomSection = document.getElementById("zoomSection");
  const zoomToggle = document.getElementById("zoomToggle");
  const showAllToggle = document.getElementById("showAllToggle");

  const templateSize = document.getElementById("templateSize");
  const matchThreshold = document.getElementById("matchThreshold");
  const rotationCount = document.getElementById("rotationCount");
  const matchInverted = document.getElementById("matchInverted");

  for (const [input, valueId] of [
    [templateSize, "templateSizeValue"],
    [matchThreshold, "matchThresholdValue"],
    [rotationCount, "rotationCountValue"],
  ]) {
    const valueEl = document.getElementById(valueId);
    valueEl.textContent = input.value;
    input.addEventListener("input", () => { valueEl.textContent = input.value; });
  }

  let cvReady = false;
  let currentImage = null;
  let templateMat = null;             // grayscale cv.Mat of the user-picked template
  let templateCenter = null;          // {x, y} in canvas pixel space
  let templateExtractedSize = 0;      // px size used when extracted
  let knots = [];                     // [{x, y, r, rowIndex, score}]
  let knotsByRow = [];
  let currentIndex = 0;

  const setStatus = (text) => { statusEl.textContent = text; };
  const updateCounter = () => {
    if (knots.length === 0) { counterEl.textContent = ""; return; }
    const k = knots[currentIndex];
    counterEl.textContent = `Row ${k.rowIndex + 1} · Knot ${currentIndex + 1} of ${knots.length}`;
  };
  const setStepEnabled = (enabled) => {
    nextBtn.disabled = !enabled;
    prevBtn.disabled = !enabled;
    resetBtn.disabled = !enabled;
  };

  function waitForCv() {
    return new Promise((resolve) => {
      if (typeof cv !== "undefined" && cv && cv.Mat) {
        cvReady = true; resolve(); return;
      }
      const check = setInterval(() => {
        if (typeof cv !== "undefined" && cv && cv.Mat) {
          clearInterval(check); cvReady = true; resolve();
        }
      }, 80);
      if (typeof cv !== "undefined") {
        cv["onRuntimeInitialized"] = () => {
          clearInterval(check); cvReady = true; resolve();
        };
      }
    });
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = (e) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not decode image"));
        image.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function drawBaseImage() {
    canvas.width = currentImage.naturalWidth;
    canvas.height = currentImage.naturalHeight;
    ctx.drawImage(currentImage, 0, 0);
  }

  function setTemplate(centerX, centerY) {
    if (!currentImage || !cvReady) return;
    const size = parseInt(templateSize.value, 10);
    const half = Math.floor(size / 2);
    const x0 = Math.max(0, Math.floor(centerX - half));
    const y0 = Math.max(0, Math.floor(centerY - half));
    const x1 = Math.min(canvas.width, x0 + size);
    const y1 = Math.min(canvas.height, y0 + size);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) {
      setStatus("Pick a spot away from the edge so the template fits.");
      return;
    }

    let src, gray;
    try {
      src = cv.imread(canvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      if (templateMat) { templateMat.delete(); templateMat = null; }
      templateMat = gray.roi(new cv.Rect(x0, y0, w, h)).clone();
      templateCenter = { x: centerX, y: centerY };
      templateExtractedSize = Math.min(w, h);
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
    }

    showTemplatePreview();
    rematchBtn.disabled = false;
    runMatching();
  }

  function showTemplatePreview() {
    if (!templateMat) return;
    const w = templateMat.cols, h = templateMat.rows;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tmpCtx = tmp.getContext("2d");
    const imageData = tmpCtx.createImageData(w, h);
    const data = templateMat.data;
    for (let i = 0; i < w * h; i++) {
      const v = data[i];
      imageData.data[i * 4] = v;
      imageData.data[i * 4 + 1] = v;
      imageData.data[i * 4 + 2] = v;
      imageData.data[i * 4 + 3] = 255;
    }
    tmpCtx.putImageData(imageData, 0, 0);

    const display = 96;
    templateCanvas.width = display;
    templateCanvas.height = display;
    tplCtx.imageSmoothingEnabled = true;
    tplCtx.imageSmoothingQuality = "high";
    tplCtx.clearRect(0, 0, display, display);
    tplCtx.drawImage(tmp, 0, 0, display, display);
  }

  function findPeaks(result, threshold, minDist) {
    const dilated = new cv.Mat();
    const ksize = Math.max(3, Math.floor(minDist) | 1);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ksize, ksize));
    cv.dilate(result, dilated, kernel);

    const peaks = [];
    const cols = result.cols;
    const rows = result.rows;
    const rData = result.data32F;
    const dData = dilated.data32F;
    for (let y = 0; y < rows; y++) {
      const rowOff = y * cols;
      for (let x = 0; x < cols; x++) {
        const v = rData[rowOff + x];
        if (v < threshold) continue;
        if (v >= dData[rowOff + x] - 1e-6) peaks.push({ x, y, val: v });
      }
    }

    dilated.delete();
    kernel.delete();
    return peaks;
  }

  function rotatedTemplate(base, angleDeg) {
    if (angleDeg === 0) return base;
    const cx = base.cols / 2, cy = base.rows / 2;
    const M = cv.getRotationMatrix2D(new cv.Point(cx, cy), angleDeg, 1);
    const rotated = new cv.Mat();
    cv.warpAffine(
      base, rotated, M,
      new cv.Size(base.cols, base.rows),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE
    );
    M.delete();
    return rotated;
  }

  function runMatching() {
    if (!templateMat || !currentImage) return;
    setStatus("Matching template across the pattern…");

    requestAnimationFrame(() => setTimeout(doMatching, 0));
  }

  function doMatching() {
    let src, gray, maxResp;
    const tempMats = [];
    try {
      src = cv.imread(canvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      const tplW = templateMat.cols;
      const tplH = templateMat.rows;
      const halfW = tplW / 2;
      const halfH = tplH / 2;

      const nRot = parseInt(rotationCount.value, 10);
      const angles = [];
      for (let i = 0; i < nRot; i++) angles.push((i * 360) / nRot);

      const polarities = [templateMat];
      if (matchInverted.checked) {
        const inv = new cv.Mat();
        cv.bitwise_not(templateMat, inv);
        polarities.push(inv);
        tempMats.push(inv);
      }

      for (const base of polarities) {
        for (const ang of angles) {
          const rt = rotatedTemplate(base, ang);
          const result = new cv.Mat();
          try {
            cv.matchTemplate(gray, rt, result, cv.TM_CCOEFF_NORMED);
            if (!maxResp) {
              maxResp = result.clone();
            } else {
              cv.max(maxResp, result, maxResp);
            }
          } finally {
            result.delete();
            if (rt !== base) rt.delete();
          }
        }
      }

      const threshold = parseInt(matchThreshold.value, 10) / 100;
      const minDist = Math.max(Math.floor(Math.min(tplW, tplH) * 0.7), 6);
      const peaks = findPeaks(maxResp, threshold, minDist);

      const r = Math.min(halfW, halfH) * 0.65;
      const detected = peaks.map((p) => ({
        x: p.x + halfW,
        y: p.y + halfH,
        r,
        score: p.val,
      }));

      knots = sortKnotsReadingOrder(detected);
      currentIndex = 0;

      if (knots.length === 0) {
        setStatus("No matches above threshold. Try lowering the match threshold or re-picking the template.");
        setStepEnabled(false);
        drawBaseImage();
        zoomSection.hidden = true;
      } else {
        const bestScore = Math.max(...knots.map((k) => k.score));
        setStatus(
          `Found ${knots.length} matches in ${knotsByRow.length} rows ` +
          `(best score ${bestScore.toFixed(2)}).`
        );
        setStepEnabled(true);
        render();
      }
      updateCounter();
    } catch (err) {
      console.error(err);
      setStatus("Matching failed: " + (err && err.message ? err.message : err));
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
      if (maxResp) maxResp.delete();
      for (const m of tempMats) m.delete();
    }
  }

  function sortKnotsReadingOrder(circles) {
    if (circles.length === 0) { knotsByRow = []; return []; }
    const sorted = [...circles].sort((a, b) => a.y - b.y);
    const avgR = sorted.reduce((s, c) => s + c.r, 0) / sorted.length;
    const rowTol = Math.max(avgR * 0.9, 6);

    const rows = [];
    let row = [sorted[0]];
    let rowYSum = sorted[0].y;
    for (let i = 1; i < sorted.length; i++) {
      const c = sorted[i];
      const rowMeanY = rowYSum / row.length;
      if (c.y - rowMeanY < rowTol) {
        row.push(c); rowYSum += c.y;
      } else {
        row.sort((a, b) => a.x - b.x);
        rows.push(row);
        row = [c]; rowYSum = c.y;
      }
    }
    row.sort((a, b) => a.x - b.x);
    rows.push(row);

    knotsByRow = rows;
    const flat = [];
    rows.forEach((r, rowIndex) => {
      r.forEach((k) => { k.rowIndex = rowIndex; flat.push(k); });
    });
    return flat;
  }

  function drawRedRing(targetCtx, knot) {
    const ringRadius = knot.r * 1.55 + 4;
    targetCtx.beginPath();
    targetCtx.arc(knot.x, knot.y, ringRadius + 3, 0, Math.PI * 2);
    targetCtx.lineWidth = 8;
    targetCtx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    targetCtx.stroke();

    targetCtx.beginPath();
    targetCtx.arc(knot.x, knot.y, ringRadius, 0, Math.PI * 2);
    targetCtx.lineWidth = Math.max(4, knot.r * 0.45);
    targetCtx.strokeStyle = "#e11d1d";
    targetCtx.stroke();
  }

  function drawAllOverlay(targetCtx, list, scale = 1, ox = 0, oy = 0) {
    targetCtx.save();
    for (const k of list) {
      targetCtx.beginPath();
      targetCtx.arc((k.x - ox) * scale, (k.y - oy) * scale, Math.max(2, k.r * scale * 0.25), 0, Math.PI * 2);
      targetCtx.fillStyle = "rgba(40, 160, 40, 0.85)";
      targetCtx.fill();
    }
    targetCtx.restore();
  }

  function drawZoom() {
    if (!zoomToggle.checked || knots.length === 0) {
      zoomSection.hidden = true;
      return;
    }
    const knot = knots[currentIndex];
    const rowKnots = knotsByRow[knot.rowIndex];
    if (!rowKnots || rowKnots.length === 0) { zoomSection.hidden = true; return; }
    zoomSection.hidden = false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const k of rowKnots) {
      const r = k.r * 1.9 + 6;
      if (k.x - r < minX) minX = k.x - r;
      if (k.x + r > maxX) maxX = k.x + r;
      if (k.y - r < minY) minY = k.y - r;
      if (k.y + r > maxY) maxY = k.y + r;
    }
    minX = Math.max(0, minX - 12);
    minY = Math.max(0, minY - 12);
    maxX = Math.min(currentImage.naturalWidth, maxX + 12);
    maxY = Math.min(currentImage.naturalHeight, maxY + 12);

    const cropW = maxX - minX;
    const cropH = maxY - minY;
    const containerWidth = Math.max(320, zoomSection.clientWidth - 40);
    const aspect = cropW / cropH;
    let zw = containerWidth;
    let zh = zw / aspect;
    if (zh > 260) { zh = 260; zw = zh * aspect; }

    zoomCanvas.width = Math.round(zw);
    zoomCanvas.height = Math.round(zh);
    zctx.imageSmoothingEnabled = true;
    zctx.imageSmoothingQuality = "high";
    zctx.drawImage(currentImage, minX, minY, cropW, cropH, 0, 0, zw, zh);

    const scale = zw / cropW;
    if (showAllToggle.checked) {
      drawAllOverlay(zctx, rowKnots, scale, minX, minY);
    }
    drawRedRing(zctx, {
      x: (knot.x - minX) * scale,
      y: (knot.y - minY) * scale,
      r: knot.r * scale,
    });
  }

  function render() {
    drawBaseImage();
    if (knots.length === 0) { zoomSection.hidden = true; return; }
    if (showAllToggle.checked) drawAllOverlay(ctx, knots);
    drawRedRing(ctx, knots[currentIndex]);
    drawZoom();
    updateCounter();
  }

  const next = () => {
    if (knots.length === 0) return;
    currentIndex = (currentIndex + 1) % knots.length;
    render();
  };
  const prev = () => {
    if (knots.length === 0) return;
    currentIndex = (currentIndex - 1 + knots.length) % knots.length;
    render();
  };
  const reset = () => {
    if (knots.length === 0) return;
    currentIndex = 0;
    render();
  };

  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
    const clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY);
    if (clientX == null || clientY == null) return null;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStepEnabled(false);
    knots = []; knotsByRow = [];
    if (templateMat) { templateMat.delete(); templateMat = null; }
    templateCenter = null;
    rematchBtn.disabled = true;
    try {
      setStatus("Loading image…");
      currentImage = await loadImageFromFile(file);
      drawBaseImage();
      templateSection.hidden = false;
      zoomSection.hidden = true;
      tplCtx.clearRect(0, 0, templateCanvas.width, templateCanvas.height);
      if (!cvReady) {
        setStatus("Waiting for image processor…");
        await waitForCv();
      }
      setStatus("Tap or click any single knot in the pattern to set the template.");
      canvas.style.cursor = "crosshair";
    } catch (err) {
      console.error(err);
      setStatus("Could not load image: " + err.message);
    }
  });

  canvas.addEventListener("click", (e) => {
    const p = canvasPointFromEvent(e);
    if (!p) return;
    setTemplate(p.x, p.y);
  });

  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const p = canvasPointFromEvent(e);
    if (!p) return;
    setTemplate(p.x, p.y);
  }, { passive: false });

  nextBtn.addEventListener("click", next);
  prevBtn.addEventListener("click", prev);
  resetBtn.addEventListener("click", reset);
  rematchBtn.addEventListener("click", () => {
    // If template size changed since last extraction, re-extract first.
    const currentSize = parseInt(templateSize.value, 10);
    if (templateCenter && currentSize !== templateExtractedSize) {
      setTemplate(templateCenter.x, templateCenter.y);
    } else {
      runMatching();
    }
  });
  zoomToggle.addEventListener("change", () => { if (knots.length) render(); });
  showAllToggle.addEventListener("change", () => { if (knots.length) render(); });

  // Slider releases (`change`) trigger re-extract / re-match without spamming
  // matching while the user is still dragging.
  templateSize.addEventListener("change", () => {
    if (templateCenter) setTemplate(templateCenter.x, templateCenter.y);
  });
  matchThreshold.addEventListener("change", () => { if (templateMat) runMatching(); });
  rotationCount.addEventListener("change", () => { if (templateMat) runMatching(); });
  matchInverted.addEventListener("change", () => { if (templateMat) runMatching(); });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (knots.length === 0) return;
    if (e.code === "Space" || e.code === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.code === "ArrowLeft") { e.preventDefault(); prev(); }
  });

  waitForCv().then(() => {
    setStatus("Ready. Upload a pattern image to begin.");
  });
})();
