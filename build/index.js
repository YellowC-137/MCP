"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_BASE = 'https://dapi.kakao.com/v2/local';
// Google Places (별점 보조 소스). 키 없으면 보강 단계 자동 스킵 → 카카오 결과만으로 동작.
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACES_SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_TIMEOUT_MS = 3000; // 개별 Google 호출 타임아웃
// 카카오 로컬 API 호출 공통 함수
async function kakaoGet(path, params) {
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
    const data = (await res.json());
    return data.documents ?? [];
}
// 문자열 배열 인자 정규화.
// LLM/클라이언트가 배열 대신 JSON 문자열('["a","b"]')이나 콤마 문자열('a, b')로 보내는 흔한 실수를 흡수.
function normalizeStringArray(input) {
    if (Array.isArray(input)) {
        // 배열인데 원소가 JSON 배열 문자열인 경우(예: ['["카페","조용한"]'])도 펼친다.
        return input.flatMap((item) => normalizeStringArray(item));
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed))
                    return parsed.map((v) => String(v).trim()).filter(Boolean);
            }
            catch {
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
function toCoord(input) {
    const n = typeof input === 'string' ? parseFloat(input) : input;
    if (typeof n !== 'number' || Number.isNaN(n) || n === 0)
        return null;
    return n;
}
// 무드/추상 키워드 → 구체 검색어 확장.
// 사용자가 "조용한","감성" 같은 분위기어만 줄 때 카카오 키워드 매칭률을 높인다.
// 원 키워드는 항상 유지하고 동의/연관어를 덧붙인다 (중복은 Set으로 제거).
const MOOD_MAP = {
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
function expandKeywords(keywords) {
    const out = new Set();
    for (const kw of keywords) {
        out.add(kw);
        const syn = MOOD_MAP[kw];
        if (syn)
            syn.forEach((s) => out.add(s));
    }
    return [...out];
}
// 키워드로 카카오 카테고리(CE7 카페 / FD6 음식점) 추론 → 검색을 해당 업종으로 제한해 정확도↑.
// 카페 힌트를 먼저 검사 (음식점 힌트가 더 광범위해 오분류 방지).
const CATEGORY_HINTS = [
    { code: 'CE7', hints: ['카페', '커피', '디저트', '베이커리', '브런치', '빵', '티룸'] },
    {
        code: 'FD6',
        hints: ['맛집', '식당', '밥', '술집', '와인바', '이자카야', '포차', '고기', '파스타', '한식', '일식', '중식', '양식', '횟집', '바', '비스트로', '레스토랑', '맥주', '칵테일'],
    },
];
function inferCategory(keywords) {
    const joined = keywords.join(' ');
    for (const { code, hints } of CATEGORY_HINTS) {
        if (hints.some((h) => joined.includes(h)))
            return code;
    }
    return null;
}
// 'food'/'cafe' 명시값을 카카오 코드로, 'auto'면 키워드 추론.
function resolveCategory(explicit, keywords) {
    const v = typeof explicit === 'string' ? explicit.trim().toLowerCase() : 'auto';
    if (v === 'food')
        return 'FD6';
    if (v === 'cafe')
        return 'CE7';
    return inferCategory(keywords);
}
// 장소/주소 문자열 → 좌표 (키워드 검색 첫 결과)
async function geocode(query) {
    const docs = await kakaoGet('/search/keyword.json', { query, size: 1 });
    if (docs.length === 0)
        return null;
    return { lat: parseFloat(docs[0].y), lng: parseFloat(docs[0].x) };
}
// 카카오 장소를 Google Places로 매칭해 별점/리뷰수/가격대를 가져온다.
// 실패(키 없음/쿼터/매칭 실패)하면 null을 반환해 호출부가 별점 없이 진행하도록 한다 (안정성 우선).
async function fetchGoogleRating(name, lat, lng) {
    if (!GOOGLE_PLACES_API_KEY)
        return null;
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
                'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.priceLevel',
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
        const data = (await res.json());
        const p = data.places?.[0];
        if (!p)
            return null;
        return {
            rating: p.rating ?? null,
            user_rating_count: p.userRatingCount ?? null,
            price_level: p.priceLevel ?? null,
        };
    }
    catch (e) {
        console.error('Google Places 호출 실패:', e);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
// MCP 서버 인스턴스 생성 + 핸들러 등록.
// Stateless Streamable HTTP라 요청마다 새 인스턴스를 만든다 (분산 환경 세션 무효화 회피).
function createServer() {
    const server = new index_js_1.Server({
        name: 'playmcp-server',
        version: '1.0.0',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // List available tools
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
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
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        if (name === 'calculate_optimal_midpoint') {
            const locations = normalizeStringArray(args?.locations);
            if (locations.length === 0) {
                throw new Error('locations 배열 필수. 최소 1개 출발지 필요. (예: ["강남역","홍대입구역"])');
            }
            console.log(`중간 지점 계산 요청. 입력 출발지:`, locations);
            // 1. 각 출발지 좌표 변환
            const coords = await Promise.all(locations.map(geocode));
            const valid = coords.filter((c) => c !== null);
            if (valid.length === 0) {
                throw new Error('좌표 변환 실패. 출발지명 확인 필요.');
            }
            // 2. centroid (좌표 평균)
            const centLat = valid.reduce((s, c) => s + c.lat, 0) / valid.length;
            const centLng = valid.reduce((s, c) => s + c.lng, 0) / valid.length;
            // 3. centroid 근처 지하철역(SW8) 검색 → 대중교통 거점으로 스냅
            const stations = await kakaoGet('/search/category.json', {
                category_group_code: 'SW8',
                x: centLng,
                y: centLat,
                radius: 2000,
                sort: 'distance',
                size: 1,
            });
            let result;
            if (stations.length > 0) {
                const st = stations[0];
                result = {
                    center_region: st.place_name,
                    center_lat: parseFloat(st.y),
                    center_lng: parseFloat(st.x),
                    snapped_to_station: true,
                };
            }
            else {
                // 근처 역 없으면 centroid 그대로 반환
                result = {
                    center_region: '중간 지점',
                    center_lat: centLat,
                    center_lng: centLng,
                    snapped_to_station: false,
                };
            }
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
            console.log(`카카오 장소 검색 요청. 좌표: (${lat}, ${lng}), 원키워드:`, rawKeywords, `확장:`, keywords, `반경: ${radius}m`, `카테고리: ${categoryCode ?? '없음'}`);
            const safeRadius = Math.min(radius, 20000); // 카카오 최대 20000m
            const scoreMap = new Map();
            // 주어진 반경으로 키워드별 검색 후 scoreMap에 병합.
            const searchAtRadius = async (r) => {
                const perKeyword = await Promise.all(keywords.map((kw) => {
                    const params = {
                        query: kw,
                        x: lng,
                        y: lat,
                        radius: r,
                        sort: 'distance',
                        size: 15,
                    };
                    // 카테고리 추론/지정 시 해당 업종(CE7/FD6)으로 제한해 무관 장소 제거.
                    if (categoryCode)
                        params.category_group_code = categoryCode;
                    return kakaoGet('/search/keyword.json', params).then((docs) => ({ kw, docs }));
                }));
                for (const { kw, docs } of perKeyword) {
                    for (const d of docs) {
                        const id = d.place_url || d.place_name;
                        const dist = d.distance ? parseInt(d.distance, 10) : Number.MAX_SAFE_INTEGER;
                        const existing = scoreMap.get(id);
                        if (existing) {
                            existing.matched.add(kw);
                            existing.distance = Math.min(existing.distance, dist);
                        }
                        else {
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
                if (curRadius >= 20000)
                    break;
            }
            const effectiveRadius = curRadius;
            // 1차 정렬: 매칭 키워드 수 내림차순 → 거리 오름차순
            const ranked = [...scoreMap.values()].sort((a, b) => {
                if (b.matched.size !== a.matched.size)
                    return b.matched.size - a.matched.size;
                return a.distance - b.distance;
            });
            // 별점 보강 대상: 1차 상위 후보 8곳만 Google 조회(비용/지연 절감). 나머지는 별점 없이 후순위.
            const TOP_CANDIDATES = 8;
            const candidates = ranked.slice(0, TOP_CANDIDATES);
            // allSettled로 한 곳 실패/타임아웃이 배치 전체를 깨지 않게. rejected는 별점 없음(null)으로 폴백.
            const settled = await Promise.allSettled(candidates.map((s) => {
                const lat2 = parseFloat(s.doc.y);
                const lng2 = parseFloat(s.doc.x);
                return fetchGoogleRating(s.doc.place_name, lat2, lng2);
            }));
            const ratings = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
            // 종합 스코어 = 매칭(0.45) + 별점(0.40, 리뷰수로 신뢰 가중) + 근접(0.15)
            const scored = candidates.map((s, i) => {
                const r = ratings[i];
                // 확장어로 매칭 수가 부풀 수 있어 원 키워드 수 기준 + 1.0 상한.
                const matchNorm = Math.min(s.matched.size / rawKeywords.length, 1);
                const ratingNorm = r?.rating ? r.rating / 5 : 0;
                // 리뷰수 적으면 별점 신뢰 낮춤 (50건에서 포화)
                const confidence = r?.user_rating_count ? Math.min(r.user_rating_count / 50, 1) : 0;
                const proximity = s.distance === Number.MAX_SAFE_INTEGER ? 0 : 1 - Math.min(s.distance / effectiveRadius, 1);
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
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// MCP Streamable HTTP 엔드포인트 (stateless).
// 요청마다 새 Server + Transport를 만들어 처리 후 정리 → 세션 미보관, 로드밸런서 뒤에서도 안정.
app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => {
        transport.close();
        server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
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
const methodNotAllowed = (_req, res) => {
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
//# sourceMappingURL=index.js.map