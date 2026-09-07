# 검증 도구

NEON CITY는 눈으로 확인하는 대신 **헤드리스 크로미움(SwiftShader WebGL2)** 에서 실제로 실행하고
측정해 검증합니다. 브라우저가 필요한 스크립트는 Playwright를 사용합니다 (`npm i -D playwright`).

## 실행 방법

```bash
# 노드에서 바로 도는 회귀 테스트
node --experimental-vm-modules tools/check-syntax.mjs   # 전 모듈 실제 파싱
node tools/test-player.mjs                              # 도보 이동/점프/충돌/승하차/피격
node tools/test-collision.mjs                           # 착지·관통·연석·레이캐스트·처리량
node tools/test-vehicle.mjs                             # 10종 0-100km/h·최고속·제동·안정성
node tools/test-citygen.mjs                             # 도시 데이터 정합성
node tools/test-missions.mjs                            # 미션 8종 + 무기 시스템

# 브라우저(WebGL2/Web Audio)가 필요한 프로브
node tools/gl-probe.mjs tools/<probe>.js [--shot out.png] [--pageshot] [--view <mode>]
```

## 파일

| 파일 | 내용 |
|---|---|
| `check-syntax.mjs` | 모든 모듈을 실제로 파싱. **`node --check`는 ESM 구문 오류를 출력하면서도 종료 코드 0을 반환하므로 쓸 수 없습니다.** |
| `gl-probe.mjs` | 프로브 실행기. 저장소를 http로 서빙하고 헤드리스 크로미움에서 모듈을 실행. `--shot`(캔버스) / `--pageshot`(HUD 포함) / `--view`(시점·모드) / `--stub`(미작성 모듈 대체) |
| `contract-check.js` | 30개 모듈이 `docs/ARCHITECTURE.md`의 export/메서드를 모두 갖췄는지 확인 |
| `probe-gl.js` | WebGL2 래퍼: 셰이더·인스턴싱·HDR 렌더타깃·sRGB 밉맵·풀스크린 블릿 |
| `probe-input.js` | 키 엣지·축 합성·blocked 게이팅·블러 시 키 해제·마우스 감도/스파이크 클램프 |
| `probe-textures.js` / `probe-textures-atlas.js` | 절차적 텍스처 48종의 대비·심(seam)·알파 마스크·아틀라스 UV |
| `probe-sky.js` | 시간대별 하늘: 정오 청색 천정, 황금시간대, 밤하늘 별, 태양/달 전환 |
| `probe-render.js` | PBR·태양광·캐스케이드 섀도·품질 프리셋 |
| `probe-postfx.js` | 블룸 에너지·ACES·비네트·FXAA·SSAO |
| `probe-character.js` | 본 행렬·발 미끄러짐·래그돌·드로우콜 |
| `probe-world.js` | 도시 생성 → 지오메트리 → 충돌 → 렌더. `--view aerial\|street\|sunset\|night` |
| `probe-audio.js` | 오디오 그래프·효과음 전 메서드·클래식 악보 정합성 |
| `probe-ui.js` / `e2e-ui.mjs` | HUD/메뉴/지도 단위 및 통합 검사 |
| `probe-hud.js` | HUD 패널이 실제로 화면에 보이는지(위치·불투명도) 확인. `--view menu\|map\|settings` |
| `probe-game.js` | **전체 통합**: 부팅 → 입력 → 렌더 → 전 플로우 → AI 소크 3000프레임 |
| `smoke-test.mjs` | 실제 페이지(`index.html`)를 띄우는 엔드투엔드 스모크 테스트 |
| `shrink-image.mjs` | 스크린샷 리사이즈(이 컨테이너에 이미지 도구가 없어 브라우저 캔버스 사용) |
| `stubs/` | 미작성 모듈을 대체하던 통합 테스트용 스텁 (`gl-probe --stub`) |
