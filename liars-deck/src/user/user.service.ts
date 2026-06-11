import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        avatar: true,
        coins: true,
        wins: true,
        matchesPlayed: true,
        createdAt: true,
      },
    });

    if (!user) throw new NotFoundException('Usuário não encontrado');

    const losses = user.matchesPlayed - user.wins;
    const winRate = user.matchesPlayed > 0 
      ? Math.round((user.wins / user.matchesPlayed) * 100) 
      : 0;

    return {
      ...user,
      losses,
      winRate, // Retorna como número puro (ex: 75), ideal para o Flutter tratar
    };
  }

  // ==========================================
  // 🏆 RANKING 1: Top Vencedores (Por Vitórias)
  // ==========================================
  async getRanking() {
    const topPlayers = await this.prisma.user.findMany({
      orderBy: { wins: 'desc' },
      take: 10,
      select: {
        nickname: true,
        avatar: true, // Adicionado para a UI do Flutter ficar completa!
        wins: true,
        coins: true,
        matchesPlayed: true,
      }
    });

    return topPlayers.map(player => ({
      ...player,
      winRate: player.matchesPlayed > 0 
        ? ((player.wins / player.matchesPlayed) * 100).toFixed(1) + '%' 
        : '0%'
    }));
  }

  // ==========================================
  // 💰 RANKING 2: Mais Ricos (Por Moedas)
  // ==========================================
  async getRankingByCoins() {
    const richestPlayers = await this.prisma.user.findMany({
      orderBy: { coins: 'desc' }, // A MÁGICA AQUI: Ordena pela fortuna
      take: 10,
      select: {
        nickname: true,
        avatar: true,
        coins: true, // O destaque principal desta lista
        wins: true,
        matchesPlayed: true,
      }
    });

    return richestPlayers.map(player => ({
      ...player,
      winRate: player.matchesPlayed > 0 
        ? ((player.wins / player.matchesPlayed) * 100).toFixed(1) + '%' 
        : '0%'
    }));
  }

  async updateAvatar(userId: string, avatarName: string) {
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: avatarName },
      select: {
        id: true,
        nickname: true,
        avatar: true, // Retornamos o novo avatar para confirmar o sucesso
      },
    });

    return updatedUser;
  }
}