import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'hello_world') {
    const personName = (args?.name as string) || '손님';
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

const transports = new Map<string, SSEServerTransport>();

app.get('/sse', async (req, res) => {
  const sessionId = randomUUID();
  console.log(`새로운 SSE 세션 생성: ${sessionId}`);

  const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
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
