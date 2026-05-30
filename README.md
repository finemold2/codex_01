# 날씨 웹앱 ☁️

[Open-Meteo](https://open-meteo.com/) API를 사용한 순수 HTML/CSS/JavaScript 날씨 웹앱입니다. 빌드 도구나 API 키 없이 브라우저에서 바로 실행됩니다.

## 주요 기능

- **현재 날씨** — 기온, 체감온도, 습도, 풍속, 강수확률
- **도시 검색** — 도시 이름으로 검색 (자동완성 지원, 키보드 ↑↓ 탐색)
- **현재 위치** — 📍 버튼으로 브라우저 Geolocation 기반 날씨 조회
- **시간별 예보** — 향후 24시간 가로 스크롤
- **주간 예보** — 7일간 최고/최저 기온 및 강수확률

## 실행 방법

별도의 빌드 과정이 없습니다. 로컬 서버로 띄우기만 하면 됩니다.

```bash
# Python 3
python3 -m http.server 8000

# 또는 Node
npx serve .
```

브라우저에서 `http://localhost:8000` 접속.

> Geolocation은 보안 컨텍스트(localhost 또는 HTTPS)에서만 동작합니다.

## 파일 구조

| 파일 | 설명 |
| --- | --- |
| `index.html` | 마크업 및 레이아웃 |
| `style.css` | 스타일 (다크 테마, 반응형) |
| `app.js` | API 호출, 렌더링, 검색/자동완성 로직 |

## 사용 API

- **Geocoding**: `https://geocoding-api.open-meteo.com/v1/search` — 도시명 → 좌표
- **Forecast**: `https://api.open-meteo.com/v1/forecast` — 현재/시간별/일별 예보

날씨 상태는 [WMO Weather interpretation codes](https://open-meteo.com/en/docs)를 한국어 설명과 이모지로 매핑합니다.
