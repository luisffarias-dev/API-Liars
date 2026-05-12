import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Server, Socket } from 'socket.io';

@Injectable()
export class MatchmakingService {
  private waitingRooms: Map<string, string[]> = new Map();

  constructor(private prisma: PrismaService) {}

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
      console.log(`[Queue] Jogador ${userId} adicionado à sala ${targetRoomId}. Total: ${roomPlayers.length}/4`);
    }

    this.waitingRooms.set(targetRoomId, roomPlayers);

    if (roomPlayers.length === 4) {
      console.log(`[Matchmaking] Sala ${targetRoomId} cheia! Gravando no banco de dados...`);
      
      try {
        const match = await this.prisma.match.create({
          data: {
            status: 'PLAYING',
            players: {
              create: roomPlayers.map(id => ({ userId: id, status: 'SAFE' }))
            }
          }
        });

        console.log(`[Matchmaking] ✅ Partida criada no Supabase com ID: ${match.id}`);
        
        this.waitingRooms.delete(targetRoomId);
        server.to(targetRoomId).emit('match_started', { matchId: match.id });
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
        console.log(`[Queue] Jogador ${userId} saiu da fila. Sala ${roomId} agora tem ${players.length} players.`);
        if (players.length === 0) {
          this.waitingRooms.delete(roomId);
          console.log(`[Queue] Sala ${roomId} removida (vazia).`);
        }
      }
    }
  }
}