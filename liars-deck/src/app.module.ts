import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { MatchModule } from './match/match.module';
import { UserController } from './user/user.controller';
import { UserService } from './user/user.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // Carrega o .env para todo o projeto
    AuthModule,
    PrismaModule,
    MatchModule,
  ],
  controllers: [UserController], // Geralmente vazio no AppModule
  providers: [UserService],   // Geralmente vazio no AppModule
})
export class AppModule {}


