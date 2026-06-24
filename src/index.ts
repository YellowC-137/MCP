import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';

const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_BASE = 'https://dapi.kakao.com/v2/local';

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

// 장소/주소 문자열 → 좌표 (키워드 검색 첫 결과)
async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const docs = await kakaoGet('/search/keyword.json', { query, size: 1 });
  if (docs.length === 0) return null;
  return { lat: parseFloat(docs[0].y), lng: parseFloat(docs[0].x) };
}

const app = express();
app.use(cors());

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
        description: '여러 모임 멤버들의 출발지 목록을 받아서 최적의 중간 대중교통 거점 위치를 계산해 반환합니다.',
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
        description: '좌표 정보(위도, 경도)와 뾰족해진 취향 키워드를 바탕으로 카카오맵의 장소 목록을 검색해 상위 3곳의 정보를 반환합니다.',
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
    const locations = (args?.locations as string[]) ?? [];
    if (!Array.isArray(locations) || locations.length === 0) {
      throw new Error('locations 배열 필수. 최소 1개 출발지 필요.');
    }
    console.log(`중간 지점 계산 요청. 입력 출발지:`, locations);

    // 1. 각 출발지 좌표 변환
    const coords = await Promise.all(locations.map(geocode));
    const valid = coords.filter((c): c is { lat: number; lng: number } => c !== null);
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
    } else {
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
    const lat = args?.lat as number;
    const lng = args?.lng as number;
    const keywords = args?.keywords as string[];
    const radius = (args?.radius as number) || 1000;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw new Error('lat, lng 숫자 필수.');
    }
    if (!Array.isArray(keywords) || keywords.length === 0) {
      throw new Error('keywords 배열 필수.');
    }
    console.log(`카카오 장소 검색 요청. 좌표: (${lat}, ${lng}), 키워드:`, keywords, `반경: ${radius}m`);

    const safeRadius = Math.min(radius, 20000); // 카카오 최대 20000m

    // 키워드를 합쳐 검색하면 카카오가 문구 전체로 매칭해 0건이 됨.
    // → 키워드별 개별 검색 후 장소 id로 병합, 매칭 키워드 수 + 거리로 스코어링.
    interface Scored {
      doc: KakaoPlace;
      matched: Set<string>;
      distance: number;
    }
    const scoreMap = new Map<string, Scored>();

    const perKeyword = await Promise.all(
      keywords.map((kw) =>
        kakaoGet('/search/keyword.json', {
          query: kw,
          x: lng,
          y: lat,
          radius: safeRadius,
          sort: 'distance',
          size: 15,
        }).then((docs) => ({ kw, docs }))
      )
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

    // 매칭 키워드 수 내림차순 → 거리 오름차순
    const ranked = [...scoreMap.values()].sort((a, b) => {
      if (b.matched.size !== a.matched.size) return b.matched.size - a.matched.size;
      return a.distance - b.distance;
    });

    const places = ranked.slice(0, 3).map((s) => ({
      place_name: s.doc.place_name,
      address_name: s.doc.road_address_name || s.doc.address_name,
      category_name: s.doc.category_name,
      place_url: s.doc.place_url,
      distance_m: s.distance === Number.MAX_SAFE_INTEGER ? null : s.distance,
      matched_keywords: [...s.matched],
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(places) }],
    };
  }

  throw new Error(`지원하지 않는 도구: ${name}`);
});

const transports = new Map<string, SSEServerTransport>();

app.get('/sse', async (req, res) => {
  // SSEServerTransport가 자체 sessionId를 생성하고 endpoint에 붙여 클라이언트로 전달.
  const transport = new SSEServerTransport('/message', res);
  const sessionId = transport.sessionId;
  console.log(`새로운 SSE 세션 생성: ${sessionId}`);

  transports.set(sessionId, transport);

  transport.onclose = () => {
    console.log(`SSE 세션 종료: ${sessionId}`);
    transports.delete(sessionId);
  };

  await server.connect(transport);
});

app.post('/message', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).send('sessionId 쿼리 파라미터 필요.');
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).send('세션 찾을 수 없음.');
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PlayMCP SSE Server listening on port ${PORT}`);
});
