"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
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
                name: 'hello_world',
                description: '인사를 건네는 기본 도구.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: '인사받을 이름',
                        },
                    },
                    required: ['name'],
                },
            },
        ],
    };
});
// Handle tool execution
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'hello_world') {
        const personName = args?.name || '손님';
        return {
            content: [
                {
                    type: 'text',
                    text: `안녕, ${personName}! PlayMCP 서버 잘 작동함.`,
                },
            ],
        };
    }
    throw new Error(`알 수 없는 도구: ${name}`);
});
const transports = new Map();
app.get('/sse', async (req, res) => {
    const sessionId = (0, crypto_1.randomUUID)();
    console.log(`새로운 SSE 세션 생성: ${sessionId}`);
    const transport = new sse_js_1.SSEServerTransport(`/message?sessionId=${sessionId}`, res);
    transports.set(sessionId, transport);
    transport.onclose = () => {
        console.log(`SSE 세션 종료: ${sessionId}`);
        transports.delete(sessionId);
    };
    await server.connect(transport);
});
app.post('/message', express_1.default.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
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
//# sourceMappingURL=index.js.map