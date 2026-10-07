import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, Matches, IsIn } from 'class-validator';
export class PayerContactDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty() @IsString() @Matches(/^\+?[0-9 ()-]{7,25}$/) phone!: string;
  @ApiProperty({ enum: ['REQUESTER', 'AUTHORIZED_REPRESENTATIVE'] })
  @IsIn(['REQUESTER', 'AUTHORIZED_REPRESENTATIVE'])
  capacity!: 'REQUESTER' | 'AUTHORIZED_REPRESENTATIVE';
}
