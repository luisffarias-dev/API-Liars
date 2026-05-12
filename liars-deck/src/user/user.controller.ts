import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; // Ajuste o caminho

@Controller('users')
export class UserController {
  constructor(private prisma: PrismaService) {}

  // ROTA: GET /users/ranking
  @Get('ranking')
  async getRanking() {
    // Busca os 10 usuários com mais vitórias, em ordem decrescente
    const topPlayers = await this.prisma.user.findMany({
      orderBy: { wins: 'desc' },
      take: 10,
      select: {
        nickname: true,
        wins: true,
        matchesPlayed: true,
      }
    });

    // Calcula a "Taxa de Vitória" (Winrate) pra ficar bonitão no Front-end
    return topPlayers.map(player => ({
      ...player,
      winRate: player.matchesPlayed > 0 
        ? ((player.wins / player.matchesPlayed) * 100).toFixed(1) + '%' 
        : '0%'
    }));
  }
}