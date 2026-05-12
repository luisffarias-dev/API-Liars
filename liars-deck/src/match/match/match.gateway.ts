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
import { MatchmakingService } from '../matchmaking/matchmaking.service'; // Ajuste o caminho se necessário
import { GameService } from '../game.service'; // Importando o GameService (ajuste o caminho se necessário)

@WebSocketGateway({ cors: { origin: '*' } })
export class MatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService,
    private gameService: GameService // Injetando o nosso gerenciador de regras do jogo
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
      
      // 3. IMPORTANTE: Coloca o jogador em uma "sala privada" com o próprio ID.
      // Isso permite que o GameService envie as 13 cartas só para ele.
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

  // --- NOVA ROTA: JOGAR CARTA ---
  @SubscribeMessage('play_card')
  async handlePlayCard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; cardPlayed: string; claimedCard: string }
  ) {
    const userId = client.data.userId;

    // 1. O GameService valida e processa a carta escolhida
    const result = await this.gameService.processMove(
      data.matchId,
      userId,
      data.cardPlayed,   // A carta que ele REALMENTE está jogando
      data.claimedCard,  // A carta que ele DIZ estar jogando (o blefe)
      this.server
    );

    // 2. Se houver erro (não é a vez dele, ou não tem a carta), avisa só ele
    if (!result.success) {
      client.emit('error', { message: result.message });
      return;
    }

    // 3. Notifica a mesa inteira que uma jogada aconteceu.
    // CIBERSEGURANÇA: Só mandamos o 'claimedCard'. A verdade fica no servidor!
    this.server.to(data.matchId).emit('card_played', {
      userId: userId,
      claimedCard: data.claimedCard, 
      message: `O jogador disse que colocou um(a) ${data.claimedCard} na mesa.`
    });
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
      client.emit('error', { message: result.message });
    }
  }

  @SubscribeMessage('reconnect_match')
  async handleReconnectMatch(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId;
    
    // Chama o GameService passando o próprio client (Socket) para ele ser reinserido nas salas
    await this.gameService.recoverGameState(userId, client);
  }
}