# 제출 전 남은 작업 (집에서 이어서)

> 서버 기능 구현은 사실상 완료. 빌드 클린, 도구 2개 동작 확인.
> 상세 배경은 `PLANS.md`, 되묻기 프롬프트는 `SYSTEM_PROMPT.md` 참조.

## 현재 상태 (완료)
- [x] 중간지점 계산(centroid→지하철역 스냅) + **멤버별 ETA**(카카오모빌리티)
- [x] 키워드 검색 + **무드 매핑** + **category 필터**(food/cafe) + **Google 별점**
- [x] **지역 혼잡도+12h 예측**(서울 citydata, 121곳 매칭)
- [x] 안정성 가드(타임아웃·allSettled·0건 반경확대)
- [x] Stateless Streamable HTTP (`POST /mcp`, `/health`)
- [x] `SYSTEM_PROMPT.md` v2 (ETA/혼잡도/category 활용 되묻기)

---

## A. 필수 — 예선 제출용

### A1. API 키 마무리
- [ ] **서울 열린데이터광장 키 발급** → `.env`에 `SEOUL_OPENDATA_KEY=...`
  - data.seoul.go.kr 회원가입 → 인증키 신청(즉시 발급, 무료) → "실시간 인구현황" 류 일반 인증키
  - 없으면 혼잡도가 sample키라 광화문만 동작(타지역 null)
- [ ] **`.env.example` 갱신** — `GOOGLE_PLACES_API_KEY=`, `SEOUL_OPENDATA_KEY=` 라인 추가 (현재 누락)
- [ ] 배포 env 4종 주입 확인: `KAKAO_REST_API_KEY`, `GOOGLE_PLACES_API_KEY`, `SEOUL_OPENDATA_KEY`, `PORT`

### A2. 배포 (카카오 클라우드)
- [ ] 배포: `npm ci && npm run build && npm start`
- [ ] `/health` 헬스체크 200 확인
- [ ] 배포 URL로 `POST /mcp` tools/list·tools/call 원격 동작 확인

### A3. PlayMCP 등록
- [ ] PlayMCP 콘솔에 MCP 서버 등록(임시)
- [ ] 등록 상태에서 도구 호출 검증
- [ ] **전체공개** 전환 (대회 요건)

### A4. 되묻기 실기기 튜닝 (Phase 3.3)
- [ ] Claude Desktop / Cursor에 서버 + `SYSTEM_PROMPT.md` v2 연결
- [ ] 시나리오 3종 테스트:
  - (a) 사진 무드 + 출발지 3개
  - (b) 텍스트 무드만
  - (c) 조건 일부 미리 제공(이미 말한 건 안 되묻나)
- [ ] v2 체크리스트로 검증 (검색 선행 차단 / 질문 1~2개 / ETA·혼잡 예측 활용 / category 정확 / 응답 간결)
- [ ] 튜닝 로그(성공·실패 케이스) 기록

---

## B. 선택 — 여유 / 본선

- [ ] 카카오모빌리티 길찾기 키 권한 재확인(이미 동작 중)
- [⏸] **경로 polyline 시각화** — fieldmask 확장, 데모앱 재개 시
- [⏸] **데모 채팅 클라이언트**(SwiftUI/Flutter) — 사진 업로드+버블+지도(ETA/혼잡/경로). 본선 시연 필요 시 재개

---

## C. 보류 (불가/범위 밖)
- 식당 *단위* 혼잡도 — 공식 API 없음(스크래핑은 ToS·불안정 제외). 지역 단위로 대체 완료.
- ETA 기반 중간지점 자체 보정 — 위밋플레이스 등시선 영역, YAGNI.

---

## 빠른 로컬 점검
```bash
npm run build            # 타입체크
node build/index.js      # 서버 (PORT=3000)
# POST http://localhost:3000/mcp  (Accept: application/json, text/event-stream)
```
