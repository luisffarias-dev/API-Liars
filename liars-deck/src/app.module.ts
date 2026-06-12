import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { MatchModule } from './match/match.module';
import { UserController } from './user/user.controller';
import { UserService } from './user/user.service';

// 👇 1. Importe o ThrottlerModule aqui
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // Carrega o .env para todo o projeto
    
    // 👇 2. Adicione o ThrottlerModule configurado aqui
    ThrottlerModule.forRoot([{
      ttl: 60000, // Tempo de vida em milissegundos (1 minuto)
      limit: 10,  // Limite de requisições (Ex: 10 tentativas por minuto)
    }]),

    AuthModule,
    PrismaModule,
    MatchModule,
  ],
  controllers: [UserController], // Geralmente vazio no AppModule
  providers: [UserService],   // Geralmente vazio no AppModule
})
export class AppModule {}