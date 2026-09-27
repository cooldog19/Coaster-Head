/* Coaster Heads! — heads-up coaster guessing game.
   Zero dependencies. Data: coasters.json (fetched, with inline fallback). */
"use strict";

const DATA_PATHS = ["coasters.json", "data/coasters.json"];

const DIFFICULTY = {
  easy:   { label: "Easy",   maxRank: 40 },
  medium: { label: "Medium", maxRank: 100 },
  hard:   { label: "Hard",   maxRank: 160 },
  expert: { label: "Expert", maxRank: 229 },
};

const STORAGE_KEY = "coasterHeads";

// ---------- Scoring ----------
const SCORE_MAX = 100;   // instant perfect guess
const SCORE_MIN = 20;    // slowest correct guess
const SCORE_DECAY_PER_SEC = 10;  // points lost per second of hesitation
const SKIP_PENALTY = 50; // points deducted for a skip (toggleable)
const COUNTDOWN_SECS = 5;

// ---------- State ----------
let ALL_COASTERS = [];
let settings = {
  excluded: [],      // array of country names to EXCLUDE
  difficulty: "medium",
  noTimer: false,
  seconds: 60,
  scorePenalty: true, // deduct points for skips
};

let round = {
  words: [],         // ordered list of word objects for this round
  index: 0,
  results: [],       // "got" | "skip" per word (undefined = not answered)
  basePoints: [],    // points earned for a "got" at answer time (0 for a skip)
  got: 0,
  skip: 0,
  score: 0,
  roundStartedAt: 0,
  wordShownAt: 0,
  locked: false,     // true during the countdown; input ignored
  initial: [],       // snapshot of results at end-of-round (stable for summary)
};

let timerInterval = null;
let timeLeft = 0;

// ---------- Element refs ----------
const $ = (id) => document.getElementById(id);
const screens = { setup: $("screen-setup"), play: $("screen-play"), summary: $("screen-summary") };

// ---------- Data loading ----------
async function loadData() {
  for (const p of DATA_PATHS) {
    try {
      const res = await fetch(p);
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        ALL_COASTERS = arr;
        return;
      }
    } catch (e) { /* try next */ }
  }
  console.error("Could not load coasters.json from any known path.");
  throw new Error("Failed to load coaster data");
}

// ---------- Pool ----------
function buildPool() {
  const diff = DIFFICULTY[settings.difficulty];
  const excluded = new Set(settings.excluded);
  let pool = ALL_COASTERS.filter((c) => {
    if (c.rank > diff.maxRank) return false;
    if (c.country && excluded.has(c.country)) return false;
    return true;
  });
  // Deduplicate by name, keeping the best (lowest) rank occurrence
  const seen = new Map();
  for (const c of pool) {
    const prev = seen.get(c.name);
    if (!prev || c.rank < prev.rank) seen.set(c.name, c);
  }
  return Array.from(seen.values());
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Settings persistence ----------
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && DIFFICULTY[s.difficulty]) {
      settings = Object.assign(settings, s);
      settings.excluded = Array.isArray(s.excluded) ? s.excluded : [];
      settings.scorePenalty = s.scorePenalty !== false;
    }
  } catch (e) {}
}

// ---------- Screens ----------
function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].classList.toggle("active", k === name);
}

// ---------- Setup screen ----------
function renderCountryChecklist() {
  const countries = Array.from(
    new Set(ALL_COASTERS.map((c) => c.country).filter(Boolean))
  ).sort();
  const list = $("country-list");
  list.innerHTML = "";
  for (const country of countries) {
    const label = document.createElement("label");
    label.className = "country-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = country;
    input.checked = settings.excluded.includes(country);
    input.addEventListener("change", () => {
      syncExcluded();
      label.classList.toggle("checked", input.checked);
      updateCountryBadge();
      updatePoolInfo();
    });
    const span = document.createElement("span");
    span.textContent = country;
    label.append(input, span);
    label.classList.toggle("checked", input.checked);
    list.append(label);
  }
}

function reflectSetupState() {
  const segButtons = Array.from(document.querySelectorAll("#difficulty .seg-btn"));
  const current =
    segButtons.find((b) => b.dataset.diff === settings.difficulty) || segButtons[0];
  segButtons.forEach((b) => b.setAttribute("aria-checked", String(b === current)));
  $("no-timer").checked = settings.noTimer;
  $("timer-seconds").value = settings.seconds;
  $("timer-row").classList.toggle("disabled", settings.noTimer);
  $("score-penalty").checked = settings.scorePenalty;
  updateCountryBadge();
  updatePoolInfo();
}

let setupWired = false;
function wireSetupOnce() {
  if (setupWired) return;
  setupWired = true;
  Array.from(document.querySelectorAll("#difficulty .seg-btn")).forEach((b) =>
    b.addEventListener("click", () => {
      settings.difficulty = b.dataset.diff;
      saveSettings();
      reflectSetupState();
    })
  );
  $("no-timer").addEventListener("change", () => {
    settings.noTimer = $("no-timer").checked;
    $("timer-row").classList.toggle("disabled", settings.noTimer);
    saveSettings();
  });
  $("timer-seconds").addEventListener("change", () => {
    let v = parseInt($("timer-seconds").value, 10);
    if (isNaN(v) || v < 5) v = 5;
    if (v > 600) v = 600;
    $("timer-seconds").value = v;
    settings.seconds = v;
    saveSettings();
  });
  const step = (d) => {
    if (settings.noTimer) return;
    let v = (parseInt($("timer-seconds").value, 10) || 60) + d;
    v = Math.max(5, Math.min(600, v));
    $("timer-seconds").value = v;
    settings.seconds = v;
    saveSettings();
  };
  $("timer-minus").addEventListener("click", () => step(-5));
  $("timer-plus").addEventListener("click", () => step(5));
  $("score-penalty").addEventListener("change", () => {
    settings.scorePenalty = $("score-penalty").checked;
    saveSettings();
  });
  wireCountryCollapse();
  $("start-btn").addEventListener("click", startRound);
}

function wireCountryCollapse() {
  const head = $("country-toggle");
  const body = $("country-body");
  head.addEventListener("click", () => {
    const expanded = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });
}

function updateCountryBadge() {
  const badge = $("country-count");
  const n = settings.excluded.length;
  badge.textContent = n === 0 ? "none" : n + " excluded";
  badge.classList.toggle("has", n > 0);
}

function refreshSetup() {
  loadSettings();
  wireSetupOnce();
  renderCountryChecklist();
  reflectSetupState();
}

function syncExcluded() {
  settings.excluded = Array.from($("country-list").querySelectorAll("input:checked")).map((i) => i.value);
  saveSettings();
}

function updatePoolInfo() {
  const pool = buildPool();
  const info = $("pool-info");
  const n = pool.length;
  if (n < 5) {
    info.textContent = `Only ${n} coaster${n === 1 ? "" : "s"} match these settings — need at least 5. Uncheck some countries or raise difficulty.`;
    info.classList.add("bad");
    $("start-btn").disabled = true;
    const warn = $("start-warning");
    warn.hidden = false;
    warn.textContent = `Not enough words (${n}). Fewer than 5 makes the round meaningless — adjust countries or difficulty.`;
  } else {
    info.textContent = `${n} coasters available for ${DIFFICULTY[settings.difficulty].label} with current exclusions.`;
    info.classList.remove("bad");
    $("start-btn").disabled = false;
    $("start-warning").hidden = true;
  }
}

// ---------- Game ----------
function pointsFor(elapsedSeconds) {
  return Math.max(SCORE_MIN, SCORE_MAX - Math.round(elapsedSeconds * SCORE_DECAY_PER_SEC));
}

function startRound() {
  const pool = buildPool();
  if (pool.length < 5) return;
  round = {
    words: shuffle(pool),
    index: 0,
    results: [],
    basePoints: [],
    got: 0,
    skip: 0,
    score: 0,
    roundStartedAt: 0,
    wordShownAt: 0,
    locked: true,
    initial: [],
  };
  $("tally-got").textContent = "0";
  $("tally-skip").textContent = "0";
  setScore(0, false);
  showScreen("play");
  runCountdown(COUNTDOWN_SECS, () => {
    round.locked = false;
    round.roundStartedAt = Date.now();
    showWord();
    startTimer();
  });
}

// ---------- Pre-round countdown ----------
let countTimer = null;
function runCountdown(seconds, onDone) {
  const el = $("countdown");
  el.hidden = false;
  const tick = (n) => {
    el.innerHTML = "";
    const s = document.createElement("span");
    s.textContent = String(n);
    el.appendChild(s);
    void s.offsetWidth;
    s.classList.add("tick");
    if (n <= 0) {
      el.innerHTML = "";
      const go = document.createElement("span");
      go.textContent = "Go!";
      el.appendChild(go);
      void go.offsetWidth;
      go.classList.add("tick");
      setTimeout(() => {
        el.hidden = true;
        if (onDone) onDone();
      }, 350);
      return true;
    }
    return false;
  };
  let n = seconds;
  if (tick(n)) return;
  clearInterval(countTimer);
  countTimer = setInterval(() => {
    n -= 1;
    if (tick(n)) clearInterval(countTimer), (countTimer = null);
  }, 1000);
}

function currentWord() { return round.words[round.index]; }

function showWord() {
  const w = currentWord();
  round.wordShownAt = Date.now();
  const el = $("word");
  el.textContent = w.name;
  // Auto-shrink: base size scales inversely with name length so it never wraps awkwardly
  const len = w.name.length;
  let size;
  if (len <= 8) size = "13vw";
  else if (len <= 14) size = "11vw";
  else if (len <= 22) size = "9vw";
  else size = "7vw";
  el.style.fontSize = "min(" + size + ", 100px)";
  el.classList.remove("pop");
  void el.offsetWidth; // restart animation
  el.classList.add("pop");
}

function answer(kind) {
  if (!screens.play.classList.contains("active")) return;
  if (round.locked) return;
  const elapsed = (Date.now() - round.wordShownAt) / 1000;

  let delta;
  if (kind === "got") {
    delta = pointsFor(elapsed);
    round.basePoints[round.index] = delta;
    round.got++;
  } else {
    delta = settings.scorePenalty ? -SKIP_PENALTY : 0;
    round.basePoints[round.index] = 0;
    round.skip++;
  }
  round.results[round.index] = kind;
  round.score += delta;

  $("tally-got").textContent = String(round.got);
  $("tally-skip").textContent = String(round.skip);
  setScore(round.score, true);

  // visual flash + vibration
  const screen = screens.play;
  screen.classList.remove("flash-got", "flash-skip");
  void screen.offsetWidth;
  screen.classList.add(kind === "got" ? "flash-got" : "flash-skip");
  setTimeout(() => screen.classList.remove("flash-got", "flash-skip"), 300);
  if (navigator.vibrate) {
    try { navigator.vibrate(kind === "got" ? 30 : [40, 40, 40]); } catch (e) {}
  }

  round.index++;
  if (round.index >= round.words.length) {
    endRound();
  } else {
    showWord();
  }
}

function setScore(value, animate) {
  round.score = value;
  const el = $("score-chip");
  el.textContent = String(value);
  if (animate) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
}

// ----------
// Timer ----------
function startTimer() {
  stopTimer();
  const chip = $("timer-chip");
  if (settings.noTimer) { chip.hidden = true; return; }
  timeLeft = settings.seconds;
  renderTimer();
  chip.hidden = false;
  timerInterval = setInterval(() => {
    timeLeft -= 1;
    renderTimer();
    if (timeLeft <= 0) endRound();
  }, 1000);
}
function renderTimer() {
  const chip = $("timer-chip");
  if (chip.hidden) return;
  chip.textContent = timeLeft + "s";
  chip.classList.toggle("low", timeLeft <= 10);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ---------- Round end / summary ----------
function endRound() {
  stopTimer();
  clearInterval(countTimer);
  countTimer = null;
  $("countdown").hidden = true;
  // Snapshot the state at round-end so summary flips don't corrupt the
  // original per-word points (which were earned mid-round and shouldn't grow
  // just because a player re-marks one later).
  round.initial = {
    results: round.results.slice(),
    basePoints: round.basePoints.slice(),
  };
  renderSummary();
  showScreen("summary");
}

function pointFor(index, res, basePoints) {
  if (res === "got") return basePoints[index] || 0;
  return settings.scorePenalty ? -SKIP_PENALTY : 0;
}

function renderSummary() {
  const results = round.initial.results || round.results;
  const basePoints = round.initial.basePoints || round.basePoints;
  const answered = round.words
    .map((w, i) => ({ w, i, res: results[i] || null }))
    .filter((x) => x.res !== null);
  const score = answered.reduce((sum, x) => sum + pointFor(x.i, x.res, basePoints), 0);
  const gotCount = answered.filter((x) => x.res === "got").length;

  $("final-score").textContent = String(score);
  $("final-total").textContent = gotCount + " got · " + (answered.length - gotCount) + " skipped";

  const list = $("summary-list");
  list.innerHTML = "";
  list.classList.toggle("empty", answered.length === 0);

  if (answered.length === 0) {
    const li = document.createElement("li");
    li.className = "summary-empty";
    li.textContent = "No rides were answered this round.";
    list.appendChild(li);
    return;
  }

  answered.forEach(({ w, i, res }) => addSummaryRow(list, w, i, res, basePoints));
}

function addSummaryRow(list, w, i, res, basePoints) {
  let myRes = res;
  const li = document.createElement("li");
  const paint = () => {
    const p = pointFor(i, myRes, basePoints);
    li.className = myRes === "got" ? "is-got" : "is-skip";
    points.className = "entry-points " + (p >= 0 ? "pos" : "neg");
    points.textContent = (p >= 0 ? "+" : "") + p;
    tag.className = "entry-tag " + (myRes === "got" ? "got" : "skip");
    tag.textContent = myRes === "got" ? "Got It ✓" : "Skip ✗";
  };

  const name = document.createElement("div");
  name.className = "entry-name";
  name.textContent = w.name;
  const park = document.createElement("span");
  park.className = "entry-park";
  park.textContent = (w.park || "") + (w.country ? " · " + w.country : "");
  name.appendChild(park);

  const points = document.createElement("span");
  const tag = document.createElement("span");

  paint();

  li.addEventListener("click", () => {
    myRes = myRes === "got" ? "skip" : "got";
    round.results[i] = myRes;
    paint();
    const gotCount = round.words.filter((_, k) => round.results[k] === "got").length;
    const answeredCount = round.results.filter((r) => r === "got" || r === "skip").length;
    const score = round.words.reduce((sum, _, k) => {
      const r = round.results[k];
      if (r !== "got" && r !== "skip") return sum;
      return sum + pointFor(k, r, basePoints);
    }, 0);
    $("final-score").textContent = String(score);
    $("final-total").textContent = gotCount + " got · " + (answeredCount - gotCount) + " skipped";
  });

  li.appendChild(name);
  li.appendChild(points);
  li.appendChild(tag);
  list.appendChild(li);
}

// ---------- Input wiring ----------
let inputWired = false;
function wireInput() {
  if (inputWired) return;
  inputWired = true;
  // "click" fires once per activation on desktop and mobile alike, and works
  // even if the finger drifts slightly — ideal for the two giant zones.
  // CSS `touch-action: manipulation` already removes double-tap zoom delay.
  $("zone-got").addEventListener("click", (e) => { e.preventDefault(); answer("got"); });
  $("zone-skip").addEventListener("click", (e) => { e.preventDefault(); answer("skip"); });

  $("end-round").addEventListener("click", endRound);
  $("play-again").addEventListener("click", () => { showScreen("setup"); refreshSetup(); });

  document.addEventListener("keydown", (e) => {
    if (!screens.play.classList.contains("active")) return;
    if (e.key === "ArrowRight" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      answer("got");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      answer("skip");
    } else if (e.key === "Escape") {
      e.preventDefault();
      endRound();
    }
  });
}

// ---------- Boot ----------
async function boot() {
  await loadData();
  refreshSetup();
  wireInput();
  showScreen("setup");
}
document.addEventListener("DOMContentLoaded", boot);
