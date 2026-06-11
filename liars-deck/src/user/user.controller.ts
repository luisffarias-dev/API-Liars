import { Controller, Get, Patch, Request, UseGuards, UnauthorizedException, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // Ajuste o caminho do seu guard
import { UserProfileResponseDto } from './dto/user-profile.dto'; // DTO que criamos no passo anterior
import { UpdateAvatarDto } from './dto/update-avatar.dto'; // DTO que criamos no passo anterior

@ApiTags('User') // Agrupa as rotas no Swagger
@Controller('user')
export class UserController {
  // CORREÇÃO AQUI: removido o "s" de usersService para userService
  constructor(private readonly userService: UserService) {}

  @Get('ranking')
  @ApiOperation({ summary: 'Busca o top 10 jogadores com mais vitórias' })
  @ApiResponse({ status: 200, description: 'Ranking retornado com sucesso.' })
  async getRanking() {
    // Agora vai funcionar perfeitamente
    return this.userService.getRanking();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Busca o perfil e estatísticas do usuário logado' })
  @ApiResponse({ 
    status: 200, 
    description: 'Perfil retornado com sucesso.', 
    type: UserProfileResponseDto 
  })
  @ApiResponse({ status: 401, description: 'Não autorizado.' })
  async getProfile(@Request() req) {
    // 1. Agora usamos o nome EXATO que a sua JwtStrategy exportou
    const id = req.user.userId;

    // 2. Trava de segurança extra (nunca mais teremos Erro 500 por causa disso)
    if (!id) {
      throw new UnauthorizedException('Token inválido: ID não mapeado na requisição.');
    }

    // 3. Busca no banco de dados
    return this.userService.getProfile(id);
  }


 @Patch('me/avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Atualiza o avatar do usuário logado' })
  // ... ApiResponses ...
  async updateAvatar(@Request() req, @Body() updateAvatarDto: UpdateAvatarDto) {
    // 👇 ADICIONE ESTA LINHA DE DEBUG AQUI 👇
    console.log('👀 Body do PATCH de avatar recebido:', updateAvatarDto);

    const userId = req.user.userId;
    if (!userId) {
      throw new UnauthorizedException('Token inválido: ID não mapeado.');
    }

    return this.userService.updateAvatar(userId, updateAvatarDto.avatar);
  }

  @Get('ranking/coins')
  async getCoinRanking() {
    return this.userService.getRankingByCoins();
  }
}