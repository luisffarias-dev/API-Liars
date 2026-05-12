import { 
  WebSocketGateway, 
  SubscribeMessage, 
  WebSocketServer, 
  OnGatewayConnection, 
  OnGatewayDisconnect 
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { MatchmakingService } from '../matchmaking/matchmaking.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class MatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService
  ) {}

async handleConnection(client: Socket) {
  try {
    // 1. Tenta extrair o token de várias fontes possíveis
    const rawToken = 
      client.handshake.auth?.token || 
      client.handshake.query?.token;

    if (!rawToken) throw new Error('Token não encontrado');

    // 2. Remove o "Bearer " se ele existir, senão usa o token puro
    const token = Array.isArray(rawToken) 
      ? rawToken[0] 
      : rawToken.toString().replace('Bearer ', '');

    const payload = await this.jwtService.verifyAsync(token);
    client.data.userId = payload.sub;
    
    console.log(`✅ Conectado: ${payload.email}`);
  } catch (err) {
    console.log(`❌ Erro: ${err.message}`);
    client.disconnect(); // Aqui é onde o Postman recebe o "forcefully disconnected"
  }
}

  handleDisconnect(client: Socket) {
    this.matchmakingService.removeFromQueue(client.data.userId);
  }

  @SubscribeMessage('find_match')
  async handleFindMatch(client: Socket) {
    await this.matchmakingService.joinQueue(client, client.data.userId, this.server);
  }
}