import { IsString } from 'class-validator';

export class ChallengeDto {
  @IsString({ message: 'O matchId é obrigatório.' })
  matchId: string;
}