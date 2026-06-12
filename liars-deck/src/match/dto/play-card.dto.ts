import { IsString, IsArray, ArrayMaxSize, ArrayMinSize, IsIn } from 'class-validator';

export class PlayCardDto {
  @IsString({ message: 'O matchId deve ser uma string válida.' })
  matchId: string;

  @IsString({ message: 'O userId deve ser uma string válida.' })
  userId: string;

  @IsArray({ message: 'cardsPlayed deve ser um array de cartas.' })
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'Tem de jogar pelo menos uma carta.' })
  @ArrayMaxSize(5, { message: 'Não pode jogar mais de 5 cartas de uma vez.' })
  @IsIn(['ROCK', 'PAPER', 'SCISSORS', 'JOKER'], { 
    each: true, 
    message: 'Carta inválida. Apenas ROCK, PAPER, SCISSORS ou JOKER são permitidos.' 
  })
  cardsPlayed: string[];
}