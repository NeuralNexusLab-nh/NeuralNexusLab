export const GIFT_CODE = "ELBILLUG";
export const REVEAL_DELAY = 3800;
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
  let revealTimer;
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

  function reveal({ announce = true } = {}) {
    view.clearTimeout(revealTimer);
    const moveFocus = opening.contains(doc.activeElement);
    opening.hidden = true;
    doc.body.dataset.phase = "gift";
    gift.removeAttribute("aria-hidden");
    gift.inert = false;
    replay.hidden = false;
    if (announce) doc.getElementById("reveal-status").textContent = "生日禮物已拆開！競爭者優惠碼：ELBILLUG。";
    if (moveFocus) copy.focus({ preventScroll: true });
  }

  function celebrate() {
    view.clearTimeout(revealTimer);
    stopConfetti();
    doc.getElementById("reveal-status").textContent = "";
    if (reducedMotion.matches) { reveal({ announce: false }); return; }
    doc.body.dataset.phase = "celebrate";
    opening.hidden = false;
    gift.setAttribute("aria-hidden", "true");
    gift.inert = true;
    const moveFocus = doc.activeElement === replay;
    replay.hidden = true;
    if (moveFocus) doc.getElementById("open-gift").focus({ preventScroll: true });
    if (context) {
      resize();
      burst = 0;
      seed(width < 600 ? 95 : 165);
      started = previous = view.performance.now();
      frame = view.requestAnimationFrame(draw);
    }
    revealTimer = view.setTimeout(reveal, REVEAL_DELAY);
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
    status.textContent = copied ? "優惠碼已收好，祝你玩得開心！" : "請選取 ELBILLUG，手動複製。";
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
    if (doc.hidden) { stopConfetti(); reveal({ announce: false }); }
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) { stopConfetti(); reveal({ announce: false }); }
  });
  view.addEventListener("pagehide", () => {
    view.clearTimeout(revealTimer); view.clearTimeout(copyTimer); stopConfetti();
  });
  celebrate();
}

if (typeof document !== "undefined" && document.getElementById("gift")) initBirthday();
