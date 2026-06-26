import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';

const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_BASE = 'https://dapi.kakao.com/v2/local';

// Google Places (별점 보조 소스). 키 없으면 보강 단계 자동 스킵 → 카카오 결과만으로 동작.
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACES_SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_TIMEOUT_MS = 3000; // 개별 Google 호출 타임아웃

// 카카오모빌리티 자동차 길찾기. 경로 추천이 아니라 각 멤버→중간지점 대략 거리/시간 표시용.
const KAKAO_NAVI_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';
const NAVI_TIMEOUT_MS = 3000;

interface KakaoPlace {
  place_name: string;
  address_name: string;
  road_address_name: string;
  category_name: string;
  place_url: string;
  x: string; // 경도 lng
  y: string; // 위도 lat
  distance?: string;
}

// 카카오 로컬 API 호출 공통 함수
async function kakaoGet(path: string, params: Record<string, string | number>): Promise<KakaoPlace[]> {
  if (!KAKAO_REST_API_KEY) {
    throw new Error('KAKAO_REST_API_KEY 환경변수 미설정. .env 확인.');
  }
  const url = new URL(`${KAKAO_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`카카오 API 오류 ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { documents: KakaoPlace[] };
  return data.documents ?? [];
}

// 문자열 배열 인자 정규화.
// LLM/클라이언트가 배열 대신 JSON 문자열('["a","b"]')이나 콤마 문자열('a, b')로 보내는 흔한 실수를 흡수.
function normalizeStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    // 배열인데 원소가 JSON 배열 문자열인 경우(예: ['["카페","조용한"]'])도 펼친다.
    return input.flatMap((item) => normalizeStringArray(item));
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
      } catch {
        // JSON 파싱 실패 시 콤마 분리로 폴백
      }
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// 위경도 같은 숫자 인자 정규화 (문자열 "37.5"도 허용, 0/NaN은 무효 처리).
function toCoord(input: unknown): number | null {
  const n = typeof input === 'string' ? parseFloat(input) : (input as number);
  if (typeof n !== 'number' || Number.isNaN(n) || n === 0) return null;
  return n;
}

// 무드/추상 키워드 → 구체 검색어 확장.
// 사용자가 "조용한","감성" 같은 분위기어만 줄 때 카카오 키워드 매칭률을 높인다.
// 원 키워드는 항상 유지하고 동의/연관어를 덧붙인다 (중복은 Set으로 제거).
const MOOD_MAP: Record<string, string[]> = {
  조용한: ['조용한', '한적한'],
  한적한: ['한적한', '조용한'],
  감성: ['감성', '분위기'],
  분위기: ['분위기', '감성'],
  데이트: ['데이트', '분위기'],
  뷰: ['뷰맛집', '루프탑'],
  루프탑: ['루프탑', '뷰맛집'],
  가성비: ['가성비'],
  회식: ['회식', '단체'],
  단체: ['단체', '회식'],
  룸: ['룸', '프라이빗'],
  프라이빗: ['프라이빗', '룸'],
  모던: ['모던', '깔끔한'],
  이색: ['이색', '독특한'],
  노포: ['노포', '맛집'],
};

function expandKeywords(keywords: string[]): string[] {
  const out = new Set<string>();
  for (const kw of keywords) {
    out.add(kw);
    const syn = MOOD_MAP[kw];
    if (syn) syn.forEach((s) => out.add(s));
  }
  return [...out];
}

// 키워드로 카카오 카테고리(CE7 카페 / FD6 음식점) 추론 → 검색을 해당 업종으로 제한해 정확도↑.
// 카페 힌트를 먼저 검사 (음식점 힌트가 더 광범위해 오분류 방지).
const CATEGORY_HINTS: Array<{ code: 'CE7' | 'FD6'; hints: string[] }> = [
  { code: 'CE7', hints: ['카페', '커피', '디저트', '베이커리', '브런치', '빵', '티룸'] },
  {
    code: 'FD6',
    hints: ['맛집', '식당', '밥', '술집', '와인바', '이자카야', '포차', '고기', '파스타', '한식', '일식', '중식', '양식', '횟집', '바', '비스트로', '레스토랑', '맥주', '칵테일'],
  },
];

function inferCategory(keywords: string[]): 'CE7' | 'FD6' | null {
  const joined = keywords.join(' ');
  for (const { code, hints } of CATEGORY_HINTS) {
    if (hints.some((h) => joined.includes(h))) return code;
  }
  return null;
}

// 'food'/'cafe' 명시값을 카카오 코드로, 'auto'면 키워드 추론.
function resolveCategory(explicit: unknown, keywords: string[]): 'CE7' | 'FD6' | null {
  const v = typeof explicit === 'string' ? explicit.trim().toLowerCase() : 'auto';
  if (v === 'food') return 'FD6';
  if (v === 'cafe') return 'CE7';
  return inferCategory(keywords);
}

// 장소/주소 문자열 → 좌표 (키워드 검색 첫 결과)
async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const docs = await kakaoGet('/search/keyword.json', { query, size: 1 });
  if (docs.length === 0) return null;
  return { lat: parseFloat(docs[0].y), lng: parseFloat(docs[0].x) };
}

interface GoogleRating {
  rating: number | null;
  user_rating_count: number | null;
  price_level: string | null;
}

// 카카오 장소를 Google Places로 매칭해 별점/리뷰수/가격대를 가져온다.
// 실패(키 없음/쿼터/매칭 실패)하면 null을 반환해 호출부가 별점 없이 진행하도록 한다 (안정성 우선).
async function fetchGoogleRating(
  name: string,
  lat: number,
  lng: number
): Promise<GoogleRating | null> {
  if (!GOOGLE_PLACES_API_KEY) return null;
  // 개별 호출 타임아웃. 한 곳이 느려도 전체 응답을 막지 않게 (안정성).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_PLACES_SEARCH, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        // 필드마스크로 필요한 필드만 요청 → 비용 절감.
        'X-Goog-FieldMask':
          'places.displayName,places.rating,places.userRatingCount,places.priceLevel',
      },
      body: JSON.stringify({
        textQuery: name,
        languageCode: 'ko',
        regionCode: 'KR',
        maxResultCount: 1,
        locationBias: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 500.0 },
        },
      }),
    });
    if (!res.ok) {
      console.error(`Google Places 오류 ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as {
      places?: Array<{
        rating?: number;
        userRatingCount?: number;
        priceLevel?: string;
      }>;
    };
    const p = data.places?.[0];
    if (!p) return null;
    return {
      rating: p.rating ?? null,
      user_rating_count: p.userRatingCount ?? null,
      price_level: p.priceLevel ?? null,
    };
  } catch (e) {
    console.error('Google Places 호출 실패:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 서울 실시간 도시데이터(인구현황) — 거점 지역 혼잡도 + 12시간 예측. 공식·무료, 서울 주요 ~120곳 한정.
// 키 없으면 'sample'로 폴백(광화문·덕수궁만 조회 가능). 실서비스는 SEOUL_OPENDATA_KEY 필요.
const SEOUL_OPENDATA_KEY = process.env.SEOUL_OPENDATA_KEY;
const SEOUL_CITYDATA_BASE = 'http://openapi.seoul.go.kr:8088';
const CITYDATA_TIMEOUT_MS = 3000;
// 중간지점이 핫스폿 대표좌표서 이 반경 밖이면 혼잡도 생략(엉뚱한 지역 혼잡도 방지).
const HOTSPOT_MATCH_RADIUS_M = 1500;

// 지역혼잡도 API 지원 핫스폿(지역명+대표좌표). 좌표 기반 최근접 매칭용.
// (서울 실시간 도시데이터 주요 장소 목록)
const SEOUL_HOTSPOTS: Array<{ name: string; lat: number; lng: number }> = [
  { name: "DDP(동대문디자인플라자)", lat: 37.566988, lng: 127.010289 },
  { name: "DMC(디지털미디어시티)", lat: 37.579278, lng: 126.891794 },
  { name: "가락시장", lat: 37.493468, lng: 127.111896 },
  { name: "가로수길", lat: 37.521389, lng: 127.023572 },
  { name: "가산디지털단지역", lat: 37.48089, lng: 126.880107 },
  { name: "강남 MICE 관광특구", lat: 37.511, lng: 127.060063 },
  { name: "강남역", lat: 37.498857, lng: 127.028134 },
  { name: "강서한강공원", lat: 37.586514, lng: 126.818549 },
  { name: "건대입구역", lat: 37.539967, lng: 127.068195 },
  { name: "경복궁", lat: 37.579876, lng: 126.976765 },
  { name: "고덕역", lat: 37.553455, lng: 127.154872 },
  { name: "고속터미널역", lat: 37.504814, lng: 127.005855 },
  { name: "고척돔", lat: 37.497672, lng: 126.867023 },
  { name: "광나루한강공원", lat: 37.553988, lng: 127.12982 },
  { name: "광장(전통)시장", lat: 37.570003, lng: 126.999904 },
  { name: "광화문·덕수궁", lat: 37.570931, lng: 126.977186 },
  { name: "광화문광장", lat: 37.573409, lng: 126.976921 },
  { name: "교대역", lat: 37.492201, lng: 127.013958 },
  { name: "구로디지털단지역", lat: 37.483878, lng: 126.896183 },
  { name: "구로역", lat: 37.50235, lng: 126.882122 },
  { name: "국립중앙박물관·용산가족공원", lat: 37.522768, lng: 126.981427 },
  { name: "군자역", lat: 37.556316, lng: 127.080195 },
  { name: "김포공항", lat: 37.562272, lng: 126.802599 },
  { name: "난지한강공원", lat: 37.566502, lng: 126.877328 },
  { name: "남대문시장", lat: 37.559915, lng: 126.978527 },
  { name: "남산공원", lat: 37.551577, lng: 126.993762 },
  { name: "노들섬", lat: 37.517557, lng: 126.958661 },
  { name: "노량진", lat: 37.513894, lng: 126.944056 },
  { name: "대림역", lat: 37.492667, lng: 126.895543 },
  { name: "덕수궁길·정동길", lat: 37.566351, lng: 126.971785 },
  { name: "동대문 관광특구", lat: 37.567311, lng: 127.011023 },
  { name: "동대문역", lat: 37.571481, lng: 127.009654 },
  { name: "뚝섬역", lat: 37.548291, lng: 127.046137 },
  { name: "뚝섬한강공원", lat: 37.529184, lng: 127.071515 },
  { name: "망원한강공원", lat: 37.553281, lng: 126.899268 },
  { name: "명동 관광특구", lat: 37.564149, lng: 126.981851 },
  { name: "미아사거리역", lat: 37.612195, lng: 127.030741 },
  { name: "반포한강공원", lat: 37.509825, lng: 126.994675 },
  { name: "발산역", lat: 37.559151, lng: 126.839173 },
  { name: "보라매공원", lat: 37.492963, lng: 126.920056 },
  { name: "보신각", lat: 37.570585, lng: 126.983411 },
  { name: "북서울꿈의숲", lat: 37.621852, lng: 127.041116 },
  { name: "북창동 먹자골목", lat: 37.562264, lng: 126.978498 },
  { name: "북촌한옥마을", lat: 37.582236, lng: 126.984002 },
  { name: "사당역", lat: 37.477931, lng: 126.981266 },
  { name: "삼각지역", lat: 37.535341, lng: 126.973884 },
  { name: "서대문독립공원", lat: 37.574091, lng: 126.956607 },
  { name: "서리풀공원·몽마르뜨공원", lat: 37.491583, lng: 127.002683 },
  { name: "서울 암사동 유적", lat: 37.560632, lng: 127.130759 },
  { name: "서울대공원", lat: 37.429007, lng: 127.017156 },
  { name: "서울대입구역", lat: 37.480613, lng: 126.953063 },
  { name: "서울숲공원", lat: 37.542963, lng: 127.037648 },
  { name: "서울식물원·마곡나루역", lat: 37.567597, lng: 126.831061 },
  { name: "서울역", lat: 37.556594, lng: 126.973028 },
  { name: "서촌", lat: 37.580367, lng: 126.969575 },
  { name: "선릉역", lat: 37.506054, lng: 127.049807 },
  { name: "성수카페거리", lat: 37.542967, lng: 127.056596 },
  { name: "성신여대입구역", lat: 37.592393, lng: 127.016865 },
  { name: "송리단길·호수단길", lat: 37.508047, lng: 127.106314 },
  { name: "송현녹지광장", lat: 37.577857, lng: 126.983711 },
  { name: "수유역", lat: 37.64106, lng: 127.025722 },
  { name: "숭례문", lat: 37.560486, lng: 126.975729 },
  { name: "시의회 앞", lat: 37.567069, lng: 126.976939 },
  { name: "신논현역·논현역", lat: 37.50808, lng: 127.023406 },
  { name: "신도림역", lat: 37.509099, lng: 126.890205 },
  { name: "신림역", lat: 37.484677, lng: 126.929337 },
  { name: "신정네거리역", lat: 37.521306, lng: 126.855275 },
  { name: "신촌 스타광장", lat: 37.556509, lng: 126.936931 },
  { name: "신촌·이대역", lat: 37.557035, lng: 126.938972 },
  { name: "쌍문역", lat: 37.647762, lng: 127.033089 },
  { name: "아차산", lat: 37.566842, lng: 127.102811 },
  { name: "안양천", lat: 37.518668, lng: 126.879697 },
  { name: "압구정로데오거리", lat: 37.525495, lng: 127.038734 },
  { name: "양재역", lat: 37.485339, lng: 127.033972 },
  { name: "양화한강공원", lat: 37.541305, lng: 126.898185 },
  { name: "어린이대공원", lat: 37.549062, lng: 127.081361 },
  { name: "여의도", lat: 37.525022, lng: 126.925531 },
  { name: "여의도한강공원", lat: 37.528987, lng: 126.928223 },
  { name: "여의서로", lat: 37.532701, lng: 126.914584 },
  { name: "역삼역", lat: 37.500392, lng: 127.038184 },
  { name: "연남동", lat: 37.561618, lng: 126.92234 },
  { name: "연신내역", lat: 37.618659, lng: 126.920725 },
  { name: "영등포 타임스퀘어", lat: 37.516863, lng: 126.906151 },
  { name: "오목교역·목동운동장", lat: 37.528811, lng: 126.876641 },
  { name: "올림픽공원", lat: 37.519408, lng: 127.122411 },
  { name: "왕십리역", lat: 37.562216, lng: 127.0389 },
  { name: "용리단길", lat: 37.531186, lng: 126.971294 },
  { name: "용산역", lat: 37.530256, lng: 126.960822 },
  { name: "월드컵공원", lat: 37.570188, lng: 126.884201 },
  { name: "응봉산", lat: 37.548215, lng: 127.030466 },
  { name: "이촌한강공원", lat: 37.519401, lng: 126.966651 },
  { name: "이태원 관광특구", lat: 37.534438, lng: 126.994373 },
  { name: "이태원 앤틱가구거리", lat: 37.532231, lng: 126.993918 },
  { name: "이태원역", lat: 37.534186, lng: 126.993048 },
  { name: "익선동", lat: 37.572661, lng: 126.989631 },
  { name: "인사동", lat: 37.573863, lng: 126.986063 },
  { name: "잠실 관광특구", lat: 37.516479, lng: 127.115274 },
  { name: "잠실롯데타워·석촌호수", lat: 37.511559, lng: 127.103306 },
  { name: "잠실새내역", lat: 37.510413, lng: 127.082656 },
  { name: "잠실역", lat: 37.511997, lng: 127.100367 },
  { name: "잠실종합운동장", lat: 37.514522, lng: 127.073648 },
  { name: "잠실한강공원", lat: 37.519234, lng: 127.084298 },
  { name: "잠원한강공원", lat: 37.52381, lng: 127.014728 },
  { name: "장지역", lat: 37.47875, lng: 127.123275 },
  { name: "장한평역", lat: 37.561804, lng: 127.064786 },
  { name: "종로·청계 관광특구", lat: 37.570002, lng: 126.99737 },
  { name: "창덕궁·종묘", lat: 37.578696, lng: 126.993353 },
  { name: "창동 신경제 중심지", lat: 37.656148, lng: 127.054706 },
  { name: "천호역", lat: 37.539239, lng: 127.125013 },
  { name: "청계산", lat: 37.440739, lng: 127.050018 },
  { name: "청담동 명품거리", lat: 37.525832, lng: 127.043765 },
  { name: "청량리 제기동 일대 전통시장", lat: 37.58083, lng: 127.039981 },
  { name: "총신대입구(이수)역", lat: 37.486003, lng: 126.981042 },
  { name: "충정로역", lat: 37.559696, lng: 126.963691 },
  { name: "합정역", lat: 37.549376, lng: 126.911735 },
  { name: "해방촌·경리단길", lat: 37.542371, lng: 126.987183 },
  { name: "혜화역", lat: 37.582482, lng: 127.001764 },
  { name: "홍대 관광특구", lat: 37.553919, lng: 126.921274 },
  { name: "홍대입구역(2호선)", lat: 37.556762, lng: 126.923008 },
  { name: "홍제폭포", lat: 37.580788, lng: 126.936983 },
  { name: "회기역", lat: 37.59054, lng: 127.056162 },
];

// 두 좌표 간 거리(m), Haversine.
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 좌표 → 가장 가까운 핫스폿 지역명 (반경 내). 없으면 null.
function matchHotspot(lat: number, lng: number): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const h of SEOUL_HOTSPOTS) {
    const d = haversineM(lat, lng, h.lat, h.lng);
    if (!best || d < best.dist) best = { name: h.name, dist: d };
  }
  if (best && best.dist <= HOTSPOT_MATCH_RADIUS_M) return best.name;
  return null;
}

interface Congestion {
  area_name: string;
  level: string; // 여유/보통/약간 붐빔/붐빔
  message: string;
  ppltn_min: number | null;
  ppltn_max: number | null;
  updated: string;
  forecast: Array<{ time: string; level: string }>; // 시간대별 예측(혼잡 몰리는 시간 파악용)
}

// 지역명으로 실시간 혼잡도 + 예측 조회. 실패/미지원 지역이면 null 폴백.
async function fetchAreaCongestion(areaNm: string): Promise<Congestion | null> {
  const key = SEOUL_OPENDATA_KEY || 'sample';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CITYDATA_TIMEOUT_MS);
  try {
    const url = `${SEOUL_CITYDATA_BASE}/${key}/json/citydata_ppltn/1/1/${encodeURIComponent(areaNm)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      'SeoulRtd.citydata_ppltn'?: Array<{
        AREA_NM: string;
        AREA_CONGEST_LVL: string;
        AREA_CONGEST_MSG: string;
        AREA_PPLTN_MIN?: string;
        AREA_PPLTN_MAX?: string;
        PPLTN_TIME: string;
        FCST_PPLTN?: Array<{ FCST_TIME: string; FCST_CONGEST_LVL: string }>;
      }>;
      RESULT?: { 'RESULT.CODE'?: string };
    };
    const row = data['SeoulRtd.citydata_ppltn']?.[0];
    if (!row || !row.AREA_CONGEST_LVL) return null;
    // 요청 지역과 응답 지역이 다르면(sample키 치환 등) 엉뚱한 지역 혼잡도이므로 버림.
    if (row.AREA_NM !== areaNm) return null;
    return {
      area_name: row.AREA_NM,
      level: row.AREA_CONGEST_LVL,
      message: row.AREA_CONGEST_MSG,
      ppltn_min: row.AREA_PPLTN_MIN ? parseInt(row.AREA_PPLTN_MIN, 10) : null,
      ppltn_max: row.AREA_PPLTN_MAX ? parseInt(row.AREA_PPLTN_MAX, 10) : null,
      updated: row.PPLTN_TIME,
      forecast: (row.FCST_PPLTN ?? []).map((f) => ({
        time: f.FCST_TIME.slice(11, 16), // "HH:MM"
        level: f.FCST_CONGEST_LVL,
      })),
    };
  } catch (e) {
    console.error('서울 혼잡도 호출 실패:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface DriveETA {
  distance_m: number;
  duration_min: number;
}

// 출발 좌표 → 도착 좌표 자동차 소요시간/거리 (요약값만). 실패 시 null 폴백(안정성).
// 카카오 디벨로퍼스에서 '카카오내비/길찾기' 활성화 필요. 미활성/오류면 null → 호출부가 ETA 없이 진행.
async function fetchDriveETA(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number }
): Promise<DriveETA | null> {
  if (!KAKAO_REST_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVI_TIMEOUT_MS);
  try {
    const url = new URL(KAKAO_NAVI_DIRECTIONS);
    // 좌표 포맷은 "경도,위도" (x,y)
    url.searchParams.set('origin', `${origin.lng},${origin.lat}`);
    url.searchParams.set('destination', `${dest.lng},${dest.lat}`);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`카카오모빌리티 오류 ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as {
      routes?: Array<{ result_code: number; summary?: { distance: number; duration: number } }>;
    };
    const route = data.routes?.[0];
    // result_code 0 = 성공. 그 외(출발=도착 등)는 ETA 생략.
    if (!route || route.result_code !== 0 || !route.summary) return null;
    return {
      distance_m: route.summary.distance,
      duration_min: Math.round(route.summary.duration / 60),
    };
  } catch (e) {
    console.error('카카오모빌리티 호출 실패:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// MCP 서버 인스턴스 생성 + 핸들러 등록.
// Stateless Streamable HTTP라 요청마다 새 인스턴스를 만든다 (분산 환경 세션 무효화 회피).
function createServer(): Server {
  const server = new Server(
    {
      name: 'playmcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'calculate_optimal_midpoint',
        description: '여러 모임 멤버들의 출발지 목록을 받아서 최적의 중간 대중교통 거점 위치를 계산해 반환합니다. 장소 검색(search_kakao_places) 전에 가장 먼저 호출해 중간 거점을 파악하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            locations: {
              type: 'array',
              items: {
                type: 'string'
              },
              description: '출발 위치 배열 (예: ["강남역", "홍대입구역", "잠실역"])'
            }
          },
          required: ['locations']
        }
      },
      {
        name: 'search_kakao_places',
        description: '좌표 정보(위도, 경도)와 뾰족해진 취향 키워드를 바탕으로 카카오맵의 장소 목록을 검색해 상위 3곳의 정보를 반환합니다. 호출 전에 사용자에게 추가 조건(주종/룸/예산/분위기 등)을 1~2가지 되물어 키워드를 구체화한 뒤 호출하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            lat: {
              type: 'number',
              description: '중간 지점 위도 (Latitude)'
            },
            lng: {
              type: 'number',
              description: '중간 지점 경도 (Longitude)'
            },
            keywords: {
              type: 'array',
              items: {
                type: 'string'
              },
              description: '사용자와의 대화를 통해 구체화된 선호 무드 및 조건 키워드 (예: ["모던", "와인바", "룸"])'
            },
            radius: {
              type: 'number',
              description: '검색 반경 단위 미터 (기본값: 1000)',
              default: 1000
            },
            category: {
              type: 'string',
              enum: ['auto', 'food', 'cafe'],
              description: "업종 필터. 'food'=음식점(FD6), 'cafe'=카페(CE7), 'auto'=키워드로 자동 추론(기본). 카페/식당이 명확하면 지정해 정확도를 높이세요.",
              default: 'auto'
            }
          },
          required: ['lat', 'lng', 'keywords']
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'calculate_optimal_midpoint') {
    const locations = normalizeStringArray(args?.locations);
    if (locations.length === 0) {
      throw new Error('locations 배열 필수. 최소 1개 출발지 필요. (예: ["강남역","홍대입구역"])');
    }
    console.log(`중간 지점 계산 요청. 입력 출발지:`, locations);

    // 1. 각 출발지 좌표 변환 (출발지명 ↔ 좌표 쌍 유지: 멤버별 소요시간 표시에 사용)
    const geocoded = await Promise.all(
      locations.map(async (loc) => ({ loc, coord: await geocode(loc) }))
    );
    const valid = geocoded.filter(
      (g): g is { loc: string; coord: { lat: number; lng: number } } => g.coord !== null
    );
    if (valid.length === 0) {
      throw new Error('좌표 변환 실패. 출발지명 확인 필요.');
    }

    // 2. centroid (좌표 평균)
    const centLat = valid.reduce((s, g) => s + g.coord.lat, 0) / valid.length;
    const centLng = valid.reduce((s, g) => s + g.coord.lng, 0) / valid.length;

    // 3. centroid 근처 지하철역(SW8) 검색 → 대중교통 거점으로 스냅
    const stations = await kakaoGet('/search/category.json', {
      category_group_code: 'SW8',
      x: centLng,
      y: centLat,
      radius: 2000,
      sort: 'distance',
      size: 1,
    });

    let center: { center_region: string; center_lat: number; center_lng: number; snapped_to_station: boolean };
    if (stations.length > 0) {
      const st = stations[0];
      center = {
        center_region: st.place_name,
        center_lat: parseFloat(st.y),
        center_lng: parseFloat(st.x),
        snapped_to_station: true,
      };
    } else {
      // 근처 역 없으면 centroid 그대로 반환
      center = {
        center_region: '중간 지점',
        center_lat: centLat,
        center_lng: centLng,
        snapped_to_station: false,
      };
    }

    // 4. 멤버별 중간지점까지 대략 소요시간/거리 (자동차 기준, 시각화·투명성용).
    //    경로 추천이 아니라 "각자 얼마나 걸리는지" 비교용. 실패 멤버는 null.
    const destCoord = { lat: center.center_lat, lng: center.center_lng };
    const settled = await Promise.allSettled(
      valid.map((g) => fetchDriveETA(g.coord, destCoord))
    );
    const members = valid.map((g, i) => {
      const r = settled[i];
      const eta = r.status === 'fulfilled' ? r.value : null;
      return {
        location: g.loc,
        distance_m: eta?.distance_m ?? null,
        duration_min: eta?.duration_min ?? null,
      };
    });

    // 5. 거점 지역 혼잡도 (서울 핫스폿 매칭 시). 비매칭/비서울/실패는 null.
    const hotspot = matchHotspot(center.center_lat, center.center_lng);
    const congestion = hotspot ? await fetchAreaCongestion(hotspot) : null;

    const result = { ...center, members, congestion };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  if (name === 'search_kakao_places') {
    const lat = toCoord(args?.lat);
    const lng = toCoord(args?.lng);
    const rawKeywords = normalizeStringArray(args?.keywords);
    const radius = toCoord(args?.radius) ?? 1000;

    if (lat === null || lng === null) {
      throw new Error('lat, lng 유효 좌표 필수. calculate_optimal_midpoint의 center_lat/center_lng 값을 그대로 넣으세요.');
    }
    if (rawKeywords.length === 0) {
      throw new Error('keywords 배열 필수. (예: ["카페","조용한"])');
    }

    // 무드어 동의/연관 확장 → 매칭률↑. 카테고리는 명시값 우선, 없으면 키워드로 추론.
    const keywords = expandKeywords(rawKeywords);
    const categoryCode = resolveCategory(args?.category, rawKeywords);
    console.log(
      `카카오 장소 검색 요청. 좌표: (${lat}, ${lng}), 원키워드:`, rawKeywords,
      `확장:`, keywords, `반경: ${radius}m`, `카테고리: ${categoryCode ?? '없음'}`
    );

    const safeRadius = Math.min(radius, 20000); // 카카오 최대 20000m

    // 키워드를 합쳐 검색하면 카카오가 문구 전체로 매칭해 0건이 됨.
    // → 키워드별 개별 검색 후 장소 id로 병합, 매칭 키워드 수 + 거리로 스코어링.
    interface Scored {
      doc: KakaoPlace;
      matched: Set<string>;
      distance: number;
    }
    const scoreMap = new Map<string, Scored>();

    // 주어진 반경으로 키워드별 검색 후 scoreMap에 병합.
    const searchAtRadius = async (r: number) => {
      const perKeyword = await Promise.all(
        keywords.map((kw) => {
          const params: Record<string, string | number> = {
            query: kw,
            x: lng,
            y: lat,
            radius: r,
            sort: 'distance',
            size: 15,
          };
          // 카테고리 추론/지정 시 해당 업종(CE7/FD6)으로 제한해 무관 장소 제거.
          if (categoryCode) params.category_group_code = categoryCode;
          return kakaoGet('/search/keyword.json', params).then((docs) => ({ kw, docs }));
        })
      );
      for (const { kw, docs } of perKeyword) {
        for (const d of docs) {
          const id = d.place_url || d.place_name;
          const dist = d.distance ? parseInt(d.distance, 10) : Number.MAX_SAFE_INTEGER;
          const existing = scoreMap.get(id);
          if (existing) {
            existing.matched.add(kw);
            existing.distance = Math.min(existing.distance, dist);
          } else {
            scoreMap.set(id, { doc: d, matched: new Set([kw]), distance: dist });
          }
        }
      }
    };

    // 0건이면 반경 단계 확대 재검색(×2, ×4 … 최대 20km) → 무인 운영 중 빈 응답 방지.
    let curRadius = safeRadius;
    await searchAtRadius(curRadius);
    while (scoreMap.size === 0 && curRadius < 20000) {
      curRadius = Math.min(curRadius * 2, 20000);
      console.log(`결과 0건 → 반경 확대 재검색: ${curRadius}m`);
      await searchAtRadius(curRadius);
      if (curRadius >= 20000) break;
    }
    const effectiveRadius = curRadius;

    // 1차 정렬: 매칭 키워드 수 내림차순 → 거리 오름차순
    const ranked = [...scoreMap.values()].sort((a, b) => {
      if (b.matched.size !== a.matched.size) return b.matched.size - a.matched.size;
      return a.distance - b.distance;
    });

    // 별점 보강 대상: 1차 상위 후보 8곳만 Google 조회(비용/지연 절감). 나머지는 별점 없이 후순위.
    const TOP_CANDIDATES = 8;
    const candidates = ranked.slice(0, TOP_CANDIDATES);
    // allSettled로 한 곳 실패/타임아웃이 배치 전체를 깨지 않게. rejected는 별점 없음(null)으로 폴백.
    const settled = await Promise.allSettled(
      candidates.map((s) => {
        const lat2 = parseFloat(s.doc.y);
        const lng2 = parseFloat(s.doc.x);
        return fetchGoogleRating(s.doc.place_name, lat2, lng2);
      })
    );
    const ratings = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));

    // 종합 스코어 = 매칭(0.45) + 별점(0.40, 리뷰수로 신뢰 가중) + 근접(0.15)
    const scored = candidates.map((s, i) => {
      const r = ratings[i];
      // 확장어로 매칭 수가 부풀 수 있어 원 키워드 수 기준 + 1.0 상한.
      const matchNorm = Math.min(s.matched.size / rawKeywords.length, 1);
      const ratingNorm = r?.rating ? r.rating / 5 : 0;
      // 리뷰수 적으면 별점 신뢰 낮춤 (50건에서 포화)
      const confidence = r?.user_rating_count ? Math.min(r.user_rating_count / 50, 1) : 0;
      const proximity =
        s.distance === Number.MAX_SAFE_INTEGER ? 0 : 1 - Math.min(s.distance / effectiveRadius, 1);
      const score = 0.45 * matchNorm + 0.4 * (ratingNorm * confidence) + 0.15 * proximity;
      return { s, r, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const places = scored.slice(0, 3).map(({ s, r }) => ({
      place_name: s.doc.place_name,
      address_name: s.doc.road_address_name || s.doc.address_name,
      category_name: s.doc.category_name,
      place_url: s.doc.place_url,
      distance_m: s.distance === Number.MAX_SAFE_INTEGER ? null : s.distance,
      matched_keywords: [...s.matched],
      rating: r?.rating ?? null,
      user_rating_count: r?.user_rating_count ?? null,
      price_level: r?.price_level ?? null,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(places) }],
    };
  }

    throw new Error(`지원하지 않는 도구: ${name}`);
  });

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

// MCP Streamable HTTP 엔드포인트 (stateless).
// 요청마다 새 Server + Transport를 만들어 처리 후 정리 → 세션 미보관, 로드밸런서 뒤에서도 안정.
app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP 요청 처리 오류:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: '내부 서버 오류' },
        id: null,
      });
    }
  }
});

// stateless 모드에서는 서버 주도 스트림/세션 종료가 불필요 → GET/DELETE는 405.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method Not Allowed. POST /mcp 만 지원 (stateless).' },
    id: null,
  });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// 헬스체크 (클라우드 배포용)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PlayMCP Streamable HTTP Server listening on port ${PORT} (POST /mcp)`);
});
