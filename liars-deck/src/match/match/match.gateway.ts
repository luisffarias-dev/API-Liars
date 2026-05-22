import { 
  WebSocketGateway, 
  SubscribeMessage, 
  WebSocketServer, 
  OnGatewayConnection, 
  OnGatewayDisconnect,
  ConnectedSocket, 
  MessageBody
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { GameService } from '../game.service'; 

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
      
      // 3. Coloca o jogador em uma "sala privada" com o próprio ID.
      // Isso permite que o GameService envie as cartas só para ele.
      client.join(client.data.userId);
      
      console.log(`✅ Conectado: ${payload.email}`);
    } catch (err) {
      console.log(`❌ Erro de Autenticação: ${err.message}`);
      client.disconnect(); // Desconecta forçadamente quem tiver token inválido
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    
    if (userId) {
      // 1. Tira da fila de espera (se ele estava procurando partida)
      this.matchmakingService.removeFromQueue(userId);
      
      // 2. Aciona o Anti-Travamento (se ele estava no meio de um jogo)
      this.gameService.handlePlayerDisconnect(userId, this.server);
    }
  }

  @SubscribeMessage('find_match')
  async handleFindMatch(client: Socket) {
    await this.matchmakingService.joinQueue(client, client.data.userId, this.server);
  }

  // --- ROTA ATUALIZADA: JOGAR MÚLTIPLAS CARTAS ---
  @SubscribeMessage('play_card')
  async handlePlayCard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; cardsPlayed: string[] } // Recebe um array de cartas
  ) {
    const userId = client.data.userId;

    // 1. O GameService valida e processa as cartas escolhidas
    const result = await this.gameService.processMove(
      data.matchId,
      userId,
      data.cardsPlayed, 
      this.server
    );

    // 2. Se houver erro (não é a vez dele, ou não tem as cartas), avisa só ele.
    // (Em caso de sucesso, o próprio GameService já notifica a mesa inteira)
    if (!result.success) {
      client.emit('error', { message: (result as any).message || 'Erro ao jogar a carta.' });
      return;
    }
  }

  @SubscribeMessage('challenge')
  async handleChallenge(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string }
  ) {
    const challengerId = client.data.userId;
    console.log(`[Gateway] 🕵️ Jogador ${challengerId} apertou o botão de DUVIDAR!`);

    try {
      const result = await this.gameService.challengeMove(
        data.matchId,
        challengerId,
        this.server
      );

      console.log(`[Gateway] 📊 Resultado do desafio:`, result);

      if (!result.success) {
        client.emit('error', { message: (result as any).message || 'Erro ao duvidar.' });
      }
    } catch (error) {
      console.error(`[Gateway] 💥 ERRO FATAL AO DUVIDAR:`, error.message);
      client.emit('error', { message: 'Erro interno no servidor ao processar o desafio.' });
    }
  }

  @SubscribeMessage('play_penalty')
  async handlePenaltyDuel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; choice: string } // choice deve ser 'ROCK', 'PAPER' ou 'SCISSORS'
  ) {
    const userId = client.data.userId;

    const result = await this.gameService.resolvePenaltyDuel(
      data.matchId,
      userId,
      data.choice,
      this.server
    );

    if (!result.success) {
      // Se não for a vez dele de duelar ou passar algo errado
      client.emit('error', { message: (result as any).message || 'Erro no duelo.' });
    }
  }

  @SubscribeMessage('reconnect_match')
  async handleReconnectMatch(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId;
    
    // Chama o GameService passando o próprio client (Socket) para ele ser reinserido nas salas
    await this.gameService.recoverGameState(userId, client);
  }
}