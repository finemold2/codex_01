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

function formatHour(iso) {
  const d = new Date(iso);
  return `${d.getHours()}시`;
}

function formatDay(iso, idx) {
  const d = new Date(iso);
  if (idx === 0) return "오늘";
  return `${d.getMonth() + 1}.${d.getDate()} (${KOR_DAYS[d.getDay()]})`;
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
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation_probability",
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

  els.place.textContent = label;
  els.currentTime.textContent = new Date(c.time).toLocaleString("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
  });
  els.currentIcon.textContent = w.i;
  els.currentTemp.textContent = `${Math.round(c.temperature_2m)}°`;
  els.currentCond.textContent = w.t;
  els.currentFeels.textContent = `체감 ${Math.round(c.apparent_temperature)}°`;

  els.mHumidity.textContent = `${c.relative_humidity_2m}%`;
  els.mWind.textContent = `${c.wind_speed_10m} m/s`;
  els.mPrecip.textContent = `${c.precipitation_probability ?? 0}%`;
  els.mFeels.textContent = `${Math.round(c.apparent_temperature)}°`;
}

function renderHourly(data) {
  const h = data.hourly;
  const now = Date.now();
  // 현재 시각 이후 24개 시간 슬롯
  let start = h.time.findIndex((t) => new Date(t).getTime() >= now);
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
    .map(
      (g, i) => `
      <li role="option" data-idx="${i}">
        <span>${g.name}</span>
        <span class="sug__sub">${[g.admin1, g.country].filter(Boolean).join(", ")}</span>
      </li>`
    )
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
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const results = await geocode(q);
      renderSuggestions(results);
    } catch {
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
