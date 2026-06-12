import { 
  WebSocketGateway, 
  SubscribeMessage, 
  WebSocketServer, 
  OnGatewayConnection, 
  OnGatewayDisconnect,
  ConnectedSocket, 
  MessageBody
} from '@nestjs/websockets';
import { UsePipes, ValidationPipe } from '@nestjs/common'; 
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { GameService } from '../game.service'; 
import { PlayCardDto } from '../dto/play-card.dto'; 
import { ChallengeDto } from '../dto/challenge.dto'; 

@WebSocketGateway({ cors: { origin: '*' } })
export class MatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService,
    private gameService: GameService 
  ) {}

  async handleConnection(client: Socket) {
    try {
      const rawToken = client.handshake.auth?.token || client.handshake.query?.token;
      if (!rawToken) throw new Error('Token não encontrado');

      const token = Array.isArray(rawToken) ? rawToken[0] : rawToken.toString().replace('Bearer ', '');
      const payload = await this.jwtService.verifyAsync(token);
      client.data.userId = payload.sub;
      
      client.join(client.data.userId);
      console.log(`✅ Conectado: ${payload.email}`);
    } catch (err) {
      console.log(`❌ Erro de Autenticação: ${err.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (userId) {
      this.matchmakingService.removeFromQueue(userId);
      this.gameService.handlePlayerDisconnect(userId, this.server);
    }
  }

  @SubscribeMessage('find_match')
  async handleFindMatch(client: Socket) {
    await this.matchmakingService.joinQueue(client, client.data.userId, this.server);
  }

  // --- ROTA PROTEGIDA COM DTO ---
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('play_card')
  async handlePlayCard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: PlayCardDto
  ) {
    const result = await this.gameService.processMove(
      data.matchId,
      client.data.userId, // Pegamos o ID da sessão, não do Body, para evitar Spoofing
      data.cardsPlayed, 
      this.server
    );

    if (!result.success) {
      client.emit('error', { message: (result as any).message || 'Erro desconhecido' });
    }
  }

  // --- ROTA PROTEGIDA COM DTO ---
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('challenge')
  async handleChallenge(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChallengeDto
  ) {
    const result = await this.gameService.challengeMove(
      data.matchId,
      client.data.userId,
      this.server
    );

    if (!result.success) {
      client.emit('error', { message: (result as any).message || 'Erro desconhecido' });
    }
  }

  @SubscribeMessage('play_penalty')
  async handlePenaltyDuel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; choice: string }
  ) {
    const result = await this.gameService.resolvePenaltyDuel(
      data.matchId,
      client.data.userId,
      data.choice,
      this.server
    );

    if (!result.success) {
      client.emit('error', { message: (result as any).message || 'Erro desconhecido' });
    }
  }

  // 👇 NOVA ROTA ADICIONADA: DESISTÊNCIA (SURRENDER) PROTEGIDA
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('surrender')
  async handleSurrender(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChallengeDto // Reaproveitamos o ChallengeDto pois ele já valida o matchId!
  ) {
    console.log(`[Gateway] 🏳️ Jogador ${client.data.userId} solicitou desistência da partida ${data.matchId}.`);
    
    await this.gameService.surrenderMatch(
      data.matchId,
      client.data.userId,
      this.server
    );
  }

  @SubscribeMessage('reconnect_match')
  async handleReconnectMatch(@ConnectedSocket() client: Socket) {
    await this.gameService.recoverGameState(client.data.userId, client);
  }
}