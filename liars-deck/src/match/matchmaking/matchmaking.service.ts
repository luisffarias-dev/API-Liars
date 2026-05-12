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

        console.log(`[Matchmaking] ✅ Partida criada no banco com ID: ${match.id}`);
        
        // ---> É AQUI QUE O MATCHMAKING PASSA A BOLA PRO GAME SERVICE <---
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