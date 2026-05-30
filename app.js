"use strict";

/* ------------------------------------------------------------------ *
 * Open-Meteo 기반 날씨 웹앱
 *  - Geocoding API:  도시 이름 -> 좌표
 *  - Forecast API:   현재 / 시간별 / 일별 예보
 * ------------------------------------------------------------------ */

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/* WMO weather interpretation codes -> { 한글 설명, 이모지 } */
const WMO = {
  0:  { t: "맑음",          i: "☀️" },
  1:  { t: "대체로 맑음",    i: "🌤️" },
  2:  { t: "구름 조금",      i: "⛅" },
  3:  { t: "흐림",          i: "☁️" },
  45: { t: "안개",          i: "🌫️" },
  48: { t: "서리 안개",      i: "🌫️" },
  51: { t: "약한 이슬비",    i: "🌦️" },
  53: { t: "이슬비",        i: "🌦️" },
  55: { t: "강한 이슬비",    i: "🌧️" },
  56: { t: "어는 이슬비",    i: "🌧️" },
  57: { t: "강한 어는 이슬비", i: "🌧️" },
  61: { t: "약한 비",        i: "🌦️" },
  63: { t: "비",            i: "🌧️" },
  65: { t: "강한 비",        i: "🌧️" },
  66: { t: "어는 비",        i: "🌧️" },
  67: { t: "강한 어는 비",    i: "🌧️" },
  71: { t: "약한 눈",        i: "🌨️" },
  73: { t: "눈",            i: "❄️" },
  75: { t: "강한 눈",        i: "❄️" },
  77: { t: "싸락눈",        i: "🌨️" },
  80: { t: "약한 소나기",    i: "🌦️" },
  81: { t: "소나기",        i: "🌧️" },
  82: { t: "강한 소나기",    i: "⛈️" },
  85: { t: "약한 눈 소나기", i: "🌨️" },
  86: { t: "강한 눈 소나기", i: "❄️" },
  95: { t: "뇌우",          i: "⛈️" },
  96: { t: "뇌우(우박)",     i: "⛈️" },
  99: { t: "강한 뇌우(우박)", i: "⛈️" },
};

const wmo = (code) => WMO[code] || { t: "알 수 없음", i: "❓" };

/* ----------------------------- DOM ----------------------------- */
const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"),
  input: $("search-input"),
  geoBtn: $("geo-btn"),
  suggestions: $("suggestions"),
  status: $("status"),
  content: $("content"),
  current: $("current"),
  place: $("place"),
  currentTime: $("current-time"),
  currentIcon: $("current-icon"),
  currentTemp: $("current-temp"),
  currentCond: $("current-cond"),
  currentFeels: $("current-feels"),
  mHumidity: $("m-humidity"),
  mWind: $("m-wind"),
  mPrecip: $("m-precip"),
  mFeels: $("m-feels"),
  hourly: $("hourly"),
  hourlyScroll: $("hourly-scroll"),
  daily: $("daily"),
  dailyList: $("daily-list"),
};

/* --------------------------- Helpers --------------------------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.hidden = !msg;
  els.status.classList.toggle("error", isError);
}

function showResults(show) {
  els.current.hidden = !show;
  els.hourly.hidden = !show;
  els.daily.hidden = !show;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`요청 실패 (HTTP ${res.status})`);
  return res.json();
}

/* 도시 표시명 만들기: "서울, 서울특별시, 대한민국" */
function placeLabel(g) {
  return [g.name, g.admin1, g.country].filter(Boolean).join(", ");
}

const KOR_DAYS = ["일", "월", "화", "수", "목", "금", "토"];

/* Open-Meteo가 반환하는 시간 문자열은 항상 "YYYY-MM-DDTHH:mm" 형식이고
 * timezone=auto 옵션에 따라 대상 지역의 현지 시간 기준이므로 문자열에서 직접 추출 */
function formatHour(iso) {
  return `${parseInt(iso.slice(11, 13), 10)}시`;
}

function formatDay(iso, idx) {
  if (idx === 0) return "오늘";
  // YYYY-MM-DD 만 들어오면 UTC로 해석되어 타임존에 따라 하루 밀릴 수 있음 → "T00:00"으로 로컬 처리
  const d = new Date(`${iso}T00:00`);
  return `${d.getMonth() + 1}.${d.getDate()} (${KOR_DAYS[d.getDay()]})`;
}

function formatCurrentTime(iso) {
  // "YYYY-MM-DDTHH:mm" 그대로 표시 — 대상 지역 현지 시간이므로 Date 변환 불필요
  const [date, time] = iso.split("T");
  const [y, m, d] = date.split("-");
  return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일 ${time}`;
}

/* ------------------------- Geocoding --------------------------- */
async function geocode(query) {
  const url = `${GEO_URL}?name=${encodeURIComponent(query)}&count=5&language=ko&format=json`;
  const data = await fetchJSON(url);
  return data.results || [];
}

/* --------------------------- Forecast -------------------------- */
async function getForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "7",
    wind_speed_unit: "ms",
  });
  return fetchJSON(`${FORECAST_URL}?${params.toString()}`);
}

/* --------------------------- Render ---------------------------- */
function renderCurrent(label, data) {
  const c = data.current;
  const w = wmo(c.weather_code);

  // current API는 강수확률을 제공하지 않으므로 hourly에서 현재 시각에 해당하는 값을 사용
  const hourIdx = data.hourly.time.findIndex((t) => t >= c.time);
  const precipProb = hourIdx >= 0 ? (data.hourly.precipitation_probability?.[hourIdx] ?? 0) : 0;

  els.place.textContent = label;
  els.currentTime.textContent = formatCurrentTime(c.time);
  els.currentIcon.textContent = w.i;
  els.currentTemp.textContent = `${Math.round(c.temperature_2m)}°`;
  els.currentCond.textContent = w.t;
  els.currentFeels.textContent = `체감 ${Math.round(c.apparent_temperature)}°`;

  els.mHumidity.textContent = `${c.relative_humidity_2m}%`;
  els.mWind.textContent = `${c.wind_speed_10m} m/s`;
  els.mPrecip.textContent = `${precipProb}%`;
  els.mFeels.textContent = `${Math.round(c.apparent_temperature)}°`;
}

function renderHourly(data) {
  const h = data.hourly;
  // 대상 지역 현지 시각(data.current.time) 기준 문자열 비교 — 타임존 영향 없음
  let start = h.time.findIndex((t) => t >= data.current.time);
  if (start < 0) start = 0;
  const end = Math.min(start + 24, h.time.length);

  const items = [];
  for (let i = start; i < end; i++) {
    const w = wmo(h.weather_code[i]);
    items.push(`
      <div class="hour">
        <div class="hour__time">${formatHour(h.time[i])}</div>
        <div class="hour__icon">${w.i}</div>
        <div class="hour__temp">${Math.round(h.temperature_2m[i])}°</div>
        <div class="hour__pop">💧${h.precipitation_probability?.[i] ?? 0}%</div>
      </div>`);
  }
  els.hourlyScroll.innerHTML = items.join("");
}

function renderDaily(data) {
  const d = data.daily;
  const items = d.time.map((t, i) => {
    const w = wmo(d.weather_code[i]);
    return `
      <li class="day">
        <span class="day__name">${formatDay(t, i)}</span>
        <span class="day__icon">${w.i}</span>
        <span class="day__cond">${w.t} · 💧${d.precipitation_probability_max?.[i] ?? 0}%</span>
        <span class="day__temp">${Math.round(d.temperature_2m_max[i])}°<span class="lo">${Math.round(d.temperature_2m_min[i])}°</span></span>
      </li>`;
  });
  els.dailyList.innerHTML = items.join("");
}

/* ------------------------- Orchestration ----------------------- */
async function loadWeather(label, lat, lon) {
  setStatus("날씨 정보를 불러오는 중...");
  showResults(false);
  els.content.classList.add("loading");
  try {
    const data = await getForecast(lat, lon);
    renderCurrent(label, data);
    renderHourly(data);
    renderDaily(data);
    setStatus("");
    showResults(true);
  } catch (err) {
    console.error(err);
    setStatus(`날씨 정보를 불러오지 못했습니다. ${err.message}`, true);
  } finally {
    els.content.classList.remove("loading");
  }
}

async function searchAndLoad(query) {
  if (!query.trim()) return;
  hideSuggestions();
  setStatus(`"${query}" 검색 중...`);
  try {
    const results = await geocode(query);
    if (results.length === 0) {
      setStatus(`"${query}"에 대한 도시를 찾을 수 없습니다.`, true);
      showResults(false);
      return;
    }
    const g = results[0];
    await loadWeather(placeLabel(g), g.latitude, g.longitude);
  } catch (err) {
    console.error(err);
    setStatus(`검색에 실패했습니다. ${err.message}`, true);
  }
}

/* ----------------------- Autocomplete -------------------------- */
let suggestTimer = null;
let suggestController = null;
let activeIdx = -1;
let currentSuggestions = [];

function hideSuggestions() {
  els.suggestions.hidden = true;
  els.suggestions.innerHTML = "";
  activeIdx = -1;
  currentSuggestions = [];
}

function renderSuggestions(results) {
  currentSuggestions = results;
  activeIdx = -1;
  if (results.length === 0) {
    hideSuggestions();
    return;
  }
  els.suggestions.innerHTML = results
    .map((g, i) => {
      const sub = [g.admin1, g.country].filter(Boolean).join(", ");
      return `
      <li role="option" data-idx="${i}">
        <span>${esc(g.name)}</span>
        <span class="sug__sub">${esc(sub)}</span>
      </li>`;
    })
    .join("");
  els.suggestions.hidden = false;
}

function pickSuggestion(idx) {
  const g = currentSuggestions[idx];
  if (!g) return;
  els.input.value = g.name;
  hideSuggestions();
  loadWeather(placeLabel(g), g.latitude, g.longitude);
}

els.input.addEventListener("input", () => {
  const q = els.input.value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) {
    if (suggestController) suggestController.abort();
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(async () => {
    if (suggestController) suggestController.abort();
    suggestController = new AbortController();
    const signal = suggestController.signal;
    try {
      const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=5&language=ko&format=json`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`요청 실패 (HTTP ${res.status})`);
      const data = await res.json();
      if (signal.aborted) return;
      renderSuggestions(data.results || []);
    } catch (err) {
      if (err.name === "AbortError") return;
      hideSuggestions();
    }
  }, 300);
});

els.suggestions.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-idx]");
  if (li) pickSuggestion(Number(li.dataset.idx));
});

els.input.addEventListener("keydown", (e) => {
  if (els.suggestions.hidden) return;
  const items = els.suggestions.querySelectorAll("li");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
  } else if (e.key === "Enter") {
    if (activeIdx >= 0) {
      e.preventDefault();
      pickSuggestion(activeIdx);
    }
    return;
  } else if (e.key === "Escape") {
    hideSuggestions();
    return;
  } else {
    return;
  }
  items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
});

document.addEventListener("click", (e) => {
  if (!els.form.contains(e.target)) hideSuggestions();
});

/* --------------------------- Events ---------------------------- */
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  searchAndLoad(els.input.value);
});

els.geoBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("이 브라우저에서는 위치 기능을 지원하지 않습니다.", true);
    return;
  }
  setStatus("현재 위치를 확인하는 중...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      loadWeather("현재 위치", latitude, longitude);
    },
    (err) => {
      console.error(err);
      setStatus("위치 권한이 거부되었거나 위치를 가져올 수 없습니다.", true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

/* 첫 화면: 기본 도시(서울) 표시 */
window.addEventListener("DOMContentLoaded", () => {
  searchAndLoad("서울");
});
