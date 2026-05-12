import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config'; // Importe estes
import { MatchGateway } from './match/match.gateway';
import { MatchmakingService } from './matchmaking/matchmaking.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    // Configuração dinâmica para pegar do seu .env
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'), // Certifique-se que o nome no .env é este
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  providers: [MatchGateway, MatchmakingService],
})
export class MatchModule {}