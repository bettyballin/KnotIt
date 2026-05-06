(() => {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const nextBtn = document.getElementById("nextBtn");
  const prevBtn = document.getElementById("prevBtn");
  const resetBtn = document.getElementById("resetBtn");
  const redetectBtn = document.getElementById("redetectBtn");
  const tuningSection = document.getElementById("tuning");
  const statusEl = document.getElementById("status");
  const counterEl = document.getElementById("counter");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const zoomCanvas = document.getElementById("zoomCanvas");
  const zctx = zoomCanvas.getContext("2d");
  const zoomSection = document.getElementById("zoomSection");
  const zoomToggle = document.getElementById("zoomToggle");
  const showAllToggle = document.getElementById("showAllToggle");

  const sensitivity = document.getElementById("sensitivity");
  const minRadius = document.getElementById("minRadius");
  const maxRadius = document.getElementById("maxRadius");
  const minDist = document.getElementById("minDist");
  const arrowStrictness = document.getElementById("arrowStrictness");

  for (const [input, valueId] of [
    [sensitivity, "sensitivityValue"],
    [minRadius, "minRadiusValue"],
    [maxRadius, "maxRadiusValue"],
    [minDist, "minDistValue"],
    [arrowStrictness, "arrowStrictnessValue"],
  ]) {
    const valueEl = document.getElementById(valueId);
    valueEl.textContent = input.value;
    input.addEventListener("input", () => {
      valueEl.textContent = input.value;
    });
  }

  let cvReady = false;
  let currentImage = null;
  let knots = []; // {x, y, r, rowIndex}
  let knotsByRow = []; // [[knot, knot, ...], ...]
  let currentIndex = 0;

  const setStatus = (text) => { statusEl.textContent = text; };
  const updateCounter = () => {
    if (knots.length === 0) { counterEl.textContent = ""; return; }
    const k = knots[currentIndex];
    counterEl.textContent = `Row ${k.rowIndex + 1} · Knot ${currentIndex + 1} of ${knots.length}`;
  };
  const setControlsEnabled = (enabled) => {
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

  // Returns true if a small dark mark (arrow) lives inside the circle on top of
  // a relatively uniform colour fill. Works for both dark and light fills:
  // the annulus is sampled tightly inside the outline so its colour doesn't
  // matter, only that it's uniform.
  function hasArrow(grayMat, c, strictness) {
    const innerR = c.r * 0.40;   // tighter inner so a small arrow still dominates
    const annR1 = c.r * 0.55;    // pure-fill ring, well inside the outline
    const annR2 = c.r * 0.78;
    const range = Math.ceil(annR2 + 1);
    const cx = Math.round(c.x), cy = Math.round(c.y);

    const innerVals = [];
    const annulusVals = [];
    const innerR2 = innerR * innerR;
    const ann1Sq = annR1 * annR1;
    const ann2Sq = annR2 * annR2;

    for (let dy = -range; dy <= range; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= grayMat.rows) continue;
      for (let dx = -range; dx <= range; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= grayMat.cols) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 <= innerR2) {
          innerVals.push(grayMat.ucharPtr(y, x)[0]);
        } else if (d2 >= ann1Sq && d2 <= ann2Sq) {
          annulusVals.push(grayMat.ucharPtr(y, x)[0]);
        }
      }
    }

    if (innerVals.length < 6 || annulusVals.length < 6) return false;

    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const std = (arr, m) => {
      let s = 0;
      for (const v of arr) s += (v - m) * (v - m);
      return Math.sqrt(s / arr.length);
    };

    const annMean = mean(annulusVals);
    const annStd = std(annulusVals, annMean);
    const innerMean = mean(innerVals);
    const innerStd = std(innerVals, innerMean);

    // Robust "darkest pixels" estimate — survives a small arrow stroke that
    // wouldn't move the std much but still produces a few clearly dark pixels.
    const sortedInner = [...innerVals].sort((a, b) => a - b);
    const p10Idx = Math.max(0, Math.floor(sortedInner.length * 0.1));
    const innerP10 = sortedInner[p10Idx];

    const t = strictness / 100;

    // Fill ring must be uniform — colour itself doesn't matter.
    const annStdMax = 18 + (1 - t) * 30; // 18..48
    if (annStd > annStdMax) return false;

    // Fill ring can't be plain white background.
    if (annMean > 245) return false;

    // Arrow signal: EITHER inner has noticeably more texture than the fill,
    // OR the darkest 10% of inner pixels are clearly darker than the fill.
    // The OR makes us robust to small arrows where the std stays low.
    const stdSignal = innerStd > annStd + 4 + t * 7;
    const darkSignal = innerP10 < annMean - (22 + t * 18);
    if (!stdSignal && !darkSignal) return false;

    // The inner can't be substantially brighter than the fill (rules out
    // highlights / pinholes in the middle of the disc).
    if (innerMean > annMean + 30) return false;

    return true;
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
      r.forEach((k) => {
        k.rowIndex = rowIndex;
        flat.push(k);
      });
    });
    return flat;
  }

  function detectKnots() {
    if (!cvReady || !currentImage) return;
    setStatus("Detecting knots…");

    requestAnimationFrame(() => {
      let src, gray, blurred, circlesMat;
      try {
        src = cv.imread(canvas);
        gray = new cv.Mat();
        blurred = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        // Light blur only — a 5-pixel median wiped out weak outlines (esp. on
        // the lighter circles), causing Hough to miss them.
        cv.medianBlur(gray, blurred, 3);

        circlesMat = new cv.Mat();
        cv.HoughCircles(
          blurred,
          circlesMat,
          cv.HOUGH_GRADIENT,
          1,
          parseInt(minDist.value, 10),
          60, // Canny upper — was 100; lower lets weaker outlines (yellow) vote.
          parseInt(sensitivity.value, 10),
          parseInt(minRadius.value, 10),
          parseInt(maxRadius.value, 10)
        );

        const candidates = [];
        for (let i = 0; i < circlesMat.cols; i++) {
          candidates.push({
            x: circlesMat.data32F[i * 3],
            y: circlesMat.data32F[i * 3 + 1],
            r: circlesMat.data32F[i * 3 + 2],
          });
        }

        // Filter to only circles that actually contain an arrow mark.
        // Use the unblurred grayscale so the small arrow strokes are preserved.
        const strictness = parseInt(arrowStrictness.value, 10);
        const verified = candidates.filter((c) => hasArrow(gray, c, strictness));

        knots = sortKnotsReadingOrder(verified);
        currentIndex = 0;

        if (knots.length === 0) {
          setStatus(
            `No knots detected (saw ${candidates.length} round shapes, none had an arrow). ` +
            `Try lowering Arrow strictness or Sensitivity.`
          );
          setControlsEnabled(false);
          drawBaseImage();
          zoomSection.hidden = true;
        } else {
          setStatus(
            `Detected ${knots.length} knots in ${knotsByRow.length} rows ` +
            `(${candidates.length - knots.length} non-knot circles filtered out).`
          );
          setControlsEnabled(true);
          render();
        }
        updateCounter();
      } catch (err) {
        console.error(err);
        setStatus("Detection failed: " + (err && err.message ? err.message : err));
      } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (circlesMat) circlesMat.delete();
      }
    });
  }

  function drawRedRing(targetCtx, knot) {
    const ringRadius = knot.r * 1.7 + 4;
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

  function drawAllDetectionsOverlay(targetCtx, list, scale = 1, ox = 0, oy = 0) {
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
    if (!rowKnots || rowKnots.length === 0) {
      zoomSection.hidden = true;
      return;
    }
    zoomSection.hidden = false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const k of rowKnots) {
      const r = k.r * 1.9 + 6;
      if (k.x - r < minX) minX = k.x - r;
      if (k.x + r > maxX) maxX = k.x + r;
      if (k.y - r < minY) minY = k.y - r;
      if (k.y + r > maxY) maxY = k.y + r;
    }
    const padX = 12, padY = 12;
    minX = Math.max(0, minX - padX);
    minY = Math.max(0, minY - padY);
    maxX = Math.min(currentImage.naturalWidth, maxX + padX);
    maxY = Math.min(currentImage.naturalHeight, maxY + padY);

    const cropW = maxX - minX;
    const cropH = maxY - minY;
    const containerWidth = Math.max(320, zoomSection.clientWidth - 40);
    const aspect = cropW / cropH;

    let zw = containerWidth;
    let zh = zw / aspect;
    const maxH = 260;
    if (zh > maxH) {
      zh = maxH;
      zw = zh * aspect;
    }

    zoomCanvas.width = Math.round(zw);
    zoomCanvas.height = Math.round(zh);
    zctx.imageSmoothingEnabled = true;
    zctx.imageSmoothingQuality = "high";
    zctx.drawImage(currentImage, minX, minY, cropW, cropH, 0, 0, zw, zh);

    const scale = zw / cropW;
    if (showAllToggle.checked) {
      drawAllDetectionsOverlay(zctx, rowKnots, scale, minX, minY);
    }

    const cx = (knot.x - minX) * scale;
    const cy = (knot.y - minY) * scale;
    const cr = knot.r * scale;
    drawRedRing(zctx, { x: cx, y: cy, r: cr });
  }

  function render() {
    drawBaseImage();
    if (knots.length === 0) {
      zoomSection.hidden = true;
      return;
    }
    if (showAllToggle.checked) {
      drawAllDetectionsOverlay(ctx, knots);
    }
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

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setControlsEnabled(false);
    try {
      setStatus("Loading image…");
      currentImage = await loadImageFromFile(file);
      drawBaseImage();
      tuningSection.hidden = false;
      if (!cvReady) {
        setStatus("Waiting for image processor…");
        await waitForCv();
      }
      detectKnots();
    } catch (err) {
      console.error(err);
      setStatus("Could not load image: " + err.message);
    }
  });

  nextBtn.addEventListener("click", next);
  prevBtn.addEventListener("click", prev);
  resetBtn.addEventListener("click", reset);
  redetectBtn.addEventListener("click", () => { if (currentImage) detectKnots(); });
  zoomToggle.addEventListener("change", () => { if (knots.length) render(); });
  showAllToggle.addEventListener("change", () => { if (knots.length) render(); });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (knots.length === 0) return;
    if (e.code === "Space" || e.code === "ArrowRight") {
      e.preventDefault(); next();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault(); prev();
    }
  });

  waitForCv().then(() => {
    setStatus("Ready. Upload a pattern image to begin.");
  });
})();
