import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // Extrai o token do cabeçalho "Authorization: Bearer <token>"
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // Rejeita tokens vencidos
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  // Se o token for válido e não estiver expirado, essa função é chamada
  async validate(payload: any) {
    // O payload é o que você guardou dentro do token (ex: id do usuário).
    // O que você retornar aqui será injetado em "req.user" nos seus controllers!
    return { userId: payload.sub, email: payload.email,role: payload.role  };
  }
}

