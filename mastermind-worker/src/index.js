// Mastermind OG Worker
// Routes:
//   GET /?s=ENCODED  → HTML redirect page with dynamic OG tags, then JS redirect to game
//   GET /og.svg?s=ENCODED → dynamic SVG image for that specific game/solve state

// ── LZ-string decompression (base64-encoded URI component variant) ─────────────
// Inlined to avoid npm deps in the worker bundle.
const keyStrUriSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
const baseReverseDic = {};
for (let i = 0; i < keyStrUriSafe.length; i++) baseReverseDic[keyStrUriSafe[i]] = i;

function lzDecompress(compressed) {
  if (!compressed) return null;
  const input = decodeURIComponent(compressed).replace(/ /g, "+");
  const length = input.length;
  let result = "";
  let enlargeIn = 4, dictSize = 4, numBits = 3;
  const dictionary = [null, null, null];
  let entry = "", w = "";
  let bits = 0, maxpower = Math.pow(2, 2), power = 1;
  let c, next, resetValue = 0;

  // Bit reader
  let pos = 0, index = 1;
  function readBit() {
    const bit = (baseReverseDic[input[pos]] & index) ? 1 : 0;
    index *= 2;
    if (index === 32768) { index = 1; pos++; }
    return bit;
  }
  function readBits(n) {
    let val = 0, pow = 1;
    for (let i = 0; i < n; i++) { val += readBit() * pow; pow *= 2; }
    return val;
  }

  let firstChar = true;
  // Read first token
  next = readBits(2);
  if (next === 0) { c = String.fromCharCode(readBits(8)); }
  else if (next === 1) { c = String.fromCharCode(readBits(16)); }
  else { return null; } // end marker at start = empty string

  dictionary[3] = c;
  w = result = c;

  while (true) {
    if (pos >= length) return result;
    let i = readBits(numBits);

    switch (next = i) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        i = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        i = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result;
    }

    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }

    if (dictionary[i]) { entry = dictionary[i]; }
    else if (i === dictSize) { entry = w + w[0]; }
    else { return null; }

    result += entry;
    dictionary[dictSize++] = w + entry[0];
    enlargeIn--;
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
    w = entry;
  }
}

function decode(s) {
  try { return JSON.parse(lzDecompress(s)); } catch { return null; }
}

// ── OG SVG generator ───────────────────────────────────────────────────────────
const COLORS = {
  R: { hex: "#ef4444", hi: "#fca5a5" },
  O: { hex: "#f97316", hi: "#fdba74" },
  Y: { hex: "#eab308", hi: "#fde047" },
  G: { hex: "#22c55e", hi: "#86efac" },
  B: { hex: "#3b82f6", hi: "#93c5fd" },
  V: { hex: "#a855f7", hi: "#d8b4fe" },
  K: { hex: "#ec4899", hi: "#f9a8d4" },
  T: { hex: "#14b8a6", hi: "#5eead4" },
};

function pegGradientDef(id, col) {
  const c = COLORS[col];
  if (!c) return "";
  return `<radialGradient id="p${id}" cx="36%" cy="30%" r="65%">
    <stop offset="0%" stop-color="${c.hi}"/>
    <stop offset="52%" stop-color="${c.hex}"/>
    <stop offset="100%" stop-color="#000" stop-opacity="0.65"/>
  </radialGradient>`;
}

function buildOgSvg(state) {
  const { guesses = [], pegs: nPegs = 4, maxG = 10 } = state;
  const isWon = guesses.length > 0 && guesses.at(-1).fb?.black === nPegs;
  const isLost = !isWon && guesses.length >= maxG;
  const isDone = isWon || isLost;

  const title = isDone
    ? (isWon ? `Cracked in ${guesses.length}/${maxG}!` : `Failed — ${maxG} guesses used`)
    : `${guesses.length}/${maxG} guesses — can you crack it?`;

  // Layout
  const W = 1200, H = 630;
  const cardX = 680, cardW = 440, cardH = 510, cardY = 60;
  const rowH = Math.min(58, Math.floor((cardH - 80) / Math.max(guesses.length, 4)));
  const pegR = 18;

  // Collect unique color IDs for gradient defs
  const usedColors = new Set();
  guesses.forEach(g => g.colors?.forEach(c => usedColors.add(c)));

  const gradDefs = [...usedColors].map(c => pegGradientDef(c, c)).join("\n");

  // Build board rows
  let boardRows = "";
  const displayRows = Math.min(guesses.length, Math.floor((cardH - 80) / rowH));
  guesses.slice(-displayRows).forEach((g, ri) => {
    const globalRow = guesses.length - displayRows + ri;
    const y = cardY + 60 + ri * rowH;
    const cx0 = cardX + 58;
    const { black = 0, white = 0 } = g.fb || {};
    const isWinRow = isWon && globalRow === guesses.length - 1;

    const rowFill = isWinRow ? `fill="#f59e0b" fill-opacity="0.06"` : `fill="#ffffff" fill-opacity="0.025"`;
    const rowStroke = isWinRow ? `stroke="#f59e0b" stroke-opacity="0.2" stroke-width="1"` : "";
    boardRows += `<rect x="${cardX + 8}" y="${y}" width="${cardW - 16}" height="${rowH - 4}" rx="9" ${rowFill} ${rowStroke}/>\n`;

    // Guess pegs
    (g.colors || []).forEach((col, pi) => {
      const pcx = cx0 + pi * (pegR * 2 + 8);
      const pcy = y + rowH / 2;
      const filter = isWinRow ? `filter="url(#glow)"` : "";
      boardRows += `<circle cx="${pcx}" cy="${pcy}" r="${pegR}" fill="url(#p${col})" ${filter}/>\n`;
    });

    // Feedback dots (2×2 grid)
    const fdx = cardX + cardW - 52;
    const total = nPegs;
    const cols2 = total <= 4 ? 2 : 3;
    const dotR = total <= 4 ? 7 : 6;
    const dotGap = dotR * 2 + 3;
    for (let di = 0; di < total; di++) {
      const col2 = di % cols2;
      const row2 = Math.floor(di / cols2);
      const dx = fdx + col2 * dotGap;
      const dy = y + rowH / 2 - (dotGap / 2) + row2 * dotGap;
      const dotFill = di < black ? "#f59e0b" : di < black + white ? "#d4d8e8" : "#181d30";
      const gf = isWinRow ? `filter="url(#glow)"` : "";
      boardRows += `<circle cx="${dx}" cy="${dy}" r="${dotR}" fill="${dotFill}" ${gf}/>\n`;
    }
  });

  // Emoji grid for description (used in OG desc, not in image — but let's also show it)
  const emojiRows = guesses.map(g => {
    const { black = 0, white = 0 } = g.fb || {};
    return "🟠".repeat(black) + "⚪".repeat(white) + "⚫".repeat(nPegs - black - white);
  }).join("  ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg1" cx="18%" cy="20%" r="55%">
      <stop offset="0%" stop-color="#502890" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#07090f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bg2" cx="82%" cy="80%" r="50%">
      <stop offset="0%" stop-color="#14328c" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#07090f" stop-opacity="0"/>
    </radialGradient>
    ${gradDefs}
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="#07090f"/>
  <rect width="${W}" height="${H}" fill="url(#bg1)"/>
  <rect width="${W}" height="${H}" fill="url(#bg2)"/>

  <!-- Title -->
  <text x="90" y="220" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="100" font-weight="700" letter-spacing="-3">
    <tspan fill="#dde1f0">Master</tspan><tspan fill="#f59e0b">mind</tspan>
  </text>
  <rect x="90" y="244" width="180" height="2" rx="1" fill="#f59e0b" opacity="0.35"/>

  <!-- Status line -->
  <text x="90" y="298" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="24" fill="${isDone ? (isWon ? "#f59e0b" : "#ef4444") : "#6b7aaa"}" letter-spacing="0.2">
    ${escXml(title)}
  </text>

  <!-- Bullet lines -->
  <text x="90" y="378" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="20">
    <tspan fill="#f59e0b">→</tspan><tspan fill="#6b7aaa"> Crack the secret color code</tspan>
  </text>
  <text x="90" y="416" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="20">
    <tspan fill="#f59e0b">→</tspan><tspan fill="#6b7aaa"> ${nPegs} pegs · ${state.colors || 6} colors · ${maxG} guesses</tspan>
  </text>
  <text x="90" y="454" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="20">
    <tspan fill="#f59e0b">→</tspan><tspan fill="#6b7aaa"> 🟠 right place  ⚪ right color  ⚫ not in code</tspan>
  </text>

  <!-- Game board card -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="18" fill="#0b0e1c" stroke="#181d30" stroke-width="1.5"/>
  <text x="${cardX + cardW / 2}" y="${cardY + 32}" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#2a3050" letter-spacing="2.5" font-weight="600">GUESS BOARD</text>

  ${boardRows}
</svg>`;

  return svg;
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── OG meta description from state ─────────────────────────────────────────────
function buildOgMeta(state, s) {
  const { guesses = [], pegs: nPegs = 4, maxG = 10 } = state;
  const isWon = guesses.length > 0 && guesses.at(-1).fb?.black === nPegs;
  const isLost = !isWon && guesses.length >= maxG;
  const isDone = isWon || isLost;

  const title = isDone
    ? (isWon ? `Mastermind: Cracked in ${guesses.length}/${maxG}! Can you beat it?` : `Mastermind: Failed after ${maxG} guesses. Can you do better?`)
    : `Mastermind: ${guesses.length}/${maxG} guesses in — can you crack the code?`;

  const emojiGrid = guesses.map(g => {
    const { black = 0, white = 0 } = g.fb || {};
    return "🟠".repeat(black) + "⚪".repeat(white) + "⚫".repeat(nPegs - black - white);
  }).join("  ");

  const desc = isDone
    ? `${emojiGrid}  — Try the same puzzle!`
    : `${nPegs} pegs, ${state.colors || 6} colors, ${maxG} max guesses. Set a secret code and challenge a friend.`;

  return { title, desc };
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const s = url.searchParams.get("s") || "";
    const GAME_BASE = env.GAME_BASE || "https://tvue0228.github.io/landing-zone/games/mastermind/";

    // /og.svg — return dynamic SVG image
    if (url.pathname === "/og.svg") {
      const state = s ? (decode(s) || {}) : {};
      const svg = buildOgSvg(state);
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // / (root) — dynamic OG HTML + redirect
    const state = s ? (decode(s) || {}) : null;
    const gameUrl = GAME_BASE + (s ? "?s=" + encodeURIComponent(s) : "");

    let title = "Mastermind — The Code-Breaking Challenge";
    let desc = "Set a secret color code, share the link, and challenge someone to crack it.";
    let ogImage = GAME_BASE + "og-image.svg";

    if (state) {
      const meta = buildOgMeta(state, s);
      title = meta.title;
      desc = meta.desc;
      ogImage = url.origin + "/og.svg?s=" + encodeURIComponent(s);
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>${escXml(title)}</title>
<meta property="og:title" content="${escXml(title)}"/>
<meta property="og:description" content="${escXml(desc)}"/>
<meta property="og:image" content="${escXml(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${escXml(gameUrl)}"/>
<meta property="og:type" content="website"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escXml(title)}"/>
<meta name="twitter:description" content="${escXml(desc)}"/>
<meta name="twitter:image" content="${escXml(ogImage)}"/>
<meta http-equiv="refresh" content="0;url=${escXml(gameUrl)}"/>
<script>window.location.replace(${JSON.stringify(gameUrl)});</script>
</head>
<body>
<p>Redirecting to <a href="${escXml(gameUrl)}">Mastermind</a>…</p>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
