export const GIFT_CODE = "ELBILLUG";
export const PARTY_DURATION = 5600;

export function initBirthday(doc = document) {
  const view = doc.defaultView;
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const canvas = doc.getElementById("confetti");
  const context = canvas.getContext("2d");
  const gift = doc.getElementById("gift");
  const opening = doc.getElementById("opening");
  const replay = doc.getElementById("replay");
  const copy = doc.getElementById("copy-code");
  const label = doc.getElementById("copy-label");
  const status = doc.getElementById("copy-status");
  let copyTimer;
  let frame;
  let particles = [];
  let width = 0;
  let height = 0;
  let started = 0;
  let previous = 0;
  let burst = 0;
  const colors = ["#667cdb", "#dda1b1", "#e7b85d", "#91b395", "#a58abc", "#df856f"];

  function resize() {
    width = view.innerWidth;
    height = view.innerHeight;
    const scale = Math.min(view.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context?.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function stopConfetti() {
    view.cancelAnimationFrame(frame);
    particles = [];
    context?.clearRect(0, 0, width, height);
  }

  function seed(count, fromTop = false) {
    for (let index = 0; index < count; index++) {
      const side = Math.random() > .5 ? 1 : -1;
      particles.push({
        x: fromTop ? Math.random() * width : side === 1 ? -8 : width + 8,
        y: fromTop ? -20 - Math.random() * 180 : height * (.4 + Math.random() * .25),
        vx: fromTop ? (Math.random() - .5) * 2 : side * (3 + Math.random() * 7),
        vy: fromTop ? 2 + Math.random() * 2 : -5 - Math.random() * 10,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - .5) * .17,
        size: 5 + Math.random() * 6,
        color: colors[index % colors.length],
        ribbon: index % 5 === 0
      });
    }
  }

  function draw(time) {
    const elapsed = time - started;
    if (elapsed >= PARTY_DURATION || reducedMotion.matches) { stopConfetti(); return; }
    const delta = Math.min((time - previous) / 16.67 || 1, 2);
    previous = time;
    if (!burst && elapsed > 1800) { seed(width < 600 ? 40 : 70, true); burst++; }
    context.clearRect(0, 0, width, height);
    context.globalAlpha = Math.min(1, (PARTY_DURATION - elapsed) / 900);
    particles = particles.filter(particle => particle.y < height + 100);
    for (const p of particles) {
      p.x += p.vx * delta; p.y += p.vy * delta; p.vy += .14 * delta;
      p.vx *= Math.pow(.993, delta); p.rotation += p.spin * delta;
      context.save();
      context.translate(p.x, p.y);
      context.rotate(p.rotation);
      context.fillStyle = p.color;
      if (p.ribbon) {
        context.strokeStyle = p.color;
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(0, -16);
        context.bezierCurveTo(14, -10, -14, 10, 0, 20);
        context.stroke();
      } else context.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .55);
      context.restore();
    }
    frame = view.requestAnimationFrame(draw);
  }

  function reveal() {
    const moveFocus = opening.contains(doc.activeElement);
    opening.hidden = true;
    doc.body.dataset.phase = "gift";
    gift.hidden = false;
    gift.removeAttribute("aria-hidden");
    gift.inert = false;
    replay.hidden = false;
    doc.getElementById("reveal-status").textContent = "生日禮物已拆開！按下按鈕，就能複製競爭者優惠碼。";
    if (moveFocus) copy.focus({ preventScroll: true });
  }

  function celebrate() {
    stopConfetti();
    view.clearTimeout(copyTimer);
    copy.dataset.copied = "false";
    label.textContent = "複製優惠碼";
    status.textContent = "";
    doc.getElementById("reveal-status").textContent = "";
    doc.body.dataset.phase = "celebrate";
    opening.hidden = false;
    doc.getElementById("open-gift").disabled = false;
    gift.hidden = true;
    gift.setAttribute("aria-hidden", "true");
    gift.inert = true;
    const moveFocus = doc.activeElement === replay;
    replay.hidden = true;
    if (moveFocus) doc.getElementById("open-gift").focus({ preventScroll: true });
    if (context && !reducedMotion.matches) {
      resize();
      burst = 0;
      seed(width < 600 ? 95 : 165);
      started = previous = view.performance.now();
      frame = view.requestAnimationFrame(draw);
    }
  }

  copy.addEventListener("click", async () => {
    copy.disabled = true;
    let copied = false;
    try {
      await view.navigator.clipboard.writeText(GIFT_CODE);
      copied = true;
    } catch {
      const textarea = doc.createElement("textarea");
      textarea.className = "copy-fallback";
      textarea.value = GIFT_CODE;
      textarea.readOnly = true;
      doc.body.appendChild(textarea);
      textarea.select();
      try { copied = doc.execCommand("copy"); } catch { copied = false; }
      textarea.remove();
      copy.focus({ preventScroll: true });
    }
    copy.disabled = false;
    copy.dataset.copied = String(copied);
    label.textContent = copied ? "已複製！" : "複製優惠碼";
    status.textContent = copied ? "優惠碼已收好，祝你玩得開心！" : "複製失敗，請允許剪貼簿存取後再試一次。";
    view.clearTimeout(copyTimer);
    copyTimer = view.setTimeout(() => {
      copy.dataset.copied = "false";
      label.textContent = "複製優惠碼";
      status.textContent = "";
    }, 2200);
  });
  doc.getElementById("open-gift").addEventListener("click", () => reveal());
  replay.addEventListener("click", celebrate);
  view.addEventListener("resize", resize, { passive: true });
  doc.addEventListener("visibilitychange", () => {
    if (doc.hidden) stopConfetti();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) stopConfetti();
  });
  view.addEventListener("pagehide", () => {
    view.clearTimeout(copyTimer); stopConfetti();
  });
  celebrate();
}

if (typeof document !== "undefined" && document.getElementById("gift")) initBirthday();
