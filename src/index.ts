import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server, type Socket, type ExtendedError } from 'socket.io';
import { bindSocket } from './socket.js';
import crypto from 'node:crypto';

const PORT: number = Number(process.env.PORT || 4000);
const NODE_ENV: string = process.env.NODE_ENV || 'development';
const CORS_ORIGIN: string = process.env.CORS_ORIGIN || 'http://localhost:5173';
const SIGNING_SECRET: string = process.env.SIGNING_SECRET || 'dev-secret';

const app = express();
if (NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  })
);

function sign(id: string): string {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(id).digest('hex');
}

app.get('/api/hello', (req: Request, res: Response) => {
  let clientId = req.cookies?.['st_clientId'] as string | undefined;

  if (!clientId) {
    clientId = crypto.randomUUID();
    const clientSig = sign(clientId);

    res.cookie('st_clientId', clientId, {
      httpOnly: true,
      sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
      secure: NODE_ENV === 'production',
    });

    res.cookie('st_clientSig', clientSig, {
      httpOnly: true,
      sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
      secure: NODE_ENV === 'production',
    });

    return res.json({ clientId, clientSig });
  }

  // already has clientId -> refresh signature
  const clientSig = sign(clientId);
  res.cookie('st_clientSig', clientSig, {
    httpOnly: true,
    sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
    secure: NODE_ENV === 'production',
  });

  return res.json({ clientId, clientSig });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
  transports: ['websocket'], // reduce CORS edge
});

// handshake auth from cookies (via header/query fallback for dev)
io.use((socket: Socket, next: (err?: ExtendedError) => void) => {
  try {
    // prefer auth.clientId
    let clientId = socket.handshake.auth?.clientId as unknown;

    // fallback to header x-client-id
    if (!clientId) {
      const hdr = socket.handshake.headers['x-client-id'];
      clientId = typeof hdr === 'string' ? hdr : Array.isArray(hdr) ? hdr[0] : undefined;
    }

    if (!clientId || typeof clientId !== 'string') {
      return next(new Error('E_INVALID_PAYLOAD'));
    }

    // keep clientId on auth for downstream handlers
    (socket.handshake.auth as Record<string, unknown>).clientId = clientId;
    next();
  } catch (e) {
    next(e as ExtendedError);
  }
});

bindSocket(io);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`backend listening on :${PORT}`);
});
