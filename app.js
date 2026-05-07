(() => {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const nextBtn = document.getElementById("nextBtn");
  const prevBtn = document.getElementById("prevBtn");
  const resetBtn = document.getElementById("resetBtn");
  const lockBtn = document.getElementById("lockBtn");
  const rowInput = document.getElementById("rowInput");
  const rowTotal = document.getElementById("rowTotal");
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

  const recolorSection = document.getElementById("recolorSection");
  const recolorRulesEl = document.getElementById("recolorRules");
  const addRecolorBtn = document.getElementById("addRecolorBtn");
  const clearRecolorBtn = document.getElementById("clearRecolorBtn");

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
  let currentImage = null;            // original uploaded image (HTMLImageElement)
  let displayCanvas = null;           // off-screen canvas with recoloured pixels (or null)
  let templateMat = null;             // grayscale cv.Mat of the user-picked template
  let templateCenter = null;          // {x, y} in canvas pixel space
  let templateExtractedSize = 0;      // px size used when extracted
  let templateLocked = false;         // if true, canvas clicks navigate instead of re-picking
  let knots = [];                     // [{x, y, r, rowIndex, score}]
  let knotsByRow = [];
  let currentIndex = 0;
  let recolorRules = [];              // [{el, fromInput, toInput, tolInput, eyedropperBtn}]
  let eyedropperTarget = null;        // {rule, input} when waiting for a colour pick

  const setStatus = (text) => { statusEl.textContent = text; };
  const updateCounter = () => {
    if (knots.length === 0) { counterEl.textContent = ""; return; }
    const k = knots[currentIndex];
    counterEl.textContent = `Row ${k.rowIndex + 1} · Knot ${currentIndex + 1} of ${knots.length}`;
    if (document.activeElement !== rowInput) {
      rowInput.value = String(k.rowIndex + 1);
    }
  };
  const setStepEnabled = (enabled) => {
    nextBtn.disabled = !enabled;
    prevBtn.disabled = !enabled;
    resetBtn.disabled = !enabled;
    rowInput.disabled = !enabled;
    if (enabled) {
      rowInput.min = "1";
      rowInput.max = String(knotsByRow.length);
      rowTotal.textContent = `/ ${knotsByRow.length}`;
    } else {
      rowTotal.textContent = "/ —";
    }
  };

  function setTemplateLocked(locked) {
    templateLocked = locked;
    lockBtn.textContent = locked ? "Unlock template" : "Lock template";
    lockBtn.classList.toggle("locked", locked);
    canvas.style.cursor = !templateMat
      ? "crosshair"
      : locked
        ? "pointer"
        : "crosshair";
  }

  function gotoRow(rowIndex0) {
    if (knotsByRow.length === 0) return;
    const r = Math.max(0, Math.min(rowIndex0, knotsByRow.length - 1));
    const first = knotsByRow[r][0];
    const idx = knots.indexOf(first);
    if (idx >= 0) {
      currentIndex = idx;
      render();
    }
  }

  function jumpToNearestKnot(px, py) {
    if (knots.length === 0) return;
    let bestIdx = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < knots.length; i++) {
      const dx = knots[i].x - px;
      const dy = knots[i].y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    currentIndex = bestIdx;
    render();
  }

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

  function getDisplaySource() {
    return displayCanvas || currentImage;
  }

  function getSourceWidth(src) {
    return src.naturalWidth || src.width;
  }

  function getSourceHeight(src) {
    return src.naturalHeight || src.height;
  }

  function drawBaseImage() {
    const src = getDisplaySource();
    canvas.width = getSourceWidth(src);
    canvas.height = getSourceHeight(src);
    ctx.drawImage(src, 0, 0);
  }

  function hexToRgb(hex) {
    const s = (hex || "").replace("#", "");
    if (s.length !== 6) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(s.substring(0, 2), 16),
      g: parseInt(s.substring(2, 4), 16),
      b: parseInt(s.substring(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    const h = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    const v = max * 100;
    return { h, s, v };
  }

  function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let rp, gp, bp;
    if (h < 60)       { rp = c; gp = x; bp = 0; }
    else if (h < 120) { rp = x; gp = c; bp = 0; }
    else if (h < 180) { rp = 0; gp = c; bp = x; }
    else if (h < 240) { rp = 0; gp = x; bp = c; }
    else if (h < 300) { rp = x; gp = 0; bp = c; }
    else              { rp = c; gp = 0; bp = x; }
    return {
      r: Math.round((rp + m) * 255),
      g: Math.round((gp + m) * 255),
      b: Math.round((bp + m) * 255),
    };
  }

  function rebuildDisplayCanvas() {
    if (!currentImage) return;
    if (recolorRules.length === 0) {
      displayCanvas = null;
      return;
    }
    if (!displayCanvas) displayCanvas = document.createElement("canvas");
    displayCanvas.width = currentImage.naturalWidth;
    displayCanvas.height = currentImage.naturalHeight;
    const dctx = displayCanvas.getContext("2d");
    dctx.drawImage(currentImage, 0, 0);

    const imgData = dctx.getImageData(0, 0, displayCanvas.width, displayCanvas.height);
    const data = imgData.data;

    // Pre-compile each rule. We match in RGB (intuitive for the tolerance
    // slider) but apply the swap in HSV: keep the pixel's *relative* value
    // so darker variants of the source colour (e.g. arrow strokes inside a
    // filled circle) become correspondingly dark variants of the target,
    // instead of all collapsing to the same flat target colour and erasing
    // the arrow.
    const compiled = recolorRules.map((r) => {
      const f = hexToRgb(r.fromInput.value);
      const t = hexToRgb(r.toInput.value);
      const fHsv = rgbToHsv(f.r, f.g, f.b);
      const tHsv = rgbToHsv(t.r, t.g, t.b);
      const tol = parseInt(r.tolInput.value, 10);
      return {
        fr: f.r, fg: f.g, fb: f.b,
        toH: tHsv.h, toS: tHsv.s, toV: tHsv.v,
        fromV: Math.max(1, fHsv.v),
        tol2: tol * tol,
      };
    });

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      for (const c of compiled) {
        const dr = r - c.fr, dg = g - c.fg, db = b - c.fb;
        if (dr * dr + dg * dg + db * db <= c.tol2) {
          const pHsv = rgbToHsv(r, g, b);
          const newV = Math.min(100, c.toV * (pHsv.v / c.fromV));
          const out = hsvToRgb(c.toH, c.toS, newV);
          data[i] = out.r; data[i + 1] = out.g; data[i + 2] = out.b;
          break;
        }
      }
    }
    dctx.putImageData(imgData, 0, 0);
  }

  function applyRecolor() {
    rebuildDisplayCanvas();
    drawBaseImage();
    if (templateCenter && templateMat) {
      // Re-extract template from the now-recoloured canvas, then re-match.
      setTemplate(templateCenter.x, templateCenter.y);
    } else if (knots.length) {
      if (showAllToggle.checked) drawAllOverlay(ctx, knots);
      drawRedRing(ctx, knots[currentIndex]);
      drawZoom();
    }
  }

  function activateEyedropper(rule) {
    if (eyedropperTarget) {
      eyedropperTarget.rule.eyedropperBtn.classList.remove("active");
    }
    eyedropperTarget = { rule, input: rule.fromInput };
    rule.eyedropperBtn.classList.add("active");
    canvas.style.cursor = "crosshair";
    setStatus('Tap a colour in the pattern to set it as the "from" colour.');
  }

  function cancelEyedropper() {
    if (eyedropperTarget) {
      eyedropperTarget.rule.eyedropperBtn.classList.remove("active");
      eyedropperTarget = null;
    }
    canvas.style.cursor = !templateMat
      ? "crosshair"
      : (templateLocked ? "pointer" : "crosshair");
  }

  function pickColorAt(px, py) {
    if (!eyedropperTarget) return;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(px)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(py)));
    const data = ctx.getImageData(x, y, 1, 1).data;
    const hex = rgbToHex(data[0], data[1], data[2]);
    const target = eyedropperTarget.input;
    target.value = hex;
    setStatus("Picked " + hex);
    cancelEyedropper();
    applyRecolor();
  }

  function addRecolorRule(initialFromHex) {
    const ruleEl = document.createElement("div");
    ruleEl.className = "recolor-rule";
    ruleEl.innerHTML = `
      <input type="color" class="from-color" value="${initialFromHex || "#cca22d"}">
      <button type="button" class="eyedropper" title="Pick the &quot;from&quot; colour from the pattern">Pick</button>
      <span class="arrow">&rarr;</span>
      <input type="color" class="to-color" value="#0066cc">
      <input type="range" class="tolerance" min="5" max="160" value="50" title="Colour tolerance">
      <button type="button" class="remove-rule" title="Remove rule" aria-label="Remove">&times;</button>
    `;

    const fromInput = ruleEl.querySelector(".from-color");
    const toInput = ruleEl.querySelector(".to-color");
    const tolInput = ruleEl.querySelector(".tolerance");
    const eyedropperBtn = ruleEl.querySelector(".eyedropper");
    const removeBtn = ruleEl.querySelector(".remove-rule");

    const rule = { el: ruleEl, fromInput, toInput, tolInput, eyedropperBtn };
    recolorRules.push(rule);
    recolorRulesEl.appendChild(ruleEl);

    fromInput.addEventListener("change", applyRecolor);
    toInput.addEventListener("change", applyRecolor);

    let tolDebounce;
    tolInput.addEventListener("input", () => {
      clearTimeout(tolDebounce);
      tolDebounce = setTimeout(applyRecolor, 120);
    });

    eyedropperBtn.addEventListener("click", () => {
      if (eyedropperTarget && eyedropperTarget.rule === rule) {
        cancelEyedropper();
      } else {
        activateEyedropper(rule);
      }
    });

    removeBtn.addEventListener("click", () => {
      ruleEl.remove();
      recolorRules = recolorRules.filter((r) => r !== rule);
      if (eyedropperTarget && eyedropperTarget.rule === rule) cancelEyedropper();
      applyRecolor();
    });
  }

  function resetRecolorRules() {
    recolorRules.forEach((r) => r.el.remove());
    recolorRules = [];
    if (eyedropperTarget) cancelEyedropper();
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
    lockBtn.disabled = false;
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
    const src = getDisplaySource();
    const srcW = getSourceWidth(src);
    const srcH = getSourceHeight(src);
    minX = Math.max(0, minX - 12);
    minY = Math.max(0, minY - 12);
    maxX = Math.min(srcW, maxX + 12);
    maxY = Math.min(srcH, maxY + 12);

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
    zctx.drawImage(src, minX, minY, cropW, cropH, 0, 0, zw, zh);

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
    lockBtn.disabled = true;
    setTemplateLocked(false);
    resetRecolorRules();
    displayCanvas = null;
    try {
      setStatus("Loading image…");
      currentImage = await loadImageFromFile(file);
      drawBaseImage();
      templateSection.hidden = false;
      recolorSection.hidden = false;
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

  function handleCanvasPick(p) {
    if (eyedropperTarget) {
      pickColorAt(p.x, p.y);
      return;
    }
    if (templateLocked) {
      jumpToNearestKnot(p.x, p.y);
    } else {
      setTemplate(p.x, p.y);
    }
  }

  canvas.addEventListener("click", (e) => {
    const p = canvasPointFromEvent(e);
    if (!p) return;
    handleCanvasPick(p);
  });

  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const p = canvasPointFromEvent(e);
    if (!p) return;
    handleCanvasPick(p);
  }, { passive: false });

  lockBtn.addEventListener("click", () => {
    if (!templateMat) return;
    setTemplateLocked(!templateLocked);
  });

  rowInput.addEventListener("change", () => {
    const r = parseInt(rowInput.value, 10);
    if (Number.isFinite(r)) gotoRow(r - 1);
  });

  addRecolorBtn.addEventListener("click", () => {
    addRecolorRule();
    if (recolorRules.length === 1) applyRecolor();
  });

  clearRecolorBtn.addEventListener("click", () => {
    if (recolorRules.length === 0) return;
    resetRecolorRules();
    applyRecolor();
  });

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
