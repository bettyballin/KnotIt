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

  const sensitivity = document.getElementById("sensitivity");
  const minRadius = document.getElementById("minRadius");
  const maxRadius = document.getElementById("maxRadius");
  const minDist = document.getElementById("minDist");

  const sliders = [
    [sensitivity, "sensitivityValue"],
    [minRadius, "minRadiusValue"],
    [maxRadius, "maxRadiusValue"],
    [minDist, "minDistValue"],
  ];
  for (const [input, valueId] of sliders) {
    const valueEl = document.getElementById(valueId);
    valueEl.textContent = input.value;
    input.addEventListener("input", () => {
      valueEl.textContent = input.value;
    });
  }

  let cvReady = false;
  let currentImage = null;
  let knots = []; // {x, y, r}
  let currentIndex = 0;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function updateCounter() {
    counterEl.textContent = knots.length
      ? `Knot ${currentIndex + 1} of ${knots.length}`
      : "";
  }

  function setControlsEnabled(enabled) {
    nextBtn.disabled = !enabled;
    prevBtn.disabled = !enabled;
    resetBtn.disabled = !enabled;
  }

  function waitForCv() {
    return new Promise((resolve) => {
      if (typeof cv !== "undefined" && cv && cv.Mat) {
        cvReady = true;
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (typeof cv !== "undefined" && cv && cv.Mat) {
          clearInterval(check);
          cvReady = true;
          resolve();
        }
      }, 80);
      // OpenCV.js sets this when its WASM runtime is ready.
      if (typeof cv !== "undefined") {
        cv["onRuntimeInitialized"] = () => {
          clearInterval(check);
          cvReady = true;
          resolve();
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

  // Group circles into rows by y, then sort each row by x. Returns flat array.
  function sortKnotsReadingOrder(circles) {
    if (circles.length === 0) return [];
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
        row.push(c);
        rowYSum += c.y;
      } else {
        row.sort((a, b) => a.x - b.x);
        rows.push(row);
        row = [c];
        rowYSum = c.y;
      }
    }
    row.sort((a, b) => a.x - b.x);
    rows.push(row);

    return rows.flat();
  }

  function detectKnots() {
    if (!cvReady || !currentImage) return;

    setStatus("Detecting knots…");

    // Defer to next frame so the status text actually paints.
    requestAnimationFrame(() => {
      let src, gray, circlesMat;
      try {
        src = cv.imread(canvas);
        gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.medianBlur(gray, gray, 5);

        circlesMat = new cv.Mat();
        const dp = 1;
        const minDistVal = parseInt(minDist.value, 10);
        const param1 = 100; // Canny upper threshold
        const param2 = parseInt(sensitivity.value, 10); // smaller -> more circles
        const minR = parseInt(minRadius.value, 10);
        const maxR = parseInt(maxRadius.value, 10);

        cv.HoughCircles(
          gray,
          circlesMat,
          cv.HOUGH_GRADIENT,
          dp,
          minDistVal,
          param1,
          param2,
          minR,
          maxR
        );

        const found = [];
        for (let i = 0; i < circlesMat.cols; i++) {
          found.push({
            x: circlesMat.data32F[i * 3],
            y: circlesMat.data32F[i * 3 + 1],
            r: circlesMat.data32F[i * 3 + 2],
          });
        }
        knots = sortKnotsReadingOrder(found);
        currentIndex = 0;

        if (knots.length === 0) {
          setStatus(
            "No knots detected. Try lowering Sensitivity or adjusting the radius range."
          );
          setControlsEnabled(false);
          drawBaseImage();
        } else {
          setStatus(`Detected ${knots.length} knots.`);
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
        if (circlesMat) circlesMat.delete();
      }
    });
  }

  function render() {
    drawBaseImage();
    if (knots.length === 0) return;

    const knot = knots[currentIndex];
    const ringRadius = knot.r * 1.7 + 4;

    // Soft outer halo for contrast on busy backgrounds
    ctx.beginPath();
    ctx.arc(knot.x, knot.y, ringRadius + 3, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();

    // Bold red ring
    ctx.beginPath();
    ctx.arc(knot.x, knot.y, ringRadius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(4, knot.r * 0.45);
    ctx.strokeStyle = "#e11d1d";
    ctx.stroke();

    updateCounter();
  }

  function next() {
    if (knots.length === 0) return;
    currentIndex = (currentIndex + 1) % knots.length;
    render();
  }

  function prev() {
    if (knots.length === 0) return;
    currentIndex = (currentIndex - 1 + knots.length) % knots.length;
    render();
  }

  function reset() {
    if (knots.length === 0) return;
    currentIndex = 0;
    render();
  }

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
  redetectBtn.addEventListener("click", () => {
    if (currentImage) detectKnots();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (knots.length === 0) return;
    if (e.code === "Space" || e.code === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      prev();
    }
  });

  // Kick off OpenCV readiness as soon as the script tag finishes loading.
  waitForCv().then(() => {
    setStatus("Ready. Upload a pattern image to begin.");
  });
})();
