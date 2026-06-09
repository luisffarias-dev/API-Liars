import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Server, Socket } from 'socket.io';
import { GameService } from '../game.service'; // Importando o novo serviço

@Injectable()
export class MatchmakingService {
  private waitingRooms: Map<string, string[]> = new Map();

  constructor(
    private prisma: PrismaService,
    private gameService: GameService // Injetando o GameService aqui
  ) {}

  async joinQueue(client: Socket, userId: string, server: Server) {
    console.log(`[Queue] Tentativa de entrada: User ID ${userId}`);

    // ==========================================
    // 🛡️ TRAVA DE SEGURANÇA (ANTI-CLONE)
    // ==========================================
    const activeMatch = await this.prisma.matchPlayer.findFirst({
      where: {
        userId: userId,
        status: { not: 'ELIMINATED' }, // O jogador NÃO foi eliminado
        match: { status: { in: ['PLAYING', 'PENALTY'] } } // E a partida continua rolando
      }
    });

    if (activeMatch) {
      console.log(`[Queue] ⛔ Bloqueado: Jogador ${userId} tentou entrar na fila, mas já tem uma partida ativa.`);
      
      // Avisa o cliente do erro
      client.emit('error', { 
        message: 'Você já tem uma partida em andamento! Reconectando...' 
      });
      
      // Força o front-end a pedir a reconexão para a sala antiga
      client.emit('force_reconnect', { matchId: activeMatch.matchId });
      
      return; // 🛑 Para a execução aqui! Ele não entra na fila.
    }
    // ==========================================

    let targetRoomId: string | null = null;

    for (const [roomId, players] of this.waitingRooms.entries()) {
      if (players.length < 4) {
        targetRoomId = roomId;
        break;
      }
    }

    if (!targetRoomId) {
      targetRoomId = `room_${Date.now()}`;
      this.waitingRooms.set(targetRoomId, []);
      console.log(`[Queue] Nova sala criada: ${targetRoomId}`);
    }

    const roomPlayers = this.waitingRooms.get(targetRoomId) || [];
    
    if (!roomPlayers.includes(userId)) {
      roomPlayers.push(userId);
      client.join(targetRoomId);
      console.log(`[Queue] Jogador ${userId} adicionado. Total: ${roomPlayers.length}/4`);
    }

    this.waitingRooms.set(targetRoomId, roomPlayers);

    if (roomPlayers.length === 4) {
      console.log(`[Matchmaking] Sala cheia! Gravando no banco de dados...`);
      
      try {
        const match = await this.prisma.match.create({
          data: {
            status: 'PLAYING',
            players: {
              create: roomPlayers.map(id => ({ userId: id, status: 'SAFE' }))
            }
          }
        });

        console.log(`[Matchmaking] ✅ Partida criada com ID: ${match.id}`);
        
        // ---> A SOLUÇÃO ESTÁ NESTA LINHA AQUI <---
        // Força todos os sockets que estavam na fila a entrarem na sala da partida oficial!
        server.in(targetRoomId).socketsJoin(match.id);
        
        // Agora sim chamamos o GameService
        await this.gameService.initializeGame(match.id, roomPlayers, server);

        this.waitingRooms.delete(targetRoomId);
      } catch (error) {
        console.error(`[Matchmaking] ❌ Erro ao criar partida no banco:`, error.message);
      }
    } else {
      server.to(targetRoomId).emit('queue_update', { 
        count: roomPlayers.length,
        message: `${roomPlayers.length}/4 jogadores na sala...` 
      });
    }
  }

  removeFromQueue(userId: string) {
    for (const [roomId, players] of this.waitingRooms.entries()) {
      const index = players.indexOf(userId);
      if (index !== -1) {
        players.splice(index, 1);
        console.log(`[Queue] Jogador saiu. Sala ${roomId} agora tem ${players.length} players.`);
        if (players.length === 0) {
          this.waitingRooms.delete(roomId);
        }
      }
    }
  }
}